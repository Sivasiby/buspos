/**
 * usePOSTickets
 *
 * Saves POS (conductor-printed) tickets to:
 *   1. AsyncStorage  — instant, works offline
 *   2. Supabase `tickets` table — via the existing supabase client
 *      so they appear in the Bus Owner dashboard automatically
 *
 * ── SUPABASE RLS ──────────────────────────────────────────────────────────────
 * Run once in Supabase SQL Editor so authenticated conductors can insert:
 *
 *   CREATE POLICY "Conductors can insert POS tickets"
 *     ON tickets FOR INSERT TO authenticated
 *     WITH CHECK (true);
 *
 * ── ticket_type column ───────────────────────────────────────────────────────
 * Make sure your `tickets` table has this column (run once):
 *
 *   ALTER TABLE tickets
 *     ADD COLUMN IF NOT EXISTS ticket_type TEXT DEFAULT 'full';
 *
 * ── COLUMN MAPPING (your schema) ─────────────────────────────────────────────
 *   tickets.trip_id        ← trip_id  (uuid | null)
 *   tickets.from_stop_id   ← resolved stop uuid  (fk → stops.id, nullable)
 *   tickets.to_stop_id     ← resolved stop uuid  (fk → stops.id, nullable)
 *   tickets.from_stop      ← UUID FK (same column as from_stop_id in some schemas)
 *   tickets.to_stop        ← UUID FK (same column as to_stop_id in some schemas)
 *   tickets.fare           ← unit_fare  (per-ticket amount)
 *   tickets.ticket_count   ← ticket_count
 *   tickets.total_fare     ← fare  (unit_fare × ticket_count)
 *   tickets.ticket_type    ← 'full' | 'half'
 *   tickets.payment_method ← 'pos'
 *   tickets.booking_status ← 'booked'
 *   tickets.is_verified    ← true
 *   tickets.created_at     ← issued_at  (device clock ISO)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {useState, useEffect, useCallback} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {supabase}   from '../../lib/supabase'; // ← adjust path to match your project

const STORAGE_KEY = 'pos_tickets_v2'; // bumped so old records don't interfere

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface POSTicket {
  id:           string;              // local id  e.g. "pos_1711012345_abc12"
  trip_id:      string | null;       // activeTrip.trip_id
  from_stop:    string;              // full label "Athipalayam-017-அதிபாளையம்"
  to_stop:      string;
  from_key:     string;              // fareMatrix key
  to_key:       string;
  ticket_count: number;
  fare:         number;              // total = unit_fare × ticket_count
  unit_fare:    number;
  ticket_type:  'full' | 'half';    // NEW — full adult / half child
  ticket_number: number | null;
  bus_number:   string;
  direction:    string;              // 'up' | 'dn'
  issued_at:    string;              // ISO timestamp
  synced:       boolean;             // true once written to Supabase
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve stop label to stop UUID via Supabase stops table.
// Label format: "EnglishName-017-LocalName"
// Tries progressively looser matches so short aliases still resolve.
// Returns null when not found — insert proceeds with null FK (safe).
// ─────────────────────────────────────────────────────────────────────────────
async function resolveStopId(label: string): Promise<string | null> {
  try {
    // Extract English part before the first numeric segment
    // "Sathyamangalam BS-017-சத்தி" -> "Sathyamangalam BS"
    const engName = label.split('-')[0].trim();
    if (!engName) return null;

    // 1. Prefix match  (faster, more precise)
    const r1 = await supabase
      .from('stops').select('id')
      .ilike('stop_name', `${engName}%`)
      .limit(1);
    if (!r1.error && r1.data && r1.data.length > 0) return r1.data[0].id as string;

    // 2. Contains match (handles abbreviations like "Sathy BS" matching "Sathyamangalam BS")
    const r2 = await supabase
      .from('stops').select('id')
      .ilike('stop_name', `%${engName}%`)
      .limit(1);
    if (!r2.error && r2.data && r2.data.length > 0) return r2.data[0].id as string;

    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Insert one POS ticket row into Supabase.
// Returns true on success, false on any error.
//
// CRITICAL — from_stop and to_stop are UUID FK columns in the tickets table.
// Never send a text string to them — always send the resolved UUID or null.
// ─────────────────────────────────────────────────────────────────────────────
async function insertToSupabase(ticket: POSTicket): Promise<boolean> {
  try {
    // Resolve stop UUIDs in parallel (nullable — insert proceeds even if null)
    const [fromStopId, toStopId] = await Promise.all([
      resolveStopId(ticket.from_stop),
      resolveStopId(ticket.to_stop),
    ]);

    const {error} = await supabase.from('tickets').insert({
      trip_id:        ticket.trip_id ?? null,
      // from_stop / to_stop are UUID FK columns — MUST be uuid or null
      from_stop:      fromStopId ?? null,
      to_stop:        toStopId   ?? null,
      // Fare
      fare:           ticket.unit_fare,
      ticket_count:   ticket.ticket_count,
      total_fare:     ticket.fare,
      // Ticket type for full/half breakdown
      ticket_type:    ticket.ticket_type,
      // Meta
      ticket_number:  ticket.ticket_number,
      payment_method: 'pos',
      booking_status: 'booked',
      is_verified:    true,
      created_at:     ticket.issued_at,
    });

    if (error) {
      console.warn('[POS] Supabase insert error:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[POS] Supabase insert failed:', e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────
export function usePOSTickets() {
  const [tickets, setTickets] = useState<POSTicket[]>([]);
  const [syncing, setSyncing] = useState(false);

  // Load persisted tickets on mount — with 48hr auto-cleanup and v1→v2 migration
  useEffect(() => { load(); }, []);

  const load = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      let parsed: POSTicket[] = raw ? JSON.parse(raw) : [];

      // Migrate old pos_tickets_v1 records if v2 is empty
      if (parsed.length === 0) {
        const oldRaw = await AsyncStorage.getItem('pos_tickets_v1');
        if (oldRaw) {
          const oldParsed: any[] = JSON.parse(oldRaw);
          parsed = oldParsed.map((t: any) => ({
            ...t,
            ticket_type: t.ticket_type ?? 'full',
            synced: t.synced ?? true,
          }));
          console.log(`[POS] Migrated ${parsed.length} tickets from v1 to v2`);
        }
      }

      // ── Auto-cleanup: remove tickets older than 48 hours ────────────────
      // This prevents stale records from accumulating and causing duplicate
      // counting between local AsyncStorage and the Supabase DB.
      const cutoff = Date.now() - (48 * 60 * 60 * 1000); // 48 hours ago
      const fresh = parsed.filter(t => {
        try { return new Date(t.issued_at).getTime() > cutoff; }
        catch { return false; }
      });

      if (fresh.length !== parsed.length) {
        console.log(`[POS] Cleaned up ${parsed.length - fresh.length} tickets older than 48h`);
        parsed = fresh;
      }

      // Always persist the cleaned list (handles both migration and cleanup)
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      setTickets(parsed);
    } catch { /* silent */ }
  };

  const persist = async (updated: POSTicket[]) => {
    setTickets(updated);
    try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); }
    catch { /* silent */ }
  };

  // ── saveTicket ─────────────────────────────────────────────────────────────
  // Called immediately after a successful print.
  // 1. Saves to AsyncStorage instantly (works offline)
  // 2. Fires Supabase insert in background (retried via syncPending if offline)
  // NOTE: this is the ONLY place that writes to Supabase.
  //       Do NOT call supabase.from('tickets').insert() elsewhere in the screen.
  const saveTicket = useCallback(async (ticket: Omit<POSTicket, 'synced'> & {ticket_type: 'full'|'half'}) => {
    const newTicket: POSTicket = {...ticket, synced: false};

    // 1. Local save — always instant
    const updated = [...tickets, newTicket];
    await persist(updated);

    // 2. Background Supabase insert
    setSyncing(true);
    try {
      const ok = await insertToSupabase(newTicket);
      if (ok) {
        const synced = updated.map(t =>
          t.id === newTicket.id ? {...t, synced: true} : t,
        );
        await persist(synced);
      }
    } finally {
      setSyncing(false);
    }
  }, [tickets]);

  // ── syncPending — retries all unsynced tickets ────────────────────────────
  const syncPending = useCallback(async () => {
    const unsynced = tickets.filter(t => !t.synced);
    if (unsynced.length === 0) return;
    setSyncing(true);
    try {
      const raw     = await AsyncStorage.getItem(STORAGE_KEY);
      const latest: POSTicket[] = raw ? JSON.parse(raw) : [];
      let updated   = [...latest];
      for (const t of latest.filter(x => !x.synced)) {
        const ok = await insertToSupabase(t);
        if (ok) {
          updated = updated.map(x => x.id === t.id ? {...x, synced: true} : x);
        }
      }
      await persist(updated);
    } finally {
      setSyncing(false);
    }
  }, [tickets]);

  // ── Query helpers ─────────────────────────────────────────────────────────

  const todayTickets = useCallback((): POSTicket[] => {
    const today = new Date().toDateString();
    return tickets.filter(t => new Date(t.issued_at).toDateString() === today);
  }, [tickets]);

  const ticketsForTrip = useCallback((tripId: string): POSTicket[] =>
    tickets.filter(t => t.trip_id === tripId), [tickets]);

  const todayByTrip = useCallback((): Record<string, POSTicket[]> =>
    todayTickets().reduce((acc, t) => {
      const key = t.trip_id ?? 'no_trip';
      if (!acc[key]) acc[key] = [];
      acc[key].push(t);
      return acc;
    }, {} as Record<string, POSTicket[]>),
  [todayTickets]);

  /**
   * Stage breakdown for a list of POS tickets.
   * Groups by from→to, splits passenger count into full/half.
   * Used by Stage Filter, Report Tab, Trip Report Modal.
   */
  const stageBreakdown = useCallback((list: POSTicket[]) => {
    const map: Record<string, {
      from: string; to: string;
      fullCount: number; halfCount: number;
      count: number; fare: number;
    }> = {};

    // UUID pattern — old tickets stored stop UUIDs instead of labels
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const stopLabel = (s: string) => {
      if (!s || s.trim() === '' || UUID_RE.test(s.trim())) return '?';
      return s.split('-')[0].trim() || '?';
    };

    for (const t of list) {
      const key = `${t.from_stop}|||${t.to_stop}`;
      if (!map[key]) map[key] = {
        from:      stopLabel(t.from_stop),
        to:        stopLabel(t.to_stop),
        fullCount: 0,
        halfCount: 0,
        count:     0,
        fare:      0,
      };
      // Split by ticket_type — default to 'full' for old records
      if ((t.ticket_type ?? 'full') === 'half') {
        map[key].halfCount += t.ticket_count;
      } else {
        map[key].fullCount += t.ticket_count;
      }
      map[key].count += t.ticket_count;
      map[key].fare  += t.fare;
    }
    return Object.values(map).sort((a, b) => b.fare - a.fare);
  }, []);

  /**
   * Today's summary — split into full/half passenger counts.
   * `rows`    = number of POSTicket records (for backend row subtraction)
   * `count`   = total passengers (full + half)
   * `full`    = adult passenger count
   * `half`    = child passenger count
   * `total`   = total fare collected
   * `unsynced`= records not yet in Supabase
   */
  const todaySummary = useCallback(() => {
    const today    = todayTickets();
    const trips    = new Set(today.map(t => t.trip_id).filter(Boolean)).size;
    const rows     = today.length;
    const full     = today
      .filter(t => (t.ticket_type ?? 'full') === 'full')
      .reduce((s, t) => s + t.ticket_count, 0);
    const half     = today
      .filter(t => t.ticket_type === 'half')
      .reduce((s, t) => s + t.ticket_count, 0);
    const count    = full + half;
    const total    = today.reduce((s, t) => s + t.fare, 0);
    const unsynced = today.filter(t => !t.synced).length;
    return {trips, rows, count, full, half, total, unsynced};
  }, [todayTickets]);

  /**
   * Summary for a specific trip — full/half split + totals.
   */
  const tripSummary = useCallback((tripId: string) => {
    const list  = tickets.filter(t => t.trip_id === tripId);
    const full  = list
      .filter(t => (t.ticket_type ?? 'full') === 'full')
      .reduce((s, t) => s + t.ticket_count, 0);
    const half  = list
      .filter(t => t.ticket_type === 'half')
      .reduce((s, t) => s + t.ticket_count, 0);
    return {
      rows:  list.length,
      count: full + half,
      full,
      half,
      total: list.reduce((s, t) => s + t.fare, 0),
    };
  }, [tickets]);

  const clearAll = useCallback(async () => { await persist([]); }, []);

  return {
    tickets,
    syncing,
    saveTicket,
    syncPending,
    todayTickets,
    ticketsForTrip,
    todayByTrip,
    stageBreakdown,
    todaySummary,
    tripSummary,
    clearAll,
  };
}