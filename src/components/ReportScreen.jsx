import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator,
  FlatList, Animated, Alert, Platform, ToastAndroid, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Receipt, BarChart3, Download, Bus, Clock, Layers,
  RefreshCw, ArrowRight, FileText, Navigation,
} from 'lucide-react-native';
import api from '../api/api';
import { supabase } from '../../lib/supabase';
import { usePOSTickets } from '../hooks/usePOSTickets';
import { places } from '../utils/places';

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────
const showToast = (msg) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
};

const formatTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '—';

const formatDuration = (start, end) => {
  if (!start) return '—';
  const mins = Math.round(
    (((end ? new Date(end) : new Date()).getTime()) - new Date(start).getTime()) / 60000
  );
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stageCodeFromName = (name) => {
  if (!name || name === 'Unknown' || name === '?') return '???';
  const parts = name.split('-');
  for (const part of parts) {
    const t = part.trim();
    if (/^\d+$/.test(t)) return t.padStart(3, '0');
  }
  return parts[0].trim().slice(0, 3).toUpperCase();
};

const stageCode = (label) => {
  if (!label || label === '?' || UUID_RE.test(label.trim())) return '???';
  const parts = label.split('-');
  for (const part of parts) {
    const t = part.trim();
    if (/^\d+$/.test(t)) return t.padStart(3, '0');
  }
  return parts[0].trim().slice(0, 3).toUpperCase();
};

const isDownDirection = (dir) =>
  ['dn', 'down', 'return'].includes((dir ?? '').toLowerCase().trim());

const routeLabel = (name, dir) => {
  if (!name) return '';
  if (!isDownDirection(dir)) return name;
  const parts = name.split(/\s*(?:->|→|-)\s*/).map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? [...parts].reverse().join(' → ') : name;
};

const buildStageRows = (appBreakdown, posTix) => {
  const map = {};
  for (const rb of appBreakdown) {
    const ss = stageCodeFromName(rb.from);
    const es = stageCodeFromName(rb.to);
    if (ss === '???' && es === '???') continue;
    const k = `${ss}|||${es}`;
    if (!map[k]) map[k] = { ss, es, f: 0, h: 0, l: 0, p: 0, amt: 0 };
    map[k].f += Number(rb.full_count ?? 0) + Number(rb.free_count ?? 0);
    map[k].h += Number(rb.half_count ?? 0);
    map[k].amt += Number(rb.total_fare ?? rb.revenue ?? 0);
  }
  for (const t of posTix) {
    const ss = stageCode(t.from_stop);
    const es = stageCode(t.to_stop);
    if (ss === '???' && es === '???') continue;
    const k = `${ss}|||${es}`;
    if (!map[k]) map[k] = { ss, es, f: 0, h: 0, l: 0, p: 0, amt: 0 };
    const cnt = Number(t.ticket_count ?? 0);
    const hasLuggage = Number(t.luggage_amount ?? 0) > 0;
    const luggCnt = hasLuggage ? 1 : 0;
    const passCnt = Math.max(0, cnt - luggCnt);
    if (t.ticket_type === 'half') map[k].h += passCnt;
    else map[k].f += passCnt;
    map[k].l += luggCnt;
    map[k].amt += Number(t.fare ?? 0);
  }
  return Object.values(map).sort((a, b) => {
    const an = parseInt(a.ss, 10), bn = parseInt(b.ss, 10);
    if (isNaN(an) && isNaN(bn)) return a.ss.localeCompare(b.ss);
    if (isNaN(an)) return 1;
    if (isNaN(bn)) return -1;
    return an - bn;
  });
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const StatusPill = ({ status }) => {
  const cfg = {
    running:   { bg: 'bg-emerald-500/15 border border-emerald-500/30', text: 'text-emerald-400', dot: 'bg-emerald-400' },
    paused:    { bg: 'bg-amber-500/15 border border-amber-500/30',     text: 'text-amber-400',   dot: 'bg-amber-400'   },
    completed: { bg: 'bg-sky-500/15 border border-sky-500/30',         text: 'text-sky-400',     dot: 'bg-sky-400'     },
    cancelled: { bg: 'bg-red-500/15 border border-red-500/30',         text: 'text-red-400',     dot: 'bg-red-400'     },
  };
  const c = cfg[status] ?? { bg: 'bg-zinc-800', text: 'text-zinc-400', dot: 'bg-zinc-400' };
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${c.bg}`}>
      <View className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      <Text className={`text-[10px] font-bold tracking-wider ${c.text}`}>{label.toUpperCase()}</Text>
    </View>
  );
};

const StatChip = ({ label, value, color }) => (
  <View className="flex-1 items-center bg-zinc-800/60 rounded-xl py-3">
    <Text className={`text-base font-black ${color}`}>{value}</Text>
    <Text className="text-zinc-500 text-[9px] font-bold tracking-widest mt-0.5">{label}</Text>
  </View>
);

// Stage table — shared between both tabs
const StageTable = ({ rows }) => {
  if (rows.length === 0)
    return <Text className="text-zinc-600 text-xs text-center py-4">No stage data available</Text>;
  return (
    <View className="rounded-xl overflow-hidden border border-zinc-800 mt-3">
      {/* Header */}
      <View className="flex-row bg-zinc-800 px-3 py-2">
        {['SS', 'ES', 'F', 'H', 'L', 'P', 'AMT'].map((h, i) => (
          <Text
            key={i}
            className="text-zinc-400 text-[10px] font-black tracking-widest"
            style={{ flex: i === 6 ? 2 : 1, textAlign: i === 6 ? 'right' : 'center' }}
          >
            {h}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View
          key={i}
          className={`flex-row items-center px-3 py-2.5 border-t border-zinc-800/60 ${i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-900/40'}`}
        >
          <Text className="text-zinc-300 text-xs font-bold" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>{r.ss}</Text>
          <Text className="text-zinc-300 text-xs font-bold" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>{r.es}</Text>
          <Text className="text-zinc-400 text-xs" style={{ flex: 1, textAlign: 'center' }}>{r.f > 0 ? r.f : '—'}</Text>
          <Text className="text-zinc-400 text-xs" style={{ flex: 1, textAlign: 'center' }}>{r.h > 0 ? r.h : '—'}</Text>
          <Text className="text-zinc-400 text-xs" style={{ flex: 1, textAlign: 'center' }}>{r.l > 0 ? r.l : '0'}</Text>
          <Text className="text-zinc-500 text-xs" style={{ flex: 1, textAlign: 'center' }}>0</Text>
          <Text className="text-sky-400 text-xs font-bold" style={{ flex: 2, textAlign: 'right' }}>₹{Number(r.amt).toFixed(0)}</Text>
        </View>
      ))}
    </View>
  );
};

