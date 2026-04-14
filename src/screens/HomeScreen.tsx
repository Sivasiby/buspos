import React, {useState, useCallback, useEffect} from 'react';
import {
  StyleSheet, Text, TouchableOpacity, View, ScrollView,
  Platform, Modal, Alert, ActivityIndicator, ToastAndroid,
  TextInput, Linking, Share,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ArrowUpDown, Minus, Plus,
  Bus, AlertCircle, Download, FileText, Navigation,
} from 'lucide-react-native';
import {getRandomFortune} from '../utils/fortune';
import {places} from '../utils/places';
import {fareMatrix} from '../utils/fareMatrix';
import {supabase} from '../../lib/supabase';
import api from '../api/api';

// ─────────────────────────────────────────────────────────────────────────────
// PDF Generation — uses react-native-html-to-pdf
// ─────────────────────────────────────────────────────────────────────────────
let RNHTMLtoPDF: any = null;
try { RNHTMLtoPDF = require('react-native-html-to-pdf').default; } catch {}

// ─────────────────────────────────────────────────────────────────────────────
// AsyncStorage Keys
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_KEYS = {
  TICKETS: 'pos_tickets_v2',
  TRIP_REPORTS: 'pos_trip_reports_v2',
  STATUS_REPORTS:'pos_status_reports_v2',
  COLLECTION_REPORTS:'pos_collection_reports_v2',
};

