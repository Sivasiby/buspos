/**
 * usePosTicketCounter.ts
 *
 * Offline-first POS ticket number assignment.
 *
 * ─── HOW IT WORKS ────────────────────────────────────────────────────────────
 *
 * ONLINE:
 *   - Fetches current counter from `bus_ticket_counters` in Supabase.
 *   - Atomically increments it and returns the new number.
 *   - Saves the last known online counter to AsyncStorage as a fallback.
 *
 * OFFLINE:
 *   - Reads last known counter from AsyncStorage.
 *   - Assigns numbers locally: lastKnown + 1, +2, +3 …
 *   - Saves each offline ticket to a local pending queue in AsyncStorage:
 *       pending_pos_tickets: [{ localId, busId, tripId, ticketNumber, ... }]
 *
 * ON RECONNECT (syncPendingTickets):
 *   1. Read the current DB counter.
 *   2. Find the highest ticket number used offline.
 *   3. If DB counter < highest offline number → bump DB counter to highest offline.
 *   4. For each pending offline ticket row (saved without an ID because we
 *      were offline), INSERT it into `tickets` with its assigned ticket_number.
 *   5. Clear the pending queue and update the local cache.
 *
 * CONFLICT EXAMPLE:
 *   - DB counter = 250 at disconnect.
 *   - POS offline: assigns 251, 252, 253, 254, 255  (5 tickets).
 *   - App online:  DB counter was still 250 → app tickets get NO ticket_number
 *                  (app tickets never get ticket_number, so no collision).
 *   - On reconnect: DB counter bumped to 255. Pending rows inserted with
 *     ticket_numbers 251–255. Everything consistent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { supabase } from '../../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingPosTicket {
  /** Locally generated UUID so we can deduplicate on retry */
  localId: string;
  busId: string;
  tripId: string;
  fromStopKey: string;
  toStopKey: string;
  ticketCount: number;
  fare: number;
  ticketNumber: number;
  createdAt: string;
  /** Set to true once successfully synced to Supabase */
  synced?: boolean;
}

interface UsePosTicketCounterResult {
  /** True while a sync is in progress */
  isSyncing: boolean;
  /** Number of tickets waiting to be synced */
  pendingCount: number;
  /**
   * Get the next ticket number and save the ticket locally if offline.
   * Returns the assigned ticket number.
   */
  assignTicketNumber: (params: {
    busId: string;
    tripId: string;
    fromStopKey: string;
    toStopKey: string;
    ticketCount: number;
    fare: number;
  }) => Promise<number>;
  /**
   * Call after a successful print to persist to DB.
   * Online  → saves immediately.
   * Offline → adds to pending queue, will sync on reconnect.
   */
  saveTicket: (params: {
    busId: string;
    tripId: string;
    fromStopKey: string;
    toStopKey: string;
    ticketCount: number;
    fare: number;
    ticketNumber: number;
  }) => Promise<void>;
  /** Manually trigger sync (also called automatically on reconnect) */
  syncPendingTickets: () => Promise<{ synced: number; failed: number }>;
}

