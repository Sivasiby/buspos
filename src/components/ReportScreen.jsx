import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import api from '../api/api';
import { supabase } from '../../lib/supabase';
import { usePOSTickets } from '../hooks/usePOSTickets';
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

  // Filter panel state
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterStart, setFilterStart] = useState(null);
  const [filterEnd, setFilterEnd] = useState(null);
  const [showFilterStartDrop, setShowFilterStartDrop] = useState(false);
  const [showFilterEndDrop, setShowFilterEndDrop] = useState(false);

  const STORAGE_KEY_TRIP = 'report_selected_trip_id';

  const at = dashboard?.active_trip;
  const recentTrips = dashboard?.recent_trips ?? [];

  // Build trip list: active first, then recent
  const trips = [
    ...(at?.trip_id ? [{ ...at, isActive: true }] : []),
    ...recentTrips
      .filter(t => t.trip_id !== at?.trip_id)
      .map(t => ({ ...t, isActive: false })),
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
        const r = await api.get(`/conductor/trip/${selectedTripId}/report`);
        setReport(r.data);
      } catch {
        Alert.alert('Error', 'Could not load trip report');
      }

      try {
        const { data: rows, error } = await supabase
          .from('tickets')
          .select(
            'ticket_type,payment_method,ticket_count,total_fare,fare,from_stop_id,to_stop_id',
          )
          .eq('trip_id', selectedTripId)
          .neq('payment_method', 'pos');
        if (error) throw error;

        const stopIds = [
          ...new Set(
            (rows ?? []).flatMap(r =>
              [r.from_stop_id, r.to_stop_id].filter(Boolean),
            ),
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

        const map = {};
        let full = 0,
          half = 0,
          free = 0,
          tickets = 0,
          collection = 0;
        for (const r of rows ?? []) {
          const cnt = Number(r.ticket_count ?? 1);
          const pm = String(r.payment_method ?? '').toLowerCase();
          const tt = r.ticket_type ?? 'full';
          const unit = Number(r.fare ?? 0);
          const total =
            r.total_fare != null ? Number(r.total_fare) : unit * cnt;
          const fromName = stopMap[String(r.from_stop_id)] ?? 'Unknown';
          const toName = stopMap[String(r.to_stop_id)] ?? 'Unknown';
          const ss = stageCodeFromName(fromName);
          const es = stageCodeFromName(toName);
          const k = `${ss}|||${es}`;
          if (!map[k])
            map[k] = {
              from: fromName,
              to: toName,
              full_count: 0,
              half_count: 0,
              free_count: 0,
              total_fare: 0,
            };
          const isFree = pm === 'fr';
          if (isFree) {
            map[k].free_count += cnt;
            free += cnt;
          } else if (tt === 'half') {
            map[k].half_count += cnt;
            half += cnt;
          } else {
            map[k].full_count += cnt;
            full += cnt;
          }
          map[k].total_fare += total;
          tickets += cnt;
          collection += total;
        }
        setAppTrip({
          tickets,
          collection,
          full,
          half,
          free,
          breakdown: Object.values(map),
        });
      } catch {
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
    if (!filterOpen || !filterStart || !filterEnd) return null;
    const startNum = parseInt(filterStart.label.split('-')[1]?.trim(), 10);
    const endNum = parseInt(filterEnd.label.split('-')[1]?.trim(), 10);
    if (isNaN(startNum) || isNaN(endNum)) return null;
    const lo = Math.min(startNum, endNum);
    const hi = Math.max(startNum, endNum);
    const filteredApp = appBreakdown.filter(rb => {
      const from = parseInt(stageCodeFromName(rb.from), 10);
      const to = parseInt(stageCodeFromName(rb.to), 10);
      if (isNaN(from) || isNaN(to)) return false;
      return from >= lo && from <= hi && to >= lo && to <= hi;
    });
    const filteredPos = posTix.filter(t => {
      const from = parseInt(stageCode(t.from_stop), 10);
      const to = parseInt(stageCode(t.to_stop), 10);
      if (isNaN(from) || isNaN(to)) return false;
      return from >= lo && from <= hi && to >= lo && to <= hi;
    });
    return buildStageRows(filteredApp, filteredPos);
  })();

  const getFilterDisplayName = place => {
    if (!place) return '';
    const parts = place.label.split('-');
    return parts.slice(2).join(' ') || parts.slice(1).join(' ') || place.label;
  };

  const handlePrintTripSheet = async () => {
    if (Platform.OS !== 'android' || !NyxPrinter) {
      Alert.alert('Not supported', 'Printing is only available on Android.');
      return;
    }
    if (!report || !stageRows || stageRows.length === 0) {
      Alert.alert('No data', 'No trip data to print.');
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

      const validTicketNums = posTix.map(t => Number(t.ticket_number)).filter(n => !isNaN(n) && n > 0);
      const minTicketNum = validTicketNums.length > 0 ? Math.min(...validTicketNums) : null;
      const maxTicketNum = validTicketNums.length > 0 ? Math.max(...validTicketNums) : null;
      const ticketRangeStr = minTicketNum && maxTicketNum && minTicketNum !== maxTicketNum 
        ? `${minTicketNum} - ${maxTicketNum}` 
        : (minTicketNum || maxTicketNum || null);

      // ── Header ──────────────────────────────────────────────────────────────
      await NyxPrinter.printText('SPS TRANSPORT', { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText('TRIP SHEET', { textSize: 26, align: PrintAlign.CENTER, bold: true });
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

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
      for (const r of stageRows) {
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
        `FULL : ${grandFull}`,
        { textSize: 26, align: PrintAlign.CENTER },
      );
      await NyxPrinter.printText(DASH32, { align: PrintAlign.CENTER });

      // ── TRIP.COLL + TOT.COLL ────────────────────────────────────────────────
      // textSize 32 fits ~20 chars. label=12 + amount right-aligned in 8 = 20
      await NyxPrinter.printText(
        `${padL('TRIP.COLL:', 12)}${padR(fmtAmt(grandCollection), 8)}`,
        { textSize: 32 },
      );
      await NyxPrinter.printText(
        `${padL('TOT.COLL:', 12)}${padR(fmtAmt(combinedTotal), 8)}`,
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
                  <View className="flex-row items-center gap-1 mb-1">
                    <View className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <Text
                      className={`text-[9px] font-black tracking-widest ${
                        isSelected ? 'text-sky-100' : 'text-emerald-400'
                      }`}
                    >
                      ACTIVE
                    </Text>
                  </View>
                )}
                <Text
                  className={`text-sm font-black ${
                    isSelected ? 'text-white' : 'text-zinc-200'
                  }`}
                >
                  {trip.trip_number ? `Trip #${trip.trip_number}` : 'No #'}
                </Text>
                <Text
                  className={`text-[10px] mt-0.5 ${
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
            <StageTable rows={stageRows} />

            {/* Grand total */}
            <View className="flex-row justify-between items-center bg-sky-500/10 border border-sky-500/20 rounded-xl px-4 py-3 mt-3">
              <Text className="text-zinc-300 text-sm font-bold">TRP TOTAL</Text>
              <Text className="text-sky-400 text-xl font-black">
                ₹{grandCollection.toFixed(2)}
              </Text>
            </View>
          </View>

         {/* Filter toggle */}
          <View className="px-4 pb-2">
            <TouchableOpacity
              className={`flex-row items-center justify-between px-4 py-3 rounded-xl border ${
                filterOpen ? 'bg-violet-500/10 border-violet-500/30' : 'bg-zinc-800/60 border-zinc-700'
              }`}
              onPress={() => { setFilterOpen(v => !v); setShowFilterStartDrop(false); setShowFilterEndDrop(false); }}
              activeOpacity={0.8}
            >
              <View className="flex-row items-center gap-2">
                <BarChart3 size={14} color={filterOpen ? '#a78bfa' : '#71717a'} />
                <Text className={`text-sm font-bold ${filterOpen ? 'text-violet-400' : 'text-zinc-400'}`}>
                  Filter by Stage Range
                </Text>
              </View>
              <Text className={`text-xs font-bold ${filterOpen ? 'text-violet-400' : 'text-zinc-600'}`}>
                {filterOpen ? 'HIDE ▲' : 'SHOW ▼'}
              </Text>
            </TouchableOpacity>

            {filterOpen && (
              <View className="mt-3">
                {/* Stage range selector */}
                <View className="bg-zinc-800/60 rounded-xl border border-zinc-700 overflow-hidden mb-3">
                  {/* Start */}
                  <TouchableOpacity
                    className="flex-row items-center gap-3 px-4 py-3 border-b border-zinc-700"
                    onPress={() => { setShowFilterStartDrop(v => !v); setShowFilterEndDrop(false); }}
                    activeOpacity={0.8}
                  >
                    <View className="w-6 h-6 rounded-full bg-zinc-700 items-center justify-center">
                      <Navigation size={11} color="#71717a" />
                    </View>
                    <View className="flex-1">
                      <Text className="text-zinc-500 text-[9px] font-black tracking-widest">FROM STAGE</Text>
                      <Text className={`text-sm font-bold ${filterStart ? 'text-white' : 'text-zinc-500'}`}>
                        {filterStart ? getFilterDisplayName(filterStart) : 'Select start stage'}
                      </Text>
                    </View>
                    {filterStart && (
                      <TouchableOpacity onPress={() => setFilterStart(null)} className="px-2 py-1 rounded-lg bg-zinc-700">
                        <Text className="text-zinc-500 text-[10px] font-bold">✕</Text>
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                  {/* End */}
                  <TouchableOpacity
                    className="flex-row items-center gap-3 px-4 py-3"
                    onPress={() => { setShowFilterEndDrop(v => !v); setShowFilterStartDrop(false); }}
                    activeOpacity={0.8}
                  >
                    <View className="w-6 h-6 rounded-full bg-violet-500/20 items-center justify-center">
                      <Navigation size={11} color="#a78bfa" />
                    </View>
                    <View className="flex-1">
                      <Text className="text-zinc-500 text-[9px] font-black tracking-widest">TO STAGE</Text>
                      <Text className={`text-sm font-bold ${filterEnd ? 'text-white' : 'text-zinc-500'}`}>
                        {filterEnd ? getFilterDisplayName(filterEnd) : 'Select end stage'}
                      </Text>
                    </View>
                    {filterEnd && (
                      <TouchableOpacity onPress={() => setFilterEnd(null)} className="px-2 py-1 rounded-lg bg-zinc-700">
                        <Text className="text-zinc-500 text-[10px] font-bold">✕</Text>
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                </View>

                {/* Start dropdown */}
                {showFilterStartDrop && (
                  <View className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden mb-3">
                    {places.map(p => {
                      const isSel = filterStart?.key === p.key;
                      const isDis = filterEnd?.key === p.key;
                      return (
                        <TouchableOpacity
                          key={`fs-${p.key}`}
                          className={`px-4 py-3 border-b border-zinc-800 ${isSel ? 'bg-sky-500/20' : 'bg-zinc-900'} ${isDis ? 'opacity-40' : ''}`}
                          onPress={() => { setFilterStart(p); setShowFilterStartDrop(false); setShowFilterEndDrop(true); }}
                          disabled={isDis}
                          activeOpacity={0.8}
                        >
                          <Text className={`text-sm font-bold ${isSel ? 'text-sky-400' : 'text-zinc-200'}`}>
                            {p.label.split('-')[1]} {p.label.split('-')[2]}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                {/* End dropdown */}
                {showFilterEndDrop && (
                  <View className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden mb-3">
                    {places.map(p => {
                      const isSel = filterEnd?.key === p.key;
                      const isDis = filterStart?.key === p.key;
                      return (
                        <TouchableOpacity
                          key={`fe-${p.key}`}
                          className={`px-4 py-3 border-b border-zinc-800 ${isSel ? 'bg-sky-500/20' : 'bg-zinc-900'} ${isDis ? 'opacity-40' : ''}`}
                          onPress={() => { setFilterEnd(p); setShowFilterEndDrop(false); }}
                          disabled={isDis}
                          activeOpacity={0.8}
                        >
                          <Text className={`text-sm font-bold ${isSel ? 'text-sky-400' : 'text-zinc-200'}`}>
                            {p.label.split('-')[1]} {p.label.split('-')[2]}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                {/* Filtered result */}
                {filteredStageRows && (
                  filteredStageRows.length > 0 ? (
                    <View>
                      <View className="flex-row items-center gap-2 mb-1">
                        <Text className="text-violet-400 text-[10px] font-black tracking-widest">
                          FILTERED: {getFilterDisplayName(filterStart)} → {getFilterDisplayName(filterEnd)}
                        </Text>
                      </View>
                      <StageTable rows={filteredStageRows} />
                      <View className="flex-row justify-between items-center bg-violet-500/10 border border-violet-500/20 rounded-xl px-4 py-3 mt-3">
                        <Text className="text-zinc-300 text-sm font-bold">RANGE TOTAL</Text>
                        <Text className="text-violet-400 text-xl font-black">
                          ₹{filteredStageRows.reduce((s, r) => s + r.amt, 0).toFixed(2)}
                        </Text>
                      </View>
                    </View>
                  ) : (
                    <View className="items-center py-6 gap-1">
                      <Text className="text-zinc-500 text-sm font-semibold">No tickets in this range</Text>
                    </View>
                  )
                )}
              </View>
            )}
          </View>

          {/* Print button */}
          <TouchableOpacity
            className="mx-4 mb-4 flex-row items-center justify-center gap-2 bg-sky-500 rounded-xl py-3.5"
            activeOpacity={0.8}
            onPress={handlePrintTripSheet}
          >
            <Download size={16} color="#fff" />
            <Text className="text-white text-sm font-bold">
              Print Trip Sheet
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
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
      console.log(
        '[DEBUG] recentTrips:',
        recentTrips.map(t => ({ id: t.trip_id, start: t.start_time })),
      );
      console.log('[DEBUG] todayStr:', todayStr);
      const todayTripIds = [
        ...(at?.trip_id ? [at.trip_id] : []),
        ...recentTrips
          .filter(t => {
            if (!t.start_time) return false;
            // Convert UTC to local time before comparing date string
            const localDate = new Date(t.start_time).toLocaleDateString(
              'en-IN',
              {
                timeZone: 'Asia/Kolkata',
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              },
            );
            const todayLocal = new Date().toLocaleDateString('en-IN', {
              timeZone: 'Asia/Kolkata',
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            });
            return localDate === todayLocal;
          })
          .map(t => t.trip_id),
      ];
      const uniqueTripIds = [...new Set(todayTripIds)];
      console.log('[DEBUG] uniqueTripIds:', uniqueTripIds);
      // Fetch all app tickets for today's trips from supabase directly
      let allAppRows = [];
      if (uniqueTripIds.length > 0) {
        const { data: rows, error } = await supabase
          .from('tickets')
          .select(
            'ticket_type,payment_method,ticket_count,total_fare,fare,from_stop_id,to_stop_id',
          )
          .in('trip_id', uniqueTripIds)
          .neq('payment_method', 'pos');

        console.log('[DEBUG] supabase tickets query error:', error);
        console.log('[DEBUG] supabase tickets raw rows count:', rows?.length);
        console.log(
          '[DEBUG] supabase tickets sample payment_methods:',
          rows?.slice(0, 5).map(r => r.payment_method),
        );
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

      // Get POS tickets for today's trips
      const allPosTix = (posHook?.tickets ?? []).filter(t =>
        uniqueTripIds.includes(t.trip_id),
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

      setFilteredData({
        stageRows,
        grandFull,
        grandHalf,
        grandCollection,
        totalTickets,
      });
    } catch (e) {
      console.error('Error filtering tickets:', e);
      setFilteredData(null);
    } finally {
      setFiltering(false);
    }
}, [selStart, selDest, dashboard, posHook, autoStart]);

  const getPlaces = () => places;

  const getDisplayName = place => {
    if (!place) return '';
    const parts = place.label.split('-');
    return parts.slice(2).join(' ') || parts.slice(1).join(' ') || place.label;
  };

  const handlePrintStatusReport = async () => {
    if (Platform.OS !== 'android' || !NyxPrinter) {
      Alert.alert('Not supported', 'Printing is only available on Android.');
      return;
    }
    if (!filteredData || filteredData.stageRows.length === 0) {
      Alert.alert('No data', 'No report data to print.');
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

      {/* Route bar — start (auto/override) → end (user picks) */}
      <View className="bg-zinc-900 rounded-2xl border border-zinc-800 mb-4 overflow-hidden">

        {/* Start place — tap to override */}
        <TouchableOpacity
          className="flex-row items-center gap-3 px-4 py-3 border-b border-zinc-800/60"
          onPress={() => { setShowStartDrop(!showStartDrop); setShowDestDrop(false); }}
          activeOpacity={0.8}
        >
          <View className="w-7 h-7 rounded-full bg-zinc-800 items-center justify-center">
            <Navigation size={13} color="#71717a" />
          </View>
          <View className="flex-1">
            <Text className="text-zinc-500 text-[9px] font-black tracking-widest">
              FROM {overrideStart ? '(CUSTOM)' : '(AUTO)'}
            </Text>
            <Text className="text-zinc-400 text-sm font-bold" numberOfLines={1}>
              {getDisplayName(selStart)}
            </Text>
          </View>
          {overrideStart && (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation(); setOverrideStart(null); AsyncStorage.removeItem(STORAGE_KEY_OVERRIDE_START); }}
              className="px-2 py-1 rounded-lg bg-zinc-800"
            >
              <Text className="text-zinc-500 text-[10px] font-bold">RESET</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>

        {/* End place — primary control */}
        <TouchableOpacity
          className="flex-row items-center gap-3 px-4 py-3"
          onPress={() => { setShowDestDrop(!showDestDrop); setShowStartDrop(false); }}
          activeOpacity={0.8}
        >
          <View className="w-7 h-7 rounded-full bg-sky-500/20 items-center justify-center">
            <Navigation size={13} color="#0ea5e9" />
          </View>
          <View className="flex-1">
            <Text className="text-zinc-500 text-[9px] font-black tracking-widest">TO (TAP TO CHANGE)</Text>
            <Text className={`text-sm font-bold ${selDest ? 'text-white' : 'text-zinc-500'}`} numberOfLines={1}>
              {selDest ? getDisplayName(selDest) : 'Select end place'}
            </Text>
          </View>
          <View className="w-6 h-6 rounded-full bg-sky-500/20 items-center justify-center">
            <ArrowRight size={12} color="#0ea5e9" />
          </View>
        </TouchableOpacity>
      </View>

      {/* Start override dropdown */}
      {showStartDrop && (
        <View className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden mb-4">
          {places.map((p) => {
            const isSelected = selStart?.key === p.key;
            const isDisabled = selDest?.key === p.key;
            return (
              <TouchableOpacity
                key={`s-${p.key}`}
                className={`px-4 py-3 border-b border-zinc-800 ${isSelected ? 'bg-sky-500/20' : 'bg-zinc-900'} ${isDisabled ? 'opacity-50' : ''}`}
                onPress={() => { setOverrideStart(p); setShowStartDrop(false); }}
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

      {/* End place dropdown */}
      {showDestDrop && (
        <View className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden mb-4">
          {places.map((p) => {
            const isSelected = selDest?.key === p.key;
            const isDisabled = selStart?.key === p.key;
            return (
              <TouchableOpacity
                key={`d-${p.key}`}
                className={`px-4 py-3 border-b border-zinc-800 ${isSelected ? 'bg-sky-500/20' : 'bg-zinc-900'} ${isDisabled ? 'opacity-50' : ''}`}
                onPress={() => { setSelDest(p); setShowDestDrop(false); }}
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
  const posByTrip = posHook.todayByTrip();

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
  const posHook = usePOSTickets();
  const indicatorAnim = useRef(new Animated.Value(0)).current;

  const TABS = [
    { key: 'tripsheet', label: 'Trip Sheet', Icon: Receipt },
    { key: 'status', label: 'Status Report', Icon: BarChart3 },
    { key: 'collection', label: 'Coll. Report', Icon: DollarSign },
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
      await posHook.reload?.();
    } catch (e) {
      console.error('[ReportScreen] Refresh failed:', e);
    } finally {
      setRefreshing(false);
    }
  }, [fetchDashboard, posHook]);

  useEffect(() => {
    fetchDashboard();
  }, []);

  // Reload POS tickets when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      posHook.reload?.();
    }, [posHook]),
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
    ];
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
  }, [dashboard]);

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
          onPress={() => fetchDashboard(true)}
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
      <View className="mx-4 mb-2 bg-zinc-900 rounded-2xl p-1 flex-row border border-zinc-800">
        {TABS.map((tab, i) => {
          const isActive = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.8}
              className={`flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-xl ${
                isActive ? 'bg-sky-500' : ''
              }`}
            >
              <tab.Icon size={14} color={isActive ? '#fff' : '#71717a'} />
              <Text
                className={`text-sm font-bold ${
                  isActive ? 'text-white' : 'text-zinc-500'
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
