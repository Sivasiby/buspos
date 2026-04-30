import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Text, TouchableOpacity, View, ScrollView,
  Platform, Alert, ActivityIndicator, ToastAndroid, RefreshControl,
  Animated, Modal, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Bus, Play, Pause, Square,
  UserCheck, CheckCircle, Clock, Timer, ArrowLeftRight, FileText,
  X, Bell, AlertCircle,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { supabase } from '../../lib/supabase';
import { useVerificationRealtime } from '../hooks/useVerificationRealtime';
import { useTripContext } from '../context/TripContext';

let NyxPrinter = null;
let PrinterStatus = null;
let PrintAlign = null;

if (Platform.OS === 'android') {
  const nyx = require('nyx-printer-react-native');
  NyxPrinter = nyx.default;
  PrinterStatus = nyx.PrinterStatus;
  PrintAlign = nyx.PrintAlign;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const showToast = (msg, dur = ToastAndroid.SHORT) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, dur);
  else Alert.alert('', msg);
};

const formatTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

const formatDuration = (start) => {
  if (!start) return '—';
  const mins = Math.round((Date.now() - new Date(start).getTime()) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

const normalizeDir = (d) => (d ?? '').toString().trim().toLowerCase();

const parseStopLabel = (name) => {
  if (!name || name === '?') return { tamil: name || '?', tripNum: null };
  const parts = name.split('-');
  const tripNum = parts.length >= 2 ? parts[1].trim() : null;
  const tamil = parts.length >= 3 ? parts.slice(2).join('-').trim() : parts[0].trim();
  return { tamil: tamil || name, tripNum };
};
const isDown = (d) => ['dn', 'down', 'return'].includes(normalizeDir(d));

const parseAmount = (v) => {
  const n = Number(v);
  return !Number.isFinite(n) || n < 0 ? 0 : n;
};

const FIXED_EXPENSES = ['Diesel', 'Driver', 'Conductor', 'Tollgate', 'Pooja', 'Others'];

const routeLabel = (name, dir) => {
  if (!name) return '';
  if (!isDown(dir)) return name;
  const parts = name.split(/\s*(?:->|→|-)\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return name;
  return [...parts].reverse().join(' → ');
};

const jwtDecodePayload = (token) => {
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

const getSessionBaselineIso = async () => {
  try {
    const saved = await AsyncStorage.getItem('trip_report_reset_after_iso');
    if (saved) return saved;
  } catch {}
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const getRouteNameMap = async (routeIds = []) => {
  const ids = [...new Set((routeIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const { data } = await supabase.from('routes').select('id,route_name').in('id', ids);
  return Object.fromEntries((data ?? []).map((r) => [String(r.id), r.route_name]));
};

const updateTripStatusSupabase = async (tripId, status) => {
  const payload = status === 'completed'
    ? { status, expected_end_time: new Date().toISOString() }
    : { status };
  const { error } = await supabase.from('trips').update(payload).eq('id', tripId);
  if (error) throw error;
};

const verifyTicketSupabase = async (ticketId) => {
  const { error } = await supabase.from('tickets').update({ is_verified: true }).eq('id', ticketId);
  if (error) throw error;
};

const startTripFromSupabase = async ({ routeId, direction, busId = null }) => {
  const conductorId = await getConductorIdFromStorage();
  if (!conductorId) throw new Error('No conductor session');

  const { data: existing } = await supabase
    .from('trips')
    .select('id')
    .eq('conductor_id', conductorId)
    .in('status', ['scheduled', 'running', 'paused'])
    .limit(1);
  if (existing?.[0]?.id) {
    throw new Error('You already have an active trip');
  }

  let resolvedBusId = busId;
  if (!resolvedBusId) {
    try {
      const raw = await AsyncStorage.getItem('selected_bus');
      if (raw) resolvedBusId = JSON.parse(raw)?.id ?? null;
    } catch {}
  }
  if (!resolvedBusId) {
    const { data: last } = await supabase
      .from('trips')
      .select('bus_id,start_time')
      .eq('conductor_id', conductorId)
      .not('bus_id', 'is', null)
      .order('start_time', { ascending: false })
      .limit(1);
    resolvedBusId = last?.[0]?.bus_id ?? null;
  }

  const baselineIso = await getSessionBaselineIso();
  const { count } = await supabase
    .from('trips')
    .select('id', { count: 'exact', head: true })
    .eq('conductor_id', conductorId)
    .gte('start_time', baselineIso);
  const tripNumber = (count ?? 0) + 1;

  const insertPayload = {
    route_id: routeId,
    direction,
    conductor_id: conductorId,
    bus_id: resolvedBusId,
    trip_number: tripNumber,
    start_time: new Date().toISOString(),
    status: 'running',
  };
  const { data: createdRows, error } = await supabase.from('trips').insert(insertPayload).select('id,bus_id,trip_number,start_time').limit(1);
  if (error) throw error;
  const created = createdRows?.[0] ?? null;
  return { trip: created, conductorId, tripNumber };
};

const assignTripNumber = async (tripId, conductorId, forcedNumber = null, sinceIso = null) => {
  try {
    if (forcedNumber != null) {
      const num = Math.max(1, Number(forcedNumber) || 1);
      await supabase.from('trips').update({ trip_number: num }).eq('id', tripId);
      return num;
    }
    const baseline = sinceIso ? new Date(sinceIso) : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
    const { count, error } = await supabase
      .from('trips')
      .select('id', { count: 'exact', head: true })
      .eq('conductor_id', conductorId)
      .gte('start_time', baseline.toISOString())
      .neq('id', tripId);
    if (error) throw error;
    const num = (count ?? 0) + 1;
    await supabase.from('trips').update({ trip_number: num }).eq('id', tripId);
    return num;
  } catch {
    return 1;
  }
};

// ─── Status Badge ─────────────────────────────────────────────────────────────
const STATUS_CFG = {
  running:   { cls: 'bg-emerald-900/60 border border-emerald-500/40', txt: 'text-emerald-400', label: 'Running' },
  paused:    { cls: 'bg-amber-900/60 border border-amber-500/40',     txt: 'text-amber-400',   label: 'Paused'  },
  completed: { cls: 'bg-blue-900/60 border border-blue-500/40',       txt: 'text-blue-400',    label: 'Done'    },
  cancelled: { cls: 'bg-red-900/60 border border-red-500/40',         txt: 'text-red-400',     label: 'Cancelled'},
};

const StatusBadge = ({ status }) => {
  const c = STATUS_CFG[status] ?? { cls: 'bg-zinc-800', txt: 'text-zinc-400', label: status };
  return (
    <View className={`px-3 py-1 rounded-full ${c.cls}`}>
      <Text className={`text-[11px] font-bold tracking-wider ${c.txt}`}>{c.label.toUpperCase()}</Text>
    </View>
  );
};

// ─── Blocking Overlay ─────────────────────────────────────────────────────────
const BlockingOverlay = ({ message }) => (
  <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 }}
    className="bg-black/70 justify-center items-center">
    <View className="bg-zinc-900 rounded-2xl px-10 py-8 items-center border border-zinc-700">
      <ActivityIndicator size="large" color="#0ea5e9" />
      <Text className="text-white font-semibold text-base mt-4">{message}</Text>
    </View>
  </View>
);

// ─── Pending Verify Row ───────────────────────────────────────────────────────
const PendingVerifyRow = ({ item, onVerify, onDismiss, verifying }) => {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.55, duration: 750, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1,    duration: 750, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const isBusy = verifying === item.ticket_id;

  return (
    <Animated.View style={{ opacity: pulse }}>
      <View className="flex-row items-center justify-between bg-zinc-900 rounded-xl p-3 mb-2 border border-amber-500/30">
        <View className="flex-row items-center flex-1 mr-3 gap-3">
          <View className="w-10 h-10 rounded-full bg-amber-500/20 justify-center items-center">
            <UserCheck size={18} color="#f59e0b" />
          </View>
          <View className="flex-1">
            <View className="flex-row items-center gap-1 flex-wrap">
              <Text className="text-white text-sm font-bold" numberOfLines={1}>
                {parseStopLabel(item.from).tamil}
              </Text>
              <Text className="text-zinc-500 text-sm">→</Text>
              <Text className="text-white text-sm font-bold" numberOfLines={1}>
                {parseStopLabel(item.to).tamil}
              </Text>
            </View>
            <View className="flex-row items-center gap-2 mt-0.5">
              {(parseStopLabel(item.from).tripNum || parseStopLabel(item.to).tripNum) && (
                <Text className="text-zinc-600 text-[10px] font-semibold">
                  {parseStopLabel(item.from).tripNum} → {parseStopLabel(item.to).tripNum}
                </Text>
              )}
              <Text className="text-zinc-400 text-xs">₹{item.fare ?? item.amount ?? 0}</Text>
              {item.bus_number ? <Text className="text-zinc-500 text-xs">🚌 {item.bus_number}</Text> : null}
            </View>
          </View>
        </View>
        <View className="flex-row items-center gap-2">
          <TouchableOpacity
            className={`flex-row items-center gap-1.5 px-3 py-2.5 rounded-xl ${
              isBusy ? 'bg-emerald-700/50' : 'bg-emerald-600'
            }`}
            onPress={() => onVerify(item.ticket_id)}
            disabled={isBusy}
            activeOpacity={0.75}
          >
            {isBusy
              ? <ActivityIndicator size="small" color="#fff" />
              : <><CheckCircle size={14} color="#fff" /><Text className="text-white text-xs font-bold">Verify</Text></>
            }
          </TouchableOpacity>
          <TouchableOpacity
            className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/30 justify-center items-center"
            onPress={() => onDismiss(item.ticket_id)}
            disabled={isBusy}
            activeOpacity={0.75}
          >
            <X size={16} color="#ef4444" />
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
};

// ─── Direction Toggle ─────────────────────────────────────────────────────────
const DirectionToggle = ({ routeName, currentDirection, onStartReturn, starting }) => {
  const dirs = [
    { key: 'up', arrow: '↑ UP' },
    { key: 'dn', arrow: '↓ Return' },
  ];
  return (
    <View className="bg-zinc-900 rounded-2xl p-4 border border-zinc-800 mb-4">
      <View className="flex-row items-center gap-2 mb-3">
        <ArrowLeftRight size={13} color="#71717a" />
        <Text className="text-zinc-500 text-[10px] font-bold tracking-widest">DIRECTION</Text>
      </View>
      {dirs.map((d) => {
        const isCurrent = normalizeDir(currentDirection) === normalizeDir(d.key);
        const label = routeLabel(routeName, d.key);
        return (
          <TouchableOpacity
            key={d.key}
            onPress={() => { if (!isCurrent) onStartReturn(d.key); }}
            disabled={isCurrent || starting}
            activeOpacity={isCurrent ? 1 : 0.7}
            className={`flex-row items-center justify-between px-4 py-4 rounded-xl mb-2 ${
              isCurrent ? 'bg-sky-500' : 'bg-zinc-800'
            }`}
          >
            <View>
              <Text className={`text-sm font-bold ${isCurrent ? 'text-white' : 'text-zinc-200'}`}>
                {label}
              </Text>
              <Text className={`text-xs mt-0.5 ${isCurrent ? 'text-sky-100' : 'text-zinc-500'}`}>
                {isCurrent ? 'Current trip' : 'Tap to start return'}
              </Text>
            </View>
            <View className={`px-3 py-1 rounded-full ${isCurrent ? 'bg-sky-600/60' : 'bg-zinc-700'}`}>
              {starting && !isCurrent
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text className={`text-xs font-bold ${isCurrent ? 'text-white' : 'text-zinc-300'}`}>{d.arrow}</Text>
              }
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

// ─── Start Trip Buttons (no active trip) ─────────────────────────────────────
const StartTripButtons = ({ routes, onStarted }) => {
  const [dir, setDir] = useState('dn');
  const [loading, setLoading] = useState(false);

  const start = async () => {
    const routeId = routes.length > 0 ? routes[0].id : null;
    if (!routeId) { Alert.alert('Error', 'No routes available.'); return; }
    setLoading(true);
    try {
      const created = await startTripFromSupabase({ routeId, direction: dir });
      showToast('Trip started!');
      const selectedRoute = routes[0];
      onStarted({
        trip_id: created?.trip?.id,
        direction: dir,
        route_name: selectedRoute?.name,
        start_time: created?.trip?.start_time ?? new Date().toISOString(),
        bus_id: created?.trip?.bus_id,
        trip_number: created?.trip?.trip_number ?? created?.tripNumber ?? 1,
      });
    } catch (e) {
      Alert.alert('Error', e?.message || 'Failed to start trip.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View className="bg-zinc-900 rounded-2xl p-5 border border-zinc-800">
      <View className="items-center py-4 mb-4">
        <Bus size={44} color="#3f3f46" />
        <Text className="text-zinc-300 text-lg font-bold mt-4">No Active Trip</Text>
        <Text className="text-zinc-500 text-sm mt-1 text-center">Start a trip when you're ready</Text>
      </View>

      <Text className="text-zinc-400 text-xs font-semibold tracking-widest mb-3">SELECT ROUTE</Text>
      <View className="flex-row gap-3 mb-5">
        {[
          { key: 'up', label: 'CBE TO STY' },
          { key: 'dn', label: 'STY TO CBE' }
        ].map(d => (
          <TouchableOpacity
            key={d.key}
            onPress={() => setDir(d.key)}
            className={`flex-1 py-4 rounded-xl items-center border ${
              dir === d.key ? 'bg-sky-500 border-sky-500' : 'bg-zinc-800 border-zinc-700'
            }`}
          >
            <Text className={`text-base font-bold ${dir === d.key ? 'text-white' : 'text-zinc-400'}`}>
              {d.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        className={`flex-row items-center justify-center gap-3 bg-sky-500 rounded-2xl py-4 ${loading ? 'opacity-60' : ''}`}
        onPress={start}
        disabled={loading}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Play size={20} color="#fff" />}
        <Text className="text-white text-base font-bold">Start Trip</Text>
      </TouchableOpacity>
    </View>
  );
};

// ─── Supabase Dashboard Fetch ────────────────────────────────────────────────
const fetchDashboardFromSupabase = async () => {
  const conductorId = await getConductorIdFromStorage();
  if (!conductorId) throw new Error('No conductor session');

  // Active trip
  const { data: activeRows } = await supabase
    .from('trips')
    .select('id, bus_id, route_id, conductor_id, direction, start_time, expected_end_time, status, trip_number')
    .eq('conductor_id', conductorId)
    .in('status', ['scheduled', 'running', 'paused'])
    .order('start_time', { ascending: false })
    .limit(1);

  const activeRow = activeRows?.[0] ?? null;

  let active_trip = null;
  if (activeRow) {
    const { count: tkCount, data: tkData } = await supabase
      .from('tickets')
      .select('fare', { count: 'exact' })
      .eq('trip_id', activeRow.id);
    const tickets_sold = tkCount ?? 0;
    const collection = (tkData ?? []).reduce((s, t) => s + Number(t.fare ?? 0), 0);
    active_trip = {
      trip_id:      activeRow.id,
      trip_number:  activeRow.trip_number,
      route_id:     activeRow.route_id,
      route_name:   'Unknown',
      direction:    activeRow.direction,
      status:       activeRow.status,
      start_time:   activeRow.start_time,
      end_time:     activeRow.expected_end_time ?? null,
      bus_id:       activeRow.bus_id ?? null,
      conductor_id: activeRow.conductor_id,
      tickets_sold,
      collection:   Math.round(collection * 100) / 100,
    };
  }

  // Bus info
  const busId = activeRow?.bus_id ?? null;
  let bus = null;
  if (busId) {
    const { data: busRow } = await supabase
      .from('buses')
      .select('id, bus_number, bus_name, capacity')
      .eq('id', busId)
      .single();
    if (busRow) {
      bus = {
        id:             busRow.id,
        vehicle_number: busRow.bus_number,
        bus_name:       busRow.bus_name,
        capacity:       busRow.capacity,
      };
    }
  }

  // Recent trips (last 24h)
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentRows } = await supabase
    .from('trips')
    .select('id, bus_id, route_id, direction, start_time, expected_end_time, status, trip_number')
    .eq('conductor_id', conductorId)
    .gte('start_time', since24h)
    .order('start_time', { ascending: false })
    .limit(10);

  const routeNameMap = await getRouteNameMap([
    activeRow?.route_id,
    ...(recentRows ?? []).map((r) => r.route_id),
  ]);
  if (active_trip?.route_id) {
    active_trip.route_name = routeNameMap[String(active_trip.route_id)] ?? 'Unknown';
  }

  const recent_trips = await Promise.all(
    (recentRows ?? []).map(async (row) => {
      const { count: tkCount, data: tkData } = await supabase
        .from('tickets')
        .select('fare', { count: 'exact' })
        .eq('trip_id', row.id);
      const collection = (tkData ?? []).reduce((s, t) => s + Number(t.fare ?? 0), 0);
      return {
        trip_id:      row.id,
        trip_number:  row.trip_number,
        route_name:   routeNameMap[String(row.route_id)] ?? 'Unknown',
        direction:    row.direction,
        status:       row.status,
        start_time:   row.start_time,
        end_time:     row.expected_end_time ?? null,
        bus_id:       row.bus_id ?? null,
        tickets_sold: tkCount ?? 0,
        collection:   Math.round(collection * 100) / 100,
      };
    })
  );

  // Today stats
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data: todayTripRows } = await supabase
    .from('trips')
    .select('id')
    .eq('conductor_id', conductorId)
    .gte('start_time', todayStart.toISOString());

  const todayTripIds = (todayTripRows ?? []).map(t => t.id);
  let today_stats = { trips_completed: todayTripIds.length, tickets_sold: 0, total_collection: 0, passengers: 0 };
  if (todayTripIds.length > 0) {
    const { data: todayTix } = await supabase
      .from('tickets')
      .select('ticket_count, fare')
      .in('trip_id', todayTripIds);
    const tixRows = todayTix ?? [];
    const tickets_sold = tixRows.reduce((s, t) => s + Number(t.ticket_count ?? 1), 0);
    const total_collection = Math.round(tixRows.reduce((s, t) => s + Number(t.fare ?? 0), 0) * 100) / 100;
    today_stats = { trips_completed: todayTripIds.length, tickets_sold, total_collection, passengers: tickets_sold };
  }

  // Conductor info
  const conductor = { id: conductorId };

  return { conductor, bus, active_trip, today_stats, recent_trips };
};

// ─── Supabase Routes Fetch ─────────────────────────────────────────────────────
const fetchRoutesFromSupabase = async () => {
  const { data, error } = await supabase
    .from('routes')
    .select('id, route_name')
    .order('route_name');
  if (error) throw error;
  return (data ?? []).map(r => ({ id: r.id, name: r.route_name }));
};

// ─── Main Screen ──────────────────────────────────────────────────────────────
const TripScreen = () => {
  const navigation = useNavigation();
  const { setActiveTrip: setCtxTrip, setTripNumber: setCtxTripNumber, setBusNumber: setCtxBusNumber, posHook } = useTripContext();
  const [dashboard, setDashboard] = useState(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [changing, setChanging] = useState(false);
  const [changingMessage, setChangingMessage] = useState('');
  const [startingReturn, setStartingReturn] = useState(false);
  const [routes, setRoutes] = useState([]);
  const [verifyingTicket, setVerifyingTicket] = useState(null);
  const [showVerification, setShowVerification] = useState(true);
  const prevVerifyCountRef = useRef(0);
  const [ticketRefreshKey, setTicketRefreshKey] = useState(0);
  const [appOnlyTickets, setAppOnlyTickets] = useState(0);
  const [appOnlyFare, setAppOnlyFare] = useState(0);
  const [appTripLoading, setAppTripLoading] = useState(false);
  const [localTripNumber, setLocalTripNumber] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [showPasscodeModal, setShowPasscodeModal] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [passcodeError, setPasscodeError] = useState('');
  const [endingTrip, setEndingTrip] = useState(false);
  const [resetNextTripNumber, setResetNextTripNumber] = useState(false);
  const resetNextTripNumberRef = useRef(false);
  const sessionStartRef = useRef(null);

  const [showReportModal, setShowReportModal] = useState(false);
  const [reportData, setReportData] = useState(null);
  const [splitAtAnnur] = useState(true);

  const at = dashboard?.active_trip;

  const { pendingRequests, clearTicket, dismissTicket } = useVerificationRealtime(at?.trip_id, at?.status);

  const activePOSTix = posHook.tickets.filter(t => t.trip_id === at?.trip_id);
  const activePOSCount = activePOSTix.reduce((s, t) => s + Number(t.ticket_count ?? 0), 0);
  const activePOSFare = activePOSTix.reduce((s, t) => s + Number(t.fare ?? 0), 0);
  const totalFare = appOnlyFare + activePOSFare;

  useEffect(() => { fetchDashboard(); }, []);

  useEffect(() => {
    if (pendingRequests.length > 0 && prevVerifyCountRef.current === 0) {
      setShowVerification(true);
    }
    prevVerifyCountRef.current = pendingRequests.length;
  }, [pendingRequests.length]);

  useEffect(() => {
    fetchRoutesFromSupabase().then(r => setRoutes(r)).catch(() => {});
  }, []);

  useEffect(() => {
    const tid = at?.trip_id;
    if (!tid) { setAppOnlyTickets(0); setAppOnlyFare(0); return; }
    let cancelled = false;
    setAppTripLoading(true);
    (async () => {
      try {
        const { data, error } = await supabase
          .from('tickets')
          .select('ticket_count,total_fare,fare')
          .eq('trip_id', tid)
          .or('payment_method.neq.pos,payment_method.is.null');
        if (error) throw error;
        const rows = data || [];
        const count = rows.reduce((s, r) => s + Number(r.ticket_count ?? 1), 0);
        const total = rows.reduce((s, r) => {
          const cnt = Number(r.ticket_count ?? 1);
          const unit = Number(r.fare ?? 0);
          return s + (r.total_fare != null ? Number(r.total_fare) : unit * cnt);
        }, 0);
        if (!cancelled) { setAppOnlyTickets(count); setAppOnlyFare(total); }
      } catch {
        if (!cancelled) { setAppOnlyTickets(0); setAppOnlyFare(0); }
      } finally {
        if (!cancelled) setAppTripLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [at?.trip_id, ticketRefreshKey]);

  const fetchDashboard = async () => {
    try {
      if (!sessionStartRef.current) {
        try {
          const saved = await AsyncStorage.getItem('trip_report_reset_after_iso');
          if (saved) sessionStartRef.current = saved;
        } catch {}
      }
      const data = await fetchDashboardFromSupabase();
      setDashboard(data);
      const conductorId = data?.active_trip?.conductor_id ?? data?.conductor?.id;
      const tripId = data?.active_trip?.trip_id;
      const shouldResetTripNumber = resetNextTripNumberRef.current || resetNextTripNumber;
      const dbTripNumber = Number(data?.active_trip?.trip_number ?? 0);
      if (dbTripNumber > 0) {
        setLocalTripNumber(dbTripNumber);
        if (shouldResetTripNumber) {
          setResetNextTripNumber(false);
          resetNextTripNumberRef.current = false;
        }
      } else if (conductorId && tripId) {
        const nextNum = await assignTripNumber(tripId, conductorId, shouldResetTripNumber ? 1 : null, sessionStartRef.current);
        setLocalTripNumber(nextNum);
        setCtxTripNumber(nextNum);
        if (shouldResetTripNumber) {
          setResetNextTripNumber(false);
          resetNextTripNumberRef.current = false;
        }
      }
      setCtxTrip(data?.active_trip ?? null);
      if (dbTripNumber > 0) setCtxTripNumber(dbTripNumber);
      if (data?.bus?.vehicle_number) setCtxBusNumber(data.bus.vehicle_number);
    } catch (e) { console.error(e); }
    finally { setDashLoading(false); }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchDashboard();
      const freshRoutes = await fetchRoutesFromSupabase().catch(() => []);
      setRoutes(freshRoutes);
      if (posHook.reload) await posHook.reload();
      setTicketRefreshKey(k => k + 1);
    } catch (e) { console.error('[TripScreen] Refresh failed:', e); }
    finally { setRefreshing(false); }
  }, [posHook]);

  const handleTripStarted = async (started) => {
    try {
      if (started) {
        setDashboard(prev => {
          if (!prev || prev?.active_trip?.trip_id) return prev;
          return {
            ...prev,
            active_trip: {
              ...(prev.active_trip || {}),
              trip_id: null,
              route_name: started.route_name || prev?.active_trip?.route_name || '',
              direction: started.direction,
              start_time: started.start_time,
              status: 'running',
              bus_number: prev?.bus?.vehicle_number ?? prev?.active_trip?.bus_number,
              bus_id: started.bus_id || prev?.bus?.id || prev?.active_trip?.bus_id,
            },
          };
        });
      }
      let dash = null;
      for (let i = 0; i < 6; i++) {
        dash = await fetchDashboardFromSupabase();
        if (dash?.active_trip?.trip_id) break;
        await new Promise(res => setTimeout(res, 700));
      }
      if (dash) {
        setDashboard(dash);
        const conductorId = dash?.active_trip?.conductor_id ?? dash?.conductor?.id;
        const tripId = dash?.active_trip?.trip_id ?? dash?.active_trip?.id;
        const shouldResetTripNumber = resetNextTripNumberRef.current || resetNextTripNumber;
        const dbTripNumber = Number(dash?.active_trip?.trip_number ?? 0);
        if (dbTripNumber > 0) {
          setLocalTripNumber(dbTripNumber);
          if (shouldResetTripNumber) {
            setResetNextTripNumber(false);
            resetNextTripNumberRef.current = false;
          }
        } else if (conductorId && tripId) {
          const nextNum = await assignTripNumber(tripId, conductorId, shouldResetTripNumber ? 1 : null, sessionStartRef.current);
          setLocalTripNumber(nextNum);
          setCtxTripNumber(nextNum);
          if (shouldResetTripNumber) {
            setResetNextTripNumber(false);
            resetNextTripNumberRef.current = false;
          }
        }
        setCtxTrip(dash?.active_trip ?? null);
        if (dbTripNumber > 0) setCtxTripNumber(dbTripNumber);
        if (dash?.bus?.vehicle_number) setCtxBusNumber(dash.bus.vehicle_number);
      }
    } catch (e) { console.error(e); }
    finally { setDashLoading(false); }
  };

  const handleStartReturn = async (dir) => {
    if (!at) return;
    Alert.alert(
      'Start return trip?',
      `This will end the current trip and start ${routeLabel(at.route_name, dir)}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start',
          onPress: async () => {
            setStartingReturn(true);
            setChanging(true);
            setChangingMessage('Ending current trip…');
            try {
              await updateTripStatusSupabase(at.trip_id, 'completed');
              setChangingMessage('Starting return trip…');
              const route = routes.find(r => r.name === at.route_name) ?? routes[0];
              if (!route) throw new Error('Route not found');
              const created = await startTripFromSupabase({ routeId: route.id, direction: dir, busId: at.bus_id ?? null });
              showToast('Return trip started!');
              await handleTripStarted({
                trip_id: created?.trip?.id,
                direction: dir,
                route_name: route.name,
                start_time: created?.trip?.start_time ?? new Date().toISOString(),
                bus_id: created?.trip?.bus_id,
                trip_number: created?.trip?.trip_number ?? created?.tripNumber ?? 1,
              });
            } catch (e) {
              Alert.alert('Error', e?.message || 'Could not switch trip.');
            } finally {
              setChanging(false);
              setChangingMessage('');
              setStartingReturn(false);
            }
          },
        },
      ]
    );
  };

  const changeStatus = async (s) => {
    if (!at) return;
    const labels = { completed: 'End this trip?', paused: 'Pause trip?', running: 'Resume trip?' };
    const toastLabels = { completed: 'Trip ended', paused: 'Trip paused', running: 'Trip resumed' };
    const loadingLabels = { completed: 'Ending trip…', paused: 'Pausing…', running: 'Resuming…' };
    Alert.alert('Confirm', labels[s] || 'Continue?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Yes',
        onPress: async () => {
          setChanging(true);
          setChangingMessage(loadingLabels[s] || 'Please wait…');
          try {
            await updateTripStatusSupabase(at.trip_id, s);
            showToast(toastLabels[s] || 'Done');
            await handleTripStarted();
          } catch (e) {
            Alert.alert('Error', e?.message || 'Could not change status.');
          } finally {
            setChanging(false);
            setChangingMessage('');
          }
        },
      },
    ]);
  };

  const printCollectionReport = async (dash, useSplit = splitAtAnnur) => {
    console.log('[printCollectionReport] useSplit:', useSplit, 'splitAtAnnur:', splitAtAnnur);
    const testingMode = await AsyncStorage.getItem('testing_mode');
    const isTestingMode = testingMode === 'true';

    // ── Session cutoff: only include trips/tickets from the current session ──
    // sessionStartRef.current is set when a trip is ended, so only data
    // from that point forward (until now) belongs to this report.
    const sessionCutoffIso = sessionStartRef.current ?? null;
    const isAfterCutoff = (isoStr) => {
      if (!isoStr) return false;
      if (!sessionCutoffIso) return true;
      return new Date(isoStr).getTime() >= new Date(sessionCutoffIso).getTime();
    };

    const recentTrips = (dash?.recent_trips ?? []).filter((t) => isAfterCutoff(t.start_time));

    const posByTripAll = posHook.todayByTrip();
    // Filter POS tickets to only those belonging to sessions trips (by trip_id)
    // and also to tickets issued after the session cutoff
    const sessionTripIds = new Set(recentTrips.map((t) => t.trip_id).filter(Boolean));
    const posByTrip = Object.fromEntries(
      Object.entries(posByTripAll)
        .map(([tripId, tix]) => [
          tripId,
          tix.filter((t) => isAfterCutoff(t.issued_at)),
        ])
        .filter(([tripId, tix]) => sessionTripIds.has(tripId) || tix.length > 0)
    );

    const todayTripIds = recentTrips.map((t) => t.trip_id);

    const allTripIds = [...new Set([...Object.keys(posByTrip), ...todayTripIds])];
    const backendTrip = (id) => recentTrips.find((t) => t.trip_id === id);

    const rawTripRows = allTripIds
      .map((tripId, idx) => {
        const bt = backendTrip(tripId);
        const posTix = posByTrip[tripId] || [];
        const posAmt = posTix.reduce((s, t) => s + Number(t.fare || 0), 0);
        const appAmt = Number(bt?.collection ?? 0);
        const total = appAmt + posAmt;
        const dir = (bt?.direction ?? '').toString().trim().toLowerCase();
        return {
          tripId,
          trip: bt?.trip_number ?? idx + 1,
          amount: total,
          direction: dir,
        };
      })
      .sort((a, b) => {
        const an = Number(a.trip);
        const bn = Number(b.trip);
        if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
        return String(a.trip).localeCompare(String(b.trip));
      });

    // When splitting at Annur (011), each physical trip becomes 2 sub-trips.
    // We fetch per-stop ticket breakdown from Supabase + POS to split amounts
    // at the Annur(011) boundary, mirroring the Quick Select filter in TripSheetTab.
    let tripRows;
    console.log('[printCollectionReport] About to check useSplit, useSplit:', useSplit, 'rawTripRows count:', rawTripRows.length);
    if (useSplit) {
      const ANNUR_UP_1 = '003-011'; // STY → Annur
      const ANNUR_UP_2 = '011-018'; // Annur → CBE
      const ANNUR_DN_1 = '018-011'; // CBE → Annur
      const ANNUR_DN_2 = '011-003'; // Annur → STY
      const ANNUR_STAGE = 11; // stage number for Annur

      // Helper: parse stage number from a stop name like "1-11-Annur"
      const stageNumFromName = (name) => {
        if (!name) return NaN;
        const parts = name.split('-');
        for (const p of parts) {
          const n = parseInt(p.trim(), 10);
          if (!isNaN(n)) return n;
        }
        return NaN;
      };

      // Fetch app tickets for all trips in one query
      const tripIdsForFetch = allTripIds.filter(Boolean);
      let appTicketsByTrip = {};
      try {
        const { data: allTickets } = await supabase
          .from('tickets')
          .select('trip_id,ticket_count,total_fare,fare,from_stop_id,to_stop_id,payment_method')
          .in('trip_id', tripIdsForFetch)
          .neq('payment_method', 'pos');

        if (allTickets && allTickets.length > 0) {
          // Resolve stop names in one query
          const stopIds = [...new Set(allTickets.flatMap(t => [t.from_stop_id, t.to_stop_id].filter(Boolean)))];
          const stopMap = {};
          if (stopIds.length) {
            const { data: stops } = await supabase.from('stops').select('id,stop_name').in('id', stopIds);
            (stops ?? []).forEach(s => { stopMap[String(s.id)] = s.stop_name; });
          }
          for (const t of allTickets) {
            const tid = t.trip_id;
            if (!appTicketsByTrip[tid]) appTicketsByTrip[tid] = [];
            appTicketsByTrip[tid].push({
              from_stage: stageNumFromName(stopMap[String(t.from_stop_id)] ?? ''),
              cnt: Number(t.ticket_count ?? 1),
              total: t.total_fare != null ? Number(t.total_fare) : Number(t.fare ?? 0) * Number(t.ticket_count ?? 1),
            });
          }
        }
      } catch { /* fall back to total amount if fetch fails */ }

      // For each physical trip, compute sub-trip amounts by filtering on stage boundary
      const amtInRange = (tripId, lo, hi) => {
        // App tickets in range
        const appAmt = (appTicketsByTrip[tripId] ?? [])
          .filter(t => !isNaN(t.from_stage) && t.from_stage >= lo && t.from_stage <= hi)
          .reduce((s, t) => s + t.total, 0);
        // POS tickets in range
        const posAmt = (posByTrip[tripId] ?? [])
          .filter(t => {
            const parts = String(t.from_stop ?? '').split('-');
            let stage = NaN;
            for (const p of parts) { const n = parseInt(p.trim(), 10); if (!isNaN(n)) { stage = n; break; } }
            return !isNaN(stage) && stage >= lo && stage <= hi;
          })
          .reduce((s, t) => s + Number(t.fare || 0), 0);
        return appAmt + posAmt;
      };

      tripRows = [];
      console.log('[printCollectionReport] Executing split logic for rawTripRows:', rawTripRows);
      rawTripRows.forEach((r) => {
        const dn = ['dn', 'down', 'return'].includes(r.direction);
        const baseNum = typeof r.trip === 'number' ? (r.trip - 1) * 2 + 1 : r.trip;
        const tripId = r.tripId;

        // DN: sub1 = 018→011 (stages 11–18), sub2 = 011→003 (stages 3–11)
        // UP: sub1 = 003→011 (stages 3–11),  sub2 = 011→018 (stages 11–18)
        let amt1, amt2;
        if (tripId && (appTicketsByTrip[tripId] || posByTrip[tripId])) {
          if (dn) {
            amt1 = amtInRange(tripId, ANNUR_STAGE, 18); // CBE→Annur: from stage 11..18
            amt2 = amtInRange(tripId, 3, ANNUR_STAGE);  // Annur→STY: from stage 3..11
          } else {
            amt1 = amtInRange(tripId, 3, ANNUR_STAGE);  // STY→Annur: from stage 3..11
            amt2 = amtInRange(tripId, ANNUR_STAGE, 18); // Annur→CBE: from stage 11..18
          }
        } else {
          // fallback: put full amount on sub1
          amt1 = r.amount;
          amt2 = 0;
        }

        tripRows.push(
          { trip: baseNum,     route: dn ? ANNUR_DN_1 : ANNUR_UP_1, amount: amt1 },
          { trip: baseNum + 1, route: dn ? ANNUR_DN_2 : ANNUR_UP_2, amount: amt2 },
        );
      });
      console.log('[printCollectionReport] Split tripRows generated:', tripRows);
    } else {
      tripRows = rawTripRows.map(r => ({ trip: r.trip, route: '01', amount: r.amount }));
      console.log('[printCollectionReport] Non-split tripRows generated:', tripRows);
    }

    if (tripRows.length === 0) {
      Alert.alert('No data', 'No collection data to print.');
      return false;
    }

    const expenses = FIXED_EXPENSES.map((label) => ({ label, amount: '0', fixed: true }));
    const totalCollection = tripRows.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenses.reduce((s, e) => s + parseAmount(e.amount), 0);

    if (isTestingMode) {
      console.log('[printCollectionReport] Testing mode - showing modal with tripRows:', tripRows);
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '/');
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      const busNo = dash?.recent_trips?.[0]?.bus_number ?? dash?.bus?.vehicle_number ?? 'N/A';

      setReportData({
        busNo,
        dateStr,
        timeStr,
        tripRows,
        totalCollection,
        expenses,
        totalExpenses,
        useSplit,
      });
      setShowReportModal(true);
      showToast('Testing mode: collection report modal shown');
      return true;
    }

    if (Platform.OS !== 'android' || !NyxPrinter) {
      Alert.alert('Not supported', 'Printing is only available on Android.');
      return false;
    }

    console.log('[printCollectionReport] About to print with tripRows:', tripRows, 'useSplit:', useSplit);
    try {
      const statusRet = await NyxPrinter.getPrinterStatus();
      if (statusRet !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(statusRet));
        return false;
      }

      const padL = (s, w) => String(s).padEnd(w, ' ');
      const padR = (s, w) => String(s).padStart(w, ' ');
      const padC = (s, w) => {
        const str = String(s);
        const tot = Math.max(0, w - str.length);
        const l = Math.floor(tot / 2);
        return ' '.repeat(l) + str + ' '.repeat(tot - l);
      };
      const fmtAmt = (n) => Number(n).toFixed(2);

      const DASH32 = '--------------------------------';
      const DASH_LIGHT = '- - - - - - - - - - - - - - - -';

      const now = new Date();
      const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '/');
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      const busNo = dash?.recent_trips?.[0]?.bus_number ?? dash?.bus?.vehicle_number ?? 'N/A';

      await NyxPrinter.printText('COLLECTION REPORT', { textSize: 24, align: PrintAlign.CENTER, bold: true });
      await NyxPrinter.printText(`${dateStr}  ${timeStr}`, { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });
      await NyxPrinter.printText(`BUS NUMBER:${busNo}`, { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      const LINE = 40;
      const C = { trip: 5, route: 9, amt: LINE - 5 - 9 };
      const hdr = padL('TRIP', C.trip) + padC('ROUTE', C.route) + padR('AMOUNT', C.amt);
      await NyxPrinter.printText(hdr, { textSize: 26, bold: true });
      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });

      for (const r of tripRows) {
        const routeStr = r.route ?? '01';
        const row =
          padL(String(r.trip), C.trip) +
          padC(routeStr, C.route) +
          padR(fmtAmt(r.amount), C.amt);
        await NyxPrinter.printText(row, { textSize: 26 });
      }

      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });
      await NyxPrinter.printText(
        `${padL('TOTAL Rs.:', 16)}${padR(fmtAmt(totalCollection), 24)}`,
        { textSize: 26, bold: true },
      );
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      await NyxPrinter.printText('EXPENSES', { textSize: 26, align: PrintAlign.CENTER, bold: true });
      await NyxPrinter.printText(DASH_LIGHT, { align: PrintAlign.CENTER });

      const expL = 12;
      const expSep = ' : ';
      const expA = LINE - expL - expSep.length;
      for (const label of FIXED_EXPENSES) {
        const exp = expenses.find((e) => e.label.toUpperCase() === label.toUpperCase());
        const amt = exp ? parseAmount(exp.amount) : 0;
        const lbl = label.toUpperCase().substring(0, expL);
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
      return true;
    } catch (e) {
      Alert.alert('Print Error', e?.message || 'Unknown');
      return false;
    }
  };

  const handleEndTripWithMandatoryReport = async (useSplit = splitAtAnnur) => {
    console.log('[handleEndTripWithMandatoryReport] Called with useSplit:', useSplit, 'splitAtAnnur:', splitAtAnnur);
    if (!at?.trip_id) {
      Alert.alert('No active trip', 'There is no active trip to end.');
      return;
    }
    setEndingTrip(true);
    setChanging(true);
    setChangingMessage('Preparing collection report…');
    try {
      const latestDash = await fetchDashboardFromSupabase().catch(() => ({}));
      const activeTrip = latestDash?.active_trip;
      const mergedRecentTrips = activeTrip?.trip_id
        ? [
            activeTrip,
            ...(latestDash?.recent_trips ?? []).filter((t) => t.trip_id !== activeTrip.trip_id),
          ]
        : (latestDash?.recent_trips ?? []);
      const dashForPrint = {
        ...latestDash,
        recent_trips: mergedRecentTrips,
      };

      setChangingMessage('Printing collection report…');
      const printed = await printCollectionReport(dashForPrint, useSplit);
      if (!printed) {
        Alert.alert('Collection report required', 'Collection report print is mandatory. Please print it from Coll. Report tab before proceeding.');
        return;
      }

      setChangingMessage('Ending trip…');
      await updateTripStatusSupabase(at.trip_id, 'completed');

      setResetNextTripNumber(true);
      resetNextTripNumberRef.current = true;
      try {
        const resetIso = new Date().toISOString();
        await AsyncStorage.setItem('trip_report_reset_after_iso', resetIso);
        sessionStartRef.current = resetIso;
      } catch {}
      await posHook.clearAll();
      await AsyncStorage.multiRemove([
        'pos_tickets_v2',
        'pos_tickets_v1',
        'ticket_stops_up',
        'ticket_stops_dn',
      ]);
      setCtxTrip(null);
      setCtxTripNumber(0);
      setLocalTripNumber(0);
      showToast('Trip ended');
      await handleTripStarted();
    } catch (e) {
      Alert.alert('Error', e?.message || 'Could not end trip.');
    } finally {
      setChanging(false);
      setChangingMessage('');
      setEndingTrip(false);
    }
  };

  const handleEndTripConfirmed = async () => {
    if (passcode !== '1212') {
      setPasscodeError('Incorrect passcode. Try again.');
      setPasscode('');
      return;
    }
    setShowPasscodeModal(false);
    setPasscode('');
    setPasscodeError('');
    Alert.alert(
      'Take collection report?',
      'Collection report print is mandatory before finishing trip end.',
      [
        {
          text: 'Print & End Trip',
          onPress: () => {
            handleEndTripWithMandatoryReport(true);
          },
        },
        {
          text: 'No 011, Print',
          onPress: () => {
            handleEndTripWithMandatoryReport(false);
          },
        },
      ],
      { cancelable: false },
    );
  };

  const handleVerify = async (id) => {
    setVerifyingTicket(id);
    try {
      await verifyTicketSupabase(id);
      clearTicket(id);
      showToast('Ticket verified ✓');
      fetchDashboard();
    } catch (e) {
      Alert.alert('Error', e?.message || 'Could not verify ticket.');
    } finally {
      setVerifyingTicket(null);
    }
  };

  if (dashLoading) {
    return (
      <View className="flex-1 justify-center items-center bg-zinc-950">
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text className="text-zinc-400 mt-3 text-sm">Loading…</Text>
      </View>
    );
  }

  const tripDisplay = at ? routeLabel(at.route_name, at.direction) : null;

  return (
    <SafeAreaView className="flex-1 bg-zinc-950">
      {changing && <BlockingOverlay message={changingMessage} />}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0ea5e9" colors={['#0ea5e9']} />
        }
      >
        {/* ── Pending Verification Requests ── */}
        {pendingRequests.length > 0 && (
          showVerification ? (
            <View className="bg-amber-950/40 border border-amber-500/30 rounded-2xl p-4 mb-4">
              {/* Header */}
              <View className="flex-row items-center justify-between mb-1">
                <View className="flex-row items-center gap-2 flex-1">
                  <Bell size={14} color="#f59e0b" />
                  <Text className="text-amber-400 text-sm font-bold">Verification Requests</Text>
                  <View className="bg-amber-500 rounded-full w-5 h-5 justify-center items-center">
                    <Text className="text-white text-[10px] font-black">{pendingRequests.length}</Text>
                  </View>
                  <Text className="text-amber-500 text-[11px] font-bold">● LIVE</Text>
                </View>
                <TouchableOpacity
                  onPress={() => setShowVerification(false)}
                  className="w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700 justify-center items-center ml-2"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <X size={14} color="#a1a1aa" />
                </TouchableOpacity>
              </View>
              <Text className="text-zinc-500 text-xs mb-3">Tap verify to confirm a passenger ticket</Text>
              {pendingRequests.map(i => (
                <PendingVerifyRow key={i.ticket_id} item={i} onVerify={handleVerify} onDismiss={dismissTicket} verifying={verifyingTicket} />
              ))}
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => setShowVerification(true)}
              activeOpacity={0.75}
              className="flex-row items-center justify-between bg-amber-950/40 border border-amber-500/40 rounded-2xl px-4 py-3 mb-4"
            >
              <View className="flex-row items-center gap-2">
                <AlertCircle size={16} color="#f59e0b" />
                <Text className="text-amber-400 text-sm font-semibold">
                  {pendingRequests.length} awaiting verification
                </Text>
              </View>
              <Text className="text-amber-500 text-xs font-bold">View →</Text>
            </TouchableOpacity>
          )
        )}

        {at ? (
          <>
            {/* ── Active Trip Card ── */}
            <View className="bg-zinc-900 rounded-2xl p-5 border border-zinc-800 mb-4">
              {/* Header: #N - ROUTE STATUS */}
              <View className="flex-row justify-between items-start mb-4">
                <View className="flex-1 mr-3 flex-row items-center flex-wrap">
                  {localTripNumber > 0 && (
                    <Text className="text-white text-2xl font-bold tracking-widest">
                      #{localTripNumber} -{' '}
                    </Text>
                  )}
                  <Text className="text-white text-2xl font-black leading-tight">{tripDisplay}</Text>
                </View>
                {at.status === 'running' ? (
                  <TouchableOpacity
                    onPress={() => navigation?.navigate?.('Reports')}
                    className="flex-row items-center gap-1.5 bg-sky-500/10 border border-sky-500/30 px-3 py-1.5 rounded-full">
                    <FileText size={13} color="#38bdf8" />
                    <Text className="text-sky-400 text-[11px] font-bold">Print</Text>
                  </TouchableOpacity>
                ) : (
                  <StatusBadge status={at.status} />
                )}
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
                  <Text className="text-sky-400 text-2xl font-black">{appTripLoading ? '…' : appOnlyTickets}</Text>
                  <Text className="text-zinc-500 text-[10px] font-semibold mt-0.5">APP TICKETS</Text>
                </View>
                <View className="w-px bg-zinc-700 mx-2" />
                <View className="flex-1 items-center">
                  <Text className="text-violet-400 text-2xl font-black">{activePOSCount}</Text>
                  <Text className="text-zinc-500 text-[10px] font-semibold mt-0.5">POS TICKETS</Text>
                </View>
                <View className="w-px bg-zinc-700 mx-2" />
                <View className="flex-1 items-center">
                  <Text className="text-emerald-400 text-2xl font-black">
                    ₹{appTripLoading ? '…' : Number(totalFare).toFixed(0)}
                  </Text>
                  <Text className="text-zinc-500 text-[10px] font-semibold mt-0.5">TOTAL</Text>
                </View>
                {pendingRequests.length > 0 && (
                  <>
                    <View className="w-px bg-zinc-700 mx-2" />
                    <View className="flex-1 items-center">
                      <Text className="text-amber-400 text-2xl font-black">{pendingRequests.length}</Text>
                      <Text className="text-zinc-500 text-[10px] font-semibold mt-0.5">PENDING</Text>
                    </View>
                  </>
                )}
              </View>

              {/* Trip Actions */}
              <View className="flex-row gap-2">
                {at.status === 'paused' && (
                  <TouchableOpacity
                    className="flex-1 flex-row items-center justify-center gap-2 bg-emerald-500/10 border border-emerald-500/30 py-3 rounded-xl"
                    onPress={() => changeStatus('running')}
                    disabled={true}
                  >
                    <Play size={16} color="#10b981" />
                    <Text className="text-emerald-400 text-sm font-bold">Resume</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  className="flex-1 flex-row items-center justify-center gap-2 bg-red-500/10 border border-red-500/30 py-3 rounded-xl"
                  onPress={() => { setPasscode(''); setPasscodeError(''); setShowPasscodeModal(true); }}
                  disabled={changing || endingTrip}
                >
                  <Square size={16} color="#f87171" />
                  <Text className="text-red-400 text-sm font-bold">End Trip</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* ── Direction Toggle ── */}
            <DirectionToggle
              routeName={at.route_name}
              currentDirection={at.direction}
              onStartReturn={handleStartReturn}
              starting={startingReturn}
            />
          </>
        ) : (
          /* ── No Trip: Direct Start Buttons ── */
          <StartTripButtons routes={routes} onStarted={handleTripStarted} />
        )}
      </ScrollView>

      {/* ── End Trip Passcode Modal ── */}
      <Modal
        visible={showPasscodeModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPasscodeModal(false)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <View style={{ backgroundColor: '#18181b', borderRadius: 20, padding: 28, width: '100%', maxWidth: 360, borderWidth: 1, borderColor: '#3f3f46' }}>
            <View style={{ alignItems: 'center', marginBottom: 20 }}>
              <View style={{ backgroundColor: 'rgba(239,68,68,0.15)', borderRadius: 50, padding: 14, marginBottom: 12 }}>
                <Square size={28} color="#f87171" />
              </View>
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800' }}>End Trip</Text>
              <Text style={{ color: '#71717a', fontSize: 13, marginTop: 6, textAlign: 'center' }}>Enter passcode to end and reset this trip</Text>
            </View>

            <TextInput
              style={{
                backgroundColor: '#27272a',
                borderRadius: 12,
                borderWidth: 1,
                borderColor: passcodeError ? '#ef4444' : '#3f3f46',
                color: '#fff',
                fontSize: 28,
                fontWeight: '800',
                letterSpacing: 12,
                textAlign: 'center',
                paddingVertical: 14,
                paddingHorizontal: 20,
                marginBottom: 8,
              }}
              value={passcode}
              onChangeText={(v) => { setPasscode(v); setPasscodeError(''); }}
              keyboardType="number-pad"
              maxLength={4}
              // secureTextEntry
              placeholder="----"
              placeholderTextColor="#52525b"
              autoFocus
            />

            {passcodeError ? (
              <Text style={{ color: '#ef4444', fontSize: 12, textAlign: 'center', marginBottom: 12 }}>{passcodeError}</Text>
            ) : (
              <View style={{ height: 20 }} />
            )}

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => { setShowPasscodeModal(false); setPasscode(''); setPasscodeError(''); }}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#27272a', borderWidth: 1, borderColor: '#3f3f46', alignItems: 'center' }}
              >
                <Text style={{ color: '#a1a1aa', fontWeight: '700', fontSize: 14 }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleEndTripConfirmed}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: 'rgba(239,68,68,0.9)', alignItems: 'center' }}
              >
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Report Modal for Testing Mode ── */}
      <Modal
        visible={showReportModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowReportModal(false)}
      >
        <View className="flex-1 bg-black/80 justify-center items-center px-4 py-16">
          <View className="bg-zinc-900 rounded-2xl p-6 w-full max-w-sm border border-white/20" style={{ maxHeight: '100%', flex: 1 }}>
            <View className="flex-row justify-between items-center mb-4">
              <Text className="text-white text-lg font-bold">Report Preview</Text>
              <TouchableOpacity onPress={() => setShowReportModal(false)}>
                <Text className="text-sky-400 font-semibold">Close</Text>
              </TouchableOpacity>
            </View>
            
            {reportData && (
              <View className="flex-1 mb-4 bg-white rounded-xl overflow-hidden">
                <ScrollView contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={true}>
                <Text className="text-black text-center font-bold text-lg mb-1">COLLECTION REPORT</Text>
                <Text className="text-black text-center text-base mb-1">{reportData.dateStr}  {reportData.timeStr}</Text>
                <Text className="text-black text-center text-xs mb-1">--------------------------------</Text>
                <Text className="text-black text-center text-base mb-1">BUS NUMBER:{reportData.busNo}</Text>
                <Text className="text-black text-center text-xs mb-2">--------------------------------</Text>

                <View className="flex-row justify-between mb-1">
                  <Text className="text-black font-bold w-12">TRIP</Text>
                  <Text className="text-black font-bold flex-1 text-center">ROUTE</Text>
                  <Text className="text-black font-bold w-20 text-right">AMOUNT</Text>
                </View>
                <Text className="text-black text-center text-xs mb-1">- - - - - - - - - - - - - - - - -</Text>
                
                {reportData.tripRows.map((r, i) => (
                  <View key={i} className="flex-row justify-between mb-1">
                    <Text className="text-black w-12">{r.trip}</Text>
                    <Text className="text-black flex-1 text-center">{r.route ?? '01'}</Text>
                    <Text className="text-black w-20 text-right">{Number(r.amount).toFixed(2)}</Text>
                  </View>
                ))}

                <Text className="text-black text-center text-xs mt-1 mb-1">- - - - - - - - - - - - - - - - -</Text>
                <View className="flex-row justify-between mb-1">
                  <Text className="text-black font-bold flex-1">TOTAL Rs.:</Text>
                  <Text className="text-black font-bold w-24 text-right">{Number(reportData.totalCollection).toFixed(2)}</Text>
                </View>
                <Text className="text-black text-center text-xs mb-2">--------------------------------</Text>

                <Text className="text-black text-center font-bold text-lg mb-1">EXPENSES</Text>
                <Text className="text-black text-center text-xs mb-2">- - - - - - - - - - - - - - - - -</Text>

                {reportData.expenses.map((e, i) => {
                  const label = e.label.toUpperCase().substring(0, 12);
                  const amt = Number(e.amount || 0);
                  return (
                    <View key={i} className="flex-row justify-between mb-1">
                      <Text className="text-black flex-1">{label} :</Text>
                      <Text className="text-black w-24 text-right">{amt.toFixed(2)}</Text>
                    </View>
                  );
                })}

                <Text className="text-black text-center text-xs mt-1 mb-1">- - - - - - - - - - - - - - - - -</Text>
                <View className="flex-row justify-between mb-2">
                  <Text className="text-black font-bold flex-1">TOTAL Rs.:</Text>
                  <Text className="text-black font-bold w-24 text-right">{Number(reportData.totalExpenses).toFixed(2)}</Text>
                </View>
                <Text className="text-black text-center text-xs mb-4">--------------------------------</Text>
                </ScrollView>
              </View>
            )}

            <TouchableOpacity
              className="bg-sky-500 rounded-xl py-3 items-center"
              onPress={() => setShowReportModal(false)}>
              <Text className="text-white font-bold">OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

export default TripScreen;