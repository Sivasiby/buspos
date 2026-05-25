import {useEffect, useRef, useState, useCallback} from 'react';
import {AppState, AppStateStatus} from 'react-native';
import {supabase} from '../../lib/supabase';
import {sendVerificationNotification} from '../services/ticketNotification';

export interface PendingTicket {
  ticket_id:    string;
  from:         string;
  to:           string;
  fare:         number;
  is_free:      boolean;
  bus_number:   string;
  requested_at: string;
  username:     string | null;
  tamil_name:   string | null;
  user_id:      string | null;
  user_app_id:  string | null;
  avatar_url:   string | null;
}

export function useVerificationRealtime(
  tripId: string | null | undefined,
  tripStatus: string | null | undefined,
) {
  const [pendingRequests, setPendingRequests] = useState<PendingTicket[]>([]);
  const channelRef = useRef<any>(null);
  const tripIdRef = useRef(tripId);
  const dismissedTicketsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    console.log('[VerifRealtime] tripId changed:', tripId, '| tripStatus:', tripStatus);
    tripIdRef.current = tripId;
  }, [tripId, tripStatus]);

  // 🔥 FETCH INITIAL
  const fetchInitial = useCallback(async () => {
    const tid = tripIdRef.current;
    if (!tid) {
      console.log('[VerifRealtime] fetchInitial: no tripId, skipping');
      return;
    }

    console.log('[VerifRealtime] fetchInitial: querying for tripId=', tid);

    try {
      const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const {data, error} = await supabase
        .from('tickets')
        .select(`
          id,
          fare,
          payment_method,
          verification_requested_at,
          from_stop_id,
          to_stop_id,
          ver_meta_data
        `)
        .eq('trip_id', tid)
        .eq('is_verified', false)
        .not('verification_requested_at', 'is', null)
        .gte('verification_requested_at', tenMinsAgo)
        .order('verification_requested_at', {ascending: true});

      if (error) {
        console.warn('[VerifRealtime] fetchInitial DB error:', error.message);
        return;
      }

      console.log('[VerifRealtime] fetchInitial raw rows:', data?.length ?? 0, data);

      // ✅ resolve stop names
      const stopMap = await resolveStops(data || []);

      console.log('[VerifRealtime] stopMap:', stopMap);

      const mapped = mapRows(data || [], stopMap).filter(t => !dismissedTicketsRef.current.has(t.ticket_id));

      console.log('[VerifRealtime] mapped pending requests:', mapped.length, mapped);

      setPendingRequests(mapped);
    } catch (e) {
      console.warn('[VerifRealtime] fetchInitial exception', e);
    }
  }, []);

  // 🔥 REALTIME
  const subscribe = useCallback(() => {
    const tid = tripIdRef.current;
    if (!tid) {
      console.log('[VerifRealtime] subscribe: no tripId, skipping');
      return;
    }

    if (channelRef.current) {
      console.log('[VerifRealtime] subscribe: removing old channel before resubscribing');
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    // Use a unique channel name each time to avoid Supabase deduplication/caching issues
    const channelName = `pending-verif-${tid}-${Date.now()}`;
    console.log('[VerifRealtime] subscribe: creating channel', channelName);

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tickets',
          filter: `trip_id=eq.${tid}`,
        },
        async (payload: any) => {
          console.log('[VerifRealtime] postgres_changes event:', payload.eventType, 'id:', payload.new?.id ?? payload.old?.id);

          const record = payload.new ?? {};
          const oldRecord = payload.old ?? {};

          if (payload.eventType === 'DELETE') {
            setPendingRequests(prev =>
              prev.filter(p => p.ticket_id !== oldRecord.id),
            );
            return;
          }

          const isVerified = record.is_verified === true;
          const hasRequest = !!record.verification_requested_at;
          const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const isRecent = !!(record.verification_requested_at && record.verification_requested_at >= tenMinsAgo);

          console.log('[VerifRealtime] ticket', record.id, '| is_verified:', isVerified, '| hasRequest:', hasRequest, '| isRecent:', isRecent, '| verification_requested_at:', record.verification_requested_at);

          const isFreshRequest = hasRequest && isRecent && !isVerified;
          const isStaleOrDone = isVerified || !hasRequest || !isRecent;

          // Always remove from pending if the ticket is no longer needing verification
          if (isStaleOrDone) {
            console.log('[VerifRealtime] ticket', record.id, 'is stale/done — removing from pending');
            setPendingRequests(prev =>
              prev.filter(p => p.ticket_id !== record.id),
            );
          }

          if (!isFreshRequest) {
            console.log('[VerifRealtime] ticket', record.id, 'NOT a fresh request — skipping notification');
            return;
          }

          console.log('[VerifRealtime] 🔔 FRESH VERIFICATION REQUEST for ticket', record.id, '— triggering fetchInitial + notification');

          // ✅ A new verification request came in — lift any prior dismissal so it re-appears
          dismissedTicketsRef.current.delete(record.id);

          // ✅ always re-fetch (with stopMap)
          await fetchInitial();

          // 🔔 Send notification for every fresh verification request
          // Parse ver_meta_data — may arrive as string (jsonb) or already as object
          const rawMeta = record.ver_meta_data;
          const meta = rawMeta
            ? (typeof rawMeta === 'string' ? (() => { try { return JSON.parse(rawMeta); } catch { return {}; } })() : rawMeta)
            : {};

          console.log('[VerifRealtime] ver_meta_data (parsed):', meta);

          setPendingRequests(prev => {
            const found = prev.find(p => p.ticket_id === record.id);
            const notifPayload = {
              ticket_id: record.id,
              username: found?.username ?? meta?.username ?? null,
              tamil_name: found?.tamil_name ?? meta?.tamil_name ?? null,
              user_id: found?.user_id ?? meta?.user_id ?? record.user_id ?? null,
              user_app_id: found?.user_app_id ?? meta?.user_app_id ?? null,
              fare: parseFloat(String(found?.fare ?? record.fare ?? 0)),
              from: found?.from ?? 'Unknown',
              to: found?.to ?? 'Unknown',
              requested_at: record.verification_requested_at ?? '',
            };
            console.log('[VerifRealtime] sending notification with payload:', notifPayload);
            sendVerificationNotification(notifPayload).catch((e: any) => {
              console.warn('[VerifRealtime] notification send failed:', e?.message);
            });
            return prev;
          });
        },
      )
      .subscribe((status: string, err?: Error) => {
        console.log('[VerifRealtime] channel status:', status, err ? `error: ${err.message}` : '');
      });

    channelRef.current = channel;
  }, [fetchInitial]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    setPendingRequests([]);
  }, []);

  useEffect(() => {
    const isActive = !!(
      tripId &&
      (tripStatus === 'running' || tripStatus === 'paused')
    );

    console.log('[VerifRealtime] main effect: tripId=', tripId, 'tripStatus=', tripStatus, 'isActive=', isActive);

    if (isActive) {
      fetchInitial();
      subscribe();
    } else {
      console.log('[VerifRealtime] not active — unsubscribing');
      unsubscribe();
    }

    return () => unsubscribe();
  }, [tripId, tripStatus, fetchInitial, subscribe, unsubscribe]);

  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      console.log('[VerifRealtime] AppState changed to:', nextState);
      if (nextState === 'active') {
        console.log('[VerifRealtime] app foregrounded — re-fetching and resubscribing');
        fetchInitial();
        subscribe();
      } else {
        if (channelRef.current) {
          console.log('[VerifRealtime] app backgrounded — removing channel');
          supabase.removeChannel(channelRef.current);
          channelRef.current = null;
        }
      }
    };

    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, [fetchInitial, subscribe]);

  useEffect(() => {
    const timer = setInterval(() => {
      const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      setPendingRequests(prev => {
        const filtered = prev.filter(p => !p.requested_at || p.requested_at >= tenMinsAgo);
        if (filtered.length !== prev.length) {
          console.log('[VerifRealtime] pruned stale requests:', prev.length - filtered.length, 'remaining:', filtered.length);
        }
        return filtered;
      });
    }, 30000);

    return () => clearInterval(timer);
  }, []);

  const clearTicket = useCallback((ticketId: string) => {
    setPendingRequests(prev =>
      prev.filter(p => p.ticket_id !== ticketId),
    );
  }, []);

  const dismissTicket = useCallback((ticketId: string) => {
    dismissedTicketsRef.current.add(ticketId);
    setPendingRequests(prev =>
      prev.filter(p => p.ticket_id !== ticketId),
    );
  }, []);

  return {pendingRequests, clearTicket, dismissTicket};
}