// ─── Storage keys ─────────────────────────────────────────────────────────────
const KEY_LAST_COUNTER = (busId: string) => `pos_counter_last_${busId}`;
const KEY_PENDING = 'pos_pending_tickets_v1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const generateLocalId = () =>
  `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const readPending = async (): Promise<PendingPosTicket[]> => {
  try {
    const raw = await AsyncStorage.getItem(KEY_PENDING);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const writePending = async (tickets: PendingPosTicket[]) => {
  await AsyncStorage.setItem(KEY_PENDING, JSON.stringify(tickets));
};

const readLastCounter = async (busId: string): Promise<number> => {
  try {
    const raw = await AsyncStorage.getItem(KEY_LAST_COUNTER(busId));
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
};

const writeLastCounter = async (busId: string, value: number) => {
  await AsyncStorage.setItem(KEY_LAST_COUNTER(busId), String(value));
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export const usePosTicketCounter = (): UsePosTicketCounterResult => {
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const syncLockRef = useRef(false); // prevent concurrent syncs

  // Keep pendingCount fresh on mount
  useEffect(() => {
    readPending().then(p => setPendingCount(p.filter(t => !t.synced).length));
  }, []);

  // Auto-sync when network comes back online
  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      if (state.isConnected && state.isInternetReachable) {
        syncPendingTickets();
      }
    });
    return unsub;
  }, []);

  // ── assignTicketNumber ──────────────────────────────────────────────────────
  const assignTicketNumber = useCallback(async ({
    busId,
  }: {
    busId: string;
    tripId: string;
    fromStopKey: string;
    toStopKey: string;
    ticketCount: number;
    fare: number;
  }): Promise<number> => {
    const netState = await NetInfo.fetch();
    const isOnline = !!(netState.isConnected && netState.isInternetReachable);

    if (isOnline) {
      // ── ONLINE PATH ── atomically increment DB counter ──────────────────
      try {
        const { data, error } = await supabase
          .from('bus_ticket_counters')
          .select('last_number')
          .eq('bus_id', busId)
          .single();

        if (error && error.code !== 'PGRST116') throw error;

        const current = data?.last_number ?? 0;
        const next = current + 1;

        if (!data) {
          await supabase
            .from('bus_ticket_counters')
            .insert({ bus_id: busId, last_number: next });
        } else {
          await supabase
            .from('bus_ticket_counters')
            .update({ last_number: next })
            .eq('bus_id', busId);
        }

        // Cache the latest counter locally for offline fallback
        await writeLastCounter(busId, next);
        return next;

      } catch (err) {
        // DB call failed even though we thought we were online — fall through
        // to offline path so the conductor isn't blocked
        console.warn('[PosCounter] DB increment failed, falling back to offline:', err);
      }
    }

    // ── OFFLINE PATH ── use local counter ───────────────────────────────────
    // Read the highest number already used (either from cache or pending queue)
    const [cachedLast, pending] = await Promise.all([
      readLastCounter(busId),
      readPending(),
    ]);

    const pendingMax = pending
      .filter(t => t.busId === busId)
      .reduce((max, t) => Math.max(max, t.ticketNumber), 0);

    const localLast = Math.max(cachedLast, pendingMax);
    const next = localLast + 1;

    // Update the local cache so the next offline ticket increments correctly
    await writeLastCounter(busId, next);
    return next;
  }, []);

  // ── saveTicket ──────────────────────────────────────────────────────────────
  const saveTicket = useCallback(async (params: {
    busId: string;
    tripId: string;
    fromStopKey: string;
    toStopKey: string;
    ticketCount: number;
    fare: number;
    ticketNumber: number;
  }): Promise<void> => {
    const netState = await NetInfo.fetch();
    const isOnline = !!(netState.isConnected && netState.isInternetReachable);

    if (isOnline) {
      // ── ONLINE: save directly to Supabase ──────────────────────────────
      const { error } = await supabase.from('tickets').insert({
        trip_id: params.tripId,
        from_stop: params.fromStopKey,
        to_stop: params.toStopKey,
        ticket_count: params.ticketCount,
        total_fare: params.fare,
        fare: params.fare / params.ticketCount,
        payment_method: 'pos',
        ticket_number: params.ticketNumber,
        booking_status: 'booked',
        created_at: new Date().toISOString(),
      });
      if (error) throw new Error(`Failed to save ticket online: ${error.message}`);
      return;
    }

    // ── OFFLINE: push to pending queue ──────────────────────────────────────
    const pending = await readPending();
    const newEntry: PendingPosTicket = {
      localId: generateLocalId(),
      busId: params.busId,
      tripId: params.tripId,
      fromStopKey: params.fromStopKey,
      toStopKey: params.toStopKey,
      ticketCount: params.ticketCount,
      fare: params.fare,
      ticketNumber: params.ticketNumber,
      createdAt: new Date().toISOString(),
      synced: false,
    };
    await writePending([...pending, newEntry]);
    setPendingCount(c => c + 1);
  }, []);

  // ── syncPendingTickets ──────────────────────────────────────────────────────
  /**
   * Called automatically on reconnect and can be called manually.
   *
   * Steps:
   *  1. Read all unsynced pending tickets grouped by busId.
   *  2. For each bus, bump DB counter to max(db_last, max_offline_number).
   *  3. Insert each pending ticket row with its assigned ticket_number.
   *  4. Mark as synced in local queue.
   */
  const syncPendingTickets = useCallback(async (): Promise<{ synced: number; failed: number }> => {
    if (syncLockRef.current) return { synced: 0, failed: 0 };
    syncLockRef.current = true;
    setIsSyncing(true);

    let synced = 0;
    let failed = 0;

    try {
      const pending = await readPending();
      const unsynced = pending.filter(t => !t.synced);
      if (unsynced.length === 0) return { synced: 0, failed: 0 };

      // Group by busId to minimize DB round-trips for counter updates
      const byBus = unsynced.reduce<Record<string, PendingPosTicket[]>>((acc, t) => {
        if (!acc[t.busId]) acc[t.busId] = [];
        acc[t.busId].push(t);
        return acc;
      }, {});

      // Step 1: For each bus, bump the DB counter if needed
      for (const [busId, tickets] of Object.entries(byBus)) {
        const maxOffline = Math.max(...tickets.map(t => t.ticketNumber));

        try {
          const { data } = await supabase
            .from('bus_ticket_counters')
            .select('last_number')
            .eq('bus_id', busId)
            .single();

          const dbLast = data?.last_number ?? 0;

          if (maxOffline > dbLast) {
            // Bump DB counter so future online tickets don't collide
            if (!data) {
              await supabase
                .from('bus_ticket_counters')
                .insert({ bus_id: busId, last_number: maxOffline });
            } else {
              await supabase
                .from('bus_ticket_counters')
                .update({ last_number: maxOffline })
                .eq('bus_id', busId);
            }
            await writeLastCounter(busId, maxOffline);
          }
        } catch (err) {
          console.warn(`[PosSync] Failed to update counter for bus ${busId}:`, err);
          // Don't abort — still try to insert the tickets
        }
      }

      // Step 2: Insert each pending ticket row
      const updated = [...pending];
      for (const ticket of unsynced) {
        try {
          const { error } = await supabase.from('tickets').insert({
            trip_id: ticket.tripId,
            from_stop: ticket.fromStopKey,
            to_stop: ticket.toStopKey,
            ticket_count: ticket.ticketCount,
            total_fare: ticket.fare,
            fare: ticket.fare / ticket.ticketCount,
            payment_method: 'pos',
            ticket_number: ticket.ticketNumber,
            booking_status: 'booked',
            created_at: ticket.createdAt, // preserve original time
          });

          if (error) {
            // If it's a unique constraint violation the ticket was already inserted
            // (double-sync scenario) — treat as success
            if (error.code === '23505') {
              const idx = updated.findIndex(t => t.localId === ticket.localId);
              if (idx !== -1) updated[idx] = { ...updated[idx], synced: true };
              synced++;
            } else {
              console.warn(`[PosSync] Failed to insert ticket #${ticket.ticketNumber}:`, error);
              failed++;
            }
          } else {
            const idx = updated.findIndex(t => t.localId === ticket.localId);
            if (idx !== -1) updated[idx] = { ...updated[idx], synced: true };
            synced++;
          }
        } catch (err) {
          console.warn(`[PosSync] Exception on ticket #${ticket.ticketNumber}:`, err);
          failed++;
        }
      }

      // Step 3: Prune synced tickets older than 24h, keep recent ones for audit
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const pruned = updated.filter(
        t => !t.synced || new Date(t.createdAt).getTime() > cutoff
      );
      await writePending(pruned);
      setPendingCount(pruned.filter(t => !t.synced).length);

    } catch (err) {
      console.error('[PosSync] Sync failed:', err);
    } finally {
      syncLockRef.current = false;
      setIsSyncing(false);
    }

    return { synced, failed };
  }, []);

  return { isSyncing, pendingCount, assignTicketNumber, saveTicket, syncPendingTickets };
};