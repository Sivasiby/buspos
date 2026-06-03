import React, {useState, useCallback, useEffect, useRef} from 'react';
import {
  Text, TouchableOpacity, View, ScrollView,
  Platform, Alert, ActivityIndicator, ToastAndroid,
  TextInput, Modal,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  ArrowUpDown, Play,
  Bus, AlertCircle, Download, CloudOff, WifiOff, Bell,
  Ticket, Baby, Briefcase,
} from 'lucide-react-native';
import {getRandomFortune} from '../utils/fortune';
import {places} from '../utils/places';
import {fareMatrix} from '../utils/fareMatrix';
import {supabase} from '../../lib/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

import { useTripContext } from '../context/TripContext';
import { useVerificationRealtime } from '../hooks/useVerificationRealtime';
import { useNavigation } from '@react-navigation/native';

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

const jwtDecodePayload = (token: string): any => {
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

const getConductorIdFromStorage = async (): Promise<string | null> => {
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

const getSessionBaselineIso = async (): Promise<string> => {
  try {
    const saved = await AsyncStorage.getItem('trip_report_reset_after_iso');
    if (saved) return saved;
  } catch {}
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const updateTripStatusSupabase = async (tripId: string, status: string) => {
  const payload = status === 'completed'
    ? { status, expected_end_time: new Date().toISOString() }
    : { status };
  const { error } = await supabase.from('trips').update(payload).eq('id', tripId);
  if (error) throw error;
};

const startTripFromSupabase = async ({ routeId, direction, busId = null }: { routeId: string; direction: string; busId?: string | null }) => {
  const conductorId = await getConductorIdFromStorage();
  if (!conductorId) throw new Error('No conductor session');

  const { data: existing } = await supabase
    .from('trips')
    .select('id')
    .eq('conductor_id', conductorId)
    .in('status', ['scheduled', 'running', 'paused'])
    .limit(1);
  if (existing?.[0]?.id) throw new Error('You already have an active trip');

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

  const { data, error } = await supabase
    .from('trips')
    .insert({
      route_id: routeId,
      direction,
      conductor_id: conductorId,
      bus_id: resolvedBusId,
      trip_number: tripNumber,
      start_time: new Date().toISOString(),
      status: 'running',
    })
    .select('id,bus_id,trip_number,start_time')
    .limit(1);
  if (error) throw error;
  return { trip: data?.[0] ?? null, conductorId, tripNumber };
};

const fetchActiveTripFromSupabase = async () => {
  const conductorId = await getConductorIdFromStorage();
  if (!conductorId) return { conductor: null, active_trip: null, bus: null };

  const { data: activeRows } = await supabase
    .from('trips')
    .select('id, bus_id, route_id, conductor_id, direction, start_time, expected_end_time, status, trip_number')
    .eq('conductor_id', conductorId)
    .in('status', ['scheduled', 'running', 'paused'])
    .order('start_time', { ascending: false })
    .limit(1);

  const activeRow = activeRows?.[0] ?? null;
  const routeNameMap = await getRouteNameMap([activeRow?.route_id]);
  let active_trip: any = null;
  if (activeRow) {
    active_trip = {
      trip_id:      activeRow.id,
      trip_number:  (activeRow as any).trip_number,
      route_id:     (activeRow as any).route_id,
      route_name:   routeNameMap[String((activeRow as any).route_id)] ?? 'Unknown',
      direction:    (activeRow as any).direction,
      status:       (activeRow as any).status,
      start_time:   (activeRow as any).start_time,
      end_time:     (activeRow as any).expected_end_time ?? null,
      bus_id:       (activeRow as any).bus_id ?? null,
      conductor_id: (activeRow as any).conductor_id,
    };
  }

  let bus: any = null;
  const busId = (activeRow as any)?.bus_id ?? null;
  if (busId) {
    const { data: busRow } = await supabase
      .from('buses')
      .select('id, bus_number, bus_name, capacity')
      .eq('id', busId)
      .single();
    if (busRow) {
      bus = {
        id:             (busRow as any).id,
        vehicle_number: (busRow as any).bus_number,
        bus_name:       (busRow as any).bus_name,
        capacity:       (busRow as any).capacity,
      };
    }
  }

  return { conductor: { id: conductorId }, active_trip, bus };
};

const fetchRoutesFromSupabase = async () => {
  const { data, error } = await supabase
    .from('routes')
    .select('id, route_name')
    .order('route_name');
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ id: r.id, name: r.route_name }));
};