// ─── Trip Sheet Tab ───────────────────────────────────────────────────────────
const TripSheetTab = ({
  dashboard,
  posHook,
  refreshing,
  onRefresh,
}) => {
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [report, setReport] = useState(null);
  const [appTrip, setAppTrip] = useState(null);
  const [loading, setLoading] = useState(false);

  const STORAGE_KEY_TRIP = 'report_selected_trip_id';

  const at = dashboard?.active_trip;
  const recentTrips = dashboard?.recent_trips ?? [];

  // Build trip list: active first, then recent
  const trips = [
    ...(at?.trip_id ? [{ ...at, isActive: true }] : []),
    ...recentTrips.filter((t) => t.trip_id !== at?.trip_id).map((t) => ({ ...t, isActive: false })),
  ];

  // Load saved trip ID on mount
  useEffect(() => {
    const loadSavedTrip = async () => {
      try {
        const savedTripId = await AsyncStorage.getItem(STORAGE_KEY_TRIP);
        if (savedTripId) {
          setSelectedTripId(savedTripId);
        }
      } catch (e) {
        console.error('Failed to load saved trip:', e);
      }
    };
    loadSavedTrip();
  }, []);

  // Auto-select latest trip when no trip is selected and dashboard is available
  useEffect(() => {
    if (selectedTripId === null && trips.length > 0) {
      // Auto-select latest trip: active trip if available, else most recent
      if (at?.trip_id) {
        setSelectedTripId(at.trip_id);
      } else {
        setSelectedTripId(trips[0].trip_id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at?.trip_id, trips]);

  // Save selected trip ID to AsyncStorage whenever it changes
  useEffect(() => {
    if (selectedTripId) {
      AsyncStorage.setItem(STORAGE_KEY_TRIP, selectedTripId);
    }
  }, [selectedTripId]);

  useEffect(() => {
    if (!selectedTripId) { setReport(null); setAppTrip(null); return; }
    setReport(null); setAppTrip(null);
    setLoading(true);
    (async () => {
      try {
        const r = await api.get(`/conductor/trip/${selectedTripId}/report`);
        setReport(r.data);
      } catch { Alert.alert('Error', 'Could not load trip report'); }

      try {
        const { data: rows, error } = await supabase
          .from('tickets')
          .select('ticket_type,payment_method,ticket_count,total_fare,fare,from_stop_id,to_stop_id,luggage_amount')
          .eq('trip_id', selectedTripId)
          .neq('payment_method', 'pos');
        if (error) throw error;

        const stopIds = [...new Set((rows ?? []).flatMap((r) => [r.from_stop_id, r.to_stop_id].filter(Boolean)))];
        const stopMap = {};
        if (stopIds.length) {
          const { data: stops } = await supabase.from('stops').select('id,stop_name').in('id', stopIds);
          (stops ?? []).forEach((s) => { stopMap[String(s.id)] = s.stop_name; });
        }

        const map = {};
        let full = 0, half = 0, free = 0, tickets = 0, collection = 0;
        for (const r of (rows ?? [])) {
          const cnt = Number(r.ticket_count ?? 1);
          const pm = String(r.payment_method ?? '').toLowerCase();
          const tt = r.ticket_type ?? 'full';
          const unit = Number(r.fare ?? 0);
          const total = r.total_fare != null ? Number(r.total_fare) : unit * cnt;
          const fromName = stopMap[String(r.from_stop_id)] ?? 'Unknown';
          const toName = stopMap[String(r.to_stop_id)] ?? 'Unknown';
          const ss = stageCodeFromName(fromName);
          const es = stageCodeFromName(toName);
          const k = `${ss}|||${es}`;
          if (!map[k]) map[k] = { from: fromName, to: toName, full_count: 0, half_count: 0, free_count: 0, total_fare: 0 };
          const isFree = pm === 'fr';
          if (isFree) { map[k].free_count += cnt; free += cnt; }
          else if (tt === 'half') { map[k].half_count += cnt; half += cnt; }
          else { map[k].full_count += cnt; full += cnt; }
          map[k].total_fare += total;
          tickets += cnt; collection += total;
        }
        setAppTrip({ tickets, collection, full, half, free, breakdown: Object.values(map) });
      } catch {
        setAppTrip({ tickets: 0, collection: 0, full: 0, half: 0, free: 0, breakdown: [] });
      } finally { setLoading(false); }
    })();
  }, [selectedTripId]);

  const posTix = (posHook?.tickets ?? []).filter((t) => t.trip_id === selectedTripId);
  const appBreakdown = appTrip?.breakdown?.length ? appTrip.breakdown : (report?.route_breakdown ?? []);
  const stageRows = buildStageRows(appBreakdown, posTix);
  const grandFull = stageRows.reduce((s, r) => s + r.f, 0);
  const grandHalf = stageRows.reduce((s, r) => s + r.h, 0);
  const grandCollection = stageRows.reduce((s, r) => s + r.amt, 0);
  const posTotal = posTix.reduce((s, t) => s + t.fare, 0);
  const appTotal = Number(appTrip?.collection ?? 0);
  const combinedTotal = appTotal + posTotal;

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#0ea5e9"
          colors={['#0ea5e9']}
        />
      }
    >
      {/* Trip selector */}
      <Text className="text-zinc-500 text-[10px] font-bold tracking-widest mb-3">SELECT TRIP</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-5">
        <View className="flex-row gap-2">
          {trips.length === 0 && (
            <View className="bg-zinc-900 border border-zinc-800 rounded-2xl px-5 py-3">
              <Text className="text-zinc-500 text-sm">No trips found</Text>
            </View>
          )}
          {trips.map((trip) => {
            const isSelected = selectedTripId === trip.trip_id;
            return (
              <TouchableOpacity
                key={trip.trip_id}
                onPress={() => setSelectedTripId(isSelected ? null : trip.trip_id)}
                activeOpacity={0.75}
                className={`rounded-2xl px-4 py-3 border ${
                  isSelected
                    ? 'bg-sky-500 border-sky-400'
                    : 'bg-zinc-900 border-zinc-800'
                }`}
                style={{ minWidth: 110 }}
              >
                {trip.isActive && (
                  <View className="flex-row items-center gap-1 mb-1">
                    <View className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <Text className={`text-[9px] font-black tracking-widest ${isSelected ? 'text-sky-100' : 'text-emerald-400'}`}>ACTIVE</Text>
                  </View>
                )}
                <Text className={`text-sm font-black ${isSelected ? 'text-white' : 'text-zinc-200'}`}>
                  {trip.trip_number ? `Trip #${trip.trip_number}` : 'No #'}
                </Text>
                <Text className={`text-[10px] mt-0.5 ${isSelected ? 'text-sky-100' : 'text-zinc-500'}`} numberOfLines={1}>
                  {routeLabel(trip.route_name, trip.direction)?.split(' ')[0] ?? '—'}
                </Text>
                <Text className={`text-[10px] mt-0.5 ${isSelected ? 'text-sky-100' : 'text-zinc-600'}`}>
                  {formatTime(trip.start_time)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      {/* Empty state */}
      {!selectedTripId && (
        <View className="items-center justify-center py-16 gap-3">
          <View className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 items-center justify-center">
            <Receipt size={28} color="#3f3f46" />
          </View>
          <Text className="text-zinc-500 text-sm font-semibold">Select a trip above</Text>
          <Text className="text-zinc-700 text-xs">Trip sheet will appear here</Text>
        </View>
      )}

      {/* Loading */}
      {selectedTripId && loading && (
        <View className="items-center py-16 gap-3">
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text className="text-zinc-500 text-sm">Loading trip data…</Text>
        </View>
      )}

      {/* Report card */}
      {selectedTripId && !loading && report && (
        <View className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden">
          {/* Header band */}
          <View className="bg-sky-500/10 border-b border-sky-500/20 px-5 py-4">
            <View className="flex-row items-start justify-between">
              <View className="flex-1 mr-3">
                <Text className="text-zinc-500 text-[9px] font-black tracking-widest mb-1">TRIP SHEET</Text>
                <Text className="text-white text-xl font-black leading-tight">
                  {routeLabel(report.route_name, report.direction)}
                </Text>
              </View>
              <StatusPill status={report.status ?? 'completed'} />
            </View>

            {/* Meta row */}
            <View className="flex-row flex-wrap gap-x-4 gap-y-1 mt-3">
              <View className="flex-row items-center gap-1">
                <Bus size={11} color="#71717a" />
                <Text className="text-zinc-400 text-xs">{report.bus_number ?? 'N/A'}</Text>
              </View>
              <View className="flex-row items-center gap-1">
                <Clock size={11} color="#71717a" />
                <Text className="text-zinc-400 text-xs">{formatTime(report.start_time)}</Text>
              </View>
              <View className="flex-row items-center gap-1">
                <Layers size={11} color="#71717a" />
                <Text className="text-zinc-400 text-xs">
                  {report.trip_number ? `#${report.trip_number}` : '—'}
                </Text>
              </View>
              <View className="flex-row items-center gap-1">
                <FileText size={11} color="#71717a" />
                <Text className="text-zinc-400 text-xs">WB: {report.way_bill_number ?? report.waybill ?? '—'}</Text>
              </View>
            </View>
          </View>

          {/* Stats */}
          <View className="flex-row gap-2 p-4">
            <StatChip label="FULL" value={grandFull} color="text-white" />
            {grandHalf > 0 && <StatChip label="HALF" value={grandHalf} color="text-amber-400" />}
            <StatChip label="APP" value={`₹${appTotal.toFixed(0)}`} color="text-sky-400" />
            {posTotal > 0 && <StatChip label="POS" value={`₹${posTotal.toFixed(0)}`} color="text-violet-400" />}
            <StatChip label="TOTAL" value={`₹${combinedTotal.toFixed(0)}`} color="text-emerald-400" />
          </View>

          {/* Stage table */}
          <View className="px-4 pb-4">
            <View className="flex-row items-center gap-2 mb-1">
              <BarChart3 size={13} color="#71717a" />
              <Text className="text-zinc-500 text-[10px] font-bold tracking-widest">STAGE BREAKDOWN</Text>
            </View>
            <StageTable rows={stageRows} />

            {/* Grand total */}
            <View className="flex-row justify-between items-center bg-sky-500/10 border border-sky-500/20 rounded-xl px-4 py-3 mt-3">
              <Text className="text-zinc-300 text-sm font-bold">TRP TOTAL</Text>
              <Text className="text-sky-400 text-xl font-black">₹{grandCollection.toFixed(2)}</Text>
            </View>
          </View>

          {/* Save PDF button */}
          <TouchableOpacity
            className="mx-4 mb-4 flex-row items-center justify-center gap-2 bg-sky-500 rounded-xl py-3.5"
            activeOpacity={0.8}
            onPress={() => showToast('PDF export — wire up generatePDF here')}
          >
            <Download size={16} color="#fff" />
            <Text className="text-white text-sm font-bold">Save Trip Sheet PDF</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
};

// ─── Status Report Tab ────────────────────────────────────────────────────────
const StatusReportTab = ({ dashboard, posHook, refreshing, onRefresh }) => {
  const [selStart, setSelStart] = useState(null);
  const [selDest, setSelDest] = useState(null);
  const [activeDrop, setActiveDrop] = useState(null);
  const [filtering, setFiltering] = useState(false);
  const [filteredData, setFilteredData] = useState(null);

  const STORAGE_KEY_START = 'report_start_place';
  const STORAGE_KEY_DEST = 'report_dest_place';

  useEffect(() => {
    const loadSavedPlaces = async () => {
      try {
        const startData = await AsyncStorage.getItem(STORAGE_KEY_START);
        const destData = await AsyncStorage.getItem(STORAGE_KEY_DEST);
        if (startData) setSelStart(JSON.parse(startData));
        if (destData) setSelDest(JSON.parse(destData));
      } catch (e) {
        console.error('Failed to load saved places:', e);
      }
    };
    loadSavedPlaces();
  }, []);

  useEffect(() => {
    if (selStart) AsyncStorage.setItem(STORAGE_KEY_START, JSON.stringify(selStart));
  }, [selStart]);

  useEffect(() => {
    if (selDest) AsyncStorage.setItem(STORAGE_KEY_DEST, JSON.stringify(selDest));
  }, [selDest]);

  useEffect(() => {
    if (selStart && selDest) {
      filterTickets();
    } else {
      setFilteredData(null);
    }
  }, [selStart, selDest]);

  const filterTickets = useCallback(async () => {
    if (!selStart || !selDest) return;
    setFiltering(true);
    try {
      const recentTrips = dashboard?.recent_trips ?? [];
      const at = dashboard?.active_trip;
      const todayStr = new Date().toDateString();
  // ← ADD THIS
    console.log('[DEBUG] dashboard active_trip:', at);
    console.log('[DEBUG] recentTrips:', recentTrips.map(t => ({ id: t.trip_id, start: t.start_time })));
    console.log('[DEBUG] todayStr:', todayStr);
     const todayTripIds = [
  ...(at?.trip_id ? [at.trip_id] : []),
  ...recentTrips
    .filter((t) => {
      if (!t.start_time) return false;
      // Convert UTC to local time before comparing date string
      const localDate = new Date(t.start_time).toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: 'short', day: 'numeric',
      });
      const todayLocal = new Date().toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: 'short', day: 'numeric',
      });
      return localDate === todayLocal;
    })
    .map((t) => t.trip_id),
];
      const uniqueTripIds = [...new Set(todayTripIds)];
 console.log('[DEBUG] uniqueTripIds:', uniqueTripIds);
      // Fetch all app tickets for today's trips from supabase directly
      let allAppRows = [];
      if (uniqueTripIds.length > 0) {
        const { data: rows, error } = await supabase
          .from('tickets')
          .select('ticket_type,payment_method,ticket_count,total_fare,fare,from_stop_id,to_stop_id,luggage_amount')
          .in('trip_id', uniqueTripIds)
          .neq('payment_method', 'pos');

        if (!error && rows) {
          // Resolve stop names
          const stopIds = [...new Set(rows.flatMap((r) => [r.from_stop_id, r.to_stop_id].filter(Boolean)))];
          const stopMap = {};
          if (stopIds.length) {
            const { data: stops } = await supabase.from('stops').select('id,stop_name').in('id', stopIds);
            (stops ?? []).forEach((s) => { stopMap[String(s.id)] = s.stop_name; });
          }
          allAppRows = rows.map((r) => ({
            ...r,
            from_name: stopMap[String(r.from_stop_id)] ?? 'Unknown',
            to_name: stopMap[String(r.to_stop_id)] ?? 'Unknown',
          }));
          console.log('[DEBUG] allAppRows sample:', allAppRows.slice(0, 5).map(r => ({
  from_name: r.from_name,
  to_name: r.to_name,
  fromCode: parseInt(stageCodeFromName(r.from_name), 10),
  toCode: parseInt(stageCodeFromName(r.to_name), 10),
})));
        }
      }

      // Get POS tickets for today's trips
      const allPosTix = (posHook?.tickets ?? []).filter((t) =>
        uniqueTripIds.includes(t.trip_id)
      );

      // Match selected place labels to stop names
      // places labels are like "key-stageNum-StopName"
      const startNum = parseInt(selStart.label.split('-')[1]?.trim(), 10);
      const destNum = parseInt(selDest.label.split('-')[1]?.trim(), 10);

      // Create range for filtering (inclusive)
      const rangeStart = Math.min(startNum, destNum);
      const rangeEnd = Math.max(startNum, destNum);

      // Filter app tickets: range-based filtering (tickets that pass through any stage in range)
     const filteredAppRows = allAppRows.filter((r) => {
  const fromCode = parseInt(stageCodeFromName(r.from_name), 10);
  const toCode = parseInt(stageCodeFromName(r.to_name), 10);
  if (isNaN(fromCode) || isNaN(toCode)) return false;
  return fromCode >= rangeStart && fromCode <= rangeEnd &&
         toCode >= rangeStart && toCode <= rangeEnd;
});

      // Build app breakdown for filtered rows
      const appBreakdown = [];
      const breakdownMap = {};
      for (const r of filteredAppRows) {
        const cnt = Number(r.ticket_count ?? 1);
        const pm = String(r.payment_method ?? '').toLowerCase();
        const tt = r.ticket_type ?? 'full';
        const unit = Number(r.fare ?? 0);
        const total = r.total_fare != null ? Number(r.total_fare) : unit * cnt;
        const k = `${r.from_name}|||${r.to_name}`;
        if (!breakdownMap[k]) {
          breakdownMap[k] = { from: r.from_name, to: r.to_name, full_count: 0, half_count: 0, free_count: 0, total_fare: 0 };
          appBreakdown.push(breakdownMap[k]);
        }
        const isFree = pm === 'fr';
        if (isFree) breakdownMap[k].free_count += cnt;
        else if (tt === 'half') breakdownMap[k].half_count += cnt;
        else breakdownMap[k].full_count += cnt;
        breakdownMap[k].total_fare += total;
      }

      // Filter POS tickets by range
      // POS tickets
const filteredPosTix = allPosTix.filter((t) => {
  const fromCode = parseInt(stageCode(t.from_stop), 10);
  const toCode = parseInt(stageCode(t.to_stop), 10);
  if (isNaN(fromCode) || isNaN(toCode)) return false;
  return fromCode >= rangeStart && fromCode <= rangeEnd &&
         toCode >= rangeStart && toCode <= rangeEnd;
});

      const stageRows = buildStageRows(appBreakdown, filteredPosTix);
      const grandFull = stageRows.reduce((s, r) => s + r.f, 0);
      const grandHalf = stageRows.reduce((s, r) => s + r.h, 0);
      const grandCollection = stageRows.reduce((s, r) => s + r.amt, 0);
      const totalTickets = grandFull + grandHalf;

      setFilteredData({ stageRows, grandFull, grandHalf, grandCollection, totalTickets });
    } catch (e) {
      console.error('Error filtering tickets:', e);
      setFilteredData(null);
    } finally {
      setFiltering(false);
    }
  }, [selStart, selDest, dashboard, posHook]);

  const getPlaces = () => places;

  const getDisplayName = (place) => {
    if (!place) return '';
    const parts = place.label.split('-');
    return parts.slice(2).join(' ') || parts.slice(1).join(' ') || place.label;
  };

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#0ea5e9"
          colors={['#0ea5e9']}
        />
      }
    >
      <Text className="text-zinc-500 text-[10px] font-bold tracking-widest mb-3">SELECT ROUTE</Text>

      {/* Place selector bar */}
      <View className="flex-row items-center bg-zinc-900 rounded-2xl p-3 mb-4 border border-zinc-800">
        <TouchableOpacity
          className="flex-1 flex-row items-center gap-2"
          onPress={() => setActiveDrop(activeDrop === 'start' ? null : 'start')}
          activeOpacity={0.8}
        >
          <Navigation size={15} color="#71717a" />
          <View className="flex-1">
            <Text className="text-zinc-500 text-[10px] font-bold">Start Place</Text>
            <Text className="text-white text-sm font-bold" numberOfLines={1}>
              {selStart ? getDisplayName(selStart) : 'Select start'}
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          className="w-10 h-10 rounded-full bg-zinc-800 border border-zinc-700 items-center justify-center mx-2"
          onPress={() => {
            if (selStart && selDest) {
              const t = selStart;
              setSelStart(selDest);
              setSelDest(t);
            }
          }}
          disabled={!selStart || !selDest}
        >
          <ArrowRight size={16} color={!selStart || !selDest ? '#52525b' : '#a1a1aa'} />
        </TouchableOpacity>

        <TouchableOpacity
          className="flex-1 flex-row items-center gap-2"
          onPress={() => setActiveDrop(activeDrop === 'destination' ? null : 'destination')}
          activeOpacity={0.8}
        >
          <Navigation size={15} color="#71717a" />
          <View className="flex-1">
            <Text className="text-zinc-500 text-[10px] font-bold">End Place</Text>
            <Text className="text-white text-sm font-bold" numberOfLines={1}>
              {selDest ? getDisplayName(selDest) : 'Select destination'}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Start dropdown */}
      {activeDrop === 'start' && (
        <View className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden mb-4">
          {getPlaces().map((p) => {
            const isSelected = selStart?.key === p.key;
            const isDisabled = selDest?.key === p.key;
            return (
              <TouchableOpacity
                key={`s-${p.key}`}
                className={`px-4 py-3 border-b border-zinc-800 ${isSelected ? 'bg-sky-500/20' : 'bg-zinc-900'} ${isDisabled ? 'opacity-50' : ''}`}
                onPress={() => { setSelStart(p); setActiveDrop('destination'); }}
                disabled={isDisabled}
                activeOpacity={0.8}
              >
                <Text className={`text-sm font-bold ${isSelected ? 'text-sky-400' : 'text-zinc-200'}`}>
                  {p.label.split('-')[1]} {p.label.split('-')[2]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Destination dropdown */}
      {activeDrop === 'destination' && (
        <View className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden mb-4">
          {getPlaces().map((p) => {
            const isSelected = selDest?.key === p.key;
            const isDisabled = selStart?.key === p.key;
            return (
              <TouchableOpacity
                key={`d-${p.key}`}
                className={`px-4 py-3 border-b border-zinc-800 ${isSelected ? 'bg-sky-500/20' : 'bg-zinc-900'} ${isDisabled ? 'opacity-50' : ''}`}
                onPress={() => { setSelDest(p); setActiveDrop(null); }}
                disabled={isDisabled}
                activeOpacity={0.8}
              >
                <Text className={`text-sm font-bold ${isSelected ? 'text-sky-400' : 'text-zinc-200'}`}>
                  {p.label.split('-')[1]} {p.label.split('-')[2]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Results */}
      {selStart && selDest && (
        <>
          {filtering && (
            <View className="items-center py-8 gap-3">
              <ActivityIndicator size="large" color="#0ea5e9" />
              <Text className="text-zinc-500 text-sm">Filtering tickets…</Text>
            </View>
          )}

          {!filtering && filteredData && filteredData.stageRows.length > 0 && (
            <View className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden">
              <View className="bg-sky-500/10 border-b border-sky-500/20 px-4 py-3">
                <View className="flex-row items-center gap-2 mb-2">
                  <FileText size={16} color="#0ea5e9" />
                  <Text className="text-zinc-500 text-[10px] font-bold tracking-widest">FILTERED STAGE REPORT</Text>
                </View>
                <View className="flex-row items-center justify-between">
                  <View>
                    <Text className="text-zinc-400 text-[10px]">From</Text>
                    <Text className="text-white text-sm font-bold">{getDisplayName(selStart)}</Text>
                  </View>
                  <ArrowRight size={18} color="#71717a" />
                  <View className="items-end">
                    <Text className="text-zinc-400 text-[10px]">To</Text>
                    <Text className="text-white text-sm font-bold">{getDisplayName(selDest)}</Text>
                  </View>
                </View>
              </View>

              <View className="flex-row gap-2 p-4">
                <StatChip label="TICKETS" value={filteredData.totalTickets} color="text-white" />
                <StatChip label="FULL" value={filteredData.grandFull} color="text-white" />
                {filteredData.grandHalf > 0 && (
                  <StatChip label="HALF" value={filteredData.grandHalf} color="text-amber-400" />
                )}
                <StatChip label="TOTAL" value={`₹${filteredData.grandCollection.toFixed(0)}`} color="text-emerald-400" />
              </View>

              <View className="px-4 pb-4">
                <StageTable rows={filteredData.stageRows} />
              </View>
            </View>
          )}

          {!filtering && (!filteredData || filteredData.stageRows.length === 0) && (
            <View className="bg-zinc-900 rounded-2xl border border-zinc-800 p-8 items-center gap-2">
              <FileText size={28} color="#3f3f46" />
              <Text className="text-zinc-500 text-sm font-semibold">No tickets found</Text>
              <Text className="text-zinc-700 text-xs">No tickets issued between these stages today</Text>
            </View>
          )}
        </>
      )}

      {!selStart && !selDest && (
        <View className="items-center justify-center py-16 gap-3">
          <View className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 items-center justify-center">
            <BarChart3 size={28} color="#3f3f46" />
          </View>
          <Text className="text-zinc-500 text-sm font-semibold">Select a route above</Text>
          <Text className="text-zinc-700 text-xs">Filtered stage report will appear here</Text>
        </View>
      )}
    </ScrollView>
  );
};

// ─── Main Report Screen ───────────────────────────────────────────────────────
const ReportScreen = () => {
  const [activeTab, setActiveTab] = useState('tripsheet');
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const posHook = usePOSTickets();
  const indicatorAnim = useRef(new Animated.Value(0)).current;

  const TABS = [
    { key: 'tripsheet', label: 'Trip Sheet',     Icon: Receipt   },
    { key: 'status',    label: 'Status Report',  Icon: BarChart3 },
  ];

  const fetchDashboard = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const r = await api.get('/conductor/dashboard');
      setDashboard(r.data);
    } catch (e) {
      console.error('[ReportScreen] dashboard fetch failed', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchDashboard(true);
      await posHook.reload();
    } catch (e) {
      console.error('[ReportScreen] Refresh failed:', e);
    } finally {
      setRefreshing(false);
    }
  }, [fetchDashboard, posHook]);

  useEffect(() => { fetchDashboard(); }, []);

  // Reload POS tickets when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      posHook.reload();
    }, [posHook])
  );

  // Animate tab indicator
  useEffect(() => {
    Animated.spring(indicatorAnim, {
      toValue: activeTab === 'tripsheet' ? 0 : 1,
      useNativeDriver: false,
      tension: 80,
      friction: 12,
    }).start();
  }, [activeTab]);

  const at = dashboard?.active_trip;
  const posSummary = posHook.todaySummary();

  if (loading) {
    return (
      <View className="flex-1 bg-zinc-950 justify-center items-center">
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text className="text-zinc-500 mt-3 text-sm">Loading reports…</Text>
      </View>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-zinc-950">
      {/* ── Top bar ── */}
      <View className="px-5 pt-2 pb-3 flex-row items-center justify-between border-b border-zinc-900">
        <View>
          <Text className="text-white text-xl font-black tracking-tight">Reports</Text>
          <Text className="text-zinc-500 text-xs mt-0.5">
            {at?.trip_number ? `Active Trip #${at.trip_number} · ` : ''}
            {new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => fetchDashboard(true)}
          disabled={refreshing}
          className="w-9 h-9 rounded-full bg-zinc-900 border border-zinc-800 items-center justify-center"
        >
          {refreshing
            ? <ActivityIndicator size="small" color="#71717a" />
            : <RefreshCw size={15} color="#71717a" />}
        </TouchableOpacity>
      </View>

      {/* ── Summary chips ── */}
      <View className="flex-row gap-2 px-4 py-3">
        {[
          { label: 'Trips',       val: (dashboard?.recent_trips?.length ?? 0), color: 'text-sky-400',     bg: 'bg-sky-500/10 border-sky-500/20' },
          { label: 'App Tickets', val: (dashboard?.today_stats?.tickets_sold ?? 0), color: 'text-violet-400', bg: 'bg-violet-500/10 border-violet-500/20' },
          { label: 'POS',         val: posSummary.count,  color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20'  },
          { label: 'Today',       val: `₹${((dashboard?.today_stats?.total_collection ?? 0) + posSummary.total).toFixed(0)}`, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
        ].map(c => (
          <View key={c.label} className={`flex-1 items-center rounded-xl py-2.5 border ${c.bg}`}>
            <Text className={`text-sm font-black ${c.color}`}>{c.val}</Text>
            <Text className="text-zinc-600 text-[9px] font-bold tracking-wider mt-0.5">{c.label.toUpperCase()}</Text>
          </View>
        ))}
      </View>

      {/* ── Tab bar ── */}
      <View className="mx-4 mb-2 bg-zinc-900 rounded-2xl p-1 flex-row border border-zinc-800">
        {TABS.map((tab, i) => {
          const isActive = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.8}
              className={`flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-xl ${isActive ? 'bg-sky-500' : ''}`}
            >
              <tab.Icon size={14} color={isActive ? '#fff' : '#71717a'} />
              <Text className={`text-sm font-bold ${isActive ? 'text-white' : 'text-zinc-500'}`}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Content ── */}
      <View className="flex-1">
        {activeTab === 'tripsheet' && (
          <TripSheetTab dashboard={dashboard} posHook={posHook} refreshing={refreshing} onRefresh={onRefresh} />
        )}
        {activeTab === 'status' && (
          <StatusReportTab dashboard={dashboard} posHook={posHook} refreshing={refreshing} onRefresh={onRefresh} />
        )}
      </View>
    </SafeAreaView>
  );
};

export default ReportScreen;