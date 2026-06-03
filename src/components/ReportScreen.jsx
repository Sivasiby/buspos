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
  Timer,
  Square,
  ArrowUpDown,
  FileText,
  DollarSign,
  Ticket,
  CreditCard,
  ChevronRight,
  ChevronLeft,
  RotateCcw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react-native';
import { supabase } from '../../lib/supabase';
import { useTripContext } from '../context/TripContext';
import TripChange, { startTripFromSupabase } from './TripChange';
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

// ─── Printer row builder (mirrors Test.jsx exactly) ──────────────────────────
const PRINT_COLS = [
  { key: 'ss',  w: 4 },
  { key: 'es',  w: 4 },
  { key: 'f',   w: 4 },
  { key: 'h',   w: 4 },
  { key: 'l',   w: 4 },
  { key: 'p',   w: 4 },
  { key: 'amt', w: 8 },
];
const FHLP_KEYS_P = new Set(['f', 'h', 'l', 'p']);
const padPrint = (val, width) => String(val).padStart(width, '0').slice(-width);
const normalizePrintRow = row =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      if (FHLP_KEYS_P.has(k)) return [k, padPrint(v, 2)];
      if (k === 'amt') return [k, padPrint(Math.round(Number(v)), 4)];
      if (k === 'ss' || k === 'es') return [k, String(Number(v)).padStart(2, '0')]; // strip leading zeros, keep 2-digit max
      return [k, v];
    })
  );
const buildPrintRow = (values = {}, normalize = false) => {
  const v = normalize ? normalizePrintRow(values) : values;
  return PRINT_COLS.map(col => {
    const raw = v[col.key] != null ? String(v[col.key]) : '';
    const padded = raw.slice(0, col.w).padEnd(col.w, ' ');
    return col.key === 'amt' ? padded.padStart(col.w + 1, ' ') : ' ' + padded;
  }).join('');
};
const PRINT_HEADER_VALUES = { ss: 'SS', es: 'ES', f: ' F', h: ' H', l: ' L', p: ' P', amt: ' AMT' };
const PRINT_DASH = '--------------------------------';
const PRINT_DASH_LIGHT = '- - - - - - - - - - - - - - - -';

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
const COLLECTION_REPORT_PRINTED_AT_KEY = 'collection_report_printed_at';

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
    const tt = (t.ticket_type ?? 'full').toLowerCase();
    if (tt === 'luggage') {
      map[k].l += cnt;
    } else if (tt === 'half') {
      map[k].h += cnt;
      const luggCnt = Number(t.luggage_amount ?? 0) > 0 ? 1 : 0;
      map[k].l += luggCnt;
    } else {
      map[k].f += cnt;
      const luggCnt = Number(t.luggage_amount ?? 0) > 0 ? 1 : 0;
      map[k].l += luggCnt;
    }
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
    const isLuggage = !isFree && tt === 'luggage';
    const fullCount = isFree || isHalf || isLuggage ? 0 : cnt;
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
    <Text className="text-zinc-500 text-[9px] font-bold tracking-widest mt-0.5" numberOfLines={1} adjustsFontSizeToFit>
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