const getRouteNameMap = async (routeIds: any[] = []) => {
  const ids = [...new Set((routeIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const { data } = await supabase.from('routes').select('id,route_name').in('id', ids);
  return Object.fromEntries((data ?? []).map((r: any) => [String(r.id), r.route_name]));
};

const assignTripNumber = async (tripId: string, conductorId: string, sinceIso: string | null = null): Promise<number> => {
  try {
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

// ─── TicketTab ────────────────────────────────────────────────────────────────
const TicketTab = ({activeTrip, busNumber, _onTicketIssued, tripNumber, posHook}) => {
  const tripDirection = activeTrip?.direction ?? 'up';
  const effectiveTripNumber = Number(activeTrip?.trip_number ?? tripNumber ?? 0);
  const getPlaces = useCallback(() => places, []);

  const [selStart, setSelStart] = useState<any>(null);
  const [selDest, setSelDest] = useState<any>(null);
  const [activeDrop, setActiveDrop] = useState<string>('start');
  const [dirErr, setDirErr] = useState(null);
  const [issuing, setIssuing] = useState(false);
  const [ticketType, setTicketType] = useState<'full' | 'half' | 'luggage' | null>('full');
  const [showTicketModal, setShowTicketModal] = useState(false);
  const [ticketData, setTicketData] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(true);
  const [appTicketCount, setAppTicketCount] = useState(0);
  const [appTicketFare, setAppTicketFare] = useState(0);

  const tripId = activeTrip?.trip_id;

  useEffect(() => {
    if (!tripId) { setAppTicketCount(0); setAppTicketFare(0); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('tickets')
          .select('ticket_count,total_fare,fare')
          .eq('trip_id', tripId)
          .or('payment_method.neq.pos,payment_method.is.null');
        if (error || cancelled) return;
        const rows = data || [];
        const count = rows.reduce((s, r) => s + Number(r.ticket_count ?? 1), 0);
        const total = rows.reduce((s, r) => {
          const cnt = Number(r.ticket_count ?? 1);
          const unit = Number(r.fare ?? 0);
          return s + (r.total_fare != null ? Number(r.total_fare) : unit * cnt);
        }, 0);
        if (!cancelled) { setAppTicketCount(count); setAppTicketFare(total); }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [tripId]);

  const stopKey = (dir: string) => `ticket_stops_${dir}`;

  const saveStops = useCallback(async (start: any, dest: any, dir: string) => {
    try {
      await AsyncStorage.setItem(stopKey(dir), JSON.stringify({ start, dest }));
    } catch {}
  }, []);

  const isFirstMount = useRef(true);

  // Monitor network connectivity
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsConnected(state.isConnected ?? false);
    });
    
    // Check initial state
    NetInfo.fetch().then(state => {
      setIsConnected(state.isConnected ?? false);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const loadStops = async () => {
      try {
        const raw = await AsyncStorage.getItem(stopKey(tripDirection));
        if (raw) {
          const { start, dest } = JSON.parse(raw);
          setSelStart(start ?? null);
          setSelDest(dest ?? null);
          setActiveDrop(start ? 'destination' : 'start');
        } else {
          setSelStart(null); setSelDest(null); setActiveDrop('start');
        }
      } catch {
        setSelStart(null); setSelDest(null); setActiveDrop('start');
      }
      setDirErr(null);
      if (!isFirstMount.current) {
        setTicketType('full');
      }
      isFirstMount.current = false;
    };
    loadStops();
  }, [tripDirection]);

  const getFare = useCallback((sk, ek) => fareMatrix?.[sk]?.[ek] ?? 0, []);

  const baseFullFare = selStart?.key && selDest?.key ? getFare(selStart.key, selDest.key) : 0;
  const baseHalfFare = halfFare(baseFullFare);
  const LUGGAGE_FIXED_FARE = 10;
  const luggageAmount = ticketType === 'luggage' ? LUGGAGE_FIXED_FARE : 0;
  const fullTotal = ticketType === 'full' ? baseFullFare : 0;
  const halfTotal = ticketType === 'half' ? baseHalfFare : 0;
  const grandTotal = fullTotal + halfTotal + luggageAmount;
  const totalTickets = ticketType ? 1 : 0;
  const isReady = !!(selStart && selDest && ticketType && isConnected);

  useEffect(() => {
    setDirErr(null);
    if (!selStart?.key || !selDest?.key) return;

    const placesList = getPlaces();
    const fromIndex = placesList.findIndex(p => p.key === selStart.key);
    const toIndex = placesList.findIndex(p => p.key === selDest.key);

    // Wrong direction: for down trips dest index must be > start index; for up trips dest index must be < start index
    const wrongDir = isDownDirection(tripDirection) ? toIndex <= fromIndex : toIndex >= fromIndex;

    if (wrongDir) {
      setSelDest(null);
      saveStops(selStart, null, tripDirection);
      setActiveDrop('destination');
    }
  }, [selStart, selDest, tripDirection, getPlaces]);

  const handleIssue = async () => {
    if (!isConnected) {
      Alert.alert('No Internet', 'Please check your internet connection to issue tickets.');
      return;
    }

    // Confirmation for luggage and half fare tickets
    if (ticketType === 'luggage' || ticketType === 'half') {
      const isLuggage = ticketType === 'luggage';
      const confirmTitle = isLuggage ? 'Luggage Ticket' : 'Half Fare Ticket';
      const confirmMessage = isLuggage
        ? 'You are about to print a LUGGAGE ticket.\n\nConfirm to proceed?'
        : 'You are about to print a HALF FARE (Child) ticket.\n\nConfirm to proceed?';

      const shouldProceed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          confirmTitle,
          confirmMessage,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Print', style: 'default', onPress: () => resolve(true) },
          ],
          { cancelable: false }
        );
      });

      if (!shouldProceed) {
        return;
      }
    }

    setIssuing(true);
    try {
      // Check testing mode
      const testingMode = await AsyncStorage.getItem('testing_mode');
      const isTestingMode = testingMode === 'true';

      if (!isTestingMode) {
        if (Platform.OS !== 'android' || !NyxPrinter) {
          Alert.alert('Not supported', 'Printing is only available on Android.');
          setIssuing(false);
          return;
        }
        const statusRet = await NyxPrinter.getPrinterStatus();
        if (statusRet !== PrinterStatus.SDK_OK) {
          Alert.alert('Printer Error', PrinterStatus.msg(statusRet));
          setIssuing(false);
          return;
        }
      }


      // Prepare ticket data
      const now = new Date();
      const dp = now.toLocaleDateString('en-GB').replace(/\//g, '-');
      const tp = now.toLocaleTimeString('en-GB', {hour12: false});
      const fortune = getRandomFortune();
      const fn = selStart?.label?.split('-')[2] ?? selStart?.label ?? '';
      const tn = selDest?.label?.split('-')[2] ?? selDest?.label ?? '';
      const fnum = selStart?.label?.split('-')[1] ?? '';
      const tnum = selDest?.label?.split('-')[1] ?? '';

      let cFull = 0, cHalf = 0, cLug = 0;
      if (ticketType === 'full') cFull = 1;
      else if (ticketType === 'half') cHalf = 1;
      else if (ticketType === 'luggage') cLug = luggageAmount;

      const cFullTotal = cFull * baseFullFare;
      const cHalfTotal = cHalf * baseHalfFare;
      const cGrandTotal = cFullTotal + cHalfTotal + cLug;

      // Get ticket number — prefer selected_bus from AsyncStorage
      const storedBusRaw = await AsyncStorage.getItem('selected_bus');
      const storedBus = storedBusRaw ? JSON.parse(storedBusRaw) : null;
      const busId = storedBus?.id ?? activeTrip?.bus_id ?? null;
      const firstTicketNum = await getNextTicketNumber(busId);
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

      // Prepare ticket data for modal or printing
      const ticketInfo = {
        header: 'SPS - RoutePass',
        ticketNumber: numLine ? `Ticket #: ${numLine.replace(/#/g, '')}` : null,
        separator: '--------------------------------',
        busInfo: `Bus: ${busNumber}`,
        tripInfo: effectiveTripNumber > 0 ? `Trip #: ${effectiveTripNumber}` : null,
        dateTime: `${dp}  ${tp}`,
        route: `${fn}  to  ${tn}`,
        fullFare: cFull > 0 ? `ADULT   Rs ${fareStr(cFullTotal)}` : null,
        halfFare: cHalf > 0 ? `CHILD   Rs ${fareStr(cHalfTotal)}` : null,
        luggageFare: cLug > 0 ? `LUGGAGE   Rs ${fareStr(cLug)}` : null,
        fortune: fortune,
        total: cGrandTotal,
      };

      if (isTestingMode) {
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
            luggage_amount: cLug,
            ticket_number: fullTicketNum,
            trip_number: effectiveTripNumber > 0 ? effectiveTripNumber : null,
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
            luggage_amount: cFull === 0 ? cLug : 0,
            ticket_number: halfTicketNum,
            trip_number: effectiveTripNumber > 0 ? effectiveTripNumber : null,
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
            ticket_count: 1,
            fare: cLug,
            unit_fare: cLug,
            ticket_type: 'luggage',
            luggage_amount: cLug,
            ticket_number: fullTicketNum,
            trip_number: effectiveTripNumber > 0 ? effectiveTripNumber : null,
            bus_number: busNumber,
            direction: tripDirection,
            issued_at: now.toISOString()
          });
        }

        // showToast(`Ticket issued · ₹${cGrandTotal}`);

        // Show modal instead of printing
        setTicketData(ticketInfo);
        setShowTicketModal(true);
        setIssuing(false);
        return;
      }

      // Start printing the header immediately
      await NyxPrinter.printText('SPS - ZYRAP', { textSize: 28, align: PrintAlign.CENTER });
      if (ticketInfo.ticketNumber) {
        await NyxPrinter.printText(ticketInfo.ticketNumber, { textSize: 24, align: PrintAlign.CENTER });
      }
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });

      await NyxPrinter.printText(ticketInfo.busInfo, { textSize: 24, align: PrintAlign.CENTER });
      if (ticketInfo.tripInfo) {
        await NyxPrinter.printText(ticketInfo.tripInfo, { textSize: 24, align: PrintAlign.CENTER });
      }
      await NyxPrinter.printText(ticketInfo.dateTime, { textSize: 24, align: PrintAlign.CENTER });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(ticketInfo.route, { textSize: 24, align: PrintAlign.CENTER });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      if (ticketInfo.fullFare)
        await NyxPrinter.printText(ticketInfo.fullFare, { textSize: 24, align: PrintAlign.CENTER });
      if (ticketInfo.halfFare)
        await NyxPrinter.printText(ticketInfo.halfFare, { textSize: 24, align: PrintAlign.CENTER });
      if (ticketInfo.luggageFare)
        await NyxPrinter.printText(ticketInfo.luggageFare, { textSize: 24, align: PrintAlign.CENTER });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(ticketInfo.fortune, { textSize: 18, align: PrintAlign.CENTER });
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
          trip_number: effectiveTripNumber > 0 ? effectiveTripNumber : null,
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
          trip_number: effectiveTripNumber > 0 ? effectiveTripNumber : null,
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
          ticket_count: 1,
          fare: cLug,
          unit_fare: cLug,
          ticket_type: 'luggage',
          luggage_amount: cLug,
          ticket_number: fullTicketNum,
          trip_number: effectiveTripNumber > 0 ? effectiveTripNumber : null,
          bus_number: busNumber,
          direction: tripDirection,
          issued_at: now.toISOString()
        });
      }

      showToast(`Ticket issued · ₹${cGrandTotal}`);

      // Ticket issued - keep current selection for next passenger
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

        {/* ── Offline Banner ── */}
        {!isConnected && (
          <View className="flex-row items-center gap-2 bg-red-950 border border-red-900 rounded-xl px-3 py-2.5 mb-4">
            <WifiOff size={14} color="#ffffff" />
            <Text className="text-white text-sm flex-1">No internet connection</Text>
          </View>
        )}

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
              <Text className="text-white text-sm flex-1" numberOfLines={1}>
                {routeNameForDirection(activeTrip.route_name, tripDirection)}
              </Text>
              
              <Text className="text-white text-xs">
                {formatDuration(activeTrip.start_time, null)}
              </Text>
              
              <View className={`px-2 py-0.5 rounded-full ${activeTrip.status === 'running' && (busNumber && busNumber !== 'N/A') && effectiveTripNumber > 0 ? 'bg-green-950' : activeTrip.status === 'running' ? 'bg-red-950' : 'bg-black'} flex-row gap-2`}>
                <Text className={`text-xs font-semibold ${activeTrip.status === 'running' && (busNumber && busNumber !== 'N/A') && effectiveTripNumber > 0 ? 'text-green-400' : activeTrip.status === 'running' ? 'text-red-400' : 'text-white'}`}>
                  {activeTrip.status.toUpperCase()}
                </Text>
                {tripNumber > 0 && (
                  <Text className="text-white text-xs">
                    #{tripNumber}
                  </Text>
                )}
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
            {/* ── Stop Selector ── */}
            <View className="flex-row items-stretch bg-black rounded-xl border border-white/20 mb-4 overflow-hidden">
              {/* FROM */}
              <TouchableOpacity
                className={`flex-1 px-3 py-3 ${activeDrop === 'start' ? 'bg-black' : ''}`}
                onPress={() => setActiveDrop('start')}>
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
                onPress={() => setActiveDrop('destination')}>
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
            <View className="bg-black rounded-xl mb-4 overflow-hidden" style={{ borderWidth: 2, borderColor: activeDrop === 'start' ? '#38bdf8' : '#fb923c' }}>
                <View className="flex-row flex-wrap">
                  {getPlaces().map((p, idx) => {
                    const isSel = activeDrop === 'start' ? selStart?.key === p.key : selDest?.key === p.key;
                    const isOtherSel = activeDrop === 'start' ? selDest?.key === p.key : selStart?.key === p.key;
                    // Disable stops that come before the selected "From" stop when selecting "To"
                    const placesList = getPlaces();
                    const fromIndex = selStart ? placesList.findIndex(pl => pl.key === selStart.key) : -1;
                    const currentIndex = placesList.findIndex(pl => pl.key === p.key);
                    const isWrongDirection = activeDrop === 'destination' && selStart &&
                      (isDownDirection(tripDirection) ? currentIndex <= fromIndex : currentIndex >= fromIndex);
                    const isDisabled = p.disabled === true;
                    const isDis = isOtherSel || isWrongDirection || isDisabled;
                    const isNotLastInRow = (idx + 1) % 3 !== 0;
                    const borderColor = activeDrop === 'start' ? '#38bdf8' : '#fb923c';
                    return (
                      <TouchableOpacity
                        key={p.key}
                        disabled={isDisabled}
                        onPress={() => {
                          if (isSel) {
                            // Double-tap: move this stop to the other field, clear current field, focus other field
                            if (activeDrop === 'start') {
                              // Currently selected as FROM → move to TO (if direction valid), clear FROM, focus FROM
                              const pIdx = placesList.findIndex(pl => pl.key === p.key);
                              const destIdx = selDest ? placesList.findIndex(pl => pl.key === selDest?.key) : -1;
                              const wouldBeWrong = isDownDirection(tripDirection) ? pIdx <= destIdx : pIdx >= destIdx;
                              if (destIdx !== -1 && wouldBeWrong) {
                                // Can't be a valid TO given existing dest — clear both, restart
                                setSelStart(null); setSelDest(null);
                                saveStops(null, null, tripDirection);
                                setActiveDrop('start');
                              } else {
                                setSelDest(p);
                                setSelStart(null);
                                saveStops(null, p, tripDirection);
                                setActiveDrop('start');
                              }
                            } else {
                              // Currently selected as TO → move to FROM, clear TO, focus TO
                              setSelStart(p);
                              setSelDest(null);
                              saveStops(p, null, tripDirection);
                              setActiveDrop('destination');
                            }
                          } else if (isOtherSel) {
                            // Conflicting selection: clear the other field and select in current field
                            if (activeDrop === 'start') {
                              setSelDest(null);
                              saveStops(p, null, tripDirection);
                              setSelStart(p);
                              setActiveDrop('destination');
                            } else {
                              setSelStart(null);
                              saveStops(null, p, tripDirection);
                              setSelDest(p);
                              setActiveDrop('start');
                            }
                          } else if (isWrongDirection) {
                            return;
                          } else if (activeDrop === 'start') {
                            setSelStart(p);
                            saveStops(p, selDest, tripDirection);
                            setActiveDrop('destination');
                          } else {
                            setSelDest(p);
                            saveStops(selStart, p, tripDirection);
                          }
                        }}
                        style={{
                          borderBottomWidth: 2,
                          borderBottomColor: borderColor,
                          borderRightWidth: isNotLastInRow ? 2 : 0,
                          borderRightColor: borderColor,
                        }}
                        className={[
                          'w-1/3 px-1 py-3 flex-col items-center justify-center gap-0.5',
                          isSel && activeDrop === 'start' ? 'bg-sky-950' : '',
                          isSel && activeDrop === 'destination' ? 'bg-orange-950' : '',
                          isDis ? 'opacity-40' : '',
                          isDisabled ? 'bg-zinc-900' : '',
                        ].join(' ')}>
                        <Text
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          className={`text-2xl font-black text-center ${isSel && activeDrop === 'start' ? 'text-sky-400' : isSel && activeDrop === 'destination' ? 'text-orange-400' : isOtherSel ? 'text-orange-400' : isWrongDirection ? 'text-zinc-300' : isDisabled ? 'text-zinc-600' : 'text-white'}`}>
                          {stopNum(p)}
                        </Text>
                        <Text className={`text-[11px] font-medium text-center w-full px-1 ${isSel ? 'text-white' : isWrongDirection ? 'text-zinc-400' : isDisabled ? 'text-zinc-600' : 'text-white'}`} numberOfLines={1}>
                          {p.label.split('-')[2]}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

            {/* ── Ticket Type Toggle ── */}
            <View className="flex-row gap-2 mb-6 px-1">
             
              <TouchableOpacity
                onPress={() => setTicketType('half')}
                className={`flex-1 items-center py-3 rounded-2xl border ${ticketType === 'half' ? 'bg-sky-950 border-sky-500' : 'bg-zinc-900 border-white/10'}`}
                activeOpacity={0.8}>
                <Text className={`text-[10px] font-bold tracking-widest uppercase ${ticketType === 'half' ? 'text-sky-400' : 'text-zinc-500'}`}>Half</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setTicketType('full')}
                className={`flex-1 items-center py-3 rounded-2xl border ${ticketType === 'full' ? 'bg-sky-950 border-sky-500' : 'bg-zinc-900 border-white/10'}`}
                activeOpacity={0.8}>
                <Text className={`text-[10px] font-bold tracking-widest uppercase ${ticketType === 'full' ? 'text-sky-400' : 'text-zinc-500'}`}>Full</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setTicketType('luggage')}
                className={`flex-1 items-center py-3 rounded-2xl border ${ticketType === 'luggage' ? 'bg-sky-950 border-sky-500' : 'bg-zinc-900 border-white/10'}`}
                activeOpacity={0.8}>
                <Text className={`text-[10px] font-bold tracking-widest uppercase ${ticketType === 'luggage' ? 'text-sky-400' : 'text-zinc-500'}`}>Luggage</Text>
              </TouchableOpacity>
            </View>

            {/* ── Total + Issue Button (single row) ── */}
            <View className="flex-row items-center gap-3 mb-2">
              <View className="items-start justify-center">
                <Text className="text-sky-400 text-4xl font-black tracking-tight">₹{fareStr(grandTotal)}</Text>
                <Text className="text-zinc-400 text-xs mt-0.5">{totalTickets} ticket{totalTickets !== 1 ? 's' : ''}</Text>
              </View>
              {ticketType === 'half' ? (
                <LinearGradient
                  colors={['#89F336', '#C8F9A8']}
                  start={{x: 0, y: 0}}
                  end={{x: 1, y: 0}}
                  className={`flex-1 rounded-xl py-4 flex-row items-center justify-center gap-2 ${!isReady ? 'opacity-40' : ''}`}
                  style={{borderWidth: 2, borderColor: '#89F336', borderStyle: 'dashed'}}>
                  <TouchableOpacity
                    className="flex-1 flex-row items-center justify-center gap-2"
                    onPress={handleIssue}
                    disabled={!isReady || issuing}>
                    {issuing
                      ? <ActivityIndicator color="black" />
                      : <><Ticket size={18} color="black" /><Text className="text-black text-base font-bold tracking-wide">PRINT TICKET</Text></>}
                  </TouchableOpacity>
                  <View className="pr-4">
                    <Baby size={20} color="#ef4444" />
                  </View>
                </LinearGradient>
              ) : ticketType === 'luggage' ? (
                <TouchableOpacity
                  className={`flex-1 rounded-xl py-4 flex-row items-center justify-center gap-2 ${!isReady ? 'opacity-40' : ''}`}
                  style={{backgroundColor: '#C8F9A8', borderWidth: 2, borderColor: '#89F336', borderStyle: 'dashed'}}
                  onPress={handleIssue}
                  disabled={!isReady || issuing}>
                  {issuing
                    ? <ActivityIndicator color="black" />
                    : <><Ticket size={18} color="black" /><Text className="text-black text-base font-bold tracking-wide">PRINT TICKET</Text></>}
                  <View className="absolute right-4">
                    <Briefcase size={20} color="#ef4444" />
                  </View>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={{backgroundColor:'#89F336'}}
                  className={`flex-1 rounded-xl py-4 flex-row items-center justify-center gap-2 ${!isReady ? 'opacity-40' : ''}`}
                  onPress={handleIssue}
                  disabled={!isReady || issuing}>
                  {issuing
                    ? <ActivityIndicator color="black" />
                    : <><Ticket size={18} color="black" /><Text className="text-black text-base font-bold tracking-wide">PRINT TICKET</Text></>}
                </TouchableOpacity>
              )}
            </View>

            {/* ── Live Ticket Stats ── */}
            {(() => {
              const posTix = posHook.tickets.filter((t: any) => t.trip_id === tripId);
              const posCount = posTix.reduce((s: number, t: any) => s + Number(t.ticket_count ?? 0), 0);
              const posFare  = posTix.reduce((s: number, t: any) => s + Number(t.fare ?? 0), 0);
              const totalCount = appTicketCount + posCount;
              const totalFare  = appTicketFare  + posFare;
              return (
                <View className="flex-row bg-zinc-900 border border-white/10 rounded-2xl mb-4 overflow-hidden">
                  <View className="flex-1 items-center py-1.5">
                    <Text className="text-sky-400 text-base font-black">{appTicketCount}</Text>
                    <Text className="text-zinc-500 text-[9px] font-bold tracking-wider">APP</Text>
                  </View>
                  <View className="w-px bg-white/10" />
                  <View className="flex-1 items-center py-1.5">
                    <Text className="text-violet-400 text-base font-black">{posCount}</Text>
                    <Text className="text-zinc-500 text-[9px] font-bold tracking-wider">POS</Text>
                  </View>
                  <View className="w-px bg-white/10" />
                  <View className="flex-1 items-center py-1.5">
                    <Text className="text-white text-base font-black">{totalCount}</Text>
                    <Text className="text-zinc-500 text-[9px] font-bold tracking-wider">TOTAL</Text>
                  </View>
                  <View className="w-px bg-white/10" />
                  <View className="flex-1 items-center py-1.5">
                    <Text className="text-emerald-400 text-base font-black">₹{Number(totalFare).toFixed(0)}</Text>
                    <Text className="text-zinc-500 text-[9px] font-bold tracking-wider">FARE</Text>
                  </View>
                </View>
              );
            })()}
          </>
        )}
      </ScrollView>

      {/* Ticket Modal for Testing Mode */}
      <Modal
        visible={showTicketModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowTicketModal(false)}>
        <View className="flex-1 bg-black/80 justify-center items-center px-4">
          <View className="bg-zinc-900 rounded-2xl p-6 w-full max-w-sm border border-white/20">
            <View className="flex-row justify-between items-center mb-4">
              <Text className="text-white text-lg font-bold">Ticket Preview</Text>
              <TouchableOpacity onPress={() => setShowTicketModal(false)}>
                <Text className="text-sky-400 font-semibold">Close</Text>
              </TouchableOpacity>
            </View>
            
            {ticketData && (
              <View className="bg-white rounded-xl p-4 mb-4">
                <Text className="text-black text-center font-bold text-lg mb-2">{ticketData.header}</Text>
                {ticketData.ticketNumber && <Text className="text-black text-center font-bold text-base mb-2">{ticketData.ticketNumber}</Text>}
                <Text className="text-black text-center text-xs mb-2">{ticketData.separator}</Text>
                <Text className="text-black text-center text-sm mb-1">{ticketData.busInfo}</Text>
                {ticketData.tripInfo && <Text className="text-black text-center text-sm mb-1">{ticketData.tripInfo}</Text>}
                <Text className="text-black text-center text-sm mb-1">{ticketData.dateTime}</Text>
                <Text className="text-black text-center text-xs mb-2">{ticketData.separator}</Text>
                <Text className="text-black text-center text-sm mb-1">{ticketData.route}</Text>
                <Text className="text-black text-center text-xs mb-2">{ticketData.separator}</Text>
                {ticketData.fullFare && <Text className="text-black text-center text-sm mb-1">{ticketData.fullFare}</Text>}
                {ticketData.halfFare && <Text className="text-black text-center text-sm mb-1">{ticketData.halfFare}</Text>}
                {ticketData.luggageFare && <Text className="text-black text-center text-sm mb-1">{ticketData.luggageFare}</Text>}
                <Text className="text-black text-center text-xs mb-2">{ticketData.separator}</Text>
                <Text className="text-black text-center text-xs italic">{ticketData.fortune}</Text>
              </View>
            )}

            <TouchableOpacity
              className="bg-sky-500 rounded-xl py-3 items-center"
              onPress={() => setShowTicketModal(false)}>
              <Text className="text-white font-bold">OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </>
  );
};

