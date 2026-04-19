import React, {useState, useCallback, useEffect, useRef} from 'react';
import {
  Text, TouchableOpacity, View, ScrollView,
  Platform, Alert, ActivityIndicator, ToastAndroid,
  TextInput,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  ArrowUpDown, Minus, Plus, Play,
  Bus, AlertCircle, Download, MapPin, CloudOff,
} from 'lucide-react-native';
import {getRandomFortune} from '../utils/fortune';
import {places} from '../utils/places';
import {fareMatrix} from '../utils/fareMatrix';
import {supabase} from '../../lib/supabase';
import api from '../api/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

const showToast = (msg, dur = ToastAndroid.SHORT) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, dur);
  else Alert.alert('', msg);
};

const normalizeDirection = (d) => (d ?? '').toString().trim().toLowerCase();
const isDownDirection = (d) => ['dn', 'down', 'return'].includes(normalizeDirection(d));
const parseAmount = (v) => { const n = Number(v); return !Number.isFinite(n) || n < 0 ? 0 : n; };
const halfFare = (full) => Math.ceil(full / 2);
const fareStr = (n) => n % 1 === 0 ? `${n}.00` : n.toFixed(2);
const genId = () => `pos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const routeNameForDirection = (routeName, direction) => {
  if (!routeName) return '';
  if (!isDownDirection(direction)) return routeName;
  const parts = routeName.split(/\s*(?:->|→|-)\s*/).map(p => p.trim()).filter(Boolean);
  return parts.length < 2 ? routeName : [...parts].reverse().join(' → ');
};

const formatDuration = (start, end) => {
  if (!start) return '—';
  const mins = Math.round(((end ? new Date(end) : new Date()).getTime() - new Date(start).getTime()) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

const getNextTicketNumber = async (busId) => {
  if (!busId) return null;
  try {
    const {data, error} = await supabase.rpc('increment_ticket_number', {p_bus_id: busId});
    if (error) throw error;
    return typeof data === 'number' ? data : null;
  } catch (e) {
    console.warn('[TicketNum] RPC failed:', e);
    return null;
  }
};

// ─── Counter Component ────────────────────────────────────────────────────────
const Counter = ({label, sublabel, value, onChange}) => (
  <View className="flex-1 bg-black rounded-xl p-3 border border-white/20">
    <Text className="text-white text-xs font-medium mb-1 uppercase tracking-wider">{label}</Text>
    {sublabel ? <Text className="text-white text-xs mb-2">{sublabel}</Text> : null}
    <View className="flex-row items-center justify-between">
      <TouchableOpacity
        onPress={() => onChange(Math.max(0, value - 1))}
        disabled={value <= 0}
        className={`w-8 h-8 rounded-lg items-center justify-center ${value <= 0 ? 'bg-black' : 'bg-black'}`}>
        <Minus size={14} color={value <= 0 ? '#ffffff' : '#ffffff'} />
      </TouchableOpacity>
      <TextInput
        className="text-center text-xl font-bold text-white w-10"
        keyboardType="numeric"
        value={String(value)}
        onChangeText={v => onChange(Math.max(0, Number(v.replace(/[^0-9]/g, '')) || 0))}
      />
      <TouchableOpacity
        onPress={() => onChange(value + 1)}
        className="w-8 h-8 rounded-lg items-center justify-center bg-black">
        <Plus size={14} color="#ffffff" />
      </TouchableOpacity>
    </View>
  </View>
);

// ─── TicketTab ────────────────────────────────────────────────────────────────
const TicketTab = ({activeTrip, busNumber, _onTicketIssued, tripNumber, posHook}) => {
  const tripDirection = activeTrip?.direction ?? 'up';
  const getPlaces = useCallback(
    () => isDownDirection(tripDirection) ? [...places].reverse() : places,
    [tripDirection],
  );

  const [selStart, setSelStart] = useState<any>(null);
  const [selDest, setSelDest] = useState<any>(null);
  const [activeDrop, setActiveDrop] = useState<string | null>('start');
  const [dirErr, setDirErr] = useState(null);
  const [issuing, setIssuing] = useState(false);
  const [luggageInput, setLuggageInput] = useState('0');
  const [fullCount, setFullCount] = useState(1);
  const [halfCount, setHalfCount] = useState(0);

  const stopKey = (dir: string) => `ticket_stops_${dir}`;

  const saveStops = useCallback(async (start: any, dest: any, dir: string) => {
    try {
      await AsyncStorage.setItem(stopKey(dir), JSON.stringify({ start, dest }));
    } catch {}
  }, []);

  const isFirstMount = useRef(true);

  useEffect(() => {
    const loadStops = async () => {
      try {
        const raw = await AsyncStorage.getItem(stopKey(tripDirection));
        if (raw) {
          const { start, dest } = JSON.parse(raw);
          setSelStart(start ?? null);
          setSelDest(dest ?? null);
          setActiveDrop(start && dest ? null : start ? 'destination' : 'start');
        } else {
          setSelStart(null); setSelDest(null); setActiveDrop('start');
        }
      } catch {
        setSelStart(null); setSelDest(null); setActiveDrop('start');
      }
      setDirErr(null);
      if (!isFirstMount.current) {
        setFullCount(1); setHalfCount(0); setLuggageInput('0');
      }
      isFirstMount.current = false;
    };
    loadStops();
  }, [tripDirection]);

  const getFare = useCallback((sk, ek) => fareMatrix?.[sk]?.[ek] ?? 0, []);

  const baseFullFare = selStart?.key && selDest?.key ? getFare(selStart.key, selDest.key) : 0;
  const baseHalfFare = halfFare(baseFullFare);
  const fullTotal = baseFullFare * fullCount;
  const halfTotal = baseHalfFare * halfCount;
  const luggageAmount = parseAmount(luggageInput);
  const grandTotal = fullTotal + halfTotal + luggageAmount;
  const totalTickets = fullCount + halfCount + (luggageAmount > 0 ? 1 : 0);
  const hasPassengerTickets = fullCount > 0 || halfCount > 0;
  const isReady = !!(selStart && selDest && !dirErr && (luggageAmount > 0 || (hasPassengerTickets && baseFullFare > 0)));

  useEffect(() => {
    setDirErr(null);
    if (!selStart?.key || !selDest?.key) return;
    const ss = Number(selStart.label.split('-')[1]);
    const ds = Number(selDest.label.split('-')[1]);
    if (tripDirection === 'up' && ss < ds) { setDirErr('Wrong direction for UP trip (CBE → STY)'); return; }
    if (isDownDirection(tripDirection) && ss > ds) { setDirErr('Wrong direction for DN trip (STY → CBE)'); return; }
  }, [selStart, selDest, tripDirection]);

  const handleIssue = async () => {
    if (Platform.OS !== 'android' || !NyxPrinter) {
      Alert.alert('Not supported', 'Printing is only available on Android.');
      return;
    }
    setIssuing(true);
    try {
      const statusRet = await NyxPrinter.getPrinterStatus();
      if (statusRet !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(statusRet));
        return;
      }

      // Start fetching ticket number immediately so we don't block the printer from starting
      const busId = activeTrip?.bus_id ?? null;
      const ticketNumPromise = getNextTicketNumber(busId);

      // Start printing the header immediately
      await NyxPrinter.printText('SPS - ZYRAP', { textSize: 28, align: PrintAlign.CENTER });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });

      const now = new Date();
      const dp = now.toLocaleDateString('en-GB').replace(/\//g, '-');
      const tp = now.toLocaleTimeString('en-GB', {hour12: false});
      const fortune = getRandomFortune();
      const fn = selStart?.label?.split('-')[2] ?? selStart?.label ?? '';
      const tn = selDest?.label?.split('-')[2] ?? selDest?.label ?? '';
      const fnum = selStart?.label?.split('-')[1] ?? '';
      const tnum = selDest?.label?.split('-')[1] ?? '';

      let cFull = 0, cHalf = 0, cLug = 0;
      if (fullCount > 0) cFull = 1;
      else if (halfCount > 0) cHalf = 1;
      else if (luggageAmount > 0) cLug = luggageAmount;

      const cFullTotal = cFull * baseFullFare;
      const cHalfTotal = cHalf * baseHalfFare;
      const cGrandTotal = cFullTotal + cHalfTotal + cLug;

      // Await the ticket number here, after the printer has already started making noise
      const firstTicketNum = await ticketNumPromise;
      const isLuggageOnlyTicket = (cFull === 0 && cHalf === 0 && cLug > 0);

      let fullTicketNum = null;
      let halfTicketNum = null;

      if (cFull > 0) {
        fullTicketNum = firstTicketNum;
      } else if (cHalf > 0) {
        halfTicketNum = firstTicketNum;
      } else if (isLuggageOnlyTicket) {
        fullTicketNum = firstTicketNum;
      }

      const numLine = [
        fullTicketNum ? `#${fullTicketNum}` : null,
        halfTicketNum ? `#${halfTicketNum}` : null,
      ].filter(Boolean).join(' / ');

      await NyxPrinter.printText(`Bus: ${busNumber}${numLine ? `   #${numLine.replace(/#/g, '')}` : ''}`, { textSize: 24, align: PrintAlign.CENTER });
      await NyxPrinter.printText(`${dp}  ${tp}`, { textSize: 24, align: PrintAlign.CENTER });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(`${fn}  to  ${tn}`, { textSize: 24, align: PrintAlign.CENTER });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      if (cFull > 0)
        await NyxPrinter.printText(`ADULT   Rs ${fareStr(cFullTotal)}`, { textSize: 24 });
      if (cHalf > 0)
        await NyxPrinter.printText(`CHILD   Rs ${fareStr(cHalfTotal)}`, { textSize: 24 });
      if (cLug > 0)
        await NyxPrinter.printText(`LUGGAGE   Rs ${fareStr(cLug)}`, { textSize: 24 });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(fortune, { textSize: 18, align: PrintAlign.CENTER });
      await NyxPrinter.printEndAutoOut();

      // Save locally — fire-and-forget, never blocks the UI
      if (cFull > 0) {
        posHook.saveTicket({
          id: genId(),
          trip_id: activeTrip?.trip_id ?? null,
          from_stop: `${fnum}-${fn}`,
          to_stop: `${tnum}-${tn}`,
          from_key: selStart?.key || '',
          to_key: selDest?.key || '',
          ticket_count: cFull,
          fare: cFullTotal,
          unit_fare: baseFullFare,
          ticket_type: 'full',
          luggage_amount: cLug, // Attach luggage to full
          ticket_number: fullTicketNum,
          bus_number: busNumber,
          direction: tripDirection,
          issued_at: now.toISOString()
        });
      }

      if (cHalf > 0) {
        posHook.saveTicket({
          id: genId(),
          trip_id: activeTrip?.trip_id ?? null,
          from_stop: `${fnum}-${fn}`,
          to_stop: `${tnum}-${tn}`,
          from_key: selStart?.key || '',
          to_key: selDest?.key || '',
          ticket_count: cHalf,
          fare: cHalfTotal,
          unit_fare: baseHalfFare,
          ticket_type: 'half',
          luggage_amount: cFull === 0 ? cLug : 0, // Attach to half if no full
          ticket_number: halfTicketNum,
          bus_number: busNumber,
          direction: tripDirection,
          issued_at: now.toISOString()
        });
      }

      if (cFull === 0 && cHalf === 0 && cLug > 0) {
         posHook.saveTicket({
          id: genId(),
          trip_id: activeTrip?.trip_id ?? null,
          from_stop: `${fnum}-${fn}`,
          to_stop: `${tnum}-${tn}`,
          from_key: selStart?.key || '',
          to_key: selDest?.key || '',
          ticket_count: 0,
          fare: cLug,
          unit_fare: 0,
          ticket_type: 'full',
          luggage_amount: cLug,
          ticket_number: fullTicketNum,
          bus_number: busNumber,
          direction: tripDirection,
          issued_at: now.toISOString()
        });
      }

      showToast(`Ticket issued · ₹${cGrandTotal}`);

      const nextFull = fullCount - cFull;
      const nextHalf = halfCount - cHalf;
      const nextLug = luggageAmount - cLug;

      if (nextFull === 0 && nextHalf === 0) {
        // All queued tickets done — reset to ready state so the next
        // passenger for the same route doesn't require pressing + again.
        setFullCount(1);
        setHalfCount(0);
      } else {
        setFullCount(nextFull);
        setHalfCount(nextHalf);
      }
      if (cLug > 0) setLuggageInput('0');

      if (nextFull === 0 && nextHalf === 0 && nextLug === 0) {
        setActiveDrop(null);
      }
    } catch (e) {
      Alert.alert('Error', e.message || 'Unknown');
    } finally {
      setIssuing(false);
    }
  };

  const stopLabel = (p) => p.label.split('-')[2] ?? p.label.split('-').slice(1).join(' ');
  const stopNum = (p) => p.label.split('-')[1];

  return (
    <>
      <ScrollView
        className="flex-1 bg-black"
        contentContainerStyle={{padding: 16, paddingBottom: isReady ? 120 : 40}}
        showsVerticalScrollIndicator={false}>

        {/* ── Trip Info Bar ── */}
        <View className="flex-row items-center gap-3 mb-5 px-1">
          <View className="flex-row items-center gap-1.5">
            <Bus size={14} color={activeTrip ? '#22c55e' : '#ffffff'} />
            <Text className="text-white text-sm font-semibold">
              {busNumber !== 'N/A' ? busNumber : '—'}
            </Text>
          </View>
          <View className="w-px h-4 bg-black" />
          {activeTrip ? (
            <>
              <MapPin size={13} color="#ffffff" />
              <Text className="text-white text-sm flex-1" numberOfLines={1}>
                {routeNameForDirection(activeTrip.route_name, tripDirection)}
              </Text>
              <Text className="text-white text-xs">
                {formatDuration(activeTrip.start_time, null)}
                {tripNumber > 0 ? ` · #${tripNumber}` : ''}
              </Text>
              <View className={`px-2 py-0.5 rounded-full ${activeTrip.status === 'running' ? 'bg-green-950' : 'bg-black'}`}>
                <Text className={`text-xs font-semibold ${activeTrip.status === 'running' ? 'text-green-400' : 'text-white'}`}>
                  {activeTrip.status.toUpperCase()}
                </Text>
              </View>
              {posHook.unsyncedCount > 0 && (
                <TouchableOpacity
                  onPress={() => posHook.syncToDb()}
                  disabled={posHook.syncing}
                  className="flex-row items-center gap-1 bg-amber-500/20 border border-amber-500/40 px-2 py-0.5 rounded-full">
                  {posHook.syncing
                    ? <ActivityIndicator size={10} color="#f59e0b" />
                    : <CloudOff size={10} color="#f59e0b" />}
                  <Text className="text-amber-400 text-[10px] font-bold">{posHook.unsyncedCount}</Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <View className="flex-row items-center gap-1.5">
              <AlertCircle size={13} color="#f59e0b" />
              <Text className="text-amber-400 text-sm">No active trip</Text>
            </View>
          )}
        </View>

        {!activeTrip ? (
          <View className="items-center justify-center py-16 gap-3">
            <AlertCircle size={32} color="#ffffff" />
            <Text className="text-white text-base font-semibold">No Active Trip</Text>
            <Text className="text-white text-sm text-center">Start a trip from the Trip tab to issue tickets.</Text>
          </View>
        ) : (
          <>
            {/* ── Direction Error ── */}
            {dirErr && (
              <View className="flex-row items-center gap-2 bg-red-950 border border-red-900 rounded-xl px-3 py-2.5 mb-4">
                <AlertCircle size={14} color="#ffffff" />
                <Text className="text-white text-sm flex-1">{dirErr}</Text>
              </View>
            )}

            {/* ── Stop Selector ── */}
            <View className="flex-row items-stretch bg-black rounded-xl border border-white/20 mb-4 overflow-hidden">
              {/* FROM */}
              <TouchableOpacity
                className={`flex-1 px-3 py-3 ${activeDrop === 'start' ? 'bg-black' : ''}`}
                onPress={() => setActiveDrop(p => p === 'start' ? null : 'start')}>
                <Text className="text-white text-xs font-bold tracking-widest mb-1">FROM</Text>
                {selStart ? (
                  <View className="flex-row items-baseline gap-1">
                    <Text className="text-sky-400 text-2xl font-black leading-7">{stopNum(selStart)}</Text>
                    <Text className="text-white text-sm font-medium flex-shrink" numberOfLines={1}>{stopLabel(selStart)}</Text>
                  </View>
                ) : (
                  <Text className="text-white text-sm">Select stop</Text>
                )}
              </TouchableOpacity>

              {/* Swap */}
              <TouchableOpacity
                className={`w-10 items-center justify-center border-x border-white/20 ${(!selStart || !selDest) ? 'opacity-30' : ''}`}
                onPress={() => { if (selStart && selDest) { const t = selStart; setSelStart(selDest); setSelDest(t); } }}
                disabled={!selStart || !selDest}>
                <ArrowUpDown size={15} color="#ffffff" />
              </TouchableOpacity>

              {/* TO */}
              <TouchableOpacity
                className={`flex-1 px-3 py-3 ${activeDrop === 'destination' ? 'bg-black' : ''}`}
                onPress={() => setActiveDrop(p => p === 'destination' ? null : 'destination')}>
                <Text className="text-white text-xs font-bold tracking-widest mb-1">TO</Text>
                {selDest ? (
                  <View className="flex-row items-baseline gap-1">
                    <Text className="text-orange-400 text-2xl font-black leading-7">{stopNum(selDest)}</Text>
                    <Text className="text-white text-sm font-medium flex-shrink" numberOfLines={1}>{stopLabel(selDest)}</Text>
                  </View>
                ) : (
                  <Text className="text-white text-sm">Select stop</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* ── Stop Grid ── */}
            {(activeDrop === 'start' || activeDrop === 'destination') && (
              <View className="bg-black rounded-xl border border-white/20 mb-4 overflow-hidden">
                <View className="flex-row flex-wrap">
                  {(activeDrop === 'destination'
                    ? getPlaces().filter((_, idx) => {
                        if (!selStart) return true;
                        const si = getPlaces().findIndex(p => p.key === selStart.key);
                        return idx > si;
                      })
                    : getPlaces()
                  ).map((p, idx) => {
                    const isSel = activeDrop === 'start' ? selStart?.key === p.key : selDest?.key === p.key;
                    const isDis = activeDrop === 'start' ? selDest?.key === p.key : selStart?.key === p.key;
                    const isNotLastInRow = (idx + 1) % 3 !== 0;
                    return (
                      <TouchableOpacity
                        key={p.key}
                        disabled={isDis}
                        onPress={() => {
                          if (activeDrop === 'start') {
                            setSelStart(p);
                            saveStops(p, selDest, tripDirection);
                            setActiveDrop('destination');
                          } else {
                            setSelDest(p);
                            saveStops(selStart, p, tripDirection);
                            setActiveDrop(null);
                          }
                        }}
                        className={[
                          'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                          'border-b border-white/20',
                          isNotLastInRow ? 'border-r border-white/20' : '',
                          isSel && activeDrop === 'start' ? 'bg-sky-950' : '',
                          isSel && activeDrop === 'destination' ? 'bg-orange-950' : '',
                          isDis ? 'opacity-30' : '',
                        ].join(' ')}>
                        <Text
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          className={`text-2xl font-black text-center ${isSel && activeDrop === 'start' ? 'text-sky-400' : isSel && activeDrop === 'destination' ? 'text-orange-400' : 'text-white'}`}>
                          {stopNum(p)}
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

            {/* ── Passenger Counts ── */}
            <View className="flex-row gap-3 mb-4">
              <Counter
                label="Full"
                sublabel={baseFullFare > 0 ? `₹${fareStr(baseFullFare)} each` : null}
                value={fullCount}
                onChange={setFullCount}
              />
              <Counter
                label="Half"
                sublabel={baseHalfFare > 0 ? `₹${fareStr(baseHalfFare)} each` : null}
                value={halfCount}
                onChange={setHalfCount}
              />
            </View>

            {/* ── Luggage ── */}
            <View className="bg-black rounded-xl border border-white/20 px-4 py-3 mb-6">
              <Text className="text-white text-xs font-bold tracking-widest mb-2">LUGGAGE CHARGE (₹)</Text>
              <TextInput
                className="text-white text-lg font-semibold"
                keyboardType="numeric"
                value={luggageInput}
                onChangeText={setLuggageInput}
                placeholder="0"
                placeholderTextColor="#ffffff"
              />
            </View>

            {/* ── Total ── */}
            <View className="items-center mb-6">
              <Text className="text-sky-400 text-5xl font-black tracking-tight">₹{fareStr(grandTotal)}</Text>
              <Text className="text-white text-sm mt-1">{totalTickets} ticket{totalTickets !== 1 ? 's' : ''}</Text>
            </View>

            {/* ── Issue Button ── */}
            <TouchableOpacity
              className={`bg-sky-500 rounded-xl py-4 flex-row items-center justify-center gap-2 ${!isReady ? 'opacity-40' : ''}`}
              onPress={handleIssue}
              disabled={!isReady || issuing}>
              {issuing
                ? <ActivityIndicator color="#fff" />
                : <><Download size={18} color="#fff" /><Text className="text-white text-base font-bold tracking-wide">ISSUE & PRINT TICKET</Text></>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

    </>
  );
};

// ─── Start Trip (Home) ────────────────────────────────────────────────────────
const StartTripHome = ({ onStarted }: { onStarted: (trip: any) => void }) => {
  const [loading, setLoading] = useState(false);
  const [dir, setDir] = useState('up');

  const start = async () => {
    setLoading(true);
    try {
      const routesRes = await api.get('/conductor/routes');
      const route = routesRes.data?.routes?.[0];
      if (!route) { Alert.alert('Error', 'No routes available.'); return; }
      const r = await api.post('/conductor/trip/start', { route_id: route.id, direction: dir });
      if (r.data?.success) {
        showToast('Trip started!');
        onStarted({
          ...r.data.trip,
          route_name: route.name,
          direction: dir,
          start_time: new Date().toISOString(),
          status: 'running',
        });
      }
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.error || 'Failed to start trip.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View className="flex-1 justify-center px-6 bg-black gap-5">
      <View className="items-center gap-2">
        <Bus size={44} color="#3f3f46" />
        <Text className="text-white text-lg font-bold">No Active Trip</Text>
        <Text className="text-zinc-500 text-sm text-center">Start a trip to issue tickets</Text>
      </View>
      <View className="flex-row gap-3">
        {[{ key: 'up', label: 'STY → CBE' }, { key: 'dn', label: 'CBE → STY' }].map(d => (
          <TouchableOpacity
            key={d.key}
            onPress={() => setDir(d.key)}
            className={`flex-1 py-4 rounded-xl items-center border ${
              dir === d.key ? 'bg-sky-500 border-sky-500' : 'bg-zinc-900 border-zinc-700'
            }`}>
            <Text className={`text-base font-bold ${dir === d.key ? 'text-white' : 'text-zinc-400'}`}>
              {d.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <TouchableOpacity
        className={`flex-row items-center justify-center gap-3 bg-sky-500 rounded-2xl py-4 ${loading ? 'opacity-60' : ''}`}
        onPress={start}
        disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Play size={20} color="#fff" />}
        <Text className="text-white text-base font-bold">Start Trip</Text>
      </TouchableOpacity>
    </View>
  );
};

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const { activeTrip, setActiveTrip, busNumber, setBusNumber, tripNumber, setTripNumber, posHook } = useTripContext();
  const [dashLoaded, setDashLoaded] = useState(false);

  useEffect(() => {
    if (dashLoaded) return;
    const fetchDashboard = async () => {
      try {
        const r = await api.get('/conductor/dashboard');
        const dashboard = r.data;
        const trip = dashboard?.active_trip;

        if (trip?.trip_id && trip?.start_time &&
            trip.status !== 'completed' && trip.status !== 'cancelled') {
          const elapsed = Date.now() - new Date(trip.start_time).getTime();
          if (elapsed >= 8 * 60 * 60 * 1000) {
            try {
              await api.post(`/conductor/trip/${trip.trip_id}/status`, { status: 'completed' });
              showToast('Trip auto-ended (exceeded 8 hours)');
            } catch (e) {
              console.error('[HomeScreen] Auto-end failed:', e);
            }
            setActiveTrip(null);
            if (dashboard?.bus?.vehicle_number) setBusNumber(dashboard.bus.vehicle_number);
            setDashLoaded(true);
            return;
          }
        }

        if (trip) {
          setActiveTrip(trip);
          setTripNumber(Number(trip.trip_number ?? 0));
        }
        if (dashboard?.bus?.vehicle_number) setBusNumber(dashboard.bus.vehicle_number);
      } catch (e) {
        console.error('[HomeScreen] Failed to fetch dashboard:', e);
      } finally {
        setDashLoaded(true);
      }
    };
    fetchDashboard();
  }, [dashLoaded]);

  if (!dashLoaded) {
    return (
      <SafeAreaView className="flex-1 bg-black" style={{justifyContent: 'center', alignItems: 'center'}}>
        <ActivityIndicator size="large" color="#00b7f3" />
      </SafeAreaView>
    );
  }

  if (!activeTrip) {
    return (
      <SafeAreaView className="flex-1 bg-black">
        <StartTripHome
          onStarted={(trip) => {
            setActiveTrip(trip);
            setTripNumber(Number(trip?.trip_number ?? 0));
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-black">
      <TicketTab
        activeTrip={activeTrip}
        busNumber={busNumber}
        _onTicketIssued={() => {}}
        tripNumber={tripNumber}
        posHook={posHook}
      />
    </SafeAreaView>
  );
}