// ─── Trip Tab Content ─────────────────────────────────────────────────────────
const TripTabContent = ({ dashboard, onRefreshDashboard, posHook, onNavigateToCollection }) => {
  const { setActiveTrip: setCtxTrip, setTripNumber: setCtxTripNumber, setBusNumber: setCtxBusNumber } = useTripContext();
  const [routes, setRoutes] = useState([]);
  const [startingReturn, setStartingReturn] = useState(false);
  const [endingTrip, setEndingTrip] = useState(false);
  const [appTicketCount, setAppTicketCount] = useState(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    supabase
      .from('routes')
      .select('id, route_name')
      .order('route_name')
      .then(({ data }) => {
        setRoutes((data ?? []).map(r => ({ id: r.id, name: r.route_name })));
      })
      .catch(() => {});
  }, []);

  const at = dashboard?.active_trip ?? null;

  useEffect(() => {
    if (!at?.trip_id) { setAppTicketCount(0); return; }
    supabase
      .from('tickets')
      .select('ticket_count')
      .eq('trip_id', at.trip_id)
      .neq('payment_method', 'pos')
      .then(({ data }) => {
        setAppTicketCount((data ?? []).reduce((s, r) => s + Number(r.ticket_count ?? 1), 0));
      })
      .catch(() => {});
  }, [at?.trip_id]);

  const syncContextAfterTrip = async () => {
    let dash = null;
    for (let i = 0; i < 6; i++) {
      dash = await fetchDashboardFromSupabase();
      if (dash?.active_trip?.trip_id) break;
      await new Promise(res => setTimeout(res, 700));
    }
    if (dash) {
      await onRefreshDashboard();
      setCtxTrip(dash?.active_trip ?? null);
      const dbTripNumber = Number(dash?.active_trip?.trip_number ?? 0);
      if (dbTripNumber > 0) setCtxTripNumber(dbTripNumber);
      if (dash?.bus?.vehicle_number) setCtxBusNumber(dash.bus.vehicle_number);
    }
  };

  const isCollectionReportPrintedRecently = async () => {
    try {
      const printedAt = await AsyncStorage.getItem(COLLECTION_REPORT_PRINTED_AT_KEY);
      if (!printedAt) return false;
      const printedTime = new Date(printedAt).getTime();
      const now = Date.now();
      const tenMinutes = 10 * 60 * 1000;
      return now - printedTime <= tenMinutes;
    } catch {
      return false;
    }
  };

  const handleEndTrip = async () => {
    if (!at) return;

    const printedRecently = await isCollectionReportPrintedRecently();
    if (!printedRecently) {
      Alert.alert(
        'Collection report is not taken',
        'Please print the collection report before ending the trip.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Print',
            onPress: () => {
              onNavigateToCollection?.();
            },
          },
        ]
      );
      return;
    }

    Alert.alert(
      'End trip?',
      'Are you sure you want to end the current trip?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End Trip',
          style: 'destructive',
          onPress: async () => {
            setEndingTrip(true);
            try {
              await supabase
                .from('trips')
                .update({ status: 'completed', expected_end_time: new Date().toISOString() })
                .eq('id', at.trip_id);

              // ── Full session reset (mirrors old TripScreen.handleEndTripWithMandatoryReport) ──
              const resetIso = new Date().toISOString();
              await AsyncStorage.setItem('trip_report_reset_after_iso', resetIso).catch(() => {});
              await AsyncStorage.setItem('active_trip_number', '0').catch(() => {});
              await AsyncStorage.multiRemove([
                'pos_tickets_v2',
                'pos_tickets_v1',
                'ticket_stops_up',
                'ticket_stops_dn',
                COLLECTION_REPORT_PRINTED_AT_KEY,
              ]).catch(() => {});
              if (posHook?.clearAll) await posHook.clearAll();

              // Clear context immediately
              setCtxTrip(null);
              setCtxTripNumber(0);

              showToast('Trip ended');
              await onRefreshDashboard();
            } catch (e) {
              Alert.alert('Error', e?.message || 'Could not end trip.');
            } finally {
              setEndingTrip(false);
            }
          },
        },
      ]
    );
  };

  const handleStartReturn = async (dir) => {
    if (!at) return;

    const printedRecently = await isCollectionReportPrintedRecently();
    if (!printedRecently) {
      Alert.alert(
        'Collection report is not taken',
        'Please print the collection report before switching trips.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Print',
            onPress: () => {
              onNavigateToCollection?.();
            },
          },
        ]
      );
      return;
    }

    Alert.alert(
      'Start return trip?',
      `This will end the current trip and start the return direction.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start',
          onPress: async () => {
            setStartingReturn(true);
            try {
              await supabase
                .from('trips')
                .update({ status: 'completed', expected_end_time: new Date().toISOString() })
                .eq('id', at.trip_id);
              const route = routes.find(r => r.name === at.route_name) ?? routes[0];
              if (!route) throw new Error('Route not found');
              await startTripFromSupabase({ routeId: route.id, direction: dir, busId: at.bus_id ?? null });
              await AsyncStorage.removeItem(COLLECTION_REPORT_PRINTED_AT_KEY).catch(() => {});
              showToast('Return trip started!');
              await syncContextAfterTrip();
            } catch (e) {
              Alert.alert('Error', e?.message || 'Could not switch trip.');
            } finally {
              setStartingReturn(false);
            }
          },
        },
      ]
    );
  };

  const handleStarted = async () => {
    await syncContextAfterTrip();
  };

  const posTripCount = at?.trip_id
    ? (posHook?.tickets ?? []).filter(t => t.trip_id === at.trip_id).reduce((s, t) => s + Number(t.ticket_count ?? 0), 0)
    : 0;
  const posTripFare = at?.trip_id
    ? (posHook?.tickets ?? []).filter(t => t.trip_id === at.trip_id).reduce((s, t) => s + Number(t.fare ?? 0), 0)
    : 0;
  const appTripFare = Number(at?.collection ?? 0);
  const totalFare = appTripFare + posTripFare;

  const isDown = (d) => ['dn', 'down', 'return'].includes((d ?? '').toString().trim().toLowerCase());
  const routeParts = (at?.route_name ?? '').split(/\s*(?:->|→|-)\s*/).map(p => p.trim()).filter(Boolean);
  const tripDisplay = at
    ? (routeParts.length >= 2
        ? (isDown(at.direction) ? `${routeParts[1]} → ${routeParts[0]}` : `${routeParts[0]} → ${routeParts[1]}`)
        : (at.route_name ?? ''))
    : '';

  return (
    <View className="px-4 pb-4">
      {at ? (
        <View className="bg-zinc-900 rounded-2xl p-5 border border-zinc-800 mb-4">
          {/* Header: #N - ROUTE  Running */}
          <View className="flex-row justify-between items-start mb-4">
            <View className="flex-1 mr-3 flex-row items-center flex-wrap">
              {at.trip_number > 0 && (
                <Text className="text-white text-2xl font-bold tracking-widest">#{at.trip_number} -{' '}</Text>
              )}
              <Text className="text-white text-2xl font-black leading-tight">{tripDisplay}</Text>
            </View>
            <View className="flex-row items-center gap-1.5 bg-sky-500/10 border border-sky-500/30 px-3 py-1.5 rounded-full">
              <Text className="text-sky-400 text-[11px] font-bold">Running</Text>
            </View>
          </View>

          {/* Meta row */}
          <View className="flex-row gap-4 mb-4 flex-wrap">
            <View className="flex-row items-center gap-1.5">
              <Clock size={12} color="#71717a" />
              <Text className="text-zinc-400 text-xs">Started {formatTime(at.start_time)}</Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <Timer size={12} color="#71717a" />
              <Text className="text-zinc-400 text-xs">{formatDuration(at.start_time)}</Text>
            </View>
            {(at.bus_number || dashboard?.bus?.vehicle_number) && (
              <View className="flex-row items-center gap-1.5">
                <Bus size={12} color="#71717a" />
                <Text className="text-zinc-400 text-xs">{at.bus_number ?? dashboard?.bus?.vehicle_number}</Text>
              </View>
            )}
          </View>

          {/* Stats row */}
          <View className="flex-row bg-zinc-800/60 rounded-xl p-4 mb-4">
            <View className="flex-1 items-center">
              <Text className="text-sky-400 text-2xl font-black">{appTicketCount}</Text>
              <Text className="text-zinc-500 text-[10px] font-semibold mt-0.5">APP TICKETS</Text>
            </View>
            <View className="w-px bg-zinc-700 mx-2" />
            <View className="flex-1 items-center">
              <Text className="text-violet-400 text-2xl font-black">{posTripCount}</Text>
              <Text className="text-zinc-500 text-[10px] font-semibold mt-0.5">POS TICKETS</Text>
            </View>
            <View className="w-px bg-zinc-700 mx-2" />
            <View className="flex-1 items-center">
              <Text className="text-emerald-400 text-2xl font-black">₹{Number(totalFare).toFixed(0)}</Text>
              <Text className="text-zinc-500 text-[10px] font-semibold mt-0.5">TOTAL</Text>
            </View>
          </View>

        </View>
      ) : null}

      <TripChange
        at={at}
        routes={routes}
        startingReturn={startingReturn}
        onStartReturn={handleStartReturn}
        onStarted={handleStarted}
      />

      {/* End Trip */}
      {at && (
        <TouchableOpacity
          className={`flex-row items-center justify-center gap-2 bg-red-500/10 border border-red-500/30 py-3 rounded-xl mt-4 ${endingTrip ? 'opacity-50' : ''}`}
          onPress={handleEndTrip}
          disabled={endingTrip}
        >
          {endingTrip
            ? <ActivityIndicator size="small" color="#f87171" />
            : <Square size={16} color="#f87171" />}
          <Text className="text-red-400 text-sm font-bold">End Trip</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

// ─── Trip Sheet Tab Content ───────────────────────────────────────────────────
const TripSheetTabContent = ({ dashboard, posHook, onRefresh, refreshKey }) => {
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [tripPage, setTripPage] = useState(0);
  const TRIPS_PER_PAGE = 4;
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

  // Static sort, always showing all (matches HomeScreen)
  const filterPlaces = useMemo(() => [...places].reverse(), []);

  // Quick filter ranges (static)
  const quickFilterRanges = useMemo(
    () => [
      { from: 18, to: 11 },
      { from: 11, to: 3 },
    ],
    [],
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
  }, [selectedTripId, refreshKey]);

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
  const grandLugg = stageRows.reduce((s, r) => s + (r.l ?? 0), 0);
  const grandCollection = stageRows.reduce((s, r) => s + r.amt, 0);
  const posTotal = posTix.reduce((s, t) => s + Number(t.fare || 0), 0);
  const appTotal = Number(appTrip?.collection ?? 0);
  const combinedTotal = appTotal + posTotal;

  // Stage-based amount split (003-011 and 011-018)
  // Note: 011 is only counted in the first split to avoid double counting
  const { amount003to011, amount011to018 } = (() => {
    let amt003to011 = 0;
    let amt011to018 = 0;
    for (const row of stageRows) {
      const ssNum = parseInt(row.ss, 10);
      if (!isNaN(ssNum)) {
        if (ssNum >= 3 && ssNum <= 11) amt003to011 += row.amt;
        if (ssNum >= 12 && ssNum <= 18) amt011to018 += row.amt;
      }
    }
    return { amount003to011: amt003to011, amount011to018: amt011to018 };
  })();

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

    // Calculate stage-based splits for print
    // Note: 011 is only counted in the first split to avoid double counting
    const printAmount003to011 = rowsToPrint.reduce((s, r) => {
      const ssNum = parseInt(r.ss, 10);
      return s + (!isNaN(ssNum) && ssNum >= 3 && ssNum <= 11 ? r.amt : 0);
    }, 0);
    const printAmount011to018 = rowsToPrint.reduce((s, r) => {
      const ssNum = parseInt(r.ss, 10);
      return s + (!isNaN(ssNum) && ssNum >= 12 && ssNum <= 18 ? r.amt : 0);
    }, 0);

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
        ? `${firstTicketNum} - ${lastTicketNum} = ${lastTicketNum - firstTicketNum + 1}`
        : (firstTicketNum || lastTicketNum || null);

      const printGrandLuggModal = rowsToPrint.reduce((s, r) => s + (r.l ?? 0), 0);
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
        grandLugg: printGrandLuggModal,
        grandCollection: printGrandCollection,
        combinedTotal: printCombinedTotal,
        amount003to011: printAmount003to011,
        amount011to018: printAmount011to018,
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

      const opts = { textSize: 27 };
      const boldOpts = { textSize: 27, bold: true };
      const fmtAmt = n => Number(n).toFixed(2);

      const startDt = report.start_time ? new Date(report.start_time) : new Date();
      const dateStr = startDt.toLocaleDateString('en-GB').replace(/\//g, '/');
      const timeStr = startDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

      const selectedTrip = trips.find(t => t.trip_id === selectedTripId);
      const busNo = report.bus_number ?? dashboard?.bus?.vehicle_number ?? 'N/A';
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
        ? `${firstTicketNum} - ${lastTicketNum} = ${lastTicketNum - firstTicketNum + 1}`
        : (firstTicketNum || lastTicketNum || null);

      const center22 = { textSize: 22, align: PrintAlign.CENTER };
      await NyxPrinter.printText('SPS TRANSPORT', center22);
      await NyxPrinter.printText('TRIP SHEET', { textSize: 26, align: PrintAlign.CENTER, bold: true });

      const headerBlock = [
        PRINT_DASH,
        isFiltered ? `FILTERED: ${getFilterDisplayName(filterStart)} -> ${getFilterDisplayName(filterEnd)}` : null,
        `BUS:${busNo}  TRIP No.:${tripNum}`,
        `${dateStr} ${timeStr}`,
        ticketRangeStr ? `TKT:${ticketRangeStr}` : null,
        PRINT_DASH,
        buildPrintRow(PRINT_HEADER_VALUES),
      ].filter(Boolean).join('\n');
      await NyxPrinter.printText(headerBlock, { textSize: 27 });

      const tableBody = rowsToPrint
        .map(r => buildPrintRow({ ss: r.ss, es: r.es, f: r.f, h: r.h, l: r.l, p: r.p ?? 0, amt: r.amt }, true))
        .join('\n');
      await NyxPrinter.printText(tableBody, opts);

      const printGrandLugg = rowsToPrint.reduce((s, r) => s + (r.l ?? 0), 0);
      const footerLines = [
        PRINT_DASH_LIGHT,
        `FULL : ${printGrandFull}`,
        printGrandHalf > 0 ? `HALF : ${printGrandHalf}` : null,
        printGrandLugg > 0 ? `LUGG : ${printGrandLugg}` : null,
        PRINT_DASH,
        `003-011:    ${fmtAmt(printAmount003to011)}`,
        `011-018:    ${fmtAmt(printAmount011to018)}`,
        PRINT_DASH_LIGHT,
        `TRIP.COLL:  ${fmtAmt(printGrandCollection)}`,
        `TOT.COLL:   ${fmtAmt(printCombinedTotal)}`,
        PRINT_DASH,
      ].filter(Boolean).join('\n');
      await NyxPrinter.printText(footerLines, boldOpts);

      await NyxPrinter.printEndAutoOut();
      showToast('Trip sheet printed!');
    } catch (e) {
      Alert.alert('Print Error', e.message || 'Unknown');
    }
  };

  return (
    <>
    <View className="px-4 pb-4">
      {/* Trip selector */}
      <View className="mb-3">
        <Text className="text-zinc-500 text-[10px] font-bold tracking-widest">
          SELECT TRIP
        </Text>
      </View>
      <View className="flex-row items-center gap-2 mb-5">
        {tripPage > 0 && (
          <TouchableOpacity
            onPress={() => setTripPage(p => p - 1)}
            className="justify-center items-center px-2 py-3 rounded-2xl bg-zinc-900 border border-zinc-800"
          >
            <ChevronLeft size={20} color="#d4d4d8" />
          </TouchableOpacity>
        )}
        <View className="flex-1 flex-row gap-2">
          {trips.length === 0 && (
            <View className="bg-zinc-900 border border-zinc-800 rounded-2xl px-5 py-3 flex-1">
              <Text className="text-zinc-500 text-sm">No trips found</Text>
            </View>
          )}
          {trips.slice(tripPage * TRIPS_PER_PAGE, (tripPage + 1) * TRIPS_PER_PAGE).map(trip => {
            const isSelected = selectedTripId === trip.trip_id;
            return (
              <TouchableOpacity
                key={trip.trip_id}
                onPress={() =>
                  setSelectedTripId(isSelected ? null : trip.trip_id)
                }
                activeOpacity={0.75}
                className={`flex-1 rounded-2xl px-2 py-3 border ${
                  isSelected
                    ? 'bg-sky-500 border-sky-400'
                    : 'bg-zinc-900 border-zinc-800'
                }`}
              >
                {trip.isActive && (
                  <View className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-emerald-400" />
                )}
                {/* <Text
                  className={`text-[10px] font-bold tracking-wider ${
                    isSelected ? 'text-sky-100' : 'text-zinc-400'
                  }`}
                >
                  Trip
                </Text> */}
                <Text
                  className={`text-center text-2xl font-black leading-tight ${
                    isSelected ? 'text-white' : 'text-zinc-100'
                  }`}
                >
                  {trip.trip_number ? `#${trip.trip_number}` : '#—'}
                </Text>
                {/* <Text
                  className={`text-[10px] mt-1 ${
                    isSelected ? 'text-sky-100' : 'text-zinc-500'
                  }`}
                  numberOfLines={1}
                >
                  {routeLabel(trip.route_name, trip.direction)?.split(' ')[0] ??
                    '—'}
                </Text> */}
                {/* <Text
                  className={`text-[10px] mt-0.5 ${
                    isSelected ? 'text-sky-100' : 'text-zinc-600'
                  }`}
                >
                  {formatTime(trip.start_time)}
                </Text> */}
              </TouchableOpacity>
            );
          })}
        </View>
        {(tripPage + 1) * TRIPS_PER_PAGE < trips.length && (
          <TouchableOpacity
            onPress={() => setTripPage(p => p + 1)}
            className="justify-center items-center px-2 py-3 rounded-2xl bg-zinc-900 border border-zinc-800"
          >
            <ChevronRight size={20} color="#d4d4d8" />
          </TouchableOpacity>
        )}
      </View>

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
                <Text className="text-white text-xl font-black leading-tight">
                  {routeLabel(report.route_name, report.direction)}
                </Text>
              </View>
              <View className="flex-row items-center gap-3">
                <View className="flex-row items-center gap-1">
                  <Clock size={11} color="#71717a" />
                  <Text className="text-zinc-400 text-xs">
                    {formatTime(report.start_time)}
                  </Text>
                </View>
                <StatusPill status={report.status ?? 'completed'} />
              </View>
            </View>
          </View>

          {/* Stats */}
          <View className="flex-row gap-2 p-4">
            <StatChip label="FULL" value={grandFull} color="text-white" />
            {grandHalf > 0 && (
              <StatChip label="HALF" value={grandHalf} color="text-amber-400" />
            )}
            {grandLugg > 0 && (
              <StatChip label="LUGG" value={grandLugg} color="text-orange-400" />
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
            <View className="flex-row bg-zinc-900/95 gap-2 rounded-2xl p-1.5 border border-zinc-700 mt-3 mb-2">
              <TouchableOpacity
                className={`flex-1 flex-row items-center justify-center py-3 rounded-xl border ${
                  tableTab === 'full' ? 'bg-sky-500 border-sky-300' : 'bg-zinc-800/80 border-zinc-700'
                }`}
                onPress={() => setTableTab('full')}
                activeOpacity={0.8}
              >
                <Text
                  className={`text-center text-xs font-bold ${
                    tableTab === 'full' ? 'text-white' : 'text-zinc-200'
                  }`}
                >
                  FULL
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                className={`flex-1 flex-row items-center justify-center py-3 rounded-xl border ${
                  tableTab === 'filtered' ? 'bg-sky-500 border-sky-300' : 'bg-zinc-800/80 border-zinc-700'
                }`}
                onPress={() => setTableTab('filtered')}
                activeOpacity={0.8}
              >
                <Text
                  className={`text-center text-xs font-bold ${
                    tableTab === 'filtered' ? 'text-white' : 'text-zinc-200'
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
                    className="flex-row items-center justify-center gap-1.5 rounded-xl px-4 py-3"
                    style={{ backgroundColor: '#89F336' }}
                    activeOpacity={0.8}
                    onPress={handlePrintTripSheet}
                  >
                    <Download size={14} color="#000" />
                    <Text className="text-black text-xs font-bold">Print</Text>
                  </TouchableOpacity>
                </View>
                <StageTable rows={stageRows} />
                <View className="bg-sky-500/10 border border-sky-500/20 rounded-xl px-4 py-3 mt-3">
                  <View className="flex-row justify-between items-center mb-2">
                    <Text className="text-zinc-400 text-xs font-bold">003-011</Text>
                    <Text className="text-zinc-300 text-base font-bold">₹{amount003to011.toFixed(2)}</Text>
                  </View>
                  <View className="flex-row justify-between items-center mb-2">
                    <Text className="text-zinc-400 text-xs font-bold">011-018</Text>
                    <Text className="text-zinc-300 text-base font-bold">₹{amount011to018.toFixed(2)}</Text>
                  </View>
                  <View className="border-t border-sky-500/30 pt-2 mt-1">
                    <View className="flex-row justify-between items-center">
                      <Text className="text-zinc-300 text-sm font-bold">TRP TOTAL</Text>
                      <Text className="text-sky-400 text-xl font-black">₹{grandCollection.toFixed(2)}</Text>
                    </View>
                  </View>
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
              <View className="bg-zinc-900/95 rounded-2xl border border-zinc-700 p-1.5 mb-3">
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
                        className={`flex-1 items-center justify-center py-3 rounded-xl border ${
                          isActive
                            ? 'bg-sky-500 border-sky-300'
                            : 'bg-zinc-800/80 border-zinc-700'
                        }`}
                        onPress={() => applyQuickRange(range.from, range.to)}
                        activeOpacity={0.8}
                      >
                        <Text
                          className={`text-center text-xs font-bold ${
                            isActive ? 'text-white' : 'text-zinc-200'
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
                {/* ── Stop Selector ── */}
                <View className="flex-row items-stretch bg-black rounded-xl border border-white/20 mb-3 overflow-hidden">
                  {/* FROM */}
                  <TouchableOpacity
                    className={`flex-1 px-3 py-3 ${showFilterStartDrop ? 'bg-black' : ''}`}
                    onPress={() => {
                      if (showFilterStartDrop) {
                        setShowFilterStartDrop(false);
                      } else {
                        setShowFilterStartDrop(true);
                        setShowFilterEndDrop(false);
                      }
                    }}>
                    <Text className="text-white text-xs font-bold tracking-widest mb-1">FROM</Text>
                    {filterStart ? (
                      <View className="flex-row items-baseline gap-1">
                        <Text className="text-sky-400 text-2xl font-black leading-7">
                          {String(stageNumFromPlace(filterStart)).padStart(3, '0')}
                        </Text>
                        <Text className="text-white text-sm font-medium flex-shrink" numberOfLines={1}>
                          {getFilterDisplayName(filterStart)}
                        </Text>
                      </View>
                    ) : (
                      <Text className="text-white text-sm">Select start</Text>
                    )}
                  </TouchableOpacity>

                  {/* Swap */}
                  <TouchableOpacity
                    className={`w-10 items-center justify-center border-x border-white/20 ${(!filterStart || !filterEnd) ? 'opacity-30' : ''}`}
                    onPress={() => {
                      if (filterStart && filterEnd) {
                        const temp = filterStart;
                        setFilterStart(filterEnd);
                        setFilterEnd(temp);
                      }
                    }}
                    disabled={!filterStart || !filterEnd}>
                    <ArrowUpDown size={15} color="#ffffff" />
                  </TouchableOpacity>

                  {/* TO */}
                  <TouchableOpacity
                    className={`flex-1 px-3 py-3 ${showFilterEndDrop ? 'bg-black' : ''}`}
                    onPress={() => {
                      if (showFilterEndDrop) {
                        setShowFilterEndDrop(false);
                      } else {
                        setShowFilterEndDrop(true);
                        setShowFilterStartDrop(false);
                      }
                    }}>
                    <Text className="text-white text-xs font-bold tracking-widest mb-1">TO</Text>
                    {filterEnd ? (
                      <View className="flex-row items-baseline gap-1">
                        <Text className="text-orange-400 text-2xl font-black leading-7">
                          {String(stageNumFromPlace(filterEnd)).padStart(3, '0')}
                        </Text>
                        <Text className="text-white text-sm font-medium flex-shrink" numberOfLines={1}>
                          {getFilterDisplayName(filterEnd)}
                        </Text>
                      </View>
                    ) : (
                      <Text className="text-white text-sm">Select end</Text>
                    )}
                  </TouchableOpacity>
                </View>

                {/* ── Stop Grid (Start) ── */}
                {showFilterStartDrop && (
                  <View className="bg-black rounded-xl mb-3 overflow-hidden" style={{ borderWidth: 2, borderColor: '#38bdf8' }}>
                    <View className="flex-row flex-wrap">
                      {filterPlaces.map((p, idx) => {
                        const isSel = filterStart?.key === p.key;
                        const isOtherSel = filterEnd?.key === p.key;
                        const isNotLastInRow = (idx + 1) % 3 !== 0;
                        const borderColor = '#38bdf8';
                        return (
                          <TouchableOpacity
                            key={`fs-${p.key}`}
                            onPress={() => {
                              if (isOtherSel) {
                                setFilterEnd(null);
                              }
                              setFilterStart(p);
                              setShowFilterStartDrop(false);
                              setShowFilterEndDrop(true);
                            }}
                            style={{
                              borderBottomWidth: 2,
                              borderBottomColor: borderColor,
                              borderRightWidth: isNotLastInRow ? 2 : 0,
                              borderRightColor: borderColor,
                            }}
                            className={[
                              'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                              isSel ? 'bg-sky-950' : '',
                              isOtherSel ? 'opacity-60' : '',
                            ].join(' ')}>
                            <Text
                              numberOfLines={1}
                              adjustsFontSizeToFit
                              className={`text-2xl font-black text-center ${isSel ? 'text-sky-400' : isOtherSel ? 'text-orange-400' : 'text-white'}`}>
                              {p.label.split('-')[1]}
                            </Text>
                            <Text className={`text-[11px] font-medium text-center w-full px-1 ${isSel ? 'text-white' : 'text-white'}`} numberOfLines={1}>
                              {p.label.split('-')[2]}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}

                {/* ── Stop Grid (End) ── */}
                {showFilterEndDrop && (
                  <View className="bg-black rounded-xl mb-3 overflow-hidden" style={{ borderWidth: 2, borderColor: '#fb923c' }}>
                    <View className="flex-row flex-wrap">
                      {filterPlaces.map((p, idx) => {
                        const isSel = filterEnd?.key === p.key;
                        const isOtherSel = filterStart?.key === p.key;
                        const isNotLastInRow = (idx + 1) % 3 !== 0;
                        const borderColor = '#fb923c';
                        return (
                          <TouchableOpacity
                            key={`fe-${p.key}`}
                            onPress={() => {
                              if (isOtherSel) {
                                setFilterStart(null);
                              }
                              setFilterEnd(p);
                              setShowFilterEndDrop(false);
                            }}
                            style={{
                              borderBottomWidth: 2,
                              borderBottomColor: borderColor,
                              borderRightWidth: isNotLastInRow ? 2 : 0,
                              borderRightColor: borderColor,
                            }}
                            className={[
                              'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                              isSel ? 'bg-orange-950' : '',
                              isOtherSel ? 'opacity-60' : '',
                            ].join(' ')}>
                            <Text
                              numberOfLines={1}
                              adjustsFontSizeToFit
                              className={`text-2xl font-black text-center ${isSel ? 'text-orange-400' : isOtherSel ? 'text-sky-400' : 'text-white'}`}>
                              {p.label.split('-')[1]}
                            </Text>
                            <Text className={`text-[11px] font-medium text-center w-full px-1 ${isSel ? 'text-white' : 'text-white'}`} numberOfLines={1}>
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
                        className="flex-1 flex-row items-center justify-center gap-1.5 rounded-xl px-4 py-3"
                        style={{ backgroundColor: '#89F336' }}
                        activeOpacity={0.8}
                        onPress={handlePrintTripSheet}
                      >
                        <Download size={14} color="#000" />
                        <Text className="text-black text-xs font-bold">Print</Text>
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
    </View>

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
                <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800', fontSize: 13, marginBottom: 2 }}>FULL : {printModalData.grandFull}{printModalData.grandHalf > 0 ? `  HALF : ${printModalData.grandHalf}` : ''}{printModalData.grandLugg > 0 ? `  LUGG : ${printModalData.grandLugg}` : ''}</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginBottom: 4 }}>{'--------------------------------'}</Text>
                <Text style={{ color: '#000', fontWeight: '800', fontSize: 14, marginBottom: 1 }}>003-011:    ₹{Number(printModalData.amount003to011 ?? 0).toFixed(2)}</Text>
                <Text style={{ color: '#000', fontWeight: '800', fontSize: 14, marginBottom: 1 }}>011-018:    ₹{Number(printModalData.amount011to018 ?? 0).toFixed(2)}</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginTop: 4, marginBottom: 4 }}>{'- - - - - - - - - - - - - - - -'}</Text>
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

// ─── Status Report Tab Content ────────────────────────────────────────────────
const StatusReportTabContent = ({ dashboard, posHook, onRefresh }) => {
  const [selDest, setSelDest] = useState(null);
  const [overrideStart, setOverrideStart] = useState(null);
  const [showStartDrop, setShowStartDrop] = useState(false);
  const [showDestDrop, setShowDestDrop] = useState(false);
  const [activeDrop, setActiveDrop] = useState('destination'); // 'start' or 'destination'
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

      // P. In — passengers currently on the bus (from filtered stage rows)
      const pIn = grandFull + grandHalf;
      
      // TOT — total passengers for the whole trip (all tickets, not filtered)
      const totalAppPassengers = allAppRows.reduce((s, r) => {
        const tt = (r.ticket_type ?? 'full').toLowerCase();
        return tt === 'luggage' ? s : s + Number(r.ticket_count ?? 1);
      }, 0);
      const totalPosPassengers = allPosTix.reduce((s, t) => {
        if ((t.ticket_type ?? 'full').toLowerCase() === 'luggage') return s;
        return s + Number(t.ticket_count ?? 0);
      }, 0);
      const tot = totalAppPassengers + totalPosPassengers;

      // P. OUT — passengers already exited (toCode before selected stage)
      const exitedAppCount = allAppRows.reduce((s, r) => {
        if ((r.ticket_type ?? 'full').toLowerCase() === 'luggage') return s;
        const toCode = parseInt(stageCodeFromName(r.to_name), 10);
        if (isNaN(toCode)) return s;
        const exited = goingDown ? toCode > destNum : toCode < destNum;
        return exited ? s + Number(r.ticket_count ?? 1) : s;
      }, 0);
      const exitedPosCount = allPosTix.reduce((s, t) => {
        if ((t.ticket_type ?? 'full').toLowerCase() === 'luggage') return s;
        const toCode = parseInt(stageCode(t.to_stop), 10);
        if (isNaN(toCode)) return s;
        const exited = goingDown ? toCode > destNum : toCode < destNum;
        if (!exited) return s;
        return s + Number(t.ticket_count ?? 0);
      }, 0);
      const pOut = exitedAppCount + exitedPosCount;

      // P. OUT next stage — passengers exiting at the very next stage
      const nextStageNum = goingDown ? destNum - 1 : destNum + 1;
      const nextStageLabel = String(nextStageNum).padStart(3, '0');
      
      // Debug logging
      console.log('[DEBUG] Status Report - next stage calculation:');
      console.log('  destNum:', destNum, 'goingDown:', goingDown);
      console.log('  nextStageNum:', nextStageNum, 'nextStageLabel:', nextStageLabel);
      const nextAppCount = allAppRows.reduce((s, r) => {
        const toCode = parseInt(stageCodeFromName(r.to_name), 10);
        return toCode === nextStageNum ? s + Number(r.ticket_count ?? 1) : s;
      }, 0);
      const nextPosCount = allPosTix.reduce((s, t) => {
        if ((t.ticket_type ?? 'full').toLowerCase() === 'luggage') return s;
        const toCode = parseInt(stageCode(t.to_stop), 10);
        if (toCode !== nextStageNum) return s;
        return s + Number(t.ticket_count ?? 0);
      }, 0);
      const pOutNext = nextAppCount + nextPosCount;

      // Ticket number range: from all POS tickets for this trip
      const allTripTicketNums = allPosTix.map(t => Number(t.ticket_number)).filter(n => !isNaN(n) && n > 0);
      const firstTktNum = allTripTicketNums.length > 0 ? Math.min(...allTripTicketNums) : null;
      const lastTktNum = allTripTicketNums.length > 0 ? Math.max(...allTripTicketNums) : null;
      const tktRangeStr = firstTktNum && lastTktNum
        ? `${firstTktNum} - ${lastTktNum} = ${lastTktNum - firstTktNum + 1}`
        : (firstTktNum || lastTktNum || null);

      setFilteredData({
        stageRows,
        grandFull,
        grandHalf,
        grandCollection,
        totalTickets,
        pIn,
        tot,
        pOut,
        pOutNext,
        nextStageLabel,
        ticketRange: tktRangeStr,
      });
    } catch (e) {
      console.error('Error filtering tickets:', e);
      setFilteredData(null);
    } finally {
      setFiltering(false);
    }
}, [selStart, selDest, dashboard, posHook, autoStart,overrideStart]);

  const getPlaces = () => [...places].reverse(); // Static sort, always showing all

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
      const destNum = selDest?.label ? parseInt(selDest.label.split('-')[1], 10) : null;
      const destName = selDest?.label ? selDest.label.split('-').slice(2).join(' ') : '';
      const modalGrandHalf = filteredData.stageRows.reduce((s, r) => s + (r.h ?? 0), 0);
      const modalGrandLugg = filteredData.stageRows.reduce((s, r) => s + (r.l ?? 0), 0);
      setStatusModalData({
        stageRows: filteredData.stageRows,
        grandFull: filteredData.grandFull,
        grandHalf: modalGrandHalf,
        grandLugg: modalGrandLugg,
        grandCollection: filteredData.grandCollection,
        ticketRange: filteredData.ticketRange ?? null,
        pIn: filteredData.pIn,
        pOut: filteredData.pOut,
        pOutNext: filteredData.pOutNext,
        nextStageLabel: filteredData.nextStageLabel,
        tot: filteredData.tot,
        stageName: !isNaN(destNum) && destName ? `${destName} (${String(destNum).padStart(2, '0')})` : null,
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

      const opts = { textSize: 27 };
      const boldOpts = { textSize: 27, bold: true };
      const fmtAmt = n => Number(n).toFixed(2);

      const center22 = { textSize: 22, align: PrintAlign.CENTER };
      await NyxPrinter.printText('SPS TRANSPORT', center22);
      await NyxPrinter.printText('STATUS REPORT', { textSize: 26, align: PrintAlign.CENTER, bold: true });

      // Get stage info for header
      const destNum = selDest?.label ? parseInt(selDest.label.split('-')[1], 10) : null;
      const destName = selDest?.label ? selDest.label.split('-').slice(2).join(' ') : '';
      const stageLine = !isNaN(destNum) && destName ? `STAGE: ${destName} (${String(destNum).padStart(2, '0')})` : null;

      const headerBlock = [
        PRINT_DASH,
        stageLine,
        filteredData.ticketRange ? `TKT: ${filteredData.ticketRange}` : null,
        PRINT_DASH,
        buildPrintRow(PRINT_HEADER_VALUES),
      ].filter(Boolean).join('\n');
      await NyxPrinter.printText(headerBlock, { textSize: 27 });

      const tableBody = filteredData.stageRows
        .map(r => buildPrintRow({ ss: r.ss, es: r.es, f: r.f, h: r.h, l: r.l, p: r.p ?? 0, amt: r.amt }, true))
        .join('\n');
      await NyxPrinter.printText(tableBody, opts);

      const statusGrandHalf = filteredData.stageRows.reduce((s, r) => s + (r.h ?? 0), 0);
      const statusGrandLugg = filteredData.stageRows.reduce((s, r) => s + (r.l ?? 0), 0);
      const footerBlock = [
        PRINT_DASH_LIGHT,
        `FULL : ${filteredData.grandFull}`,
        statusGrandHalf > 0 ? `HALF : ${statusGrandHalf}` : null,
        statusGrandLugg > 0 ? `LUGG : ${statusGrandLugg}` : null,
        PRINT_DASH,
        `P.IN: ${filteredData.pIn}`,
        `P.OUT: ${filteredData.pOut}`,
        `P.OUT ${filteredData.nextStageLabel}:${filteredData.pOutNext}`,
        `TOT: ${filteredData.tot}`,
        PRINT_DASH_LIGHT,
        `TOT.COLL:   ${fmtAmt(filteredData.grandCollection)}`,
        PRINT_DASH,
      ].filter(Boolean).join('\n');
      await NyxPrinter.printText(footerBlock, boldOpts);

      await NyxPrinter.printEndAutoOut();
      showToast('Status report printed!');
    } catch (e) {
      Alert.alert('Print Error', e.message || 'Unknown');
    }
  };

  return (
    <>
    <View className="px-4 pb-4">
     <View className="mb-3">
        <Text className="text-zinc-500 text-[10px] font-bold tracking-widest">SELECT END PLACE</Text>
      </View>

      {/* ── Stop Selector ── */}
      <View className="flex-row items-stretch bg-black rounded-xl border border-white/20 mb-4 overflow-hidden">
        {/* FROM */}
        <TouchableOpacity
          className={`flex-1 px-3 py-3 ${activeDrop === 'start' ? 'bg-black' : ''}`}
          onPress={() => {
            if (activeDrop === 'start' && showStartDrop) {
              setShowStartDrop(false);
            } else {
              setActiveDrop('start');
              setShowStartDrop(true);
              setShowDestDrop(false);
            }
          }}>
          <Text className="text-white text-xs font-bold tracking-widest mb-1">FROM</Text>
          <View className="flex-row items-baseline gap-1">
            <Text className="text-sky-400 text-2xl font-black leading-7">
              {selStart?.label?.split('-')[1]?.padStart(3, '0') || '---'}
            </Text>
            <Text className="text-white text-sm font-medium flex-shrink" numberOfLines={1}>
              {getDisplayName(selStart)}
            </Text>
          </View>
        </TouchableOpacity>

        {/* Swap */}
        <TouchableOpacity
          className={`w-10 items-center justify-center border-x border-white/20 ${(!selStart || !selDest) ? 'opacity-30' : ''}`}
          onPress={() => {
            if (selStart && selDest) {
              const currentStart = selStart;
              const currentDest = selDest;
              setOverrideStart(currentDest);
              setSelDest(currentStart);
            }
          }}
          disabled={!selStart || !selDest}>
          <ArrowUpDown size={15} color="#ffffff" />
        </TouchableOpacity>

        {/* TO */}
        <TouchableOpacity
          className={`flex-1 px-3 py-3 ${activeDrop === 'destination' ? 'bg-black' : ''}`}
          onPress={() => {
            if (activeDrop === 'destination' && showDestDrop) {
              setShowDestDrop(false);
            } else {
              setActiveDrop('destination');
              setShowDestDrop(true);
              setShowStartDrop(false);
            }
          }}>
          <Text className="text-white text-xs font-bold tracking-widest mb-1">TO</Text>
          {selDest ? (
            <View className="flex-row items-baseline gap-1">
              <Text className="text-orange-400 text-2xl font-black leading-7">
                {selDest?.label?.split('-')[1]?.padStart(3, '0') || '---'}
              </Text>
              <Text className="text-white text-sm font-medium flex-shrink" numberOfLines={1}>
                {getDisplayName(selDest)}
              </Text>
            </View>
          ) : (
            <Text className="text-white text-sm">Select stop</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Stop Grid (Start) ── */}
      {showStartDrop && (
        <View className="bg-black rounded-xl mb-4 overflow-hidden" style={{ borderWidth: 2, borderColor: '#38bdf8' }}>
          <View className="flex-row flex-wrap">
            {getPlaces().map((p, idx) => {
              const isSel = selStart?.key === p.key;
              const isOtherSel = selDest?.key === p.key;
              const isNotLastInRow = (idx + 1) % 3 !== 0;
              const borderColor = '#38bdf8';
              return (
                <TouchableOpacity
                  key={`s-${p.key}`}
                  onPress={() => {
                    if (isOtherSel) {
                      setSelDest(null);
                      setOverrideStart(p);
                      setActiveDrop('destination');
                    } else {
                      setOverrideStart(p);
                      setActiveDrop('destination');
                    }
                    setShowStartDrop(false);
                    setShowDestDrop(true);
                  }}
                  style={{
                    borderBottomWidth: 2,
                    borderBottomColor: borderColor,
                    borderRightWidth: isNotLastInRow ? 2 : 0,
                    borderRightColor: borderColor,
                  }}
                  className={[
                    'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                    isSel ? 'bg-sky-950' : '',
                    isOtherSel ? 'opacity-60' : '',
                  ].join(' ')}>
                  <Text
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    className={`text-2xl font-black text-center ${isSel ? 'text-sky-400' : isOtherSel ? 'text-orange-400' : 'text-white'}`}>
                    {p.label.split('-')[1]}
                  </Text>
                  <Text className={`text-[11px] font-medium text-center w-full px-1 ${isSel ? 'text-white' : 'text-white'}`} numberOfLines={1}>
                    {p.label.split('-')[2]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* ── Stop Grid (End) ── */}
      {showDestDrop && (
        <View className="bg-black rounded-xl mb-4 overflow-hidden" style={{ borderWidth: 2, borderColor: '#fb923c' }}>
          <View className="flex-row flex-wrap">
            {getPlaces().map((p, idx) => {
              const isSel = selDest?.key === p.key;
              const isOtherSel = selStart?.key === p.key;
              const isNotLastInRow = (idx + 1) % 3 !== 0;
              const borderColor = '#fb923c';
              return (
                <TouchableOpacity
                  key={`d-${p.key}`}
                  onPress={() => {
                    if (isOtherSel) {
                      setOverrideStart(null);
                      setSelDest(p);
                      setActiveDrop('start');
                    } else {
                      setSelDest(p);
                    }
                    setShowDestDrop(false);
                  }}
                  style={{
                    borderBottomWidth: 2,
                    borderBottomColor: borderColor,
                    borderRightWidth: isNotLastInRow ? 2 : 0,
                    borderRightColor: borderColor,
                  }}
                  className={[
                    'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                    isSel ? 'bg-orange-950' : '',
                    isOtherSel ? 'opacity-60' : '',
                  ].join(' ')}>
                  <Text
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    className={`text-2xl font-black text-center ${isSel ? 'text-orange-400' : isOtherSel ? 'text-sky-400' : 'text-white'}`}>
                    {p.label.split('-')[1]}
                  </Text>
                  <Text className={`text-[11px] font-medium text-center w-full px-1 ${isSel ? 'text-white' : 'text-white'}`} numberOfLines={1}>
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
                  label="P. IN"
                  value={filteredData.pIn}
                  color="text-white"
                />
                <StatChip
                  label="P. OUT"
                  value={filteredData.pOut}
                  color="text-rose-400"
                />
                <StatChip
                  label={`P. OUT ${filteredData.nextStageLabel}`}
                  value={filteredData.pOutNext}
                  color="text-amber-400"
                />
                <StatChip
                  label="TOT"
                  value={filteredData.tot}
                  color="text-violet-400"
                />
              </View>
              
              <View className="flex-row items-center justify-between px-4 pb-2">
                <StatChip
                  label="TOTAL"
                  value={`₹${filteredData.grandCollection.toFixed(0)}`}
                  color="text-emerald-400"
                />
                <TouchableOpacity
                  className="flex-row items-center gap-1.5 rounded-xl px-4 py-2.5"
                  style={{ backgroundColor: '#89F336' }}
                  activeOpacity={0.8}
                  onPress={handlePrintStatusReport}
                >
                  <Download size={14} color="#000" />
                  <Text className="text-black text-xs font-bold">Print Status Report</Text>
                </TouchableOpacity>
              </View>

              <View className="px-4 pb-4">
                <StageTable rows={filteredData.stageRows} />
              </View>
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
    </View>

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
                {statusModalData.stageName && (
                  <Text style={{ color: '#000', textAlign: 'center', fontSize: 13, marginBottom: 2, fontWeight: '700' }}>STAGE: {statusModalData.stageName}</Text>
                )}
                <Text style={{ color: '#000', textAlign: 'center', fontSize: 12, marginBottom: 2 }}>TKT: {statusModalData.ticketRange ?? '—'}</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginBottom: 4 }}>{'--------------------------------'}</Text>
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
                <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800', fontSize: 13, marginBottom: 2 }}>FULL : {statusModalData.grandFull}{statusModalData.grandHalf > 0 ? `  HALF : ${statusModalData.grandHalf}` : ''}{statusModalData.grandLugg > 0 ? `  LUGG : ${statusModalData.grandLugg}` : ''}</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginBottom: 4 }}>{'--------------------------------'}</Text>
                <Text style={{ color: '#000', fontWeight: '800', fontSize: 14, marginBottom: 1 }}>P.IN: {statusModalData.pIn}</Text>
                <Text style={{ color: '#000', fontWeight: '800', fontSize: 14, marginBottom: 1 }}>P.OUT: {statusModalData.pOut}</Text>
                <Text style={{ color: '#000', fontWeight: '800', fontSize: 14, marginBottom: 1 }}>P.OUT {statusModalData.nextStageLabel}:{statusModalData.pOutNext}</Text>
                <Text style={{ color: '#000', fontWeight: '800', fontSize: 14, marginBottom: 1 }}>TOT: {statusModalData.tot}</Text>
                <Text style={{ color: '#555', textAlign: 'center', fontSize: 11, marginTop: 4, marginBottom: 4 }}>{'- - - - - - - - - - - - - - - -'}</Text>
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

const CollectionReportTabContent = ({ dashboard, posHook, onRefresh }) => {
  const [expenses, setExpenses] = useState(
    FIXED_EXPENSES.map((label, i) => ({ id: String(i + 1), label, amount: '0', fixed: true }))
  );
  const [showAddModal, setShowAddModal] = useState(false);
  const [customExpense, setCustomExpense] = useState('');
  const [showTestModal, setShowTestModal] = useState(false);
  const [testModalData, setTestModalData] = useState(null);
  const [expensesCollapsed, setExpensesCollapsed] = useState(true);

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

  // Calculate ticket number range from all POS tickets for today
  const today = new Date().toDateString();
  const todayPosTickets = (posHook?.tickets ?? []).filter(t =>
    new Date(t.issued_at).toDateString() === today
  );
  const todayTicketNums = todayPosTickets
    .map(t => Number(t.ticket_number))
    .filter(n => !isNaN(n) && n > 0);
  const firstTicketNum = todayTicketNums.length > 0 ? Math.min(...todayTicketNums) : null;
  const lastTicketNum = todayTicketNums.length > 0 ? Math.max(...todayTicketNums) : null;
  const ticketRangeStr = firstTicketNum && lastTicketNum
    ? `${firstTicketNum} - ${lastTicketNum}`
    : (firstTicketNum || lastTicketNum || '—');

  // Calculate total tickets (POS + App) for today
  const totalPosTickets = todayPosTickets.length;
  const totalAppTickets = recentTrips
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
    .reduce((sum, t) => sum + (t.tickets_sold ?? 0), 0);
  const totalTickets = totalPosTickets + totalAppTickets;

  const tripRows = allTripIds.map((tripId, idx) => {
    const bt = backendTrip(tripId);
    const posTix = posByTrip[tripId] || [];
    const posAmt = posTix.reduce((s, t) => s + Number(t.fare || 0), 0);
    const appAmt = Number(bt?.collection ?? 0);
    const total = appAmt + posAmt;
    // Per-trip stage split from POS tickets
    let pos003to011 = 0, pos011to018 = 0;
    for (const t of posTix) {
      const ssNum = parseInt(stageCode(t.from_stop), 10);
      const fare = Number(t.fare || 0);
      if (!isNaN(ssNum)) {
        if (ssNum >= 3 && ssNum <= 11) pos003to011 += fare;
        if (ssNum >= 12 && ssNum <= 18) pos011to018 += fare;
      }
    }
    return {
      tripId,
      trip: bt?.trip_number ?? idx + 1,
      route: bt?.route_name || '—',
      appAmt,
      posAmt,
      amount: total,
      amt003to011: pos003to011,
      amt011to018: pos011to018,
    };
  }).sort((a, b) => {
    const an = Number(a.trip), bn = Number(b.trip);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    return String(a.trip).localeCompare(String(b.trip));
  });

  const totalCollection = tripRows.reduce((s, r) => s + r.amount, 0);
  const netTotal = totalCollection - totalExpenses;
  const collSplit003to011 = tripRows.reduce((s, r) => s + r.amt003to011, 0);
  const collSplit011to018 = tripRows.reduce((s, r) => s + r.amt011to018, 0);

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
    const testingMode = await AsyncStorage.getItem('testing_mode');
    const isTestingMode = testingMode === 'true';

    if (!isTestingMode && (Platform.OS !== 'android' || !NyxPrinter)) {
      Alert.alert('Not supported', 'Printing is only available on Android.');
      return;
    }
    if (tripRows.length === 0) {
      Alert.alert('No data', 'No collection data to print.');
      return;
    }

    // Prepare data for print/test
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '/');
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const busNo = dashboard?.recent_trips?.[0]?.bus_number ?? dashboard?.bus?.vehicle_number ?? 'N/A';

    if (isTestingMode) {
      setTestModalData({
        dateStr,
        timeStr,
        busNo,
        tripRows,
        totalCollection,
        totalExpenses,
        netTotal,
        expenses: expenses.map(e => ({ ...e, parsedAmount: parseAmount(e.amount) })),
        ticketRangeStr,
        totalTickets,
        collSplit003to011,
        collSplit011to018,
      });
      setShowTestModal(true);
      await AsyncStorage.setItem(COLLECTION_REPORT_PRINTED_AT_KEY, new Date().toISOString());
      showToast('Testing mode: collection report modal shown');
      return;
    }

    try {
      const statusRet = await NyxPrinter.getPrinterStatus();
      if (statusRet !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(statusRet));
        return;
      }

      const opts = { textSize: 26 };
      const boldOpts = { textSize: 26, bold: true };
      const fmtAmt = n => Number(n).toFixed(2);
      const padL = (s, w) => String(s).padEnd(w, ' ');
      const padR = (s, w) => String(s).padStart(w, ' ');
      const padC = (s, w) => { const str = String(s); const tot = Math.max(0, w - str.length); const l = Math.floor(tot / 2); return ' '.repeat(l) + str + ' '.repeat(tot - l); };

      // ── Header ──────────────────────────────────────────────────────────
      await NyxPrinter.printText('COLLECTION REPORT', { textSize: 26, align: PrintAlign.CENTER, bold: true });

      const headerBlock = [
        `${dateStr}  ${timeStr}`,
        PRINT_DASH,
        `BUS NUMBER:${busNo}`,
        PRINT_DASH,
      ].join('\n');
      await NyxPrinter.printText(headerBlock, { textSize: 22, align: PrintAlign.CENTER });

      // ── Trips table ─────────────────────────────────────────────────────
      // Tr.(4) + Rt.(4) + 3-11(9) + 11-18(9) + Tot(10) = 36 chars — fits at textSize 26
      const C = { trip: 4, route: 4, col1: 9, col2: 9, tot: 10 };
      const hdr = padL('Tr.', C.trip) + padL('Rt.', C.route) + padR('3-11', C.col1) + padR('11-18', C.col2) + padR('Tot', C.tot);
      await NyxPrinter.printText(hdr, boldOpts);
      await NyxPrinter.printText(' ', { textSize: 8 });

      const tripTableBody = tripRows
        .map(r =>
          padL(String(r.trip), C.trip) +
          padL('01', C.route) +
          padR(fmtAmt(r.amt003to011 ?? 0), C.col1) +
          padR(fmtAmt(r.amt011to018 ?? 0), C.col2) +
          padR(fmtAmt(r.amount), C.tot)
        )
        .join('\n');
      await NyxPrinter.printText(tripTableBody, opts);

      const totRow =
        padL('', C.trip + C.route) +
        padR(fmtAmt(collSplit003to011), C.col1) +
        padR(fmtAmt(collSplit011to018), C.col2) +
        padR(fmtAmt(totalCollection), C.tot);

      // expL(10) + expSep(3) + expA(23) = 36 chars — fits at textSize 26
      const expL = 10;
      const expSep = ' : ';
      const expA = 23;

      const expenseLabels = [
        ...FIXED_EXPENSES.map(label => {
          const exp = expenses.find(e => e.label.toUpperCase() === label.toUpperCase());
          return `${padL(label.toUpperCase().substring(0, expL), expL)}${expSep}${padR(fmtAmt(exp ? parseAmount(exp.amount) : 0), expA)}`;
        }),
        ...expenses.filter(exp => !exp.fixed).map(extraExp =>
          `${padL(extraExp.label.toUpperCase().substring(0, expL), expL)}${expSep}${padR(fmtAmt(parseAmount(extraExp.amount)), expA)}`
        ),
      ];

      const expenseBlock = expenseLabels.join('\n');

      const footerBlock = [
        PRINT_DASH_LIGHT,
        totRow,
        PRINT_DASH,
        'EXPENSES',
        expenseBlock,
        PRINT_DASH_LIGHT,
        `TOTAL Rs.:  ${fmtAmt(totalExpenses)}`,
        PRINT_DASH,
      ].join('\n');
      await NyxPrinter.printText(footerBlock, boldOpts);

      // Expenses batched in footerBlock above

      await NyxPrinter.printEndAutoOut();
      await AsyncStorage.setItem(COLLECTION_REPORT_PRINTED_AT_KEY, new Date().toISOString());
      showToast('Collection report printed!');
    } catch (e) {
      Alert.alert('Print Error', e.message || 'Unknown');
    }
  };

  return (
    <>
    <View className="px-4 pb-4">
      {/* ── Collection Report Card (matches Trip Sheet style) ── */}
      <View className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden mb-4">

        {/* Header band (matching Trip Sheet style) */}
        <View className="bg-sky-500/10 border-b border-sky-500/20 px-5 py-4">
          <View className="flex-row items-start justify-between">
            <View className="flex-1 mr-3">
              <Text className="text-zinc-500 text-[9px] font-black tracking-widest mb-1">
               Today's 
              </Text>
              <Text className="text-white text-xl font-black leading-tight">
                 COLLECTION REPORT
              </Text>
            </View>
          </View>

          {/* Meta row */}
          <View className="flex-row flex-wrap gap-x-4 gap-y-1 mt-3">
            <View className="flex-row items-center gap-1">
              <Clock size={11} color="#71717a" />
              <Text className="text-zinc-400 text-xs">
                {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '/')}{' '}
                {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
              </Text>
            </View>
            <View className="flex-row items-center gap-1">
              <Bus size={11} color="#71717a" />
              <Text className="text-zinc-400 text-xs">
                {dashboard?.recent_trips?.[0]?.bus_number ?? dashboard?.bus?.vehicle_number ?? 'N/A'}
              </Text>
            </View>
            <View className="flex-row items-center gap-1">
              <Ticket size={11} color="#71717a" />
              <Text className="text-zinc-400 text-xs">
                {ticketRangeStr}
              </Text>
            </View>
            <View className="flex-row items-center gap-1">
              <BarChart3 size={11} color="#71717a" />
              <Text className="text-zinc-400 text-xs">
                {totalTickets} TIX
              </Text>
            </View>
          </View>
        </View>

        {/* Stats row */}
        <View className="flex-row gap-2 p-4">
          <StatChip label="COLLECTION" value={`₹${totalCollection.toFixed(0)}`} color="text-sky-400" />
          <StatChip label="EXPENSES" value={`₹${totalExpenses.toFixed(0)}`} color="text-amber-400" />
          <StatChip
            label="NET"
            value={`₹${netTotal.toFixed(0)}`}
            color={netTotal >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
        </View>

        {/* Trips table */}
        <View className="px-4 pt-2 pb-2">
          {/* Table header: TRIP | RTE | 3-11 | 11-18 | TOTAL */}
          <View className="flex-row border-b border-zinc-700 pb-2 mb-1">
            <Text className="text-zinc-500 text-[10px] font-black" style={{ flex: 0.8 }}>TRIP</Text>
            <Text className="text-zinc-500 text-[10px] font-black text-center" style={{ flex: 0.6 }}>RTE</Text>
            <Text className="text-zinc-500 text-[10px] font-black text-right" style={{ flex: 1.2 }}>3-11</Text>
            <Text className="text-zinc-500 text-[10px] font-black text-right" style={{ flex: 1.2 }}>11-18</Text>
            <Text className="text-zinc-500 text-[10px] font-black text-right" style={{ flex: 1.2 }}>TOTAL</Text>
          </View>

          {tripRows.length === 0 ? (
            <View className="py-6 items-center">
              <Text className="text-zinc-600 text-sm">No trips today</Text>
            </View>
          ) : (
            tripRows.map((row, i) => (
              <View key={i} className={`flex-row items-center py-2 ${i < tripRows.length - 1 ? 'border-b border-zinc-800/60' : ''}`}>
                <Text className="text-zinc-200 text-sm font-bold" style={{ flex: 0.8 }}>{row.trip}</Text>
                <Text className="text-zinc-400 text-xs font-bold text-center" style={{ flex: 0.6 }}>01</Text>
                <Text className="text-zinc-100 text-sm font-black text-right" style={{ flex: 1.2 }}>
                  {row.amt003to011.toFixed(2)}
                </Text>
                <Text className="text-zinc-100 text-sm font-black text-right" style={{ flex: 1.2 }}>
                  {row.amt011to018.toFixed(2)}
                </Text>
                <Text className="text-zinc-100 text-sm font-black text-right" style={{ flex: 1.2 }}>
                  {row.amount.toFixed(2)}
                </Text>
              </View>
            ))
          )}

          {/* Totals row */}
          <View className="flex-row items-center border-t border-zinc-700 pt-3 mt-2">
            <Text className="text-zinc-400 text-xs font-black" style={{ flex: 0.8 }} />
            <Text style={{ flex: 0.6 }} />
            <Text className="text-sky-400 text-sm font-black text-right" style={{ flex: 1.2 }}>
              {collSplit003to011.toFixed(2)}
            </Text>
            <Text className="text-sky-400 text-sm font-black text-right" style={{ flex: 1.2 }}>
              {collSplit011to018.toFixed(2)}
            </Text>
            <Text className="text-sky-400 text-base font-black text-right" style={{ flex: 1.2 }}>
              ₹{totalCollection.toFixed(2)}
            </Text>
          </View>
        </View>

        {/* Divider */}
        <View className="mx-4 border-t border-dashed border-zinc-700 my-2" />

        {/* Expenses section - Collapsible */}
        <View className="px-4 pb-3">
          <TouchableOpacity
            onPress={() => setExpensesCollapsed(!expensesCollapsed)}
            activeOpacity={0.8}
            className="flex-row items-center justify-between py-3 border-t border-zinc-700"
          >
            <View className="flex-row items-center gap-2">
              <Text className="text-zinc-400 text-sm font-black tracking-widest">EXPENSES</Text>
              <View className="bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">
                <Text className="text-amber-400 text-[10px] font-bold">₹{totalExpenses.toFixed(0)}</Text>
              </View>
            </View>
            <View className="flex-row items-center gap-2">
              {!expensesCollapsed && (
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation(); setShowAddModal(true); }}
                  className="bg-zinc-800 border border-zinc-700 px-3 py-1 rounded-lg"
                  activeOpacity={0.8}
                >
                  <Text className="text-zinc-400 text-xs font-bold">+ Add</Text>
                </TouchableOpacity>
              )}
              <View className="w-6 h-6 rounded-full bg-zinc-800 items-center justify-center">
                {expensesCollapsed ? (
                  <ChevronDown size={16} color="#a1a1aa" />
                ) : (
                  <ChevronUp size={16} color="#a1a1aa" />
                )}
              </View>
            </View>
          </TouchableOpacity>

          {/* Expenses content - shown when not collapsed */}
          {!expensesCollapsed && (
            <>
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
            </>
          )}
        </View>
      </View>

      {/* Print button */}
      <TouchableOpacity
        className="flex-row items-center justify-center gap-2 rounded-xl py-3.5"
        style={{ backgroundColor: '#89F336' }}
        activeOpacity={0.8}
        onPress={handlePrintCollectionReport}
      >
        <Download size={16} color="#000" />
        <Text className="text-black text-sm font-bold">
          Print Collection Report
        </Text>
      </TouchableOpacity>
    </View>

    {/* ── Test Mode Modal ── */}
    <Modal
      visible={showTestModal}
      transparent
      animationType="fade"
      onRequestClose={() => setShowTestModal(false)}
    >
      <View className="flex-1 bg-black/70 justify-center items-center p-4">
        <View className="bg-zinc-900 rounded-2xl p-5 w-full max-w-md border border-zinc-700">
          <View className="flex-row justify-between items-center mb-4">
            <Text className="text-white text-lg font-black">Collection Report Preview</Text>
            <TouchableOpacity onPress={() => setShowTestModal(false)}>
              <Text className="text-zinc-500 text-lg">✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView className="max-h-96">
            {testModalData && (
              <View className="bg-white rounded-xl p-4">
                {/* Header */}
                <Text className="text-black text-center font-bold text-lg">COLLECTION REPORT</Text>
                <Text className="text-gray-600 text-center text-sm">{testModalData.dateStr}  {testModalData.timeStr}</Text>
                <View className="border-t border-gray-400 my-2" />
                <Text className="text-black text-center text-sm font-bold">BUS NUMBER: {testModalData.busNo}</Text>
                <View className="border-t border-gray-400 my-2" />

                {/* Ticket Info */}
                <View className="flex-row justify-between mb-2">
                  <Text className="text-gray-600 text-xs">Ticket Nos: {testModalData.ticketRangeStr}</Text>
                  <Text className="text-gray-600 text-xs">Total: {testModalData.totalTickets}</Text>
                </View>
                <View className="border-t border-gray-300 my-1" />

                {/* Trips */}
                <View className="flex-row mb-1">
                  <Text style={{ flex: 0.8, fontSize: 9, fontWeight: '800', color: '#333' }}>TRIP</Text>
                  <Text style={{ flex: 0.6, fontSize: 9, fontWeight: '800', color: '#333', textAlign: 'center' }}>RTE</Text>
                  <Text style={{ flex: 1.2, fontSize: 9, fontWeight: '800', color: '#333', textAlign: 'right' }}>3-11</Text>
                  <Text style={{ flex: 1.2, fontSize: 9, fontWeight: '800', color: '#333', textAlign: 'right' }}>11-18</Text>
                  <Text style={{ flex: 1.2, fontSize: 9, fontWeight: '800', color: '#333', textAlign: 'right' }}>TOTAL</Text>
                </View>
                {testModalData.tripRows.map((row, i) => (
                  <View key={i} className="flex-row py-0.5">
                    <Text style={{ flex: 0.8, fontSize: 11, fontWeight: '700', color: '#000' }}>{row.trip}</Text>
                    <Text style={{ flex: 0.6, fontSize: 11, color: '#555', textAlign: 'center' }}>01</Text>
                    <Text style={{ flex: 1.2, fontSize: 11, fontWeight: '700', color: '#000', textAlign: 'right' }}>{(row.amt003to011 ?? 0).toFixed(2)}</Text>
                    <Text style={{ flex: 1.2, fontSize: 11, fontWeight: '700', color: '#000', textAlign: 'right' }}>{(row.amt011to018 ?? 0).toFixed(2)}</Text>
                    <Text style={{ flex: 1.2, fontSize: 11, fontWeight: '700', color: '#000', textAlign: 'right' }}>{row.amount.toFixed(2)}</Text>
                  </View>
                ))}
                <View className="border-t border-gray-300 my-1" />
                <View className="flex-row py-1">
                  <Text style={{ flex: 0.8 }} />
                  <Text style={{ flex: 0.6 }} />
                  <Text style={{ flex: 1.2, fontSize: 11, fontWeight: '800', color: '#0369a1', textAlign: 'right' }}>{Number(testModalData.collSplit003to011 ?? 0).toFixed(2)}</Text>
                  <Text style={{ flex: 1.2, fontSize: 11, fontWeight: '800', color: '#0369a1', textAlign: 'right' }}>{Number(testModalData.collSplit011to018 ?? 0).toFixed(2)}</Text>
                  <Text style={{ flex: 1.2, fontSize: 12, fontWeight: '800', color: '#0369a1', textAlign: 'right' }}>{testModalData.totalCollection.toFixed(2)}</Text>
                </View>
                <View className="border-t border-gray-400 my-2" />

                {/* Expenses */}
                <Text className="text-black text-center font-bold text-sm mb-2">EXPENSES</Text>
                <View className="border-t border-gray-300 my-1" />
                {testModalData.expenses.filter(e => e.parsedAmount > 0 || e.fixed).map((exp, i) => (
                  <View key={i} className="flex-row justify-between py-0.5">
                    <Text className="text-gray-700 text-sm">{exp.label.toUpperCase()}</Text>
                    <Text className="text-black text-sm">: {exp.parsedAmount.toFixed(2)}</Text>
                  </View>
                ))}
                <View className="border-t border-gray-300 my-1" />
                <View className="flex-row justify-between py-1">
                  <Text className="text-black text-sm font-bold">TOTAL Rs.:</Text>
                  <Text className="text-amber-600 text-sm font-bold">{testModalData.totalExpenses.toFixed(2)}</Text>
                </View>
                <View className="border-t border-gray-400 my-2" />

                {/* Net Total */}
                <View className="flex-row justify-between py-1">
                  <Text className="text-black text-sm font-bold">NET TOTAL:</Text>
                  <Text className={`text-sm font-bold ${testModalData.netTotal >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {testModalData.netTotal.toFixed(2)}
                  </Text>
                </View>
              </View>
            )}
          </ScrollView>
          <TouchableOpacity
            className="bg-emerald-600 rounded-xl py-3 mt-4"
            onPress={() => setShowTestModal(false)}
          >
            <Text className="text-white text-center font-bold">Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>

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
    </>
  );
};

// ─── Main Report Screen ───────────────────────────────────────────────────────
const ReportScreen = () => {
  const [activeTab, setActiveTab] = useState('tripsheet');
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showTripTabGroup, setShowTripTabGroup] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reportCutoffIso, setReportCutoffIso] = useState(null);
  const { posHook } = useTripContext();
  const indicatorAnim = useRef(new Animated.Value(0)).current;
  const fetchingDashboardRef = useRef(false);

  const TABS = [
    { key: 'trip', label: 'Active Trip', Icon: Bus },
    { key: 'tripsheet', label: 'Trip Sheet', Icon: Receipt },
    { key: 'status', label: 'Status Rep.', Icon: BarChart3 },
    { key: 'collection', label: 'Collection Rep.', Icon: DollarSign },
  ];

  const fetchDashboard = useCallback(async ({ showLoader = false } = {}) => {
    if (fetchingDashboardRef.current) return;
    fetchingDashboardRef.current = true;
    if (showLoader) setLoading(true);
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

      // Recompute today_stats from the cutoff-filtered trips so that
      // TODAY'S COLLECTION clears out properly after End Trip.
      const filteredTripIds = new Set([
        ...(filteredActiveTrip?.trip_id ? [filteredActiveTrip.trip_id] : []),
        ...filteredRecentTrips.map(t => t.trip_id).filter(Boolean),
      ]);
      const filteredTodayStats = {
        trips_completed: filteredTripIds.size,
        tickets_sold: [...filteredTripIds].reduce(
          (s, id) => s + ((filteredRecentTrips.find(t => t.trip_id === id) ?? filteredActiveTrip)?.tickets_sold ?? 0),
          0,
        ),
        total_collection: [...filteredTripIds].reduce(
          (s, id) => s + Number((filteredRecentTrips.find(t => t.trip_id === id) ?? filteredActiveTrip)?.collection ?? 0),
          0,
        ),
        passengers: 0,
      };
      filteredTodayStats.passengers = filteredTodayStats.tickets_sold;

      setDashboard({
        ...raw,
        active_trip: filteredActiveTrip,
        recent_trips: filteredRecentTrips,
        today_stats: filteredTodayStats,
      });
    } catch (e) {
      console.error('[ReportScreen] dashboard fetch failed', e);
    } finally {
      fetchingDashboardRef.current = false;
      if (showLoader) setLoading(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        fetchDashboard(),
        posHook.reload?.(),
      ]);
      setRefreshKey(k => k + 1);
    } catch (e) {
      console.error('[ReportScreen] Refresh failed:', e);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, fetchDashboard, posHook]);

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
      {/* ── Top header: title + active trip info + refresh ── */}
      <View className="flex-row items-center justify-between px-4 pt-2 pb-1">
        <View>
          <Text className="text-white text-lg font-black tracking-wide">REPORTS</Text>
          <Text className="text-zinc-500 text-[10px] font-bold">
            {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          {at ? (
            <View className="flex-row items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-full">
              <View className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <Text className="text-emerald-400 text-[10px] font-bold">
                #{at.trip_number > 0 ? at.trip_number : '—'}
              </Text>
              <Text className="text-emerald-500/80 text-[10px] font-semibold">
                {formatTime(at.start_time)}
              </Text>
            </View>
          ) : (
            <View className="flex-row items-center gap-1.5 bg-zinc-800 border border-zinc-700 px-2.5 py-1 rounded-full">
              <View className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
              <Text className="text-zinc-500 text-[10px] font-bold">NO ACTIVE TRIP</Text>
            </View>
          )}
          <TouchableOpacity
            onPress={onRefresh}
            activeOpacity={0.7}
            disabled={refreshing}
            className={`flex-row items-center gap-1.5 bg-red-600 border border-red-500 px-3 py-1.5 rounded-lg ${refreshing ? 'opacity-50' : ''}`}
          >
            {refreshing
              ? <ActivityIndicator size="small" color="#ffffff" />
              : <RotateCcw size={14} color="#ffffff" />}
            <Text className="text-white text-xs font-semibold">Refresh</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 40 }}
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
        <View className="mx-4 mb-2 mt-2 bg-zinc-900/95 gap-2 rounded-2xl p-1.5 flex-row border border-zinc-700">
          {!showTripTabGroup ? (
            <>
              <View className="flex-1 flex-row gap-2">
                {TABS.filter(t => t.key === 'tripsheet' || t.key === 'status').map((tab) => {
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
                      <Text
                        className={`text-[13px] font-black tracking-wide ${
                          isActive ? 'text-white' : 'text-zinc-200'
                        }`}
                      >
                        {tab.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity
                onPress={() => {
                  setShowTripTabGroup(true);
                  setActiveTab('trip');
                }}
                className="justify-center items-center px-3 py-3 rounded-xl bg-zinc-800/80 border border-zinc-700"
              >
                <ChevronRight size={20} color="#d4d4d8" />
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity
                onPress={() => {
                  setShowTripTabGroup(false);
                  if (activeTab === 'trip' || activeTab === 'collection') setActiveTab('tripsheet');
                }}
                className="justify-center items-center px-3 py-3 rounded-xl bg-zinc-800/80 border border-zinc-700"
              >
                <ChevronLeft size={20} color="#d4d4d8" />
              </TouchableOpacity>
              <View className="flex-1 flex-row gap-2">
                {TABS.filter(t => t.key === 'trip' || t.key === 'collection').map((tab) => {
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
                      <Text
                        className={`text-[13px] font-black tracking-wide ${
                          isActive ? 'text-white' : 'text-zinc-200'
                        }`}
                      >
                        {tab.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}
        </View>

        {/* ── Content ── */}
        <View className="flex-1">
          {activeTab === 'trip' && (
            <TripTabContent
              dashboard={dashboard}
              onRefreshDashboard={fetchDashboard}
              posHook={posHook}
              onNavigateToCollection={() => {
                setShowTripTabGroup(true);
                setActiveTab('collection');
              }}
            />
          )}
          {activeTab === 'tripsheet' && (
            <TripSheetTabContent
              dashboard={dashboard}
              posHook={posHook}
              onRefresh={fetchDashboard}
              refreshKey={refreshKey}
            />
          )}
          {activeTab === 'status' && (
            <StatusReportTabContent
              dashboard={dashboard}
              posHook={posHook}
              onRefresh={fetchDashboard}
            />
          )}
          {activeTab === 'collection' && (
            <>
              {/* ── Summary & Collection single row ── */}
              <View className="mb-2">
                <ScrollView 
                  horizontal 
                  showsHorizontalScrollIndicator={false} 
                  contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}
                >
                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/20">
                    <Bus size={12} color="#38bdf8" />
                    <Text className="text-sky-400 text-xs font-black">{dashboard?.recent_trips?.length ?? 0}</Text>
                    <Text className="text-sky-500/70 text-[10px] font-bold">TRIPS</Text>
                  </View>
                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20">
                    <Text className="text-violet-400 text-xs font-black">₹{(dashboard?.today_stats?.total_collection ?? 0).toFixed(0)}</Text>
                    <Text className="text-violet-500/70 text-[10px] font-bold">APP</Text>
                  </View>

                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20">
                    <Text className="text-amber-400 text-xs font-black">₹{posSummary.total.toFixed(0)}</Text>
                    <Text className="text-amber-500/70 text-[10px] font-bold">POS</Text>
                  </View>
                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20">
                    <Ticket size={12} color="#a78bfa" />
                    <Text className="text-violet-400 text-xs font-black">{todayAppCount ?? 0}</Text>
                    <Text className="text-violet-500/70 text-[10px] font-bold">APP TIX</Text>
                  </View>

                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20">
                    <CreditCard size={12} color="#f59e0b" />
                    <Text className="text-amber-400 text-xs font-black">{posSummary.count}</Text>
                    <Text className="text-amber-500/70 text-[10px] font-bold">POS TIX</Text>
                  </View>

                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                    <DollarSign size={12} color="#34d399" />
                    <Text className="text-emerald-400 text-xs font-black">₹{((dashboard?.today_stats?.total_collection ?? 0) + posSummary.total).toFixed(0)}</Text>
                    <Text className="text-emerald-500/70 text-[10px] font-bold">TOTAL</Text>
                  </View>
                </ScrollView>
              </View>
              <CollectionReportTabContent
                dashboard={dashboard}
                posHook={posHook}
                onRefresh={onRefresh}
              />
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

export default ReportScreen;
