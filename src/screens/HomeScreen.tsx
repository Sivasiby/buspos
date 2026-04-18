import React, {useState, useCallback, useEffect} from 'react';
import {
  Text, TouchableOpacity, View, ScrollView,
  Platform, Modal, Alert, ActivityIndicator, ToastAndroid,
  TextInput,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  ArrowUpDown, Minus, Plus,
  Bus, AlertCircle, Download, FileText, MapPin,
} from 'lucide-react-native';
import {getRandomFortune} from '../utils/fortune';
import {places} from '../utils/places';
import {fareMatrix} from '../utils/fareMatrix';
import {supabase} from '../../lib/supabase';
import api from '../api/api';

import { usePOSTickets } from '../hooks/usePOSTickets';

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
  const [activeDrop, setActiveDrop] = useState('start');
  const [dirErr, setDirErr] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [luggageInput, setLuggageInput] = useState('0');
  const [fullCount, setFullCount] = useState(1);
  const [halfCount, setHalfCount] = useState(0);

  useEffect(() => {
    setSelStart(null); setSelDest(null); setDirErr(null);
    setActiveDrop('start'); setFullCount(1); setHalfCount(0); setLuggageInput('0');
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

      if (numLine) {
        await NyxPrinter.printText(`Ticket: ${numLine}`, { textSize: 20, align: PrintAlign.CENTER });
      }
      await NyxPrinter.printText(`${dp}   ${tp}`, { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText(`Bus: ${busNumber}          CASH`, { textSize: 22 });
      if (cLug > 0) await NyxPrinter.printText(`Luggage: Rs ${fareStr(cLug)}`, { textSize: 20 });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(`${fnum}-${fn} to ${tnum}-${tn}`, { textSize: 24 });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      if (cFull > 0)
        await NyxPrinter.printText(
          `ADULT(S): ${cFull} * ${fareStr(baseFullFare)} = ${fareStr(cFullTotal)}`,
          { textSize: 22 },
        );
      if (cHalf > 0)
        await NyxPrinter.printText(
          `CHILD(S): ${cHalf} * ${fareStr(baseHalfFare)} = ${fareStr(cHalfTotal)}`,
          { textSize: 22 },
        );
      if (cLug > 0) {
        await NyxPrinter.printText(`LUGGAGE : Rs ${fareStr(cLug)}`, { textSize: 22 });
      }
      await NyxPrinter.printText(`Rs : ${fareStr(cGrandTotal)}`, { textSize: 36, align: PrintAlign.CENTER });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(fortune, { textSize: 18, align: PrintAlign.CENTER });
      await NyxPrinter.printEndAutoOut();

      // Save via posHook correctly
      if (cFull > 0) {
        await posHook.saveTicket({
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
        await posHook.saveTicket({
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
         await posHook.saveTicket({
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

      setFullCount(nextFull);
      setHalfCount(nextHalf);
      if (cLug > 0) setLuggageInput('0');

      if (nextFull === 0 && nextHalf === 0 && nextLug === 0) {
        setShowConfirm(false);
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
                          if (activeDrop === 'start') { setSelStart(p); setActiveDrop('destination'); }
                          else { setSelDest(p); setActiveDrop(null); }
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
              onPress={() => setShowConfirm(true)}
              disabled={!isReady}>
              <Download size={18} color="#fff" />
              <Text className="text-white text-base font-bold tracking-wide">ISSUE & PRINT TICKET</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      {/* ── Confirm Modal ── */}
      <Modal animationType="fade" transparent visible={showConfirm} onRequestClose={() => setShowConfirm(false)}>
        <TouchableOpacity 
          className="flex-1 bg-black/70 justify-center px-4" 
          activeOpacity={1} 
          onPress={() => setShowConfirm(false)}
        >
          <TouchableOpacity 
            activeOpacity={1} 
            className="bg-black border border-white/20 rounded-2xl px-5 pt-5 pb-6"
          >
            <View className="flex-row items-center justify-between mb-5">
              <View className="flex-row items-center gap-3">
                <FileText size={20} color="#0ea5e9" />
                <Text className="text-white text-lg font-bold">Issue Tickets</Text>
              </View>
              <View className="bg-sky-500/20 px-3 py-1 rounded-full">
                <Text className="text-sky-400 font-bold text-xs">{totalTickets} Remaining</Text>
              </View>
            </View>

            {[
              {label: 'Bus', val: busNumber},
              {label: 'From', val: selStart?.label?.split('-')[0]},
              {label: 'To', val: selDest?.label?.split('-')[0]},
            ].map(r => (
              <View key={r.label} className="flex-row justify-between py-2.5 border-b border-white/20">
                <Text className="text-white text-sm">{r.label}</Text>
                <Text className="text-white text-sm font-medium">{r.val}</Text>
              </View>
            ))}

            {fullCount > 0 && (
              <View className="flex-row justify-between py-2.5 border-b border-white/20">
                <Text className="text-white text-sm">Full × {fullCount}</Text>
                <Text className="text-white text-sm font-medium">₹{fareStr(fullTotal)}</Text>
              </View>
            )}
            {halfCount > 0 && (
              <View className="flex-row justify-between py-2.5 border-b border-white/20">
                <Text className="text-white text-sm">Half × {halfCount}</Text>
                <Text className="text-white text-sm font-medium">₹{fareStr(halfTotal)}</Text>
              </View>
            )}
            {luggageAmount > 0 && (
              <View className="flex-row justify-between py-2.5 border-b border-white/20">
                <Text className="text-white text-sm">Luggage</Text>
                <Text className="text-white text-sm font-medium">₹{fareStr(luggageAmount)}</Text>
              </View>
            )}

            <View className="flex-row justify-between pt-4 pb-5">
              <Text className="text-white font-bold text-base">Remaining Total</Text>
              <Text className="text-sky-400 font-black text-xl">₹{fareStr(grandTotal)}</Text>
            </View>

            <View className="flex-row gap-3">
              <TouchableOpacity
                className="flex-1 bg-black border border-white/20 rounded-xl py-3.5 items-center"
                onPress={() => setShowConfirm(false)}>
                <Text className="text-white font-semibold">Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                className={`flex-1 bg-sky-500 rounded-xl py-3.5 flex-row items-center justify-center gap-2 ${issuing ? 'opacity-60' : ''}`}
                onPress={handleIssue}
                disabled={issuing}>
                {issuing
                  ? <ActivityIndicator color="#fff" />
                  : <><Download size={16} color="#fff" /><Text className="text-white font-bold">Issue Next</Text></>
                }
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
};

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const [activeTrip, setActiveTrip] = useState(null);
  const [busNumber, setBusNumber] = useState('N/A');
  const [tripNumber, setTripNumber] = useState(0);
  const posHook = usePOSTickets();

  useEffect(() => {
    const fetchDashboard = async () => {
      try {
        const r = await api.get('/conductor/dashboard');
        const dashboard = r.data;
        if (dashboard?.active_trip) {
          setActiveTrip(dashboard.active_trip);
          setTripNumber(Number(dashboard.active_trip.trip_number ?? 0));
        }
        if (dashboard?.bus?.vehicle_number) setBusNumber(dashboard.bus.vehicle_number);
      } catch (e) {
        console.error('[HomeScreen] Failed to fetch dashboard:', e);
      }
    };
    fetchDashboard();
  }, []);

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