// ─────────────────────────────────────────────────────────────────────────────
// PDF Storage helpers
// ─────────────────────────────────────────────────────────────────────────────
const saveToStorage = async (key: string, newEntry: any) => {
  try {
    const raw = await AsyncStorage.getItem(key);
    const arr: any[] = raw ? JSON.parse(raw) : [];
    arr.unshift(newEntry);
    await AsyncStorage.setItem(key, JSON.stringify(arr.slice(0, 100)));
  } catch (e) {
    console.warn('saveToStorage error', e);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HTML → PDF generator
// ─────────────────────────────────────────────────────────────────────────────
const generatePDF = async (html: string, fileName: string): Promise<string | null> => {
  if (!RNHTMLtoPDF) {
    Alert.alert(
      'PDF Library Missing',
      'Install react-native-html-to-pdf:\nnpm install react-native-html-to-pdf\n\nThen rebuild the app.',
    );
    return null;
  }
  try {
    const options = {
      html,
      fileName,
      directory: Platform.OS === 'android' ? 'Downloads' : 'Documents',
      base64: false,
    };
    const file = await RNHTMLtoPDF.convert(options);
    return file.filePath ?? null;
  } catch (e: any) {
    Alert.alert('PDF Error', e.message || 'Could not generate PDF');
    return null;
  }
};

const openPDF = async (filePath: string) => {
  try {
    const url = Platform.OS === 'android' ? `file://${filePath}` : filePath;
    const canOpen = await Linking.canOpenURL(url);
    if (canOpen) {
      await Linking.openURL(url);
    } else {
      await Share.share({ url, title: 'Open PDF', message: filePath });
    }
  } catch {
    Alert.alert('Cannot Open', 'File saved to: ' + filePath);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HTML Templates for receipts
// ─────────────────────────────────────────────────────────────────────────────
const receiptCSS = `
  body { font-family: 'Courier New', monospace; font-size: 13px; margin: 0; padding: 10px; color: #000; }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  .large { font-size: 18px; }
  .xlarge { font-size: 22px; }
  .divider { border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; margin: 3px 0; }
  .row-left { flex: 1; }
  .row-right { text-align: right; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #1a2332; color: #fff; padding: 5px 4px; text-align: center; }
  td { padding: 4px; text-align: center; border-bottom: 1px solid #eee; }
  td:last-child { text-align: right; }
  th:last-child { text-align: right; }
  .total-box { background: #f0f4f8; padding: 8px; border-radius: 6px; margin-top: 8px; }
  .total-row { display: flex; justify-content: space-between; margin: 3px 0; font-weight: bold; }
  .highlight { color: #0077cc; font-size: 20px; font-weight: 900; }
  .badge { display: inline-block; background: #1a2332; color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 10px; }
`;

const buildTicketHTML = (params: {
  busNumber: string; dateStr: string; timeStr: string;
  fromNum: string; fromName: string; toNum: string; toName: string;
  fullCount: number; halfCount: number; baseFullFare: number; baseHalfFare: number;
  fullTotal: number; halfTotal: number; luggageAmount: number; grandTotal: number;
  totalTickets: number; ticketNums: string; fortune: string; direction: string;
}) => `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>${receiptCSS}</style></head><body>
<div class="center xlarge bold">SPS - ZYRAP</div>
<div class="center" style="font-size:11px">BUS TICKET</div>
<div class="divider"></div>
${params.ticketNums ? `<div class="center bold">${params.ticketNums}</div>` : ''}
<div class="center">${params.dateStr} &nbsp; ${params.timeStr}</div>
<div class="row"><span>Bus: ${params.busNumber}</span><span class="badge">CASH</span></div>
<div class="row"><span>Direction:</span><span>${params.direction.toUpperCase()}</span></div>
${params.luggageAmount > 0 ? `<div class="row"><span>Luggage:</span><span>Rs ${params.luggageAmount.toFixed(2)}</span></div>` : ''}
<div class="divider"></div>
<div class="bold large">${params.fromNum} - ${params.fromName}</div>
<div class="bold large">&#8594; ${params.toNum} - ${params.toName}</div>
<div class="divider"></div>
${params.fullCount > 0 ? `<div class="row"><span>ADULT(S): ${params.fullCount} × Rs ${params.baseFullFare.toFixed(2)}</span><span>Rs ${params.fullTotal.toFixed(2)}</span></div>` : ''}
${params.halfCount > 0 ? `<div class="row"><span>CHILD(S): ${params.halfCount} × Rs ${params.baseHalfFare.toFixed(2)}</span><span>Rs ${params.halfTotal.toFixed(2)}</span></div>` : ''}
${params.luggageAmount > 0 ? `<div class="row"><span>LUGGAGE:</span><span>Rs ${params.luggageAmount.toFixed(2)}</span></div>` : ''}
<div class="divider"></div>
<div class="center highlight">Rs ${params.grandTotal.toFixed(2)}</div>
<div class="center" style="font-size:10px">Total Tickets: ${params.totalTickets}</div>
<div class="divider"></div>
<div class="center" style="font-size:11px;color:#555;font-style:italic">${params.fortune}</div>
<div class="center" style="margin-top:10px;font-size:10px">** Safe Journey **</div>
</body></html>`;

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────
const showToast = (msg: string, dur = ToastAndroid.SHORT) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, dur);
  else Alert.alert('', msg);
};

const formatTime = (iso: string) =>
  iso ? new Date(iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '—';

const formatDuration = (start: string, end?: string | null) => {
  if (!start) return '—';
  const mins = Math.round((((end ? new Date(end) : new Date()).getTime()) - new Date(start).getTime()) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins/60)}h ${mins%60}m`;
};

const normalizeDirection = (direction?: string) => (direction ?? '').toString().trim().toLowerCase();
const isDownDirection = (direction?: string) => ['dn', 'down', 'return'].includes(normalizeDirection(direction));
const parseAmount = (value: string) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
};
const routeNameForDirection = (routeName?: string, direction?: string) => {
  if (!routeName) return '';
  if (!isDownDirection(direction)) return routeName;
  const parts = routeName.split(/\s*(?:->|→|-)\s*/).map((p:string) => p.trim()).filter(Boolean);
  if (parts.length < 2) return routeName;
  return [...parts].reverse().join(' - ');
};
const fareStr = (n: number) => n%1===0 ? `${n}.00` : n.toFixed(2);
const genId   = () => `pos_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

const getNextTicketNumber = async (busId: string | null): Promise<number | null> => {
  if (!busId) return null;
  try {
    const { data, error } = await supabase.rpc('increment_ticket_number', { p_bus_id: busId });
    if (error) throw error;
    return typeof data === 'number' ? data : null;
  } catch (e) {
    console.warn('[TicketNum] RPC failed:', e);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Status Badge Component
// ─────────────────────────────────────────────────────────────────────────────
const StatusBadge = ({status}: {status: string}) => {
  const color = status === 'running' ? '#4CAF50' : status === 'paused' ? '#FF9800' : '#9E9E9E';
  const label = status === 'running' ? 'RUNNING' : status === 'paused' ? 'PAUSED' : status.toUpperCase();
  return (
    <View style={{backgroundColor: color, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12}}>
      <Text style={{color: '#fff', fontSize: 10, fontWeight: '700'}}>{label}</Text>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1 — Ticket
// ─────────────────────────────────────────────────────────────────────────────
const halfFare = (full: number): number => Math.ceil(full / 2);

const TicketTab = ({activeTrip, _user, busNumber, _onTicketIssued, tripNumber}: {activeTrip: any; _user: any; busNumber: string; _onTicketIssued: (t: any) => void; tripNumber: number}) => {
  const tripDirection: string = activeTrip?.direction ?? 'up';
  const getPlaces = useCallback(()=> isDownDirection(tripDirection) ? [...(places as any[])].reverse() : places as any[], [tripDirection]);
  const getBanner = ()=> isDownDirection(tripDirection) ? 'STY → CBE | சத்தி → கோவை' : 'CBE → STY | கோவை → சத்தி';

  const [selStart, setSelStart] = useState<any>(null);
  const [selDest, setSelDest] = useState<any>(null);
  const [activeDrop, setActiveDrop] = useState<string | null>('start');
  const [dirErr, setDirErr] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [luggageInput, setLuggageInput] = useState('0');
  const [_ticketType, _setTicketType] = useState<'full' | 'half'>('full');
  const [fullCount, setFullCount] = useState(1);
  const [halfCount, setHalfCount] = useState(0);

  useEffect(() => {
    setSelStart(null); setSelDest(null); setDirErr(null); setActiveDrop('start');
    _setTicketType('full'); setFullCount(1); setHalfCount(0); setLuggageInput('0');
  }, [tripDirection]);

  useEffect(() => {
    console.log('[Places sample]', JSON.stringify(places.slice(0, 3)));
  }, []);

  const getFare = useCallback((sk: string, ek: string): number => (fareMatrix as any)?.[sk]?.[ek] ?? 0, []);

  const baseFullFare = (selStart?.key && selDest?.key) ? getFare(selStart.key, selDest.key) : 0;
  const baseHalfFare = halfFare(baseFullFare);
  const fullTotal = baseFullFare * fullCount;
  const halfTotal = baseHalfFare * halfCount;
  const luggageAmount = parseAmount(luggageInput);
  const hasPassengerTickets = fullCount > 0 || halfCount > 0;
  const grandTotal = fullTotal + halfTotal + luggageAmount;
  const totalTickets = fullCount + halfCount + (luggageAmount > 0 ? 1 : 0);

  useEffect(() => {
    setDirErr(null);
    if (!selStart?.key || !selDest?.key) return;
    const ss = Number(selStart.label.split('-')[1]), ds = Number(selDest.label.split('-')[1]);
    if (tripDirection === 'up' && ss < ds) { setDirErr('Wrong direction — swap stops for UP trip (CBE → STY)'); return; }
    if (isDownDirection(tripDirection) && ss > ds) { setDirErr('Wrong direction — swap stops for DN trip (STY → CBE)'); return; }
  }, [selStart, selDest, tripDirection]);

  const isReady = !!(selStart && selDest && !dirErr && (luggageAmount > 0 || (hasPassengerTickets && baseFullFare > 0)));

  // ── ISSUE TICKET + SAVE PDF ──────────────────────────────────────────────
  const handleIssue = async () => {
    setIssuing(true);
    try {
      const now = new Date();
      const dp = now.toLocaleDateString('en-GB').replace(/\//g, '-');
      const tp = now.toLocaleTimeString('en-GB', { hour12: false });
      const fortune = getRandomFortune();
      const fn = selStart?.label?.split('-')[2] ?? selStart?.label ?? '';
      const tn = selDest?.label?.split('-')[2] ?? selDest?.label ?? '';
      const fnum = selStart?.label?.split('-')[1] ?? '';
      const tnum = selDest?.label?.split('-')[1] ?? '';
      const busId = activeTrip?.bus_id ?? null;

      const firstTicketNum = await getNextTicketNumber(busId);
      let fullTicketNum: number | null = firstTicketNum;
      let halfTicketNum: number | null = null;

      if (halfCount > 0 && fullCount > 0) {
        halfTicketNum = await getNextTicketNumber(busId);
      } else if (halfCount > 0 && fullCount === 0) {
        halfTicketNum = firstTicketNum;
        fullTicketNum = null;
      }

      const ticketNums = [
        fullTicketNum ? `#${fullTicketNum}` : null,
        halfTicketNum ? `#${halfTicketNum}` : null,
      ].filter(Boolean).join(' / ');

      // Build HTML
      const html = buildTicketHTML({
        busNumber, dateStr: dp, timeStr: tp,
        fromNum: fnum, fromName: fn, toNum: tnum, toName: tn,
        fullCount, halfCount, baseFullFare, baseHalfFare,
        fullTotal, halfTotal, luggageAmount, grandTotal, totalTickets,
        ticketNums, fortune, direction: tripDirection,
      });

      // Generate PDF
      const fileName = `ticket_${Date.now()}`;
      const filePath = await generatePDF(html, fileName);

      // Save to AsyncStorage
      const ticketRecord = {
        id: genId(),
        trip_id: activeTrip?.trip_id ?? null,
        bus_number: busNumber,
        from: `${fnum}-${fn}`,
        to: `${tnum}-${tn}`,
        full_count: fullCount,
        half_count: halfCount,
        luggage: luggageAmount,
        total: grandTotal,
        ticket_nums: ticketNums,
        direction: tripDirection,
        issued_at: now.toISOString(),
        pdf_path: filePath,
      };
      await saveToStorage(STORAGE_KEYS.TICKETS, ticketRecord);

      showToast(`Ticket issued · ₹${grandTotal}`);
      if (filePath) {
        Alert.alert('PDF Saved', `Ticket saved!\n${filePath}`, [
          {text: 'Open', onPress: () => openPDF(filePath)},
          {text: 'OK'},
        ]);
      }

      setShowConfirm(false);
      setFullCount(1); setHalfCount(0); _setTicketType('full'); setLuggageInput('0'); setActiveDrop(null);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Unknown');
    } finally {
      setIssuing(false);
    }
  };

  return (
    <>
      <ScrollView style={{flex: 1}} contentContainerStyle={[tk.scrollContent, {paddingBottom: isReady ? 190 : 100}]} showsVerticalScrollIndicator={false}>
        {activeTrip ? (
          <View style={tk.activePill}>
            <Bus size={13} color="#2E7D32"/>
            <Text style={tk.activePillText}>
              {routeNameForDirection(activeTrip.route_name, activeTrip?.direction)} · {formatDuration(activeTrip.start_time, null)}
              {tripNumber > 0 ? `  ·  Trip #${tripNumber}` : ''}
            </Text>
            <StatusBadge status={activeTrip.status}/>
          </View>
        ) : (
          <View style={tk.noTripPill}>
            <AlertCircle size={13} color="#F57F17"/>
            <Text style={tk.noTripPillText}>No active trip — tickets saved locally</Text>
          </View>
        )}
        {activeTrip && <View style={tk.routeBanner}><ArrowUpDown size={14} color="#00b7f3"/><Text style={tk.routeBannerText}>{getBanner()}</Text></View>}
        {busNumber !== 'N/A' && <View style={tk.busPill}><Bus size={13} color="#1565C0"/><Text style={tk.busPillText}>🚌 {busNumber}</Text></View>}

        <TouchableOpacity
          style={tk.debugBtn}
          onPress={async () => {
            try {
              const raw = await AsyncStorage.getItem(STORAGE_KEYS.TICKETS);
              const tickets = raw ? JSON.parse(raw) : [];
              console.log('[DEBUG] POS Tickets from AsyncStorage:', tickets);
              console.log('[DEBUG] Total POS tickets:', tickets.length);
              Alert.alert('Debug Info', `Found ${tickets.length} POS tickets in AsyncStorage. Check console for details.`);
            } catch (e) {
              console.error('[DEBUG] Error reading AsyncStorage:', e);
              Alert.alert('Debug Error', 'Failed to read tickets from AsyncStorage');
            }
          }}
        >
          <Text style={tk.debugBtnText}>🔍 Debug POS Tickets</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[tk.debugBtn, {backgroundColor: '#FFEBEE', borderColor: '#EF9A9F'}]}
          onPress={async () => {
            Alert.alert(
              'Clear All Data',
              'Are you sure you want to completely wipe all AsyncStorage data? This cannot be undone.',
              [
                {text: 'Cancel', style: 'cancel'},
                {
                  text: 'Clear All',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await AsyncStorage.clear();
                      console.log('[DEBUG] All AsyncStorage data cleared');
                      Alert.alert('Success', 'All AsyncStorage data has been cleared.');
                    } catch (e) {
                      console.error('[DEBUG] Error clearing AsyncStorage:', e);
                      Alert.alert('Error', 'Failed to clear AsyncStorage data');
                    }
                  }
                }
              ]
            );
          }}
        >
          <Text style={[tk.debugBtnText, {color: '#C62828'}]}>🗑️ Clear All Data</Text>
        </TouchableOpacity>

        <View style={tk.ticketCard}>
          {!activeTrip ? (
            <View style={tk.startTripPrompt}>
              <AlertCircle size={18} color="#F57F17"/>
              <Text style={tk.startTripPromptTitle}>No Active Trip</Text>
              <Text style={tk.startTripPromptText}>Please start a trip from the Trip tab to issue tickets.</Text>
            </View>
          ) : (
            <>
              {dirErr && <View style={tk.dirErr}><AlertCircle size={14} color="#C62828"/><Text style={tk.dirErrText}>{dirErr}</Text></View>}

              <View style={tk.tripSelectorBar}>
                <TouchableOpacity style={tk.tripSide} onPress={() => setActiveDrop((p: any) => p === 'start' ? null : 'start')}>
                  <Navigation size={15} color="#666"/>
                  <View style={tk.tripSideCol}>
                    <Text style={tk.tripSideHint}>Leaving From</Text>
                    <Text style={tk.tripSideText} numberOfLines={1} ellipsizeMode="tail">
                      {selStart ? selStart.label.split('-').slice(2).join(' ') || selStart.label.split('-').slice(1).join(' ') : 'Select start'}
                    </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[tk.swapBtn, (!selStart || !selDest) && {opacity: .4}]}
                  onPress={() => {if (selStart && selDest) {const t = selStart; setSelStart(selDest); setSelDest(t);}}}
                  disabled={!selStart || !selDest}
                >
                  <ArrowUpDown size={15} color="#4B5563"/>
                </TouchableOpacity>
                <TouchableOpacity style={tk.tripSide} onPress={() => setActiveDrop((p: any) => p === 'destination' ? null : 'destination')}>
                  <Navigation size={15} color="#666"/>
                  <View style={tk.tripSideCol}>
                    <Text style={tk.tripSideHint}>Going To</Text>
                    <Text style={tk.tripSideText} numberOfLines={1} ellipsizeMode="tail">
                      {selDest ? selDest.label.split('-').slice(2).join(' ') || selDest.label.split('-').slice(1).join(' ') : 'Select destination'}
                    </Text>
                  </View>
                </TouchableOpacity>
              </View>

              {activeDrop === 'start' && (
                <View style={tk.placesGrid}>
                  {getPlaces().map((p: any) => {
                    const dis = selDest?.key === p.key, sel = selStart?.key === p.key;
                    return (
                      <TouchableOpacity key={`s-${p.key}`} style={[tk.chip, sel && tk.chipSel, dis && tk.chipDis]} disabled={dis} onPress={() => {setSelStart(p); setActiveDrop('destination');}}>
                        <Text style={[tk.chipText, sel && tk.chipTextSel, dis && tk.chipTextDis]}>{p.label.split('-')[1]} {p.label.split('-')[2]}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              {activeDrop === 'destination' && (
                <View style={tk.placesGrid}>
                  {getPlaces().filter((_: any, idx: number) => {if (!selStart) return true; const si = getPlaces().findIndex((p: any) => p.key === selStart.key); return idx > si;}).map((p: any) => {
                    const dis = selStart?.key === p.key, sel = selDest?.key === p.key;
                    return (
                      <TouchableOpacity key={`d-${p.key}`} style={[tk.chip, sel && tk.chipSel, dis && tk.chipDis]} disabled={dis} onPress={() => {setSelDest(p); setActiveDrop(null);}}>
                        <Text style={[tk.chipText, sel && tk.chipTextSel, dis && tk.chipTextDis]}>{p.label.split('-')[1]} {p.label.split('-')[2]}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              <View style={tk.countHeaderRow}>
                <Text style={tk.countHead}>Full</Text>
                <Text style={tk.countHead}>Half</Text>
              </View>
              <View style={tk.countInputRow}>
                <View style={tk.countCell}>
                  <TouchableOpacity style={[tk.stepBtn, fullCount <= 0 && tk.stepBtnDisabled]} onPress={() => setFullCount((v: number) => Math.max(0, v - 1))} disabled={fullCount <= 0}>
                    <Minus size={16} color={fullCount <= 0 ? '#b9c4cf' : '#fff'}/>
                  </TouchableOpacity>
                  <TextInput style={tk.countInput} keyboardType="numeric" value={String(fullCount)} onChangeText={(v: string) => setFullCount(Math.max(0, Number(v.replace(/[^0-9]/g, '')) || 0))}/>
                  <TouchableOpacity style={tk.stepBtn} onPress={() => setFullCount((v: number) => v + 1)}>
                    <Plus size={18} color="#fff"/>
                  </TouchableOpacity>
                </View>
                <View style={tk.countCell}>
                  <TouchableOpacity style={[tk.stepBtn, halfCount <= 0 && tk.stepBtnDisabled]} onPress={() => setHalfCount((v: number) => Math.max(0, v - 1))} disabled={halfCount <= 0}>
                    <Minus size={16} color={halfCount <= 0 ? '#b9c4cf' : '#fff'}/>
                  </TouchableOpacity>
                  <TextInput style={tk.countInput} keyboardType="numeric" value={String(halfCount)} onChangeText={(v: string) => setHalfCount(Math.max(0, Number(v.replace(/[^0-9]/g, '')) || 0))}/>
                  <TouchableOpacity style={tk.stepBtn} onPress={() => setHalfCount((v: number) => v + 1)}>
                    <Plus size={18} color="#fff"/>
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={tk.fieldLabel}>Luggage Charge</Text>
              <TextInput style={tk.fieldInput} keyboardType="numeric" value={luggageInput} onChangeText={setLuggageInput} placeholder="0" placeholderTextColor="#9AA7B5"/>

              <View style={tk.payWrap}>
                <Text style={tk.payLabel}>Pay</Text>
                <Text style={tk.payValue}>₹{fareStr(grandTotal)}</Text>
                <Text style={tk.payMeta}>Total Tickets : {totalTickets}</Text>
              </View>

              <TouchableOpacity style={[tk.ticketPrintBtn, !isReady && {opacity: .5}]} onPress={() => setShowConfirm(true)} disabled={!isReady}>
                <Download size={20} color="#fff" style={{marginRight: 8}}/>
                <Text style={tk.ticketPrintText}>ISSUE & SAVE PDF</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>

      <Modal animationType="slide" transparent visible={showConfirm} onRequestClose={() => setShowConfirm(false)}>
        <View style={sh.modalOverlay}>
          <View style={sh.bottomSheet}>
            <View style={sh.sheetHandle}/>
            <View style={{alignItems: 'center', marginBottom: 16}}>
              <FileText size={32} color="#00b7f3"/>
              <Text style={sh.modalTitle}>Confirm Ticket</Text>
            </View>
            <View style={tk.detailRow}><Text style={tk.detailLabel}>Bus</Text><Text style={tk.detailVal}>{busNumber}</Text></View>
            <View style={tk.detailRow}><Text style={tk.detailLabel}>From</Text><Text style={tk.detailVal}>{selStart?.label?.split('-')[0]}</Text></View>
            <View style={tk.detailRow}><Text style={tk.detailLabel}>To</Text><Text style={tk.detailVal}>{selDest?.label?.split('-')[0]}</Text></View>
            {luggageAmount > 0 && <View style={tk.detailRow}><Text style={tk.detailLabel}>Luggage</Text><Text style={tk.detailVal}>₹{fareStr(luggageAmount)}</Text></View>}
            {fullCount > 0 && <View style={tk.detailRow}><Text style={tk.detailLabel}>Adult</Text><Text style={tk.detailVal}>{fullCount} × ₹{fareStr(baseFullFare)} = ₹{fareStr(fullTotal)}</Text></View>}
            {halfCount > 0 && <View style={tk.detailRow}><Text style={tk.detailLabel}>Child</Text><Text style={[tk.detailVal, {color: '#FF9800'}]}>{halfCount} × ₹{fareStr(baseHalfFare)} = ₹{fareStr(halfTotal)}</Text></View>}
            <View style={tk.fareDivider}/>
            <View style={tk.detailRow}><Text style={tk.fareTotalLabel}>Total ({totalTickets} tickets)</Text><Text style={tk.fareTotalVal}>₹{fareStr(grandTotal)}</Text></View>
            <View style={{flexDirection: 'row', gap: 12, marginTop: 16}}>
              <TouchableOpacity style={sh.cancelBtn} onPress={() => setShowConfirm(false)}><Text style={sh.cancelBtnText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[sh.primaryBtn, {flex: 1}, issuing && {opacity: .6}]} onPress={handleIssue} disabled={issuing}>
                {issuing ? <ActivityIndicator color="#fff"/> : <><Download size={16} color="#fff"/><Text style={sh.primaryBtnText}>Issue & Save PDF</Text></>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Home Screen Component
// ─────────────────────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const [activeTrip, setActiveTrip] = useState<any>(null);
  const [user, _setUser] = useState<any>(null);
  const [busNumber, setBusNumber] = useState('N/A');
  const [tripNumber, setTripNumber] = useState(0);

  const handleTicketIssued = (ticket: any) => {
    console.log('Ticket issued:', ticket);
  };

  useEffect(() => {
    const fetchDashboard = async () => {
      try {
        const r = await api.get('/conductor/dashboard');
        const dashboard = r.data;
        if (dashboard?.active_trip) {
          setActiveTrip(dashboard.active_trip);
          setTripNumber(Number(dashboard.active_trip.trip_number ?? 0));
        }
        if (dashboard?.bus?.vehicle_number) {
          setBusNumber(dashboard.bus.vehicle_number);
        }
      } catch (e) {
        console.error('[HomeScreen] Failed to fetch dashboard:', e);
      }
    };
    fetchDashboard();
  }, []);

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: '#f8f9fa'}}>
      <TicketTab
        activeTrip={activeTrip}
        _user={user}
        busNumber={busNumber}
        _onTicketIssued={handleTicketIssued}
        tripNumber={tripNumber}
      />
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const tk = StyleSheet.create({
  scrollContent: {padding: 16},
  activePill: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#E8F5E9', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 12},
  activePillText: {flex: 1, fontSize: 13, fontWeight: '600', color: '#2E7D32'},
  noTripPill: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFF3E0', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 12},
  noTripPillText: {flex: 1, fontSize: 13, fontWeight: '600', color: '#F57F17'},
  routeBanner: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#E3F2FD', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 12},
  routeBannerText: {flex: 1, fontSize: 13, fontWeight: '600', color: '#1565C0'},
  busPill: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F3E5F5', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 12},
  busPillText: {flex: 1, fontSize: 13, fontWeight: '600', color: '#7B1FA2'},
  ticketCard: {marginHorizontal: 16, marginBottom: 16, backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e7e7e7'},
  startTripPrompt: {alignItems: 'center', justifyContent: 'center', paddingVertical: 18, paddingHorizontal: 8},
  startTripPromptTitle: {fontSize: 18, fontWeight: '700', color: '#1a2332', marginTop: 8},
  startTripPromptText: {fontSize: 13, color: '#6B7280', textAlign: 'center', marginTop: 6, lineHeight: 18},
  tripSelectorBar: {flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F1F3', borderRadius: 18, paddingVertical: 10, paddingHorizontal: 10, marginBottom: 12},
  tripSide: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0},
  tripSideCol: {flex: 1, minWidth: 0},
  tripSideHint: {fontSize: 11, color: '#6B7280', fontWeight: '600'},
  tripSideText: {fontSize: 15, fontWeight: '700', color: '#374151'},
  swapBtn: {width: 36, height: 36, borderRadius: 18, backgroundColor: '#fff', borderWidth: 1, borderColor: '#d8d8dc', justifyContent: 'center', alignItems: 'center', marginHorizontal: 10},
  fieldLabel: {fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 6, marginTop: 6},
  fieldInput: {backgroundColor: '#f8f8f8', borderRadius: 6, borderWidth: 1, borderColor: '#ddd', paddingHorizontal: 10, paddingVertical: 10, marginBottom: 8, color: '#1a1a1a'},
  countHeaderRow: {flexDirection: 'row', gap: 10, marginTop: 6},
  countHead: {flex: 1, fontSize: 20, fontWeight: '700', color: '#333'},
  countInputRow: {flexDirection: 'row', gap: 10, marginTop: 6},
  countCell: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6},
  countInput: {flex: 1, backgroundColor: '#f8f8f8', borderRadius: 6, borderWidth: 1, borderColor: '#ddd', paddingHorizontal: 10, paddingVertical: 8, fontSize: 18, color: '#1a1a1a', textAlign: 'center'},
  stepBtn: {width: 32, height: 32, borderRadius: 16, backgroundColor: '#00b7f3', justifyContent: 'center', alignItems: 'center'},
  stepBtnDisabled: {backgroundColor: '#e7edf3'},
  payWrap: {alignItems: 'center', marginTop: 14, marginBottom: 8},
  payLabel: {fontSize: 34, color: '#8a8a8a', fontWeight: '700'},
  payValue: {fontSize: 52, color: '#1f2a7a', fontWeight: '800', marginTop: -8},
  payMeta: {fontSize: 16, color: '#777', fontWeight: '700'},
  ticketPrintBtn: {marginTop: 10, backgroundColor: '#f39c12', borderRadius: 8, paddingVertical: 13, alignItems: 'center', flexDirection: 'row', justifyContent: 'center'},
  ticketPrintText: {fontSize: 20, fontWeight: '800', color: '#fff'},
  placesGrid: {marginBottom: 14, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden'},
  chip: {paddingVertical: 11, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#eef2f7', backgroundColor: '#fff'},
  chipSel: {backgroundColor: '#E8F7FF'},
  chipDis: {backgroundColor: '#f8fafc', opacity: .55},
  chipText: {fontSize: 14, color: '#334155', fontWeight: '600'},
  chipTextSel: {color: '#0284c7'},
  chipTextDis: {color: '#999'},
  dirErr: {flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FFEBEE', borderRadius: 10, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#FFCDD2'},
  dirErrText: {fontSize: 13, color: '#C62828', flex: 1, lineHeight: 18},
  fareDivider: {height: 1, backgroundColor: '#e0e0e0', marginVertical: 8},
  fareTotalLabel: {fontSize: 16, color: '#1a1a1a', fontWeight: '700'},
  fareTotalVal: {fontSize: 18, color: '#00b7f3', fontWeight: '700'},
  detailRow: {flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8},
  detailLabel: {fontSize: 15, color: '#666', fontWeight: '500'},
  detailVal: {fontSize: 15, color: '#1a1a1a', fontWeight: '600', flex: 1, textAlign: 'right', marginLeft: 16},
  fieldInputText: {fontSize: 15, color: '#444'},
  debugBtn: {backgroundColor: '#E3F2FD', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: '#90CAF9'},
  debugBtnText: {fontSize: 14, fontWeight: '600', color: '#1976D2'},
});

const sh = StyleSheet.create({
  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  bottomSheet: {backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: Platform.OS === 'ios' ? 34 : 20},
  sheetHandle: {width: 40, height: 4, backgroundColor: '#ddd', borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 16},
  modalHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 16},
  modalTitle: {fontSize: 20, fontWeight: '700', color: '#1a2332', marginTop: 12},
  primaryBtn: {backgroundColor: '#00b7f3', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8},
  primaryBtnText: {fontSize: 16, fontWeight: '700', color: '#fff'},
  cancelBtn: {backgroundColor: '#f0f0f0', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center'},
  cancelBtnText: {fontSize: 16, fontWeight: '600', color: '#666'},
});