// ─── Select Bus (Home) ──────────────────────────────────────────────────────────
const SelectBusHome = ({ onSelected }: { onSelected: (bus: any) => void }) => {
  const [buses, setBuses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        console.log('[SelectBus] Starting bus load...');
        const { data, error } = await supabase
          .from('buses')
          .select('*')
          .order('bus_number');
        console.log('[SelectBus] Raw data:', JSON.stringify(data, null, 2));
        console.log('[SelectBus] Error:', JSON.stringify(error, null, 2));
        console.log('[SelectBus] Bus count:', data?.length ?? 0);
        if (!error) setBuses(data || []);
        else console.error('[SelectBus] Supabase error fetching buses:', error);
      } catch (e) {
        console.error('[SelectBus] Failed to load buses (exception):', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleSelect = async (bus: any) => {
    setSaving(true);
    try {
      await AsyncStorage.setItem('selected_bus', JSON.stringify(bus));
      onSelected(bus);
    } catch (e) {
      console.error('[SelectBus] Failed to save:', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="flex-1 bg-black px-6">
      <View className="pt-10 pb-6">
        <Bus size={36} color="#3f3f46" />
        <Text className="text-white text-xl font-bold mt-3">Select Your Bus</Text>
        <Text className="text-zinc-500 text-sm mt-1">Choose the bus you are conducting today</Text>
      </View>
      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#00b7f3" />
        </View>
      ) : buses.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3">
          <AlertCircle size={32} color="#71717a" />
          <Text className="text-zinc-500 text-sm text-center">No active buses found.{`\n`}Contact your admin.</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
          {buses.map(bus => (
            <TouchableOpacity
              key={bus.id}
              onPress={() => handleSelect(bus)}
              disabled={saving}
              className="flex-row items-center justify-between bg-zinc-900 border border-white/10 rounded-2xl px-5 py-4 mb-3">
              <View className="flex-row items-center gap-4">
                <View className="w-10 h-10 bg-sky-500/20 rounded-xl items-center justify-center">
                  <Bus size={20} color="#38bdf8" />
                </View>
                <View>
                  <Text className="text-white text-base font-bold">{bus.bus_number}</Text>
                  {bus.bus_name ? <Text className="text-zinc-500 text-xs mt-0.5">{bus.bus_name}</Text> : null}
                </View>
              </View>
              <ArrowUpDown size={16} color="#52525b" />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
};

// ─── Start Trip (Home) ────────────────────────────────────────────────────────
const StartTripHome = ({ onStarted }: { onStarted: (trip: any) => void }) => {
  const [loading, setLoading] = useState(false);
  const [dir, setDir] = useState('up');

  const start = async () => {
    setLoading(true);
    try {
      const allRoutes = await fetchRoutesFromSupabase();
      const route = allRoutes?.[0];
      if (!route) { Alert.alert('Error', 'No routes available.'); return; }
      const created = await startTripFromSupabase({ routeId: route.id, direction: dir });
      showToast('Trip started!');
      onStarted({
        trip_id: created?.trip?.id,
        bus_id: created?.trip?.bus_id,
        trip_number: created?.trip?.trip_number ?? created?.tripNumber ?? 1,
        route_name: route.name,
        direction: dir,
        start_time: created?.trip?.start_time ?? new Date().toISOString(),
        status: 'running',
      });
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to start trip.');
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
        {[{ key: 'up', label: 'CBE → STY' }, { key: 'dn', label: 'STY → CBE' }].map(d => (
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

// ─── Pending Verify Banner ───────────────────────────────────────────────────
const PendingVerifyBanner = ({ tripId, tripStatus }: { tripId: string | null; tripStatus: string | null }) => {
  const { pendingRequests } = useVerificationRealtime(tripId, tripStatus);
  const navigation = useNavigation<any>();

  if (!pendingRequests.length) return null;

  return (
    <TouchableOpacity
      onPress={() => navigation.navigate('Trip')}
      activeOpacity={0.8}
      className="flex-row items-center gap-2 bg-amber-950/60 border-b border-amber-500/30 px-4 py-2.5"
    >
      <Bell size={13} color="#f59e0b" />
      <View className="w-5 h-5 rounded-full bg-amber-500 items-center justify-center">
        <Text className="text-black text-[10px] font-black">{pendingRequests.length}</Text>
      </View>
      <Text className="text-amber-400 text-xs font-semibold flex-1">pending verification</Text>
      <Text className="text-amber-600 text-xs font-bold">Go →</Text>
    </TouchableOpacity>
  );
};

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const { activeTrip, setActiveTrip, busNumber, setBusNumber, tripNumber, setTripNumber, posHook } = useTripContext();
  const [dashLoaded, setDashLoaded] = useState(false);
  const [selectedBus, setSelectedBus] = useState<any>(null);
  const [missingDataAlert, setMissingDataAlert] = useState(false);
  const hasFetchedRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem('selected_bus')
      .then(raw => { if (raw) { const b = JSON.parse(raw); setSelectedBus(b); setBusNumber(b.bus_number ?? 'N/A'); } })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (hasFetchedRef.current) return;

    if (activeTrip?.trip_id) {
      hasFetchedRef.current = true;
      setDashLoaded(true);
      return;
    }

    const fetchDashboard = async () => {
      try {
        const dashboard = await fetchActiveTripFromSupabase();
        const trip = dashboard?.active_trip;

        if (trip?.trip_id && trip?.start_time &&
            trip.status !== 'completed' && trip.status !== 'cancelled') {
          const elapsed = Date.now() - new Date(trip.start_time).getTime();
          if (elapsed >= 8 * 60 * 60 * 1000) {
            try {
              await updateTripStatusSupabase(trip.trip_id, 'completed');
              showToast('Trip auto-ended (exceeded 8 hours)');
            } catch (e) {
              console.error('[HomeScreen] Auto-end failed:', e);
            }
            setActiveTrip(null);
            setDashLoaded(true);
            return;
          }
        }

        if (trip?.trip_id) {
          setActiveTrip(trip);
          setTripNumber(Number(trip.trip_number ?? 0));
          if (dashboard?.bus?.vehicle_number) {
            setBusNumber(dashboard.bus.vehicle_number);
          }
        }
      } catch (e) {
        console.error('[HomeScreen] Failed to fetch dashboard:', e);
      } finally {
        setDashLoaded(true);
      }
    };
    hasFetchedRef.current = true;
    fetchDashboard();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrip]);

  const hardRefresh = useCallback(async () => {
    setMissingDataAlert(false);
    setDashLoaded(false);
    hasFetchedRef.current = false;
    setActiveTrip(null);
    try {
      const dashboard = await fetchActiveTripFromSupabase();
      const trip = dashboard?.active_trip;
      if (trip?.trip_id) {
        setActiveTrip(trip);
        setTripNumber(Number(trip.trip_number ?? 0));
        if (dashboard?.bus?.vehicle_number) setBusNumber(dashboard.bus.vehicle_number);
      }
    } catch (e) {
      console.error('[HomeScreen] Hard refresh failed:', e);
    } finally {
      setDashLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeTrip?.trip_id) return;
    const effectiveTripNumber = Number(activeTrip?.trip_number ?? tripNumber ?? 0);
    const effectiveBusNumber = selectedBus?.bus_number ?? busNumber;
    const isMissingData = effectiveTripNumber <= 0 || !effectiveBusNumber || effectiveBusNumber === 'N/A';
    if (isMissingData) {
      setMissingDataAlert(true);
    } else {
      setMissingDataAlert(false);
    }
  }, [activeTrip, tripNumber, busNumber, selectedBus]);

  if (!dashLoaded) {
    return (
      <SafeAreaView className="flex-1 bg-black items-center justify-center">
        <ActivityIndicator size="large" color="#00b7f3" />
      </SafeAreaView>
    );
  }

  if (!selectedBus) {
    return (
      <SafeAreaView className="flex-1 bg-black">
        <SelectBusHome
          onSelected={(bus) => {
            setSelectedBus(bus);
            setBusNumber(bus.bus_number ?? 'N/A');
          }}
        />
      </SafeAreaView>
    );
  }

  if (!activeTrip) {
    return (
      <SafeAreaView className="flex-1 bg-black">
        <StartTripHome
          onStarted={async (trip) => {
            setActiveTrip(trip);
            const dbTripNumber = Number(trip?.trip_number ?? 0);
            if (dbTripNumber > 0) {
              setTripNumber(dbTripNumber);
              return;
            }
            // trip_number not yet assigned — poll dashboard then call assignTripNumber
            try {
              // Read the session-reset ISO saved by TripScreen when a trip is ended,
              // so we count only trips since the last reset (same logic as TripScreen).
              let sinceIso: string | null = null;
              try {
                sinceIso = await AsyncStorage.getItem('trip_report_reset_after_iso');
              } catch {}

              let dash: any = null;
              for (let i = 0; i < 6; i++) {
                dash = await fetchActiveTripFromSupabase();
                if (dash?.active_trip?.trip_id) break;
                await new Promise<void>(done => setTimeout(done, 700));
              }
              const tripId = dash?.active_trip?.trip_id ?? trip?.trip_id ?? trip?.id;
              const conductorId = dash?.active_trip?.conductor_id ?? dash?.conductor?.id;
              const freshTripNumber = Number(dash?.active_trip?.trip_number ?? 0);
              if (freshTripNumber > 0) {
                setTripNumber(freshTripNumber);
                if (dash?.active_trip) setActiveTrip(dash.active_trip);
              } else if (tripId && conductorId) {
                const num = await assignTripNumber(tripId, conductorId, sinceIso);
                setTripNumber(num);
                if (dash?.active_trip) setActiveTrip({ ...dash.active_trip, trip_number: num });
              }
              if (dash?.bus?.vehicle_number) setBusNumber(dash.bus.vehicle_number);
            } catch (e) {
              console.error('[HomeScreen] assignTripNumber after start failed:', e);
            }
          }}
        />
      </SafeAreaView>
    );
  }

  if (missingDataAlert) {
    return (
      <SafeAreaView className="flex-1 bg-black items-center justify-center px-6">
        <AlertCircle size={48} color="#f59e0b" />
        <Text className="text-white text-lg font-bold mt-4 text-center">Trip data is incomplete</Text>
        <Text className="text-zinc-400 text-sm text-center mt-2">
          {`Trip number or bus number is missing.\nThis may happen right after starting a trip.`}
        </Text>
        <TouchableOpacity
          className="mt-8 bg-sky-500 rounded-2xl px-8 py-4 flex-row items-center gap-3"
          onPress={hardRefresh}>
          <Play size={18} color="#fff" />
          <Text className="text-white text-base font-bold">Try Again</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-black">
      <PendingVerifyBanner tripId={activeTrip?.trip_id ?? null} tripStatus={activeTrip?.status ?? null} />
      <TicketTab
        activeTrip={activeTrip}
        busNumber={selectedBus?.bus_number ?? busNumber}
        _onTicketIssued={() => {}}
        tripNumber={tripNumber}
        posHook={posHook}
      />
    </SafeAreaView>
  );
}