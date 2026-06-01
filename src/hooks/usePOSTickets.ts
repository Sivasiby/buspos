/**
 * usePOSTickets
 *
 * Saves POS (conductor-printed) tickets to:
 *   1. WatermelonDB  — instant, works offline (SQLite on-device)
 *   2. Supabase `tickets` table — synced in background when online
 *
 * ── SUPABASE RLS ──────────────────────────────────────────────────────────────
 * Run once in Supabase SQL Editor so authenticated conductors can insert:
 *
 *   CREATE POLICY "Conductors can insert POS tickets"
 *     ON tickets FOR INSERT TO authenticated
 *     WITH CHECK (true);
 *
 * ── COLUMN MAPPING (Supabase schema) ─────────────────────────────────────────
 *   tickets.trip_id        ← trip_id  (uuid | null)
 *   tickets.from_stop      ← resolved stop uuid  (fk → stops.id, nullable)
 *   tickets.to_stop        ← resolved stop uuid  (fk → stops.id, nullable)
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
import {Q} from '@nozbe/watermelondb';
import {database} from '../local_db/index';
import {supabase} from '../../lib/supabase';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface POSTicket {
  id:             string;            // local id  e.g. "pos_1711012345_abc12"
  trip_id:        string | null;     // activeTrip.trip_id
  from_stop:      string;            // full label "Athipalayam-017-அதிபாளையம்"
  to_stop:        string;
  from_key:       string;            // fareMatrix key
  to_key:         string;
  ticket_count:   number;
  fare:           number;            // total = unit_fare × ticket_count
  unit_fare:      number;
  ticket_type:    'full' | 'half' | 'luggage';   // full adult / half child / luggage
  luggage_amount?: number;
  ticket_number:  number | null;
  bus_number:     string;
  trip_number?:   number | null;     // trip sequence number
  direction:      string;            // 'up' | 'dn'
  issued_at:      string;            // ISO timestamp
  synced:         boolean;           // true once written to Supabase
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

    const payload = {
      trip_id:        ticket.trip_id ?? null,
      // from_stop / to_stop are UUID FK columns — MUST be uuid or null
      from_stop:      fromStopId ?? null,
      to_stop:        toStopId   ?? null,
      // Fare
      fare:           ticket.unit_fare,
      ticket_count:   ticket.ticket_count,
      total_fare:     ticket.fare,
      // Ticket type for full/half/luggage breakdown
      ticket_type:    ticket.ticket_type,
      // Meta
      ticket_number:  ticket.ticket_number,
      payment_method: 'pos',
      booking_status: 'booked',
      is_verified:    true,
      created_at:     ticket.issued_at,
    };
    const {error} = await supabase.from('tickets').insert(payload);

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
// WatermelonDB helper — map a DB row to the POSTicket shape the UI expects
// ─────────────────────────────────────────────────────────────────────────────
function rowToTicket(row: any): POSTicket {
  return {
    id:             row.localId   ?? row.id,
    trip_id:        row.tripId    ?? null,
    from_stop:      row.fromStop  ?? '',
    to_stop:        row.toStop    ?? '',
    from_key:       row.fromKey   ?? '',
    to_key:         row.toKey     ?? '',
    ticket_count:   Number(row.ticketCount  ?? 0),
    fare:           Number(row.fare         ?? 0),
    unit_fare:      Number(row.unitFare     ?? 0),
    ticket_type:    (row.ticketType ?? 'full') as 'full' | 'half' | 'luggage',
    luggage_amount: Number(row.luggageAmount ?? 0),
    ticket_number:  row.ticketNumber ?? null,
    bus_number:     row.busNumber   ?? '',
    trip_number:    row.tripNumber  ?? null,
    direction:      row.direction   ?? '',
    issued_at:      row.issuedAt    ?? new Date().toISOString(),
    synced:         !!row.synced,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────
export function usePOSTickets() {
  const [tickets, setTickets] = useState<POSTicket[]>([]);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { load(); }, []);

  // ── load ───────────────────────────────────────────────────────────────────
  // Reads all tickets from WatermelonDB, purges those older than 48 h.
  const load = async () => {
    try {
      const col = database.get('tickets');
      const rows = await col.query().fetch();

      // Auto-cleanup: permanently destroy tickets older than 48 hours
      const cutoff = Date.now() - (48 * 60 * 60 * 1000);
      const stale = rows.filter((r: any) => {
        try { return new Date(r.issuedAt).getTime() <= cutoff; } catch { return false; }
      });
      if (stale.length > 0) {
        await database.write(async () => {
          for (const r of stale) await (r as any).destroyPermanently();
        });
        console.log(`[POS] Cleaned up ${stale.length} tickets older than 48h`);
      }

      const fresh = rows.filter((r: any) => !stale.includes(r));
      setTickets(fresh.map(rowToTicket));
    } catch (e) {
      console.warn('[POS] load error:', e);
    }
  };

  // ── saveTicket ─────────────────────────────────────────────────────────────
  // Writes one ticket to WatermelonDB instantly (works offline).
  // Auto-triggers Supabase sync in the background when 10+ unsynced.
  const saveTicket = useCallback(async (
    ticket: Omit<POSTicket, 'synced'> & {ticket_type: 'full' | 'half' | 'luggage'},
  ) => {
    try {
      await database.write(async () => {
        await database.get('tickets').create((row: any) => {
          row.localId       = ticket.id;
          row.tripId        = ticket.trip_id   ?? null;
          row.fromStop      = ticket.from_stop ?? '';
          row.toStop        = ticket.to_stop   ?? '';
          row.fromKey       = ticket.from_key  ?? '';
          row.toKey         = ticket.to_key    ?? '';
          row.ticketCount   = ticket.ticket_count  ?? 0;
          row.fare          = ticket.fare          ?? 0;
          row.unitFare      = ticket.unit_fare     ?? 0;
          row.ticketType    = ticket.ticket_type   ?? 'full';
          row.luggageAmount = ticket.luggage_amount ?? 0;
          row.ticketNumber  = ticket.ticket_number ?? null;
          row.busNumber     = ticket.bus_number    ?? '';
          row.tripNumber    = ticket.trip_number   ?? null;
          row.direction     = ticket.direction     ?? '';
          row.issuedAt      = ticket.issued_at     ?? new Date().toISOString();
          row.synced        = false;
        });
      });

      // Reload in-memory list
      const col  = database.get('tickets');
      const rows = await col.query().fetch();
      const mapped = rows.map(rowToTicket);
      setTickets(mapped);

      const unsyncedNow = mapped.filter(t => !t.synced).length;
      if (unsyncedNow >= 10) {
        syncToDb();
      }
    } catch (e) {
      console.warn('[POS] saveTicket error:', e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── syncToDb ────────────────────────────────────────────────────────────────
  // Flushes all unsynced WatermelonDB rows to Supabase.
  const syncToDb = useCallback(async () => {
    const col = database.get('tickets');
    const rows = await col.query(Q.where('synced', false)).fetch();
    if (rows.length === 0) return;
    setSyncing(true);
    try {
      for (const row of rows) {
        const t = rowToTicket(row);
        const ok = await insertToSupabase(t);
        if (ok) {
          await database.write(async () => {
            await (row as any).update((r: any) => { r.synced = true; });
          });
        }
      }
      // Refresh in-memory list
      const fresh = await col.query().fetch();
      setTickets(fresh.map(rowToTicket));
    } finally {
      setSyncing(false);
    }
  }, []);

  // ── syncPending ─────────────────────────────────────────────────────────────
  const syncPending = useCallback(async () => {
    await syncToDb();
  }, [syncToDb]);

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
      if ((t.ticket_type ?? 'full') === 'half') {
        map[key].halfCount += t.ticket_count;
      } else {
        map[key].fullCount += t.ticket_count;
      }
      map[key].count += t.ticket_count;
      map[key].fare  += Number(t.fare || 0);
    }
    return Object.values(map).sort((a, b) => b.fare - a.fare);
  }, []);

  /**
   * Today's summary — full/half split + totals.
   */
  const todaySummary = useCallback(() => {
    const today    = todayTickets();
    const trips    = new Set(today.map(t => t.trip_id).filter(Boolean)).size;
    const rows     = today.length;
    const luggage  = today.filter(t => t.ticket_type === 'luggage').reduce((s, t) => s + Number(t.ticket_count || 1), 0);
    const full     = today
      .filter(t => (t.ticket_type ?? 'full') === 'full')
      .reduce((s, t) => s + Number(t.ticket_count || 0), 0);
    const half     = today
      .filter(t => t.ticket_type === 'half')
      .reduce((s, t) => s + Number(t.ticket_count || 0), 0);
    const count    = full + half + luggage;
    const total    = today.reduce((s, t) => s + Number(t.fare || 0), 0);
    const unsynced = today.filter(t => !t.synced).length;
    return {trips, rows, count, full, half, luggage, total, unsynced};
  }, [todayTickets]);

  /**
   * Summary for a specific trip.
   */
  const tripSummary = useCallback((tripId: string) => {
    const list    = tickets.filter(t => t.trip_id === tripId);
    const luggage = list.filter(t => t.ticket_type === 'luggage').reduce((s, t) => s + Number(t.ticket_count || 1), 0);
    const full    = list
      .filter(t => (t.ticket_type ?? 'full') === 'full')
      .reduce((s, t) => s + Number(t.ticket_count || 0), 0);
    const half    = list
      .filter(t => t.ticket_type === 'half')
      .reduce((s, t) => s + Number(t.ticket_count || 0), 0);
    return {
      rows:  list.length,
      count: full + half + luggage,
      full,
      half,
      luggage,
      total: list.reduce((s, t) => s + Number(t.fare || 0), 0),
    };
  }, [tickets]);

  // ── clearAll ───────────────────────────────────────────────────────────────
  const clearAll = useCallback(async () => {
    try {
      const col  = database.get('tickets');
      const rows = await col.query().fetch();
      await database.write(async () => {
        for (const r of rows) await (r as any).destroyPermanently();
      });
      setTickets([]);
    } catch (e) {
      console.warn('[POS] clearAll error:', e);
    }
  }, []);

  const unsyncedCount = tickets.filter(t => !t.synced).length;

  return {
    tickets,
    syncing,
    unsyncedCount,
    saveTicket,
    syncToDb,
    syncPending,
    reload: load,
    todayTickets,
    ticketsForTrip,
    todayByTrip,
    stageBreakdown,
    todaySummary,
    tripSummary,
    clearAll,
  };
}