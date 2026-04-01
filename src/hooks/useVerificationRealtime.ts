import {useEffect, useRef, useState, useCallback} from 'react';
import {AppState, AppStateStatus} from 'react-native';
import {supabase} from '../../lib/supabase';

export interface PendingTicket {
  ticket_id:    string;
  from:         string;
  to:           string;
  fare:         number;
  is_free:      boolean;
  bus_number:   string;
  requested_at: string;
}

export function useVerificationRealtime(
  tripId: string | null | undefined,
  tripStatus: string | null | undefined,
) {
  const [pendingRequests, setPendingRequests] = useState<PendingTicket[]>([]);
  const channelRef = useRef<any>(null);
  const tripIdRef = useRef(tripId);

  useEffect(() => {
    tripIdRef.current = tripId;
  }, [tripId]);

  // 🔥 FETCH INITIAL
  const fetchInitial = useCallback(async () => {
    const tid = tripIdRef.current;
    if (!tid) return;

    try {
      const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

      const {data, error} = await supabase
        .from('tickets')
        .select(`
          id,
          fare,
          payment_method,
          verification_requested_at,
          from_stop_id,
          to_stop_id
        `)
        .eq('trip_id', tid)
        .eq('is_verified', false)
        .not('verification_requested_at', 'is', null)
        .gte('verification_requested_at', twoMinsAgo)
        .order('verification_requested_at', {ascending: true});

      if (error) {
        console.warn('fetchInitial error:', error.message);
        return;
      }

      // ✅ resolve stop names
      const stopMap = await resolveStops(data || []);

      console.log('🧠 stopMap:', stopMap);

      const mapped = mapRows(data || [], stopMap);

      console.log('🧠 mapped:', mapped);

      setPendingRequests(mapped);
    } catch (e) {
      console.warn('fetchInitial exception', e);
    }
  }, []);

  // 🔥 REALTIME
  const subscribe = useCallback(() => {
    const tid = tripIdRef.current;
    if (!tid) return;

    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const channel = supabase
      .channel(`pending-verif-${tid}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tickets',
          filter: `trip_id=eq.${tid}`,
        },
        async (payload: any) => {
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
          const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
          const isRecent = record.verification_requested_at >= twoMinsAgo;

          if (isVerified || !hasRequest || !isRecent) {
            setPendingRequests(prev =>
              prev.filter(p => p.ticket_id !== record.id),
            );
            return;
          }

          // ✅ always re-fetch (with stopMap)
          await fetchInitial();
        },
      )
      .subscribe();

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

    if (isActive) {
      fetchInitial();
      subscribe();
    } else {
      unsubscribe();
    }

    return () => unsubscribe();
  }, [tripId, tripStatus, fetchInitial, subscribe, unsubscribe]);

  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        fetchInitial();
        subscribe();
      } else {
        if (channelRef.current) {
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
      const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      setPendingRequests(prev =>
        prev.filter(p => !p.requested_at || p.requested_at >= twoMinsAgo),
      );
    }, 30000);

    return () => clearInterval(timer);
  }, []);

  const clearTicket = useCallback((ticketId: string) => {
    setPendingRequests(prev =>
      prev.filter(p => p.ticket_id !== ticketId),
    );
  }, []);

  return {pendingRequests, clearTicket};
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

  if (stopIds.length === 0) return {};

  const {data, error} = await supabase
    .from('stops')
    .select('id, stop_name')
    .in('id', stopIds);

  if (error) {
    console.warn('stop fetch error:', error.message);
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
function mapRows(
  rows: any[],
  stopMap: Record<string, string> = {},
): PendingTicket[] {
  return rows.map(r => ({
    ticket_id: r.id,
    from: stopMap[r.from_stop_id] || 'Unknown',
    to: stopMap[r.to_stop_id] || 'Unknown',
    fare: parseFloat(r.fare ?? 0),
    is_free: (r.payment_method ?? '').toLowerCase() === 'fr',
    bus_number: '',
    requested_at: r.verification_requested_at ?? '',
  }));
}