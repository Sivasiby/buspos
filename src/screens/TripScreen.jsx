import React, { useState, useEffect, useCallback } from 'react';
import {
  Text, TouchableOpacity, View, ScrollView,
  Platform, Alert, ActivityIndicator, ToastAndroid, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Bus, Play, Pause, Square,
  UserCheck, CheckCircle, Clock, Timer, ArrowLeftRight, FileText,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import api from '../api/api';
import { supabase } from '../../lib/supabase';
import { useVerificationRealtime } from '../hooks/useVerificationRealtime';
import { useTripContext } from '../context/TripContext';

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
const isDown = (d) => ['dn', 'down', 'return'].includes(normalizeDir(d));

const routeLabel = (name, dir) => {
  if (!name) return '';
  if (!isDown(dir)) return name;
  const parts = name.split(/\s*(?:->|→|-)\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return name;
  return [...parts].reverse().join(' → ');
};

const assignTripNumber = async (tripId, conductorId) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('trips')
      .select('id', { count: 'exact', head: true })
      .eq('conductor_id', conductorId)
      .gte('start_time', todayStart.toISOString());
    if (error) throw error;
    const num = Math.max(1, count ?? 1);
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
const PendingVerifyRow = ({ item, onVerify, verifying }) => (
  <View className="flex-row items-center justify-between bg-zinc-900 rounded-xl p-3 mb-2 border border-amber-500/30">
    <View className="flex-row items-center flex-1 mr-3 gap-3">
      <View className="w-9 h-9 rounded-full bg-amber-500/20 justify-center items-center">
        <UserCheck size={17} color="#f59e0b" />
      </View>
      <View className="flex-1">
        <Text className="text-white text-sm font-bold">{item.from || '?'} → {item.to || '?'}</Text>
        <Text className="text-zinc-400 text-xs mt-0.5">₹{item.fare ?? 0}{item.bus_number ? `  ·  ${item.bus_number}` : ''}</Text>
      </View>
    </View>
    <TouchableOpacity
      className="flex-row items-center gap-1.5 bg-emerald-600 px-3 py-2 rounded-lg"
      onPress={() => onVerify(item.ticket_id)}
      disabled={verifying === item.ticket_id}
    >
      {verifying === item.ticket_id
        ? <ActivityIndicator size="small" color="#fff" />
        : <><CheckCircle size={13} color="#fff" /><Text className="text-white text-xs font-bold">Verify</Text></>
      }
    </TouchableOpacity>
  </View>
);

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
  const [dir, setDir] = useState('up');
  const [loading, setLoading] = useState(false);

  const start = async () => {
    const routeId = routes.length > 0 ? routes[0].id : null;
    if (!routeId) { Alert.alert('Error', 'No routes available.'); return; }
    setLoading(true);
    try {
      const r = await api.post('/conductor/trip/start', { route_id: routeId, direction: dir });
      if (r.data?.success) {
        showToast('Trip started!');
        const selectedRoute = routes[0];
        onStarted({ direction: dir, route_name: selectedRoute?.name, start_time: new Date().toISOString(), bus_id: r.data?.trip?.bus_id });
      }
    } catch (e) {
      Alert.alert('Error', e?.response?.data?.error || 'Failed to start trip.');
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
          { key: 'up', label: 'STY TO CBE' },
          { key: 'dn', label: 'CBE TO STY' }
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
  const [appOnlyTickets, setAppOnlyTickets] = useState(0);
  const [appOnlyFare, setAppOnlyFare] = useState(0);
  const [appTripLoading, setAppTripLoading] = useState(false);
  const [localTripNumber, setLocalTripNumber] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const at = dashboard?.active_trip;

  const { pendingRequests, clearTicket } = useVerificationRealtime(at?.trip_id, at?.status);

  const activePOSTix = posHook.tickets.filter(t => t.trip_id === at?.trip_id);
  const activePOSCount = activePOSTix.reduce((s, t) => s + Number(t.ticket_count ?? 0), 0);
  const activePOSFare = activePOSTix.reduce((s, t) => s + Number(t.fare ?? 0), 0);
  const totalFare = appOnlyFare + activePOSFare;

  useEffect(() => { fetchDashboard(); }, []);

  useEffect(() => {
    api.get('/conductor/routes').then(r => setRoutes(r.data?.routes || [])).catch(() => {});
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
          .neq('payment_method', 'pos');
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
  }, [at?.trip_id]);

  const fetchDashboard = async () => {
    try {
      const r = await api.get('/conductor/dashboard');
      setDashboard(r.data);
      const conductorId = r.data?.active_trip?.conductor_id ?? r.data?.conductor?.id;
      const tripId = r.data?.active_trip?.trip_id;
      const dbTripNumber = Number(r.data?.active_trip?.trip_number ?? 0);
      if (dbTripNumber > 0) {
        setLocalTripNumber(dbTripNumber);
      } else if (conductorId && tripId) {
        const nextNum = await assignTripNumber(tripId, conductorId);
        setLocalTripNumber(nextNum);
      }
      setCtxTrip(r.data?.active_trip ?? null);
      setCtxTripNumber(dbTripNumber);
      if (r.data?.bus?.vehicle_number) setCtxBusNumber(r.data.bus.vehicle_number);
    } catch (e) { console.error(e); }
    finally { setDashLoading(false); }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchDashboard();
      const r = await api.get('/conductor/routes');
      setRoutes(r.data?.routes || []);
      if (posHook.reload) await posHook.reload();
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
        const r = await api.get('/conductor/dashboard');
        dash = r.data;
        if (dash?.active_trip?.trip_id) break;
        await new Promise(res => setTimeout(res, 700));
      }
      if (dash) {
        setDashboard(dash);
        const conductorId = dash?.active_trip?.conductor_id ?? dash?.conductor?.id;
        const tripId = dash?.active_trip?.trip_id ?? dash?.active_trip?.id;
        const dbTripNumber = Number(dash?.active_trip?.trip_number ?? 0);
        if (dbTripNumber > 0) {
          setLocalTripNumber(dbTripNumber);
        } else if (conductorId && tripId) {
          const nextNum = await assignTripNumber(tripId, conductorId);
          setLocalTripNumber(nextNum);
        }
        setCtxTrip(dash?.active_trip ?? null);
        setCtxTripNumber(dbTripNumber);
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
              await api.post(`/conductor/trip/${at.trip_id}/status`, { status: 'completed' });
              setChangingMessage('Starting return trip…');
              const route = routes.find(r => r.name === at.route_name) ?? routes[0];
              if (!route) throw new Error('Route not found');
              const r = await api.post('/conductor/trip/start', { route_id: route.id, direction: dir });
              if (r.data?.success) {
                showToast('Return trip started!');
                await handleTripStarted({ direction: dir, route_name: route.name, start_time: new Date().toISOString() });
              }
            } catch (e) {
              Alert.alert('Error', e?.response?.data?.error || 'Could not switch trip.');
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
            await api.post(`/conductor/trip/${at.trip_id}/status`, { status: s });
            showToast(toastLabels[s] || 'Done');
            await handleTripStarted();
          } catch (e) {
            Alert.alert('Error', e?.response?.data?.error || 'Could not change status.');
          } finally {
            setChanging(false);
            setChangingMessage('');
          }
        },
      },
    ]);
  };

  const handleVerify = async (id) => {
    setVerifyingTicket(id);
    try {
      await api.post(`/conductor/ticket/${id}/verify`);
      clearTicket(id);
      showToast('Ticket verified ✓');
      fetchDashboard();
    } catch (e) {
      Alert.alert('Error', e?.response?.data?.error || 'Could not verify ticket.');
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
          <View className="bg-amber-950/40 border border-amber-500/30 rounded-2xl p-4 mb-4">
            <View className="flex-row justify-between items-center mb-1">
              <View className="flex-row items-center gap-2">
                <Text className="text-amber-400 text-sm font-bold">Verification Requests</Text>
                <View className="bg-amber-500 rounded-full w-5 h-5 justify-center items-center">
                  <Text className="text-white text-[10px] font-black">{pendingRequests.length}</Text>
                </View>
              </View>
              <Text className="text-amber-500 text-[11px] font-bold">● LIVE</Text>
            </View>
            <Text className="text-zinc-500 text-xs mb-3">Tap verify to confirm passenger ticket</Text>
            {pendingRequests.map(i => (
              <PendingVerifyRow key={i.ticket_id} item={i} onVerify={handleVerify} verifying={verifyingTicket} />
            ))}
          </View>
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
                {at.status === 'running' && (
                  <TouchableOpacity
                    className="flex-1 flex-row items-center justify-center gap-2 bg-amber-500/10 border border-amber-500/30 py-3 rounded-xl"
                    onPress={() => changeStatus('paused')}
                    disabled={changing}
                  >
                    <Pause size={16} color="#f59e0b" />
                    <Text className="text-amber-400 text-sm font-bold">Pause</Text>
                  </TouchableOpacity>
                )}
                {at.status === 'paused' && (
                  <TouchableOpacity
                    className="flex-1 flex-row items-center justify-center gap-2 bg-emerald-500/10 border border-emerald-500/30 py-3 rounded-xl"
                    onPress={() => changeStatus('running')}
                    disabled={changing}
                  >
                    <Play size={16} color="#10b981" />
                    <Text className="text-emerald-400 text-sm font-bold">Resume</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  className="flex-1 flex-row items-center justify-center gap-2 bg-red-500/10 border border-red-500/30 py-3 rounded-xl"
                  onPress={() => changeStatus('completed')}
                  disabled={changing}
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
    </SafeAreaView>
  );
};

export default TripScreen;