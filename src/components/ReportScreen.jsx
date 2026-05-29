import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  FlatList,
  Animated,
  Alert,
  Platform,
  ToastAndroid,
  RefreshControl,
  TextInput,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Receipt,
  BarChart3,
  Download,
  Bus,
  Clock,
  Layers,
  RefreshCw,
  ArrowRight,
  FileText,
  Navigation,
  DollarSign,
} from 'lucide-react-native';
import { supabase } from '../../lib/supabase';
import { useTripContext } from '../context/TripContext';
import { places } from '../utils/places';

// ─── NYX imports (Android only) ───────────────────────────────────────────────
let NyxPrinter = null;
let PrinterStatus = null;
let PrintAlign = null;

if (Platform.OS === 'android') {
  const nyx = require('nyx-printer-react-native');
  NyxPrinter = nyx.default;
  PrinterStatus = nyx.PrinterStatus;
  PrintAlign = nyx.PrintAlign;
}

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────
const showToast = msg => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
};

const formatTime = iso =>
  iso
    ? new Date(iso).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const formatDate = iso =>
  iso
    ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' })
    : '—';

const formatDuration = (start, end) => {
  if (!start) return '—';
  const mins = Math.round(
    ((end ? new Date(end) : new Date()).getTime() - new Date(start).getTime()) /
      60000,
  );
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stageCodeFromName = name => {
  if (!name || name === 'Unknown' || name === '?') return '???';
  const parts = name.split('-');
  for (const part of parts) {
    const t = part.trim();
    if (/^\d+$/.test(t)) return t.padStart(3, '0');
  }
  return parts[0].trim().slice(0, 3).toUpperCase();
};

const stageCode = label => {
  if (!label || label === '?' || UUID_RE.test(label.trim())) return '???';
  const parts = label.split('-');
  for (const part of parts) {
    const t = part.trim();
    if (/^\d+$/.test(t)) return t.padStart(3, '0');
  }
  return parts[0].trim().slice(0, 3).toUpperCase();
};

const isDownDirection = dir =>
  ['dn', 'down', 'return'].includes((dir ?? '').toLowerCase().trim());

const routeLabel = (name, dir) => {
  if (!name) return '';
  if (!isDownDirection(dir)) return name;
  const parts = name
    .split(/\s*(?:->|→|-)\s*/)
    .map(p => p.trim())
    .filter(Boolean);
  return parts.length >= 2 ? [...parts].reverse().join(' → ') : name;
};

const RESET_REPORT_CUTOFF_KEY = 'trip_report_reset_after_iso';

const isOnOrAfterCutoff = (iso, cutoffIso) => {
  if (!iso) return false;
  if (!cutoffIso) return true;
  const t = new Date(iso).getTime();
  const c = new Date(cutoffIso).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(c)) return true;
  return t >= c;
};

const buildStageRows = (appBreakdown, posTix) => {
  const map = {};
  for (const rb of appBreakdown) {
    const ss = stageCodeFromName(rb.from);
    const es = stageCodeFromName(rb.to);
    if (ss === '???' && es === '???') continue;
    const k = `${ss}|||${es}`;
    if (!map[k]) map[k] = { ss, es, f: 0, h: 0, l: 0, p: 0, amt: 0, app: 0 };
    const appF = Number(rb.full_count ?? 0) + Number(rb.free_count ?? 0);
    const appH = Number(rb.half_count ?? 0);
    map[k].f += appF;
    map[k].h += appH;
    map[k].app += appF + appH;
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
    map[k].amt += Number(t.fare || 0);
  }
  return Object.values(map).sort((a, b) => {
    const an = parseInt(a.ss, 10),
      bn = parseInt(b.ss, 10);
    if (isNaN(an) && isNaN(bn)) return a.ss.localeCompare(b.ss);
    if (isNaN(an)) return 1;
    if (isNaN(bn)) return -1;
    return an - bn;
  });
};

const jwtDecodePayload = token => {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const std = padded.replace(/-/g, '+').replace(/_/g, '/');
    let bytes = '';
    for (let i = 0; i < std.length; i += 4) {
      const c0 = chars.indexOf(std[i]);
      const c1 = chars.indexOf(std[i + 1]);
      const c2 = chars.indexOf(std[i + 2]);
      const c3 = chars.indexOf(std[i + 3]);
      bytes += String.fromCharCode((c0 << 2) | (c1 >> 4));
      if (std[i + 2] !== '=') bytes += String.fromCharCode(((c1 & 15) << 4) | (c2 >> 2));
      if (std[i + 3] !== '=') bytes += String.fromCharCode(((c2 & 3) << 6) | c3);
    }
    return JSON.parse(bytes);
  } catch {
    return null;
  }
};

const getConductorIdFromStorage = async () => {
  try {
    const raw = await AsyncStorage.getItem('conductor_user');
    const stored = raw ? JSON.parse(raw) : null;
    const direct = stored?.id ?? stored?.user_id ?? stored?.conductor_id ?? stored?.user?.id ?? null;
    if (direct) return String(direct);

    const token = stored?.access_token ?? await AsyncStorage.getItem('access_token');
    const payload = token ? jwtDecodePayload(token) : null;
    const fromToken = payload?.sub ?? payload?.user_id ?? payload?.id ?? null;
    return fromToken ? String(fromToken) : null;
  } catch {
    return null;
  }
};

