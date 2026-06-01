import React, { useState } from 'react';
import {
  Text, TouchableOpacity, View,
  Platform, Alert, ActivityIndicator, ToastAndroid,
} from 'react-native';
import { Bus, Play, ArrowLeftRight } from 'lucide-react-native';
import { supabase } from '../../lib/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const showToast = (msg, dur = ToastAndroid.SHORT) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, dur);
  else Alert.alert('', msg);
};

const normalizeDir = (d) => (d ?? '').toString().trim().toLowerCase();

const isDown = (d) => ['dn', 'down', 'return'].includes(normalizeDir(d));

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

export const startTripFromSupabase = async ({ routeId, direction, busId = null }) => {
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
  const { data: createdRows, error } = await supabase
    .from('trips')
    .insert(insertPayload)
    .select('id,bus_id,trip_number,start_time')
    .limit(1);
  if (error) throw error;
  const created = createdRows?.[0] ?? null;
  return { trip: created, conductorId, tripNumber };
};

// ─── Direction Toggle ──────────────────────────────────────────────────────────
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

// ─── Start Trip Buttons (no active trip) ──────────────────────────────────────
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

// ─── TripChange ────────────────────────────────────────────────────────────────
// Renders DirectionToggle when a trip is active, or StartTripButtons when idle.
// Props:
//   at            — active_trip object (or null)
//   routes        — array of { id, name } from Supabase
//   startingReturn — boolean loading state for direction switch
//   onStartReturn — (dir: string) => void
//   onStarted     — (tripPayload) => void
const TripChange = ({ at, routes, startingReturn, onStartReturn, onStarted }) => {
  if (at) {
    return (
      <DirectionToggle
        routeName={at.route_name}
        currentDirection={at.direction}
        onStartReturn={onStartReturn}
        starting={startingReturn}
      />
    );
  }
  return <StartTripButtons routes={routes} onStarted={onStarted} />;
};

export default TripChange;