//
// 🔥 RESOLVE STOPS
//
async function resolveStops(rows: any[]) {
  const stopIds = [
    ...new Set(
      rows.flatMap(r => [r.from_stop_id, r.to_stop_id]).filter(Boolean),
    ),
  ];

  if (stopIds.length === 0) {
    console.log('[VerifRealtime] resolveStops: no stop IDs to resolve');
    return {};
  }

  console.log('[VerifRealtime] resolveStops: fetching', stopIds.length, 'stops');

  const {data, error} = await supabase
    .from('stops')
    .select('id, stop_name')
    .in('id', stopIds);

  if (error) {
    console.warn('[VerifRealtime] stop fetch error:', error.message);
    return {};
  }

  const map: Record<string, string> = {};
  (data || []).forEach(s => {
    map[s.id] = s.stop_name;
  });

  return map;
}

//
// 🔥 MAP ROWS
//
function parseVerMeta(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
}

function mapRows(
  rows: any[],
  stopMap: Record<string, string> = {},
): PendingTicket[] {
  return rows.map(r => {
    const meta = parseVerMeta(r.ver_meta_data);
    return {
      ticket_id: r.id,
      from: stopMap[r.from_stop_id] || 'Unknown',
      to: stopMap[r.to_stop_id] || 'Unknown',
      fare: parseFloat(r.fare ?? 0),
      is_free: (r.payment_method ?? '').toLowerCase() === 'fr',
      bus_number: '',
      requested_at: r.verification_requested_at ?? '',
      username: meta?.username ?? null,
      tamil_name: meta?.tamil_name ?? null,
      user_id: meta?.user_id ?? r.user_id ?? null,
      user_app_id: meta?.user_app_id ?? null,
      avatar_url: meta?.avatar_url ?? null,
    };
  });
}