const fetchDashboardFromSupabase = async () => {
  const conductorId = await getConductorIdFromStorage();
  if (!conductorId) throw new Error('No conductor session');

  const now = Date.now();
  const since24hIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [activeRes, recentRes, todayTripsRes] = await Promise.all([
    supabase
      .from('trips')
      .select(
        'id,bus_id,route_id,conductor_id,direction,start_time,expected_end_time,status,trip_number',
      )
      .eq('conductor_id', conductorId)
      .in('status', ['scheduled', 'running', 'paused'])
      .order('start_time', { ascending: false })
      .limit(1),
    supabase
      .from('trips')
      .select(
        'id,bus_id,route_id,direction,start_time,expected_end_time,status,trip_number',
      )
      .eq('conductor_id', conductorId)
      .gte('start_time', since24hIso)
      .order('start_time', { ascending: false })
      .limit(10),
    supabase
      .from('trips')
      .select('id')
      .eq('conductor_id', conductorId)
      .gte('start_time', todayStart.toISOString()),
  ]);

  if (activeRes.error) throw activeRes.error;
  if (recentRes.error) throw recentRes.error;
  if (todayTripsRes.error) throw todayTripsRes.error;

  const activeRow = activeRes.data?.[0] ?? null;
  const recentRows = recentRes.data ?? [];
  const todayTripIds = (todayTripsRes.data ?? []).map(t => t.id);

  const routeIds = [
    ...new Set(
      [activeRow?.route_id, ...recentRows.map(r => r.route_id)]
        .filter(Boolean)
        .map(String),
    ),
  ];
  const busIds = [
    ...new Set(
      [activeRow?.bus_id, ...recentRows.map(r => r.bus_id)]
        .filter(Boolean)
        .map(String),
    ),
  ];
  const summaryTripIds = [
    ...new Set(
      [activeRow?.id, ...recentRows.map(r => r.id), ...todayTripIds]
        .filter(Boolean)
        .map(String),
    ),
  ];

  const [routesRes, busesRes, ticketsRes] = await Promise.all([
    routeIds.length > 0
      ? supabase.from('routes').select('id,route_name').in('id', routeIds)
      : Promise.resolve({ data: [], error: null }),
    busIds.length > 0
      ? supabase.from('buses').select('id,bus_number,bus_name,capacity').in('id', busIds)
      : Promise.resolve({ data: [], error: null }),
    summaryTripIds.length > 0
      ? supabase.from('tickets').select('trip_id,fare,payment_method').in('trip_id', summaryTripIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (routesRes.error) throw routesRes.error;
  if (busesRes.error) throw busesRes.error;
  if (ticketsRes.error) throw ticketsRes.error;

  const routeNameMap = Object.fromEntries(
    (routesRes.data ?? []).map(r => [String(r.id), r.route_name]),
  );
  const busMap = Object.fromEntries(
    (busesRes.data ?? []).map(b => [
      String(b.id),
      {
        id: b.id,
        vehicle_number: b.bus_number,
        bus_name: b.bus_name,
        capacity: b.capacity,
      },
    ]),
  );

  const ticketMetricsByTrip = (ticketsRes.data ?? []).reduce((acc, row) => {
    const key = String(row.trip_id);
    if (!acc[key]) acc[key] = { tickets_sold: 0, collection: 0 };
    const isPos = String(row.payment_method ?? '').toLowerCase() === 'pos';
    if (!isPos) {
      acc[key].tickets_sold += 1;
      acc[key].collection += Number(row.fare ?? 0);
    }
    return acc;
  }, {});

  const toTripPayload = row => {
    if (!row) return null;
    const metric = ticketMetricsByTrip[String(row.id)] ?? {
      tickets_sold: 0,
      collection: 0,
    };
    return {
      trip_id: row.id,
      trip_number: row.trip_number,
      route_id: row.route_id ?? null,
      route_name: routeNameMap[String(row.route_id)] ?? 'Unknown',
      direction: row.direction,
      status: row.status,
      start_time: row.start_time,
      end_time: row.expected_end_time ?? null,
      bus_id: row.bus_id ?? null,
      conductor_id: row.conductor_id ?? conductorId,
      tickets_sold: metric.tickets_sold,
      collection: Math.round(metric.collection * 100) / 100,
    };
  };

  const active_trip = toTripPayload(activeRow);
  const recent_trips = recentRows.map(toTripPayload);

  const todayAgg = todayTripIds.reduce(
    (acc, tripId) => {
      const metric = ticketMetricsByTrip[String(tripId)] ?? {
        tickets_sold: 0,
        collection: 0,
      };
      acc.tickets_sold += metric.tickets_sold;
      acc.total_collection += metric.collection;
      return acc;
    },
    { tickets_sold: 0, total_collection: 0 },
  );

  const refBusId = activeRow?.bus_id ?? recentRows?.[0]?.bus_id ?? null;

  return {
    conductor: { id: conductorId },
    bus: refBusId ? busMap[String(refBusId)] ?? null : null,
    active_trip,
    today_stats: {
      trips_completed: todayTripIds.length,
      tickets_sold: todayAgg.tickets_sold,
      total_collection: Math.round(todayAgg.total_collection * 100) / 100,
      passengers: todayAgg.tickets_sold,
    },
    recent_trips,
  };
};

const fetchTripReportWithAppTripFromSupabase = async tripId => {
  const conductorId = await getConductorIdFromStorage();
  if (!conductorId) throw new Error('No conductor session');

  const { data: tripRow, error: tripErr } = await supabase
    .from('trips')
    .select(
      'id,conductor_id,route_id,bus_id,trip_number,direction,status,start_time,expected_end_time',
    )
    .eq('id', tripId)
    .eq('conductor_id', conductorId)
    .maybeSingle();
  if (tripErr) throw tripErr;
  if (!tripRow) throw new Error('Trip not found');

  const [routeRes, busRes, ticketRes] = await Promise.all([
    tripRow.route_id
      ? supabase.from('routes').select('route_name').eq('id', tripRow.route_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    tripRow.bus_id
      ? supabase.from('buses').select('bus_number').eq('id', tripRow.bus_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from('tickets')
      .select(
        'id,fare,total_fare,ticket_count,is_verified,payment_method,created_at,from_stop_id,to_stop_id,ticket_type',
      )
      .eq('trip_id', tripId),
  ]);

  if (routeRes.error) throw routeRes.error;
  if (busRes.error) throw busRes.error;
  if (ticketRes.error) throw ticketRes.error;

  const ticketRows = ticketRes.data ?? [];
  const stopIds = [
    ...new Set(
      ticketRows
        .flatMap(r => [r.from_stop_id, r.to_stop_id])
        .filter(Boolean)
        .map(String),
    ),
  ];

  const stopRes = stopIds.length > 0
    ? await supabase.from('stops').select('id,stop_name').in('id', stopIds)
    : { data: [], error: null };
  if (stopRes.error) throw stopRes.error;

  const stopMap = Object.fromEntries(
    (stopRes.data ?? []).map(s => [String(s.id), s.stop_name]),
  );

  const allGrouped = {};
  const appGrouped = {};
  let allCollection = 0;
  let allVerified = 0;
  let allFull = 0;
  let allHalf = 0;
  let allFree = 0;

  let appTickets = 0;
  let appCollection = 0;
  let appFull = 0;
  let appHalf = 0;
  let appFree = 0;

  const addToGroup = (groupMap, fromName, toName, fullCount, halfCount, freeCount, total) => {
    const key = `${fromName}|||${toName}`;
    if (!groupMap[key]) {
      groupMap[key] = {
        from: fromName,
        to: toName,
        count: 0,
        full_count: 0,
        half_count: 0,
        free_count: 0,
        total_fare: 0,
      };
    }
    groupMap[key].count += fullCount + halfCount + freeCount;
    groupMap[key].full_count += fullCount;
    groupMap[key].half_count += halfCount;
    groupMap[key].free_count += freeCount;
    groupMap[key].total_fare += total;
  };

  for (const row of ticketRows) {
    const cnt = Number(row.ticket_count ?? 1);
    const unit = Number(row.fare ?? 0);
    const total = row.total_fare != null ? Number(row.total_fare) : unit * cnt;
    const pm = String(row.payment_method ?? '').toLowerCase();
    const tt = String(row.ticket_type ?? 'full').toLowerCase();
    const fromName = stopMap[String(row.from_stop_id)] ?? 'Unknown';
    const toName = stopMap[String(row.to_stop_id)] ?? 'Unknown';
    const isFree = pm === 'fr';
    const isHalf = !isFree && tt === 'half';
    const fullCount = isFree || isHalf ? 0 : cnt;
    const halfCount = isHalf ? cnt : 0;
    const freeCount = isFree ? cnt : 0;

    addToGroup(allGrouped, fromName, toName, fullCount, halfCount, freeCount, total);

    allCollection += total;
    if (row.is_verified) allVerified += 1;
    allFull += fullCount;
    allHalf += halfCount;
    allFree += freeCount;

    if (pm !== 'pos') {
      addToGroup(appGrouped, fromName, toName, fullCount, halfCount, freeCount, total);
      appTickets += cnt;
      appCollection += total;
      appFull += fullCount;
      appHalf += halfCount;
      appFree += freeCount;
    }
  }

  const toBreakdownArray = grouped =>
    Object.values(grouped)
      .sort((a, b) => Number(b.total_fare) - Number(a.total_fare))
      .map(g => ({
        from: g.from,
        to: g.to,
        route: `${g.from} → ${g.to}`,
        count: g.count,
        full_count: g.full_count,
        half_count: g.half_count,
        free_count: g.free_count,
        revenue: Math.round(Number(g.total_fare) * 100) / 100,
        total_fare: Math.round(Number(g.total_fare) * 100) / 100,
      }));

  return {
    report: {
      trip_id: tripId,
      trip_number: tripRow.trip_number ?? null,
      route_name: routeRes.data?.route_name ?? 'Unknown',
      direction: tripRow.direction,
      status: tripRow.status,
      start_time: tripRow.start_time,
      end_time: tripRow.expected_end_time ?? null,
      bus_number: busRes.data?.bus_number ?? null,
      summary: {
        total_tickets: ticketRows.length,
        total_collection: Math.round(allCollection * 100) / 100,
        total_full: allFull,
        total_half: allHalf,
        total_free: allFree,
        verified: allVerified,
        surrendered: 0,
      },
      route_breakdown: toBreakdownArray(allGrouped),
      tickets: ticketRows.map(row => ({
        ticket_id: String(row.id),
        from: stopMap[String(row.from_stop_id)] ?? 'Unknown',
        to: stopMap[String(row.to_stop_id)] ?? 'Unknown',
        fare: row.total_fare != null
          ? Number(row.total_fare)
          : Number(row.fare ?? 0) * Number(row.ticket_count ?? 1),
        is_verified: !!row.is_verified,
        is_free: String(row.payment_method ?? '').toLowerCase() === 'fr',
        created_at: row.created_at,
      })),
    },
    appTrip: {
      tickets: appTickets,
      collection: Math.round(appCollection * 100) / 100,
      full: appFull,
      half: appHalf,
      free: appFree,
      breakdown: toBreakdownArray(appGrouped),
    },
  };
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const StatusPill = ({ status }) => {
  const cfg = {
    running: {
      bg: 'bg-emerald-500/15 border border-emerald-500/30',
      text: 'text-emerald-400',
      dot: 'bg-emerald-400',
    },
    paused: {
      bg: 'bg-amber-500/15 border border-amber-500/30',
      text: 'text-amber-400',
      dot: 'bg-amber-400',
    },
    completed: {
      bg: 'bg-sky-500/15 border border-sky-500/30',
      text: 'text-sky-400',
      dot: 'bg-sky-400',
    },
    cancelled: {
      bg: 'bg-red-500/15 border border-red-500/30',
      text: 'text-red-400',
      dot: 'bg-red-400',
    },
  };
  const c = cfg[status] ?? {
    bg: 'bg-zinc-800',
    text: 'text-zinc-400',
    dot: 'bg-zinc-400',
  };
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <View
      className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${c.bg}`}
    >
      <View className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      <Text className={`text-[10px] font-bold tracking-wider ${c.text}`}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
};

const StatChip = ({ label, value, color }) => (
  <View className="flex-1 items-center bg-zinc-800/60 rounded-xl py-3">
    <Text className={`text-base font-black ${color}`}>{value}</Text>
    <Text className="text-zinc-500 text-[9px] font-bold tracking-widest mt-0.5">
      {label}
    </Text>
  </View>
);

// Stage table — shared between both tabs
const StageTable = ({ rows }) => {
  if (rows.length === 0)
    return (
      <Text className="text-zinc-600 text-xs text-center py-4">
        No stage data available
      </Text>
    );
  return (
    <View className="rounded-xl overflow-hidden border border-zinc-800 mt-3">
      {/* Header */}
      <View className="flex-row bg-zinc-800 px-3 py-2">
        {['SS', 'ES', 'F', 'H', 'L', 'P', 'AMT'].map((h, i) => (
          <Text
            key={i}
            className="text-zinc-400 text-[10px] font-black tracking-widest"
            style={{
              flex: i === 6 ? 2 : 1,
              textAlign: i === 6 ? 'right' : 'center',
            }}
          >
            {h}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View
          key={i}
          className={`flex-row items-center px-3 py-2.5 border-t border-zinc-800/60 ${
            i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-900/40'
          }`}
        >
          <Text
            className="text-zinc-300 text-xs font-bold"
            style={{ flex: 1, textAlign: 'center' }}
            numberOfLines={1}
          >
            {r.ss}
          </Text>
          <Text
            className="text-zinc-300 text-xs font-bold"
            style={{ flex: 1, textAlign: 'center' }}
            numberOfLines={1}
          >
            {r.es}
          </Text>
          <Text
            className="text-zinc-400 text-xs"
            style={{ flex: 1, textAlign: 'center' }}
          >
            {r.f > 0 ? r.f : '—'}
          </Text>
          <Text
            className="text-zinc-400 text-xs"
            style={{ flex: 1, textAlign: 'center' }}
          >
            {r.h > 0 ? r.h : '—'}
          </Text>
          <Text
            className="text-zinc-400 text-xs"
            style={{ flex: 1, textAlign: 'center' }}
          >
            {r.l > 0 ? r.l : '0'}
          </Text>
          <Text
            className="text-zinc-500 text-xs"
            style={{ flex: 1, textAlign: 'center' }}
          >
            0
          </Text>
          <View
            style={{
              flex: 2,
              alignItems: 'flex-end',
              flexDirection: 'row',
              justifyContent: 'flex-end',
              gap: 4,
            }}
          >
            {r.app > 0 && (
              <Text
                className="text-violet-400 text-[10px] font-bold"
                style={{ alignSelf: 'center' }}
              >
                ({r.app})
              </Text>
            )}
            <Text className="text-sky-400 text-xs font-bold">
              ₹{Number(r.amt).toFixed(0)}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
};

// ─── Trip Sheet Tab ───────────────────────────────────────────────────────────
const TripSheetTab = ({ dashboard, posHook, refreshing, onRefresh }) => {
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [report, setReport] = useState(null);
  const [appTrip, setAppTrip] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [printModalData, setPrintModalData] = useState(null);

  // Filter panel state
  const [filterStart, setFilterStart] = useState(null);
  const [filterEnd, setFilterEnd] = useState(null);
  const [showFilterStartDrop, setShowFilterStartDrop] = useState(false);
  const [showFilterEndDrop, setShowFilterEndDrop] = useState(false);
  const [tableTab, setTableTab] = useState('full');

  // Reload POS data when screen comes into focus (fresh tickets may have been issued)
  useFocusEffect(
    useCallback(() => {
      posHook.reload?.();
    }, [posHook]),
  );

  const at = dashboard?.active_trip;

  // Build trip list: active first, then recent
  const trips = useMemo(
    () => {
      const recentTrips = dashboard?.recent_trips ?? [];
      return [
        ...(at?.trip_id ? [{ ...at, isActive: true }] : []),
        ...recentTrips
        .filter(t => t.trip_id !== at?.trip_id)
        .map(t => ({ ...t, isActive: false })),
      ];
    },
    [at, dashboard?.recent_trips],
  );

  // Direction-aware place ordering (mirrors HomeScreen)
  const selectedTripDir = (
    trips.find(t => t.trip_id === selectedTripId)?.direction ??
    at?.direction ??
    'up'
  );
  const filterPlaces = useMemo(
    () => (isDownDirection(selectedTripDir) ? [...places].reverse() : places),
    [selectedTripDir],
  );

  const quickFilterRanges = useMemo(
    () =>
      isDownDirection(selectedTripDir)
        ? [
          { from: 3, to: 11 },
          { from: 11, to: 18 },
          ]
        : [
          { from: 18, to: 11 },
          { from: 11, to: 3 },
          ],
    [selectedTripDir],
  );

  const stageNumFromPlace = place =>
    parseInt(place?.label?.split('-')[1]?.trim(), 10);

  const applyQuickRange = (fromStage, toStage) => {
    const fromPlace = filterPlaces.find(
      p => stageNumFromPlace(p) === fromStage,
    );
    const toPlace = filterPlaces.find(p => stageNumFromPlace(p) === toStage);
    if (!fromPlace || !toPlace) {
      Alert.alert('Unavailable', 'Could not apply this stage range.');
      return;
    }
    setFilterStart(fromPlace);
    setFilterEnd(toPlace);
    setShowFilterStartDrop(false);
    setShowFilterEndDrop(false);
  };

  // Initial default selection: active trip first; otherwise latest trip.
  // Do not force active trip after user manually changes selection.
  useEffect(() => {
    if (selectedTripId !== null) return;
    if (at?.trip_id) {
      setSelectedTripId(at.trip_id);
      return;
    }
    if (trips.length > 0) {
      setSelectedTripId(trips[0].trip_id);
    }
  }, [at?.trip_id, trips, selectedTripId]);

  // If saved/selected trip is no longer in filtered list, switch to latest valid trip
  useEffect(() => {
    if (!selectedTripId) return;
    const exists = trips.some(t => t.trip_id === selectedTripId);
    if (exists) return;
    if (at?.trip_id) {
      setSelectedTripId(at.trip_id);
    } else if (trips.length > 0) {
      setSelectedTripId(trips[0].trip_id);
    } else {
      setSelectedTripId(null);
    }
  }, [selectedTripId, trips, at?.trip_id]);

  useEffect(() => {
    if (!selectedTripId) {
      setReport(null);
      setAppTrip(null);
      return;
    }
    setReport(null);
    setAppTrip(null);
    setLoading(true);
    (async () => {
      try {
        const { report: tripReport, appTrip: appOnlyTrip } =
          await fetchTripReportWithAppTripFromSupabase(selectedTripId);
        setReport(tripReport);
        setAppTrip(appOnlyTrip);
      } catch {
        Alert.alert('Error', 'Could not load trip report');
        setReport(null);
        setAppTrip({
          tickets: 0,
          collection: 0,
          full: 0,
          half: 0,
          free: 0,
          breakdown: [],
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedTripId]);

  useEffect(() => {
    setTableTab('full');
  }, [selectedTripId]);

const posTix = (posHook?.tickets ?? []).filter(
    t => t.trip_id === selectedTripId,
  );
  const appBreakdown = appTrip?.breakdown?.length
    ? appTrip.breakdown
    : report?.route_breakdown ?? [];
  const stageRows = buildStageRows(appBreakdown, posTix);
  const grandFull = stageRows.reduce((s, r) => s + r.f, 0);
  const grandHalf = stageRows.reduce((s, r) => s + r.h, 0);
  const grandCollection = stageRows.reduce((s, r) => s + r.amt, 0);
  const posTotal = posTix.reduce((s, t) => s + Number(t.fare || 0), 0);
  const appTotal = Number(appTrip?.collection ?? 0);
  const combinedTotal = appTotal + posTotal;

  // Filtered stage rows (when filter panel is open and both places selected)
  const filteredStageRows = (() => {
    if (!filterStart || !filterEnd) return null;
    const startNum = stageNumFromPlace(filterStart);
    const endNum = stageNumFromPlace(filterEnd);
    if (isNaN(startNum) || isNaN(endNum)) return null;

    const isFromWithinSelectedRange = from => {
      if (isNaN(from)) return false;
      if (startNum === endNum) return from === startNum;

      if (startNum < endNum) {
        return from >= startNum && from < endNum;
      }
      return from <= startNum && from > endNum;
    };

    const filteredApp = appBreakdown.filter(rb => {
      const from = parseInt(stageCodeFromName(rb.from), 10);
      return isFromWithinSelectedRange(from);
    });
    const filteredPos = posTix.filter(t => {
      const from = parseInt(stageCode(t.from_stop), 10);
      return isFromWithinSelectedRange(from);
    });
    return buildStageRows(filteredApp, filteredPos);
  })();

  const getFilterDisplayName = place => {
    if (!place) return '';
    const parts = place.label.split('-');
    return parts.slice(2).join(' ') || parts.slice(1).join(' ') || place.label;
  };

  const handlePrintTripSheet = async () => {
    if (!report || !stageRows || stageRows.length === 0) {
      Alert.alert('No data', 'No trip data to print.');
      return;
    }

    const testingMode = await AsyncStorage.getItem('testing_mode');
    const isTestingMode = testingMode === 'true';

    const _selectedTrip = trips.find(t => t.trip_id === selectedTripId);
    const _busNo = report.bus_number ?? dashboard?.bus?.vehicle_number ?? 'N/A';
    const _tripNum = report.trip_number ?? _selectedTrip?.trip_number ?? '—';
    const _wayBill = report.way_bill_number ?? report.waybill ?? _selectedTrip?.way_bill_number ?? '—';
    const _startDt = report.start_time ? new Date(report.start_time) : new Date();
    const _dateStr = _startDt.toLocaleDateString('en-GB');
    const _timeStr = _startDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    // Use filtered rows if in filtered tab, otherwise use full rows
    const isFiltered = tableTab === 'filtered' && filteredStageRows && filteredStageRows.length > 0;
    const rowsToPrint = isFiltered ? filteredStageRows : stageRows;

    // Calculate totals from the rows being printed
    const printGrandFull = rowsToPrint.reduce((s, r) => s + r.f, 0);
    const printGrandHalf = rowsToPrint.reduce((s, r) => s + r.h, 0);
    const printGrandCollection = rowsToPrint.reduce((s, r) => s + r.amt, 0);

    // For filtered mode, only show trip collection (no combined total)
    const printCombinedTotal = isFiltered ? printGrandCollection : combinedTotal;

    if (isTestingMode) {
      // Calculate ticket number range
      const today = new Date().toDateString();
      const todayAllTicketNums = (posHook?.tickets ?? [])
        .filter(t => new Date(t.issued_at).toDateString() === today)
        .map(t => Number(t.ticket_number))
        .filter(n => !isNaN(n) && n > 0);
      const currentTripTicketNums = posTix.map(t => Number(t.ticket_number)).filter(n => !isNaN(n) && n > 0);
      const firstTicketNum = todayAllTicketNums.length > 0 ? Math.min(...todayAllTicketNums) : null;
      const lastTicketNum = currentTripTicketNums.length > 0 ? Math.max(...currentTripTicketNums) : null;
      const ticketRangeStr = firstTicketNum && lastTicketNum
        ? `${firstTicketNum} - ${lastTicketNum}`
        : (firstTicketNum || lastTicketNum || null);

      setPrintModalData({
        title: 'TRIP SHEET',
        busNo: _busNo,
        tripNum: _tripNum,
        wayBill: _wayBill,
        dateStr: _dateStr,
        timeStr: _timeStr,
        stageRows: rowsToPrint,
        grandFull: printGrandFull,
        grandHalf: printGrandHalf,
        grandCollection: printGrandCollection,
        combinedTotal: printCombinedTotal,
        type: 'tripsheet',
        filterLabel: isFiltered ? `FILTERED: ${getFilterDisplayName(filterStart)} → ${getFilterDisplayName(filterEnd)}` : null,
        ticketRange: ticketRangeStr,
      });
      setShowPrintModal(true);
      return;
    }

    if (Platform.OS !== 'android' || !NyxPrinter) {
      Alert.alert('Not supported', 'Printing is only available on Android.');
      return;
    }
    try {
      const statusRet = await NyxPrinter.getPrinterStatus();
      if (statusRet !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(statusRet));
        return;
      }

      // Helper: pad string to fixed width (left-aligned)
      const padL = (s, w) => String(s).padEnd(w, ' ');
      // Helper: pad string to fixed width (right-aligned)
      const padR = (s, w) => String(s).padStart(w, ' ');
      // Helper: center string within fixed width
      const padC = (s, w) => { const str = String(s); const tot = w - str.length; const l = Math.floor(tot / 2); return ' '.repeat(l) + str + ' '.repeat(tot - l); };
      // Amount formatting: always 2 decimal places
      const fmtAmt = n => Number(n).toFixed(2);

      const DASH32 = '--------------------------------';
      const DASH_LIGHT = '- - - - - - - - - - - - - - - -';

      // Date/time from report start_time
      const startDt = report.start_time ? new Date(report.start_time) : new Date();
      const dateStr = startDt.toLocaleDateString('en-GB').replace(/\//g, '/');
      const timeStr = startDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

      const selectedTrip = trips.find(t => t.trip_id === selectedTripId);
      const busNo = report.bus_number ?? dashboard?.bus?.vehicle_number ?? 'N/A';
      const wayBill = report.way_bill_number ?? report.waybill ?? selectedTrip?.way_bill_number ?? '—';
      const tripNum = report.trip_number ?? selectedTrip?.trip_number ?? '—';

      const today = new Date().toDateString();
      const todayAllTicketNums = (posHook?.tickets ?? [])
        .filter(t => new Date(t.issued_at).toDateString() === today)
        .map(t => Number(t.ticket_number))
        .filter(n => !isNaN(n) && n > 0);
      const currentTripTicketNums = posTix.map(t => Number(t.ticket_number)).filter(n => !isNaN(n) && n > 0);
      const firstTicketNum = todayAllTicketNums.length > 0 ? Math.min(...todayAllTicketNums) : null;
      const lastTicketNum = currentTripTicketNums.length > 0 ? Math.max(...currentTripTicketNums) : null;
      const ticketRangeStr = firstTicketNum && lastTicketNum
        ? `${firstTicketNum} - ${lastTicketNum}`
        : (firstTicketNum || lastTicketNum || null);

      // ── Header ──────────────────────────────────────────────────────────────
      await NyxPrinter.printText('SPS TRANSPORT', { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText('TRIP SHEET', { textSize: 26, align: PrintAlign.CENTER, bold: true });
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      if (isFiltered) {
        const filterLabel = `FILTERED: ${getFilterDisplayName(filterStart)} → ${getFilterDisplayName(filterEnd)}`;
        await NyxPrinter.printText(filterLabel, { textSize: 18, align: PrintAlign.CENTER });
      }

      await NyxPrinter.printText(`BUS:${busNo}  TRIP No.:${tripNum}`, { textSize: 24 });
      await NyxPrinter.printText(`${dateStr} ${timeStr}${ticketRangeStr ? `  TKT:${ticketRangeStr}` : ''}`, { textSize: 22 });

      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      // ── Column headers: SS ES F H L P AMT ──────────────────────────────────
      // textSize 26 fits ~24 chars. SS=3,ES=3,F=3,H=3,L=3,P=3,AMT=6 = 24
     const COL = { 
  ss:6, 
  es:6, 
  f:5, 
  h:5, 
  l:5, 
  p:5, 
  amt:8 
};
      const hdr =
        padL('SS', COL.ss) +
        padL('ES', COL.es) +
        padC('F',  COL.f)  +
        padC('H',  COL.h)  +
        padC('L',  COL.l)  +
        padC('P',  COL.p)  +
        padR('AMT', COL.amt);
      await NyxPrinter.printText(hdr, { textSize: 26 });
      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });

      // ── Stage rows ───────────────────────────────────────────────────────────
      for (const r of rowsToPrint) {
        const row =
          padL(r.ss,          COL.ss)  +
          padL(r.es,          COL.es)  +
          padC(r.f,           COL.f)   +
          padC(r.h,           COL.h)   +
          padC(r.l,           COL.l)   +
          padC(r.p ?? 0,      COL.p)   +
          padR(fmtAmt(r.amt), COL.amt);
        await NyxPrinter.printText(row, { textSize: 26 });
      }
      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });

      // ── FULL total ───────────────────────────────────────────────────────────
      await NyxPrinter.printText(
        `FULL : ${printGrandFull}`,
        { textSize: 26, align: PrintAlign.CENTER },
      );
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      // ── TRIP.COLL + TOT.COLL ────────────────────────────────────────────────
      // textSize 32 fits ~20 chars. label=12 + amount right-aligned in 8 = 20
      await NyxPrinter.printText(
        `${padL('TRIP.COLL:', 12)}${padR(fmtAmt(printGrandCollection), 8)}`,
        { textSize: 32 },
      );
      await NyxPrinter.printText(
        `${padL('TOT.COLL:', 12)}${padR(fmtAmt(printCombinedTotal), 8)}`,
        { textSize: 32 },
      );
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      await NyxPrinter.printEndAutoOut();

      showToast('Trip sheet printed!');
    } catch (e) {
      Alert.alert('Print Error', e.message || 'Unknown');
    }
  };

  return (
    <>
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
      <Text className="text-zinc-500 text-[10px] font-bold tracking-widest mb-3">
        SELECT TRIP
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="mb-5"
      >
        <View className="flex-row gap-2">
          {trips.length === 0 && (
            <View className="bg-zinc-900 border border-zinc-800 rounded-2xl px-5 py-3">
              <Text className="text-zinc-500 text-sm">No trips found</Text>
            </View>
          )}
          {trips.map(trip => {
            const isSelected = selectedTripId === trip.trip_id;
            return (
              <TouchableOpacity
                key={trip.trip_id}
                onPress={() =>
                  setSelectedTripId(isSelected ? null : trip.trip_id)
                }
                activeOpacity={0.75}
                className={`rounded-2xl px-4 py-3 border ${
                  isSelected
                    ? 'bg-sky-500 border-sky-400'
                    : 'bg-zinc-900 border-zinc-800'
                }`}
                style={{ minWidth: 110 }}
              >
                {trip.isActive && (
                  <View className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-emerald-400" />
                )}
                <Text
                  className={`text-[10px] font-bold tracking-wider ${
                    isSelected ? 'text-sky-100' : 'text-zinc-400'
                  }`}
                >
                  Trip
                </Text>
                <Text
                  className={`text-center text-2xl font-black leading-tight ${
                    isSelected ? 'text-white' : 'text-zinc-100'
                  }`}
                >
                  {trip.trip_number ? `#${trip.trip_number}` : '#—'}
                </Text>
                <Text
                  className={`text-[10px] mt-1 ${
                    isSelected ? 'text-sky-100' : 'text-zinc-500'
                  }`}
                  numberOfLines={1}
                >
                  {routeLabel(trip.route_name, trip.direction)?.split(' ')[0] ??
                    '—'}
                </Text>
                <Text
                  className={`text-[10px] mt-0.5 ${
                    isSelected ? 'text-sky-100' : 'text-zinc-600'
                  }`}
                >
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
          <Text className="text-zinc-500 text-sm font-semibold">
            Select a trip above
          </Text>
          <Text className="text-zinc-700 text-xs">
            Trip sheet will appear here
          </Text>
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
                <Text className="text-zinc-500 text-[9px] font-black tracking-widest mb-1">
                  TRIP SHEET
                </Text>
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
                <Text className="text-zinc-400 text-xs">
                  {report.bus_number ?? dashboard?.bus?.vehicle_number ?? 'N/A'}
                </Text>
              </View>
              <View className="flex-row items-center gap-1">
                <Clock size={11} color="#71717a" />
                <Text className="text-zinc-400 text-xs">
                  {formatTime(report.start_time)}
                </Text>
              </View>
              <View className="flex-row items-center gap-1">
                <Layers size={11} color="#71717a" />
                <Text className="text-zinc-400 text-xs">
                  {(report.trip_number ?? trips.find(t => t.trip_id === selectedTripId)?.trip_number) ? `#${report.trip_number ?? trips.find(t => t.trip_id === selectedTripId)?.trip_number}` : '—'}
                </Text>
              </View>
              <View className="flex-row items-center gap-1">
                <FileText size={11} color="#71717a" />
                <Text className="text-zinc-400 text-xs">
                  WB: {report.way_bill_number ?? report.waybill ?? trips.find(t => t.trip_id === selectedTripId)?.way_bill_number ?? '—'}
                </Text>
              </View>
            </View>
          </View>

          {/* Stats */}
          <View className="flex-row gap-2 p-4">
            <StatChip label="FULL" value={grandFull} color="text-white" />
            {grandHalf > 0 && (
              <StatChip label="HALF" value={grandHalf} color="text-amber-400" />
            )}
            <StatChip
              label="APP"
              value={`₹${appTotal.toFixed(0)}`}
              color="text-sky-400"
            />
            {posTotal > 0 && (
              <StatChip
                label="POS"
                value={`₹${posTotal.toFixed(0)}`}
                color="text-violet-400"
              />
            )}
            <StatChip
              label="TOTAL"
              value={`₹${combinedTotal.toFixed(0)}`}
              color="text-emerald-400"
            />
          </View>

          {/* Stage table */}
          <View className="px-4 pb-4">
            <View className="flex-row items-center gap-2 mb-1">
              <BarChart3 size={13} color="#71717a" />
              <Text className="text-zinc-500 text-[10px] font-bold tracking-widest">
                STAGE BREAKDOWN
              </Text>
            </View>
            <View className="flex-row bg-black rounded-xl p-1 mt-3 mb-2 border border-zinc-700">
              <TouchableOpacity
                className={`flex-1 py-2 rounded-lg ${
                  tableTab === 'full' ? 'bg-sky-500/40 border border-sky-400/30' : 'bg-transparent'
                }`}
                onPress={() => setTableTab('full')}
                activeOpacity={0.8}
              >
                <Text
                  className={`text-center text-xs font-bold ${
                    tableTab === 'full' ? 'text-sky-100' : 'text-zinc-400'
                  }`}
                >
                  FULL
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                className={`flex-1 py-2 rounded-lg ${
                  tableTab === 'filtered' ? 'bg-violet-500/40 border border-violet-400/30' : 'bg-transparent'
                }`}
                onPress={() => setTableTab('filtered')}
                activeOpacity={0.8}
              >
                <Text
                  className={`text-center text-xs font-bold ${
                    tableTab === 'filtered' ? 'text-violet-100' : 'text-zinc-400'
                  }`}
                >
                  FILTERED
                </Text>
              </TouchableOpacity>
            </View>

            {tableTab === 'full' ? (
              <>
                <View className="flex-row justify-end mb-3">
                  <TouchableOpacity
                    className="flex-row items-center justify-center gap-1.5 bg-sky-500 rounded-xl px-4 py-3"
                    activeOpacity={0.8}
                    onPress={handlePrintTripSheet}
                  >
                    <Download size={14} color="#fff" />
                    <Text className="text-white text-xs font-bold">Print</Text>
                  </TouchableOpacity>
                </View>
                <StageTable rows={stageRows} />
                <View className="flex-row justify-between items-center bg-sky-500/10 border border-sky-500/20 rounded-xl px-4 py-3 mt-3">
                  <Text className="text-zinc-300 text-sm font-bold">TRP TOTAL</Text>
                  <Text className="text-sky-400 text-xl font-black">
                    ₹{grandCollection.toFixed(2)}
                  </Text>
                </View>
              </>
            ) : (
              null
            )}
          </View>

          {/* Filter controls (always open in filtered tab) */}
          {tableTab === 'filtered' && (
            <View className="px-4 pb-2 mt-1">
              {/* Quick stage ranges */}
              <View className="bg-black rounded-xl border border-zinc-700 p-2 mb-3">
                <Text className="text-zinc-500 text-[9px] font-black tracking-widest px-1 pb-2">
                  QUICK SELECT
                </Text>
                <View className="flex-row gap-2">
                  {quickFilterRanges.map(range => {
                    const fromLabel = String(range.from).padStart(3, '0');
                    const toLabel = String(range.to).padStart(3, '0');
                    const isActive =
                      stageNumFromPlace(filterStart) === range.from &&
                      stageNumFromPlace(filterEnd) === range.to;
                    return (
                      <TouchableOpacity
                        key={`q-${range.from}-${range.to}`}
                        className={`flex-1 rounded-lg px-3 py-2 border ${
                          isActive
                            ? 'bg-violet-500/50 border-violet-400'
                            : 'bg-zinc-800 border-zinc-700'
                        }`}
                        onPress={() => applyQuickRange(range.from, range.to)}
                        activeOpacity={0.8}
                      >
                        <Text
                          className={`text-center text-xs font-bold ${
                            isActive ? 'text-white' : 'text-zinc-300'
                          }`}
                        >
                          {fromLabel} - {toLabel}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View className="mt-1">
                {/* Stage range selector */}
                <View className="flex-row items-stretch bg-zinc-900 rounded-xl border border-zinc-700 overflow-hidden mb-3">
                  {/* FROM */}
                  <TouchableOpacity
                    className={`flex-1 px-3 py-3 ${showFilterStartDrop ? 'bg-zinc-800/60' : ''}`}
                    onPress={() => {
                      setShowFilterStartDrop(v => !v);
                      setShowFilterEndDrop(false);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text className="text-zinc-500 text-[10px] font-black tracking-widest mb-1">
                      FROM
                    </Text>
                    {filterStart ? (
                      <View className="flex-row items-baseline gap-1">
                        <Text className="text-sky-400 text-2xl font-black leading-7">
                          {String(stageNumFromPlace(filterStart)).padStart(3, '0')}
                        </Text>
                        <Text
                          className="text-white text-sm font-medium flex-shrink"
                          numberOfLines={1}
                        >
                          {getFilterDisplayName(filterStart)}
                        </Text>
                      </View>
                    ) : (
                      <Text className="text-zinc-500 text-sm">Select start stage</Text>
                    )}
                  </TouchableOpacity>

                  <View className="w-10 items-center justify-center border-x border-zinc-700">
                    <ArrowRight size={14} color="#71717a" />
                  </View>

                  {/* TO */}
                  <TouchableOpacity
                    className={`flex-1 px-3 py-3 ${showFilterEndDrop ? 'bg-zinc-800/60' : ''}`}
                    onPress={() => {
                      setShowFilterEndDrop(v => !v);
                      setShowFilterStartDrop(false);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text className="text-zinc-500 text-[10px] font-black tracking-widest mb-1">
                      TO
                    </Text>
                    {filterEnd ? (
                      <View className="flex-row items-baseline gap-1">
                        <Text className="text-violet-400 text-2xl font-black leading-7">
                          {String(stageNumFromPlace(filterEnd)).padStart(3, '0')}
                        </Text>
                        <Text
                          className="text-white text-sm font-medium flex-shrink"
                          numberOfLines={1}
                        >
                          {getFilterDisplayName(filterEnd)}
                        </Text>
                      </View>
                    ) : (
                      <Text className="text-zinc-500 text-sm">Select end stage</Text>
                    )}
                  </TouchableOpacity>
                </View>

                {/* Start grid */}
                {showFilterStartDrop && (
                  <View className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden mb-3">
                    <View className="flex-row flex-wrap">
                      {filterPlaces.map((p, idx) => {
                        const isSel = filterStart?.key === p.key;
                        const isDis = filterEnd?.key === p.key;
                        const isNotLastInRow = (idx + 1) % 3 !== 0;
                        return (
                          <TouchableOpacity
                            key={`fs-${p.key}`}
                            disabled={isDis}
                            onPress={() => { setFilterStart(p); setShowFilterStartDrop(false); setShowFilterEndDrop(true); }}
                            className={[
                              'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                              'border-b border-zinc-800',
                              isNotLastInRow ? 'border-r border-zinc-800' : '',
                              isSel ? 'bg-sky-500/20' : '',
                              isDis ? 'opacity-40' : '',
                            ].join(' ')}
                            activeOpacity={0.8}
                          >
                            <Text
                              numberOfLines={1}
                              adjustsFontSizeToFit
                              className={`text-2xl font-black text-center ${isSel ? 'text-sky-400' : 'text-white'}`}>
                              {p.label.split('-')[1]}
                            </Text>
                            <Text className="text-[11px] font-medium text-center text-zinc-300 w-full px-1" numberOfLines={1}>
                              {p.label.split('-')[2]}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}

                {/* End grid */}
                {showFilterEndDrop && (
                  <View className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden mb-3">
                    <View className="flex-row flex-wrap">
                      {filterPlaces.map((p, idx) => {
                        const isSel = filterEnd?.key === p.key;
                        const isDis = filterStart?.key === p.key;
                        const isNotLastInRow = (idx + 1) % 3 !== 0;
                        return (
                          <TouchableOpacity
                            key={`fe-${p.key}`}
                            disabled={isDis}
                            onPress={() => { setFilterEnd(p); setShowFilterEndDrop(false); }}
                            className={[
                              'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                              'border-b border-zinc-800',
                              isNotLastInRow ? 'border-r border-zinc-800' : '',
                              isSel ? 'bg-violet-500/20' : '',
                              isDis ? 'opacity-40' : '',
                            ].join(' ')}
                            activeOpacity={0.8}
                          >
                            <Text
                              numberOfLines={1}
                              adjustsFontSizeToFit
                              className={`text-2xl font-black text-center ${isSel ? 'text-violet-400' : 'text-white'}`}>
                              {p.label.split('-')[1]}
                            </Text>
                            <Text className="text-[11px] font-medium text-center text-zinc-300 w-full px-1" numberOfLines={1}>
                              {p.label.split('-')[2]}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}

              </View>
            </View>
          )}

          {/* Filtered table (bottom) */}
          {tableTab === 'filtered' && (
            <View className="px-4 pb-3">
              {filteredStageRows ? (
                filteredStageRows.length > 0 ? (
                  <>
                    <View className="flex-row items-center justify-between gap-2 mb-3">
                      <View className="flex-[0.8] bg-violet-500/10 border border-violet-500/20 rounded-xl px-3 py-2">
                        <Text className="text-zinc-400 text-[10px] font-bold uppercase">Tickets</Text>
                        <Text className="text-white text-lg font-black">
                          {filteredStageRows.reduce((s, r) => s + r.f + r.h + r.l, 0)}
                        </Text>
                      </View>
                      <View className="flex-[0.8] bg-sky-500/10 border border-sky-500/20 rounded-xl px-3 py-2">
                        <Text className="text-zinc-400 text-[10px] font-bold uppercase">Collection</Text>
                        <Text className="text-sky-400 text-lg font-black">
                          ₹{filteredStageRows.reduce((s, r) => s + r.amt, 0).toFixed(2)}
                        </Text>
                      </View>
                      <TouchableOpacity
                        className="flex-1 flex-row items-center justify-center gap-1.5 bg-sky-500 rounded-xl px-4 py-3"
                        activeOpacity={0.8}
                        onPress={handlePrintTripSheet}
                      >
                        <Download size={14} color="#fff" />
                        <Text className="text-white text-xs font-bold">Print</Text>
                      </TouchableOpacity>
                    </View>
                    <StageTable rows={filteredStageRows} />
                  </>
                ) : (
                  <View className="items-center py-6 gap-1">
                    <Text className="text-zinc-500 text-sm font-semibold">No tickets in this range</Text>
                  </View>
                )
              ) : (
                <View className="items-center py-6 gap-1">
                  <Text className="text-zinc-500 text-sm font-semibold">
                    Select a stage range to view filtered table
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </ScrollView>

    {/* ── Print Preview Modal (Testing Mode) ── */}
    <Modal
      visible={showPrintModal}
      transparent
      animationType="slide"
      onRequestClose={() => setShowPrintModal(false)}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.80)', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
        <View style={{ backgroundColor: '#18181b', borderRadius: 20, padding: 20, width: '100%', maxWidth: 380, borderWidth: 1, borderColor: '#3f3f46', maxHeight: '90%' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Print Preview</Text>
            <TouchableOpacity onPress={() => setShowPrintModal(false)}>
              <Text style={{ color: '#38bdf8', fontWeight: '700', fontSize: 14 }}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {printModalData && (
              <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800', fontSize: 15, marginBottom: 4 }}>SPS TRANSPORT</Text>
                <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800', fontSize: 17, marginBottom: 6 }}>{printModalData.title}</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginBottom: 6 }}>{'--------------------------------'}</Text>
                {printModalData.filterLabel && (
                  <Text style={{ color: '#000', textAlign: 'center', fontSize: 10, fontWeight: '700', marginBottom: 2 }}>{printModalData.filterLabel}</Text>
                )}
                <Text style={{ color: '#000', textAlign: 'center', fontSize: 12, marginBottom: 2 }}>BUS: {printModalData.busNo}  TRIP #: {printModalData.tripNum}</Text>
                <Text style={{ color: '#000', textAlign: 'center', fontSize: 12, marginBottom: 2 }}>TKT: {printModalData.ticketRange ?? '—'}</Text>
                <Text style={{ color: '#000', textAlign: 'center', fontSize: 12, marginBottom: 2 }}>WB: {printModalData.wayBill}</Text>
                <Text style={{ color: '#000', textAlign: 'center', fontSize: 12, marginBottom: 6 }}>{printModalData.dateStr}  {printModalData.timeStr}</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginBottom: 4 }}>{'- - - - - - - - - - - - - - - -'}</Text>
                {/* Stage rows header */}
                <View style={{ flexDirection: 'row', marginBottom: 2 }}>
                  {['SS','ES','F','H','L','P','AMT'].map((h, i) => (
                    <Text key={i} style={{ flex: i === 6 ? 2 : 1, textAlign: i === 6 ? 'right' : 'center', fontSize: 10, fontWeight: '800', color: '#333' }}>{h}</Text>
                  ))}
                </View>
                <Text style={{ color: '#aaa', textAlign: 'center', fontSize: 10, marginBottom: 2 }}>{'- - - - - - - - - - - - - - - -'}</Text>
                {(printModalData.stageRows ?? []).map((r, i) => (
                  <View key={i} style={{ flexDirection: 'row', marginBottom: 1 }}>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#111', fontWeight: '700' }}>{r.ss}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#111', fontWeight: '700' }}>{r.es}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#333' }}>{r.f > 0 ? r.f : '—'}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#333' }}>{r.h > 0 ? r.h : '—'}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#333' }}>{r.l > 0 ? r.l : '0'}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#333' }}>0</Text>
                    <Text style={{ flex: 2, textAlign: 'right', fontSize: 10, color: '#0369a1', fontWeight: '700' }}>₹{Number(r.amt).toFixed(0)}</Text>
                  </View>
                ))}
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginTop: 4, marginBottom: 4 }}>{'- - - - - - - - - - - - - - - -'}</Text>
                <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800', fontSize: 13, marginBottom: 2 }}>FULL : {printModalData.grandFull}</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginBottom: 4 }}>{'--------------------------------'}</Text>
                <Text style={{ color: '#000', fontWeight: '800', fontSize: 14, marginBottom: 1 }}>TRIP.COLL:  ₹{Number(printModalData.grandCollection).toFixed(2)}</Text>
                <Text style={{ color: '#000', fontWeight: '800', fontSize: 14 }}>TOT.COLL:   ₹{Number(printModalData.combinedTotal).toFixed(2)}</Text>
              </View>
            )}
          </ScrollView>
          <TouchableOpacity
            style={{ backgroundColor: '#0ea5e9', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 4 }}
            onPress={() => setShowPrintModal(false)}
          >
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>OK</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
    </>
  );
};

// ─── Status Report Tab ────────────────────────────────────────────────────────
const StatusReportTab = ({ dashboard, posHook, refreshing, onRefresh }) => {
  const [selDest, setSelDest] = useState(null);
  const [overrideStart, setOverrideStart] = useState(null);
  const [showStartDrop, setShowStartDrop] = useState(false);
  const [showDestDrop, setShowDestDrop] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [filteredData, setFilteredData] = useState(null);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [statusModalData, setStatusModalData] = useState(null);

  // Reload POS data when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      posHook.reload?.();
    }, [posHook]),
  );

const STORAGE_KEY_DEST = 'report_dest_place';
  const STORAGE_KEY_OVERRIDE_START = 'report_override_start_place';

  // Derive auto start from trip direction
  const tripDir = dashboard?.active_trip?.direction ?? '';
const autoStart = isDownDirection(tripDir)
    ? places[places.length - 1]  // dn = Sathy→CBE, start from highest stage (018)
    : places[0];                  // up = CBE→Sathy, start from lowest stage (003)

  const selStart = overrideStart ?? autoStart;

  useEffect(() => {
    const load = async () => {
      try {
        const destData = await AsyncStorage.getItem(STORAGE_KEY_DEST);
        const startData = await AsyncStorage.getItem(STORAGE_KEY_OVERRIDE_START);
        if (destData) setSelDest(JSON.parse(destData));
        if (startData) setOverrideStart(JSON.parse(startData));
      } catch (e) { console.error('Failed to load saved places:', e); }
    };
    load();
  }, []);

  useEffect(() => {
    if (selDest) AsyncStorage.setItem(STORAGE_KEY_DEST, JSON.stringify(selDest));
  }, [selDest]);

  useEffect(() => {
    if (overrideStart) AsyncStorage.setItem(STORAGE_KEY_OVERRIDE_START, JSON.stringify(overrideStart));
  }, [overrideStart]);

useEffect(() => {
    if (selDest) {
      filterTickets();
    } else {
      setFilteredData(null);
    }
  }, [selStart, filterTickets, selDest]);

  const filterTickets = useCallback(async () => {
    if (!selStart || !selDest) return;
    setFiltering(true);
    try {
      const at = dashboard?.active_trip;
      // Status Report shows on-board passengers for the active trip only.
      // Fall back to the most recent trip if no trip is currently active.
      const activeTripId =
        at?.trip_id ?? (dashboard?.recent_trips?.[0]?.trip_id ?? null);
      if (!activeTripId) {
        setFilteredData(null);
        setFiltering(false);
        return;
      }
      // Fetch app tickets for the active trip only
      let allAppRows = [];
      {
        const { data: rows, error } = await supabase
          .from('tickets')
          .select(
            'ticket_type,payment_method,ticket_count,total_fare,fare,from_stop_id,to_stop_id',
          )
          .eq('trip_id', activeTripId)
          .neq('payment_method', 'pos');

        if (!error && rows) {
          // Resolve stop names
          const stopIds = [
            ...new Set(
              rows.flatMap(r => [r.from_stop_id, r.to_stop_id].filter(Boolean)),
            ),
          ];
          const stopMap = {};
          if (stopIds.length) {
            const { data: stops } = await supabase
              .from('stops')
              .select('id,stop_name')
              .in('id', stopIds);
            (stops ?? []).forEach(s => {
              stopMap[String(s.id)] = s.stop_name;
            });
          }
          allAppRows = rows.map(r => ({
            ...r,
            from_name: stopMap[String(r.from_stop_id)] ?? 'Unknown',
            to_name: stopMap[String(r.to_stop_id)] ?? 'Unknown',
          }));
          console.log('[DEBUG] allAppRows total count:', allAppRows.length);
          console.log(
            '[DEBUG] allAppRows sample:',
            allAppRows.slice(0, 5).map(r => ({
              from_name: r.from_name,
              to_name: r.to_name,
              fromCode: parseInt(stageCodeFromName(r.from_name), 10),
              toCode: parseInt(stageCodeFromName(r.to_name), 10),
              ticket_type: r.ticket_type,
              payment_method: r.payment_method,
            })),
          );
          console.log('[DEBUG] allAppRows ready, count:', allAppRows.length);
        }
      }

      // Get POS tickets for the active trip only
      const allPosTix = (posHook?.tickets ?? []).filter(t =>
        t.trip_id === activeTripId,
      );

      // Match selected place labels to stop names
      // places labels are like "key-stageNum-StopName"
      const startNum = parseInt(selStart.label.split('-')[1]?.trim(), 10);
      const destNum = parseInt(selDest.label.split('-')[1]?.trim(), 10);

      console.log(
        '[DEBUG] selStart.label:',
        selStart.label,
        '→ startNum:',
        startNum,
      );
      console.log(
        '[DEBUG] selDest.label:',
        selDest.label,
        '→ destNum:',
        destNum,
      );

      if (isNaN(startNum) || isNaN(destNum)) {
        console.warn(
          '[DEBUG] startNum or destNum is NaN — check places label format',
        );
        setFiltering(false);
        return;
      }

    // terminal is the autoStart (the origin of the trip)
      const terminalNum = parseInt((overrideStart ?? autoStart).label.split('-')[1]?.trim(), 10);

      // isDn: terminal is high (018), selected dest is lower → tickets going further down (toCode < destNum)
      // isUp: terminal is low (003), selected dest is higher → tickets going further up (toCode > destNum)
      const goingDown = terminalNum > destNum; // dn trip: terminal=018, dest e.g. 007

      const filteredAppRows = allAppRows.filter((r) => {
        const toCode = parseInt(stageCodeFromName(r.to_name), 10);
        if (isNaN(toCode)) return false;
        // toCode must be strictly beyond selDest, towards the terminal
        return goingDown ? toCode < destNum : toCode > destNum;
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
          breakdownMap[k] = {
            from: r.from_name,
            to: r.to_name,
            full_count: 0,
            half_count: 0,
            free_count: 0,
            total_fare: 0,
          };
          appBreakdown.push(breakdownMap[k]);
        }
        const isFree = pm === 'fr';
        if (isFree) breakdownMap[k].free_count += cnt;
        else if (tt === 'half') breakdownMap[k].half_count += cnt;
        else breakdownMap[k].full_count += cnt;
        breakdownMap[k].total_fare += total;
      }

      // Filter POS tickets by range
      const filteredPosTix = allPosTix.filter((t) => {
  const toCode = parseInt(stageCode(t.to_stop), 10);
  if (isNaN(toCode)) return false;
  return goingDown ? toCode < destNum : toCode > destNum;
});

      const stageRows = buildStageRows(appBreakdown, filteredPosTix);
      const grandFull = stageRows.reduce((s, r) => s + r.f, 0);
      const grandHalf = stageRows.reduce((s, r) => s + r.h, 0);
      const grandCollection = stageRows.reduce((s, r) => s + r.amt, 0);
      const totalTickets = grandFull + grandHalf;

      // Ticket number range: from all POS tickets for this trip
      const allTripTicketNums = allPosTix.map(t => Number(t.ticket_number)).filter(n => !isNaN(n) && n > 0);
      const firstTktNum = allTripTicketNums.length > 0 ? Math.min(...allTripTicketNums) : null;
      const lastTktNum = allTripTicketNums.length > 0 ? Math.max(...allTripTicketNums) : null;
      const tktRangeStr = firstTktNum && lastTktNum
        ? `${firstTktNum} - ${lastTktNum}`
        : (firstTktNum || lastTktNum || null);

      setFilteredData({
        stageRows,
        grandFull,
        grandHalf,
        grandCollection,
        totalTickets,
        ticketRange: tktRangeStr,
      });
    } catch (e) {
      console.error('Error filtering tickets:', e);
      setFilteredData(null);
    } finally {
      setFiltering(false);
    }
}, [selStart, selDest, dashboard, posHook, autoStart,overrideStart]);

  const getPlaces = () =>
    isDownDirection(tripDir) ? [...places].reverse() : places;

  const getDisplayName = place => {
    if (!place) return '';
    const parts = place.label.split('-');
    return parts.slice(2).join(' ') || parts.slice(1).join(' ') || place.label;
  };

  const handlePrintStatusReport = async () => {
    if (!filteredData || filteredData.stageRows.length === 0) {
      Alert.alert('No data', 'No report data to print.');
      return;
    }

    const testingMode = await AsyncStorage.getItem('testing_mode');
    const isTestingMode = testingMode === 'true';

    if (isTestingMode) {
      setStatusModalData({
        stageRows: filteredData.stageRows,
        grandFull: filteredData.grandFull,
        grandCollection: filteredData.grandCollection,
        ticketRange: filteredData.ticketRange ?? null,
      });
      setShowStatusModal(true);
      return;
    }

    if (Platform.OS !== 'android' || !NyxPrinter) {
      Alert.alert('Not supported', 'Printing is only available on Android.');
      return;
    }
    try {
      const statusRet = await NyxPrinter.getPrinterStatus();
      if (statusRet !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(statusRet));
        return;
      }

      const padL = (s, w) => String(s).padEnd(w, ' ');
      const padR = (s, w) => String(s).padStart(w, ' ');
      const padC = (s, w) => { const str = String(s); const tot = w - str.length; const l = Math.floor(tot / 2); return ' '.repeat(l) + str + ' '.repeat(tot - l); };
      const fmtAmt = n => Number(n).toFixed(2);

      const DASH32 = '--------------------------------';
      const DASH_LIGHT = '- - - - - - - - - - - - - - - -';

      await NyxPrinter.printText('SPS TRANSPORT', { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText('STATUS REPORT', { textSize: 26, align: PrintAlign.CENTER, bold: true });
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });
      if (filteredData.ticketRange) {
        await NyxPrinter.printText(`TKT: ${filteredData.ticketRange}`, { textSize: 22, align: PrintAlign.CENTER });
      }

      const COL = { ss:6, es:6, f:5, h:5, l:5, p:5, amt:8 };
      const hdr =
        padL('SS', COL.ss) + padL('ES', COL.es) +
        padC('F', COL.f)   + padC('H', COL.h) +
        padC('L', COL.l)   + padC('P', COL.p) +
        padR('AMT', COL.amt);
      await NyxPrinter.printText(hdr, { textSize: 26 });
      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });

      for (const r of filteredData.stageRows) {
        const row =
          padL(r.ss,          COL.ss) + padL(r.es,      COL.es) +
          padC(r.f,           COL.f)  + padC(r.h,       COL.h)  +
          padC(r.l,           COL.l)  + padC(r.p ?? 0,  COL.p)  +
          padR(fmtAmt(r.amt), COL.amt);
        await NyxPrinter.printText(row, { textSize: 26 });
      }
      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });

      await NyxPrinter.printText(`FULL : ${filteredData.grandFull}`, { textSize: 26, align: PrintAlign.CENTER });
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      await NyxPrinter.printText(
        `${padL('TOT.COLL:', 12)}${padR(fmtAmt(filteredData.grandCollection), 8)}`,
        { textSize: 32 },
      );
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      await NyxPrinter.printEndAutoOut();
      showToast('Status report printed!');
    } catch (e) {
      Alert.alert('Print Error', e.message || 'Unknown');
    }
  };

  return (
    <>
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
     <Text className="text-zinc-500 text-[10px] font-bold tracking-widest mb-3">SELECT END PLACE</Text>

      {/* Route bar — FROM 30% / TO 70% */}
      <View className="flex-row gap-2 mb-4">
        {/* Start place — 30% */}
        <TouchableOpacity
          style={{ flex: 3 }}
          className="bg-zinc-900 rounded-2xl border border-zinc-800 px-3 py-3"
          onPress={() => { setShowStartDrop(!showStartDrop); setShowDestDrop(false); }}
          activeOpacity={0.8}
        >
          <View className="flex-row items-center gap-2 mb-1">
            <View className="w-6 h-6 rounded-full bg-zinc-800 items-center justify-center">
              <Navigation size={12} color="#71717a" />
            </View>
            <Text className="text-zinc-500 text-[9px] font-black tracking-widest" numberOfLines={1}>
              FROM
            </Text>
          </View>
          <Text className="text-zinc-300 text-sm font-bold" numberOfLines={1}>
            {getDisplayName(selStart)}
          </Text>
          {overrideStart && (
            <Text className="text-zinc-500 text-[9px] font-bold mt-1">CUSTOM</Text>
          )}
        </TouchableOpacity>

        {/* End place — 70% */}
        <TouchableOpacity
          style={{ flex: 7 }}
          className="bg-sky-500/15 rounded-2xl border border-sky-500/40 px-4 py-3"
          onPress={() => { setShowDestDrop(!showDestDrop); setShowStartDrop(false); }}
          activeOpacity={0.8}
        >
          <View className="flex-row items-center gap-2 mb-1">
            <View className="w-6 h-6 rounded-full bg-sky-500/30 items-center justify-center">
              <Navigation size={12} color="#38bdf8" />
            </View>
            <Text className="text-sky-300 text-[9px] font-black tracking-widest">TO (TAP TO CHANGE)</Text>
          </View>
          <View className="flex-row items-center justify-between">
            <Text className={`text-sm font-bold ${selDest ? 'text-white' : 'text-sky-200/80'}`} numberOfLines={1}>
              {selDest ? getDisplayName(selDest) : 'Select end place'}
            </Text>
            <View className="w-6 h-6 rounded-full bg-sky-500/30 items-center justify-center ml-2">
              <ArrowRight size={12} color="#0ea5e9" />
            </View>
          </View>
        </TouchableOpacity>
      </View>

      {/* Start override grid */}
      {showStartDrop && (
        <View className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden mb-4">
          <View className="flex-row flex-wrap">
            {getPlaces().map((p, idx) => {
              const isSelected = selStart?.key === p.key;
              const isDisabled = selDest?.key === p.key;
              const isNotLastInRow = (idx + 1) % 3 !== 0;
              return (
                <TouchableOpacity
                  key={`s-${p.key}`}
                  disabled={isDisabled}
                  onPress={() => { setOverrideStart(p); setShowStartDrop(false); }}
                  className={[
                    'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                    'border-b border-zinc-800',
                    isNotLastInRow ? 'border-r border-zinc-800' : '',
                    isSelected ? 'bg-sky-500/20' : '',
                    isDisabled ? 'opacity-50' : '',
                  ].join(' ')}
                  activeOpacity={0.8}
                >
                  <Text
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    className={`text-2xl font-black text-center ${isSelected ? 'text-sky-400' : 'text-white'}`}>
                    {p.label.split('-')[1]}
                  </Text>
                  <Text className="text-[11px] font-medium text-center text-zinc-300 w-full px-1" numberOfLines={1}>
                    {p.label.split('-')[2]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* End place grid */}
      {showDestDrop && (
        <View className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden mb-4">
          <View className="flex-row flex-wrap">
            {getPlaces().map((p, idx) => {
              const isSelected = selDest?.key === p.key;
              const isDisabled = selStart?.key === p.key;
              const isNotLastInRow = (idx + 1) % 3 !== 0;
              return (
                <TouchableOpacity
                  key={`d-${p.key}`}
                  disabled={isDisabled}
                  onPress={() => { setSelDest(p); setShowDestDrop(false); }}
                  className={[
                    'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                    'border-b border-zinc-800',
                    isNotLastInRow ? 'border-r border-zinc-800' : '',
                    isSelected ? 'bg-sky-500/20' : '',
                    isDisabled ? 'opacity-50' : '',
                  ].join(' ')}
                  activeOpacity={0.8}
                >
                  <Text
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    className={`text-2xl font-black text-center ${isSelected ? 'text-sky-400' : 'text-white'}`}>
                    {p.label.split('-')[1]}
                  </Text>
                  <Text className="text-[11px] font-medium text-center text-zinc-300 w-full px-1" numberOfLines={1}>
                    {p.label.split('-')[2]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
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
              <View className="flex-row gap-2 p-4">
                <StatChip
                  label="TICKETS"
                  value={filteredData.totalTickets}
                  color="text-white"
                />
                <StatChip
                  label="FULL"
                  value={filteredData.grandFull}
                  color="text-white"
                />
                {filteredData.grandHalf > 0 && (
                  <StatChip
                    label="HALF"
                    value={filteredData.grandHalf}
                    color="text-amber-400"
                  />
                )}
                <StatChip
                  label="TOTAL"
                  value={`₹${filteredData.grandCollection.toFixed(0)}`}
                  color="text-emerald-400"
                />
              </View>

              <View className="px-4 pb-4">
                <StageTable rows={filteredData.stageRows} />
              </View>

              {/* Print button */}
              <TouchableOpacity
                className="mx-4 mb-4 flex-row items-center justify-center gap-2 bg-sky-500 rounded-xl py-3.5"
                activeOpacity={0.8}
                onPress={handlePrintStatusReport}
              >
                <Download size={16} color="#fff" />
                <Text className="text-white text-sm font-bold">
                  Print Status Report
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {!filtering &&
            (!filteredData || filteredData.stageRows.length === 0) && (
              <View className="bg-zinc-900 rounded-2xl border border-zinc-800 p-8 items-center gap-2">
                <FileText size={28} color="#3f3f46" />
                <Text className="text-zinc-500 text-sm font-semibold">
                  No tickets found
                </Text>
                <Text className="text-zinc-700 text-xs">
                  No tickets issued between these stages today
                </Text>
              </View>
            )}
        </>
      )}

     {!selDest && (
        <View className="items-center justify-center py-16 gap-3">
          <View className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 items-center justify-center">
            <BarChart3 size={28} color="#3f3f46" />
          </View>
          <Text className="text-zinc-500 text-sm font-semibold">
            Select a route above
          </Text>
          <Text className="text-zinc-700 text-xs">
            Filtered stage report will appear here
          </Text>
        </View>
      )}
    </ScrollView>

    {/* ── Status Report Preview Modal (Testing Mode) ── */}
    <Modal
      visible={showStatusModal}
      transparent
      animationType="slide"
      onRequestClose={() => setShowStatusModal(false)}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.80)', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
        <View style={{ backgroundColor: '#18181b', borderRadius: 20, padding: 20, width: '100%', maxWidth: 380, borderWidth: 1, borderColor: '#3f3f46', maxHeight: '90%' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Print Preview</Text>
            <TouchableOpacity onPress={() => setShowStatusModal(false)}>
              <Text style={{ color: '#38bdf8', fontWeight: '700', fontSize: 14 }}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {statusModalData && (
              <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800', fontSize: 15, marginBottom: 4 }}>SPS TRANSPORT</Text>
                <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800', fontSize: 17, marginBottom: 6 }}>STATUS REPORT</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginBottom: 6 }}>{'--------------------------------'}</Text>
                <Text style={{ color: '#000', textAlign: 'center', fontSize: 12, marginBottom: 2 }}>TKT: {statusModalData.ticketRange ?? '—'}</Text>
                <View style={{ flexDirection: 'row', marginBottom: 2 }}>
                  {['SS','ES','F','H','L','P','AMT'].map((h, i) => (
                    <Text key={i} style={{ flex: i === 6 ? 2 : 1, textAlign: i === 6 ? 'right' : 'center', fontSize: 10, fontWeight: '800', color: '#333' }}>{h}</Text>
                  ))}
                </View>
                <Text style={{ color: '#aaa', textAlign: 'center', fontSize: 10, marginBottom: 2 }}>{'- - - - - - - - - - - - - - - -'}</Text>
                {(statusModalData.stageRows ?? []).map((r, i) => (
                  <View key={i} style={{ flexDirection: 'row', marginBottom: 1 }}>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#111', fontWeight: '700' }}>{r.ss}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#111', fontWeight: '700' }}>{r.es}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#333' }}>{r.f > 0 ? r.f : '—'}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#333' }}>{r.h > 0 ? r.h : '—'}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#333' }}>{r.l > 0 ? r.l : '0'}</Text>
                    <Text style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#333' }}>0</Text>
                    <Text style={{ flex: 2, textAlign: 'right', fontSize: 10, color: '#0369a1', fontWeight: '700' }}>₹{Number(r.amt).toFixed(0)}</Text>
                  </View>
                ))}
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginTop: 4, marginBottom: 4 }}>{'- - - - - - - - - - - - - - - -'}</Text>
                <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800', fontSize: 13, marginBottom: 2 }}>FULL : {statusModalData.grandFull}</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginBottom: 4 }}>{'--------------------------------'}</Text>
                <Text style={{ color: '#000', fontWeight: '800', fontSize: 14 }}>TOT.COLL:   ₹{Number(statusModalData.grandCollection).toFixed(2)}</Text>
              </View>
            )}
          </ScrollView>
          <TouchableOpacity
            style={{ backgroundColor: '#0ea5e9', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 4 }}
            onPress={() => setShowStatusModal(false)}
          >
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>OK</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
    </>
  );
};
// ─── Collection Report Tab ────────────────────────────────────────────────────
const parseAmount = v => {
  const n = Number(v);
  return !Number.isFinite(n) || n < 0 ? 0 : n;
};

const EXPENSE_PRESETS = [
  'Maintenance',
  'Fuel',
  'Parking',
  'Food',
];

const FIXED_EXPENSES = ['Diesel', 'Driver', 'Conductor', 'Tollgate', 'Pooja', 'Others'];

const CollectionReportTab = ({ dashboard, posHook, refreshing, onRefresh }) => {
  const [expenses, setExpenses] = useState(
    FIXED_EXPENSES.map((label, i) => ({ id: String(i + 1), label, amount: '0', fixed: true }))
  );
  const [showAddModal, setShowAddModal] = useState(false);
  const [customExpense, setCustomExpense] = useState('');

  const recentTrips = dashboard?.recent_trips ?? [];
  const posByTrip = (posHook?.tickets ?? []).reduce((acc, t) => {
    const key = t.trip_id ?? 'no_trip';
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});

  const todayTripIds = recentTrips
    .filter(t => {
      if (!t.start_time) return false;
      const localDate = new Date(t.start_time).toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      const todayLocal = new Date().toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      return localDate === todayLocal;
    })
    .map(t => t.trip_id);

  const allTripIds = [...new Set([...Object.keys(posByTrip), ...todayTripIds])];
  const backendTrip = id => recentTrips.find(t => t.trip_id === id);

  const totalExpenses = expenses.reduce(
    (s, e) => s + parseAmount(e.amount),
    0,
  );

  const tripRows = allTripIds.map((tripId, idx) => {
    const bt = backendTrip(tripId);
    const posTix = posByTrip[tripId] || [];
    const posAmt = posTix.reduce((s, t) => s + Number(t.fare || 0), 0);
    const appAmt = Number(bt?.collection ?? 0);
    const total = appAmt + posAmt;
    return {
      tripId,
      trip: bt?.trip_number ?? idx + 1,
      route: bt?.route_name || '—',
      appAmt,
      posAmt,
      amount: total,
    };
  }).sort((a, b) => {
    const an = Number(a.trip), bn = Number(b.trip);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    return String(a.trip).localeCompare(String(b.trip));
  });

  const totalCollection = tripRows.reduce((s, r) => s + r.amount, 0);
  const netTotal = totalCollection - totalExpenses;

  const addExpense = label => {
    setExpenses([...expenses, { id: Date.now().toString(), label, amount: '0' }]);
    setShowAddModal(false);
    setCustomExpense('');
  };

  const updateExpense = (id, amount) => {
    setExpenses(expenses.map(e => (e.id === id ? { ...e, amount } : e)));
  };

  const deleteExpense = id => {
    Alert.alert('Delete Expense', 'Remove this expense?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => setExpenses(expenses.filter(e => e.id !== id)),
      },
    ]);
  };

  const handlePrintCollectionReport = async () => {
    if (Platform.OS !== 'android' || !NyxPrinter) {
      Alert.alert('Not supported', 'Printing is only available on Android.');
      return;
    }
    if (tripRows.length === 0) {
      Alert.alert('No data', 'No collection data to print.');
      return;
    }
    try {
      const statusRet = await NyxPrinter.getPrinterStatus();
      if (statusRet !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(statusRet));
        return;
      }

      const padL = (s, w) => String(s).padEnd(w, ' ');
      const padR = (s, w) => String(s).padStart(w, ' ');
      const padC = (s, w) => { const str = String(s); const tot = Math.max(0, w - str.length); const l = Math.floor(tot / 2); return ' '.repeat(l) + str + ' '.repeat(tot - l); };
      const fmtAmt = n => Number(n).toFixed(2);

      const DASH32 = '--------------------------------';
      const DASH_LIGHT = '- - - - - - - - - - - - - - - -';

      const now = new Date();
      const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '/');
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      const busNo = dashboard?.recent_trips?.[0]?.bus_number ?? dashboard?.bus?.vehicle_number ?? 'N/A';

      // ── Header ──────────────────────────────────────────────────────────
      await NyxPrinter.printText('விண்ணப்பம் அலுவலகம்', { textSize: 20, align: PrintAlign.CENTER });
      await NyxPrinter.printText('COLLECTION REPORT', { textSize: 24, align: PrintAlign.CENTER, bold: true });
      await NyxPrinter.printText(`${dateStr}  ${timeStr}`, { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });
      await NyxPrinter.printText(`BUS NUMBER:${busNo}`, { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      // ── Trips table ─────────────────────────────────────────────────────
      // TripSheet uses textSize 26 with COL total = 40 (6+6+5+5+5+5+8).
      // So textSize 26 on 55mm = 40 chars full width.
      // TRIP(5) + ROUTE(7) + AMOUNT(28) = 40
      const LINE = 40;
      const C = { trip: 5, route: 7, amt: LINE - 5 - 7 }; // amt = 28
      const hdr = padL('TRIP', C.trip) + padC('ROUTE', C.route) + padR('AMOUNT', C.amt);
      await NyxPrinter.printText(hdr, { textSize: 26, bold: true });
      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });

      for (const r of tripRows) {
        const row =
          padL(String(r.trip), C.trip) +
          padC('01', C.route) +
          padR(fmtAmt(r.amount), C.amt);
        await NyxPrinter.printText(row, { textSize: 26 });
      }

      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });
      // "TOTAL Rs.:" left + amount right = 40
      await NyxPrinter.printText(
        `${padL('TOTAL Rs.:', 16)}${padR(fmtAmt(totalCollection), 24)}`,
        { textSize: 26, bold: true },
      );
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      // ── Expenses ────────────────────────────────────────────────────────
      await NyxPrinter.printText('EXPENSES', { textSize: 26, align: PrintAlign.CENTER, bold: true });
      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });

      // label(12) + " : "(3) + amount right-aligned in 25 = 40
      const expL = 12;
      const expSep = ' : ';
      const expA = LINE - expL - expSep.length; // 40 - 12 - 3 = 25
      const fixedLabels = FIXED_EXPENSES;
      for (const label of fixedLabels) {
        const exp = expenses.find(e => e.label.toUpperCase() === label.toUpperCase());
        const amt = exp ? parseAmount(exp.amount) : 0;
        const lbl = label.toUpperCase().substring(0, expL);
        await NyxPrinter.printText(
          `${padL(lbl, expL)}${expSep}${padR(fmtAmt(amt), expA)}`,
          { textSize: 26 },
        );
      }
      // Any extra (non-fixed) expenses
      for (const extraExp of expenses.filter(exp => !exp.fixed)) {
        const amt = parseAmount(extraExp.amount);
        const lbl = extraExp.label.toUpperCase().substring(0, expL);
        await NyxPrinter.printText(
          `${padL(lbl, expL)}${expSep}${padR(fmtAmt(amt), expA)}`,
          { textSize: 26 },
        );
      }

      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });
      await NyxPrinter.printText(
        `${padL('TOTAL Rs.:', 16)}${padR(fmtAmt(totalExpenses), 24)}`,
        { textSize: 26, bold: true },
      );
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      await NyxPrinter.printEndAutoOut();
      showToast('Collection report printed!');
    } catch (e) {
      Alert.alert('Print Error', e.message || 'Unknown');
    }
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
      {/* ── Receipt-style card ── */}
      <View className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden mb-4">

        {/* Receipt header */}
        <View className="bg-zinc-800/60 px-4 py-4 items-center border-b border-zinc-700">
          <Text className="text-zinc-300 text-base font-bold tracking-wide">
            COLLECTION REPORT
          </Text>
          <Text className="text-zinc-500 text-xs mt-1">
            {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '/')}{'  '}
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
          </Text>
          <Text className="text-zinc-400 text-xs font-bold mt-1">
            BUS: {dashboard?.recent_trips?.[0]?.bus_number ?? dashboard?.bus?.vehicle_number ?? 'N/A'}
          </Text>
        </View>

        {/* Trips table */}
        <View className="px-4 pt-3 pb-2">
          {/* Table header */}
          <View className="flex-row border-b border-zinc-700 pb-2 mb-1">
            <Text className="text-zinc-500 text-[11px] font-black tracking-widest" style={{ flex: 1.2 }}>TRIP</Text>
            <Text className="text-zinc-500 text-[11px] font-black tracking-widest text-center" style={{ flex: 1 }}>ROUTE</Text>
            <Text className="text-zinc-500 text-[11px] font-black tracking-widest text-right" style={{ flex: 2 }}>AMOUNT</Text>
          </View>

          {tripRows.length === 0 ? (
            <View className="py-6 items-center">
              <Text className="text-zinc-600 text-sm">No trips today</Text>
            </View>
          ) : (
            tripRows.map((row, i) => (
              <View key={i} className={`flex-row items-center py-2.5 ${i < tripRows.length - 1 ? 'border-b border-zinc-800/60' : ''}`}>
                <View style={{ flex: 1.2 }}>
                  <Text className="text-zinc-200 text-sm font-bold">{row.trip}</Text>
                  {(row.appAmt > 0 || row.posAmt > 0) && (
                    <View className="flex-row gap-2 mt-0.5">
                      {row.appAmt > 0 && (
                        <Text className="text-violet-400 text-[9px] font-bold">APP ₹{row.appAmt.toFixed(0)}</Text>
                      )}
                      {row.posAmt > 0 && (
                        <Text className="text-amber-400 text-[9px] font-bold">POS ₹{row.posAmt.toFixed(0)}</Text>
                      )}
                    </View>
                  )}
                </View>
                <Text className="text-zinc-400 text-sm font-bold text-center" style={{ flex: 1 }}>01</Text>
                <Text className="text-zinc-100 text-sm font-black text-right" style={{ flex: 2 }}>
                  {row.amount.toFixed(2)}
                </Text>
              </View>
            ))
          )}

          {/* Total collection */}
          <View className="flex-row items-center justify-between border-t border-zinc-700 pt-3 mt-2">
            <Text className="text-zinc-400 text-sm font-black tracking-wide">TOTAL Rs.:</Text>
            <Text className="text-sky-400 text-xl font-black">₹{totalCollection.toFixed(2)}</Text>
          </View>
        </View>

        {/* Divider */}
        <View className="mx-4 border-t border-dashed border-zinc-700 my-2" />

        {/* Expenses section */}
        <View className="px-4 pb-3">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-zinc-400 text-sm font-black tracking-widest">EXPENSES</Text>
            <TouchableOpacity
              onPress={() => setShowAddModal(true)}
              className="bg-zinc-800 border border-zinc-700 px-3 py-1 rounded-lg"
              activeOpacity={0.8}
            >
              <Text className="text-zinc-400 text-xs font-bold">+ Add</Text>
            </TouchableOpacity>
          </View>

          {/* Fixed expenses — always shown */}
          {expenses.filter(e => e.fixed).map(expense => (
            <View key={expense.id} className="flex-row items-center py-2 border-b border-zinc-800/50">
              <Text className="text-zinc-400 text-sm font-bold flex-1">
                {expense.label.toUpperCase()}
              </Text>
              <Text className="text-zinc-500 text-sm mr-3">:</Text>
              <TextInput
                className="text-zinc-100 text-sm font-bold text-right w-24"
                keyboardType="numeric"
                value={expense.amount}
                onChangeText={v => updateExpense(expense.id, v)}
                placeholder="0.00"
                placeholderTextColor="#52525b"
              />
            </View>
          ))}

          {/* Extra (non-fixed) expenses */}
          {expenses.filter(e => !e.fixed).map(expense => (
            <TouchableOpacity
              key={expense.id}
              onLongPress={() => deleteExpense(expense.id)}
              delayLongPress={500}
              activeOpacity={1}
              className="flex-row items-center py-2 border-b border-zinc-800/50"
            >
              <Text className="text-amber-400 text-sm font-bold flex-1">
                {expense.label.toUpperCase()}
              </Text>
              <Text className="text-zinc-500 text-sm mr-3">:</Text>
              <TextInput
                className="text-zinc-100 text-sm font-bold text-right w-24"
                keyboardType="numeric"
                value={expense.amount}
                onChangeText={v => updateExpense(expense.id, v)}
                placeholder="0.00"
                placeholderTextColor="#52525b"
              />
            </TouchableOpacity>
          ))}

          {/* Total expenses */}
          <View className="flex-row items-center justify-between pt-3 mt-1">
            <Text className="text-zinc-400 text-sm font-black tracking-wide">TOTAL Rs.:</Text>
            <Text className="text-amber-400 text-xl font-black">₹{totalExpenses.toFixed(2)}</Text>
          </View>
        </View>

        {/* Net total band */}
        <View className={`mx-4 mb-4 rounded-xl p-3 items-center ${
          netTotal >= 0 ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'
        }`}>
          <Text className="text-zinc-500 text-[10px] font-black tracking-widest mb-0.5">NET TOTAL</Text>
          <Text className={`text-2xl font-black ${
            netTotal >= 0 ? 'text-emerald-400' : 'text-red-400'
          }`}>₹{netTotal.toFixed(2)}</Text>
        </View>
      </View>

      {/* Print button */}
      <TouchableOpacity
        className="flex-row items-center justify-center gap-2 bg-emerald-600 rounded-xl py-3.5"
        activeOpacity={0.8}
        onPress={handlePrintCollectionReport}
      >
        <Download size={16} color="#fff" />
        <Text className="text-white text-sm font-bold">
          Print Collection Report
        </Text>
      </TouchableOpacity>

      {/* Add expense modal */}
      <Modal
        visible={showAddModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAddModal(false)}
      >
        <View className="flex-1 bg-black/60 justify-end">
          <View className="bg-zinc-900 rounded-t-3xl p-5 pb-8">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-white text-lg font-black">Add Extra Expense</Text>
              <TouchableOpacity onPress={() => setShowAddModal(false)}>
                <Text className="text-zinc-500 text-lg">✕</Text>
              </TouchableOpacity>
            </View>

            <Text className="text-zinc-500 text-xs font-bold tracking-widest mb-3">
              PRESETS
            </Text>
            <View className="flex-row flex-wrap gap-2 mb-4">
              {EXPENSE_PRESETS.map(preset => (
                <TouchableOpacity
                  key={preset}
                  onPress={() => addExpense(preset)}
                  className="bg-zinc-800 border border-zinc-700 px-4 py-2 rounded-full"
                  activeOpacity={0.8}
                >
                  <Text className="text-zinc-300 text-sm font-bold">{preset}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text className="text-zinc-500 text-xs font-bold tracking-widest mb-3">
              CUSTOM
            </Text>
            <View className="flex-row gap-3">
              <TextInput
                className="flex-1 bg-zinc-800 border border-zinc-700 text-white px-4 py-3 rounded-xl"
                value={customExpense}
                onChangeText={setCustomExpense}
                placeholder="Enter expense name..."
                placeholderTextColor="#52525b"
              />
              <TouchableOpacity
                onPress={() => {
                  if (customExpense.trim()) {
                    addExpense(customExpense.trim());
                  }
                }}
                className="bg-emerald-600 px-5 rounded-xl justify-center"
                activeOpacity={0.8}
                disabled={!customExpense.trim()}
              >
                <Text className="text-white text-sm font-bold">Add</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
};

// ─── Main Report Screen ───────────────────────────────────────────────────────
const ReportScreen = () => {
  const [activeTab, setActiveTab] = useState('tripsheet');
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reportCutoffIso, setReportCutoffIso] = useState(null);
  const { posHook } = useTripContext();
  const indicatorAnim = useRef(new Animated.Value(0)).current;
  const fetchingDashboardRef = useRef(false);

  const TABS = [
    { key: 'tripsheet', label: 'Trip Sheet', Icon: Receipt },
    { key: 'status', label: 'Status Report', Icon: BarChart3 },
    { key: 'collection', label: 'Coll. Report', Icon: DollarSign },
  ];

  const fetchDashboard = useCallback(async ({ showLoader = false, showRefresh = false } = {}) => {
    if (fetchingDashboardRef.current) return;
    fetchingDashboardRef.current = true;
    if (showLoader) setLoading(true);
    if (showRefresh) setRefreshing(true);
    try {
      const cutoffIso = await AsyncStorage.getItem(RESET_REPORT_CUTOFF_KEY);
      setReportCutoffIso(cutoffIso);
      const raw = await fetchDashboardFromSupabase();
      const filteredRecentTrips = (raw.recent_trips ?? []).filter(t =>
        isOnOrAfterCutoff(t?.start_time, cutoffIso),
      );
      const filteredActiveTrip = isOnOrAfterCutoff(raw.active_trip?.start_time, cutoffIso)
        ? raw.active_trip
        : null;
      setDashboard({
        ...raw,
        active_trip: filteredActiveTrip,
        recent_trips: filteredRecentTrips,
      });
    } catch (e) {
      console.error('[ReportScreen] dashboard fetch failed', e);
    } finally {
      fetchingDashboardRef.current = false;
      if (showLoader) setLoading(false);
      if (showRefresh) setRefreshing(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchDashboard({ showRefresh: true });
      await posHook.reload?.();
    } catch (e) {
      console.error('[ReportScreen] Refresh failed:', e);
    } finally {
      setRefreshing(false);
    }
  }, [fetchDashboard, posHook]);

  useEffect(() => {
    fetchDashboard({ showLoader: true });
  }, [fetchDashboard]);

  // Reload POS tickets when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      fetchDashboard();
      posHook.reload?.();
    }, [fetchDashboard, posHook]),
  );

  // Animate tab indicator
  useEffect(() => {
    const idx = TABS.findIndex(t => t.key === activeTab);
    Animated.spring(indicatorAnim, {
      toValue: idx,
      useNativeDriver: false,
      tension: 80,
      friction: 12,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const at = dashboard?.active_trip;
  const posSummary = posHook.todaySummary();
  const [todayAppCount, setTodayAppCount] = useState(null);

  useEffect(() => {
    if (!dashboard) return;
    const todayTrips = [
      ...(dashboard.active_trip?.trip_id ? [dashboard.active_trip] : []),
      ...(dashboard.recent_trips ?? []),
    ].filter(t => isOnOrAfterCutoff(t?.start_time, reportCutoffIso));
    const todayStr = new Date().toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const tripIds = todayTrips
      .filter(t => {
        if (!t.start_time) return false;
        return new Date(t.start_time).toLocaleDateString('en-IN', {
          timeZone: 'Asia/Kolkata',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }) === todayStr;
      })
      .map(t => t.trip_id)
      .filter(Boolean);
    const uniqueTripIds = [...new Set(tripIds)];
    if (uniqueTripIds.length === 0) { setTodayAppCount(0); return; }
    supabase
      .from('tickets')
      .select('ticket_count')
      .in('trip_id', uniqueTripIds)
      .neq('payment_method', 'pos')
      .then(({ data, error }) => {
        if (error || !data) { setTodayAppCount(0); return; }
        setTodayAppCount(data.reduce((s, r) => s + Number(r.ticket_count ?? 1), 0));
      });
  }, [dashboard, reportCutoffIso]);

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
          <Text className="text-white text-xl font-black tracking-tight">
            Reports
          </Text>
          <Text className="text-zinc-500 text-xs mt-0.5">
            {at?.trip_number ? `Active Trip #${at.trip_number} · ` : ''}
            {new Date().toLocaleDateString([], {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            })}
          </Text>
        </View>
        <TouchableOpacity
          onPress={onRefresh}
          disabled={refreshing}
          className="w-9 h-9 rounded-full bg-zinc-900 border border-zinc-800 items-center justify-center"
        >
          {refreshing ? (
            <ActivityIndicator size="small" color="#71717a" />
          ) : (
            <RefreshCw size={15} color="#71717a" />
          )}
        </TouchableOpacity>
      </View>

      {/* ── Summary chips ── */}
      <View className="flex-row gap-2 px-4 py-3">
        {[
          {
            label: 'Trips',
            val: dashboard?.recent_trips?.length ?? 0,
            color: 'text-sky-400',
            bg: 'bg-sky-500/10 border-sky-500/20',
          },
          {
            label: 'App Tickets',
            val: todayAppCount ?? 0,
            color: 'text-violet-400',
            bg: 'bg-violet-500/10 border-violet-500/20',
          },
          {
            label: 'POS',
            val: posSummary.count,
            color: 'text-amber-400',
            bg: 'bg-amber-500/10 border-amber-500/20',
          },
          {
            label: 'Today',
            val: `₹${(
              (dashboard?.today_stats?.total_collection ?? 0) + posSummary.total
            ).toFixed(0)}`,
            color: 'text-emerald-400',
            bg: 'bg-emerald-500/10 border-emerald-500/20',
          },
        ].map(c => (
          <View
            key={c.label}
            className={`flex-1 items-center rounded-xl py-2.5 border ${c.bg}`}
          >
            <Text className={`text-sm font-black ${c.color}`}>{c.val}</Text>
            <Text className="text-zinc-600 text-[9px] font-bold tracking-wider mt-0.5">
              {c.label.toUpperCase()}
            </Text>
          </View>
        ))}
      </View>

      {/* ── Tab bar ── */}
      <View className="mx-4 mb-2 bg-zinc-900/95 gap-2 rounded-2xl p-1.5 flex-row border border-zinc-700">
        {TABS.map((tab, i) => {
          const isActive = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.8}
              className={`flex-1 flex-row items-center justify-center gap-2 py-3 rounded-xl border ${
                isActive ? 'bg-sky-500 border-sky-300' : 'bg-zinc-800/80 border-zinc-700'
              }`}
            >
              {/* <tab.Icon size={16} color={isActive ? '#ffffff' : '#d4d4d8'} /> */}
              <Text
                className={`text-[12px] font-black tracking-wide ${
                  isActive ? 'text-white' : 'text-zinc-200'
                }`}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Content ── */}
      <View className="flex-1">
        {activeTab === 'tripsheet' && (
          <TripSheetTab
            dashboard={dashboard}
            posHook={posHook}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        )}
        {activeTab === 'status' && (
          <StatusReportTab
            dashboard={dashboard}
            posHook={posHook}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        )}
        {activeTab === 'collection' && (
          <CollectionReportTab
            dashboard={dashboard}
            posHook={posHook}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        )}
      </View>
    </SafeAreaView>
  );
};

export default ReportScreen;
