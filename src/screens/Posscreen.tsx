import React, {useState, useCallback, useEffect, useRef} from 'react';
import {
  StyleSheet, Text, TouchableOpacity, View, ScrollView,
  Platform, Modal, Alert, ActivityIndicator, ToastAndroid,
  Animated, FlatList, TextInput,
} from 'react-native';
import {SafeAreaView}            from 'react-native-safe-area-context';
import AsyncStorage              from '@react-native-async-storage/async-storage';
import {
  Receipt, ArrowUpDown, Printer as PrinterIcon, Minus, Plus,
  Bus, Play, Pause, Square, BarChart3, PlusCircle,
  Users, User, CheckCircle, BadgeCheck, RefreshCw,
  X, ChevronRight, Bell, LogOut, Navigation, Clock,
  Timer, Ticket, DollarSign, UserCheck, AlertCircle, TrendingUp,
} from 'lucide-react-native';
import {getRandomFortune}        from '../utils/fortune';
import {places}                  from '../utils/places';
import {fareMatrix}              from '../utils/fareMatrix';
import api                       from '../api/api';
import {useVerificationRealtime} from '../hooks/useVerificationRealtime';
import {usePOSTickets, POSTicket} from '../hooks/usePOSTickets';
import {supabase}              from '../../lib/supabase';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const showToast = (msg: string, dur = ToastAndroid.SHORT) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, dur);
  else Alert.alert('', msg);
};
const formatTime = (iso: string) =>
  iso ? new Date(iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '—';
const formatDate = (iso: string) =>
  iso ? new Date(iso).toLocaleDateString([], {day:'numeric', month:'short', year:'numeric'}) : '—';
const formatDuration = (start: string, end?: string | null) => {
  if (!start) return '—';
  const mins = Math.round((((end ? new Date(end) : new Date()).getTime()) - new Date(start).getTime()) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins/60)}h ${mins%60}m`;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const posStopLabel = (s: string): string => {
  if (!s || s.trim() === '') return '?';
  if (UUID_RE.test(s.trim())) return '?';
  return englishStop(s);
};
const shortStop   = (n: string) => { if (!n||n==='Unknown') return '?'; const p=n.split('-'); return p.length>=3?p.slice(2).join('-').trim():p[p.length-1].trim()||p[0].trim(); };
const englishStop = (n: string) => (!n||n==='Unknown') ? '?' : n.split('-')[0].trim();
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
  const parts = routeName.split(/\s*(?:->|→|-)\s*/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return routeName;
  return [...parts].reverse().join(' - ');
};
const fareStr     = (n: number) => n%1===0 ? `${n}.00` : n.toFixed(2);
const genId       = () => `pos_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

// ─────────────────────────────────────────────────────────────────────────────
// Stage code helpers — always return numeric code (e.g. "003") from any stop format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract numeric stage code from a POS stop label like "003-CBE-Coimbatore"
 * Returns zero-padded 3-digit code.
 */
const stageCode = (label: string): string => {
  if (!label || label === '?') return '???';
  const parts = label.split('-');
  if (parts.length >= 2 && /^\d+$/.test(parts[0].trim())) {
    return parts[0].trim().padStart(3, '0');
  }
  return label.slice(0, 3).padStart(3, '0');
};

/**
 * Extract numeric stage code from an app stop name.
 * Handles formats like "003-CBE-Coimbatore", "Coimbatore", plain names.
 * Falls back to first 3 chars if no numeric prefix found.
 */
const stageCodeFromName = (name: string): string => {
  if (!name || name === 'Unknown' || name === '?') return '???';
  const parts = name.split('-');
  if (parts.length >= 2 && /^\d+$/.test(parts[0].trim())) {
    return parts[0].trim().padStart(3, '0');
  }
  // Try to find a numeric token anywhere (e.g. stop_name stored as "CBE-003-Coimbatore")
  for (const part of parts) {
    if (/^\d+$/.test(part.trim())) {
      return part.trim().padStart(3, '0');
    }
  }
  return name.slice(0, 3).padStart(3, '0');
};

/**
 * Build a combined, numerically-sorted array of stage rows merging app breakdown
 * and POS tickets. App tickets are merged into the F (full) column — NOT shown separately.
 */
const buildCombinedStageRows = (
  appBreakdown: any[],
  posTix: any[]
): Array<{ss:string; es:string; f:number; h:number; l:number; p:number; amt:number}> => {
  const map: Record<string, {ss:string; es:string; f:number; h:number; l:number; p:number; amt:number}> = {};

  // ── App tickets — merged into F/H columns ──
  for (const rb of appBreakdown) {
    const ssCode = stageCodeFromName(rb.from);
    const esCode = stageCodeFromName(rb.to);
    // Skip rows where we genuinely cannot determine stage codes
    if (ssCode === '???' && esCode === '???') continue;
    const k = `${ssCode}|||${esCode}`;
    if (!map[k]) map[k] = { ss: ssCode, es: esCode, f: 0, h: 0, l: 0, p: 0, amt: 0 };
    const fullCnt = Number(rb.full_count ?? 0);
    const halfCnt = Number(rb.half_count ?? 0);
    const freeCnt = Number(rb.free_count ?? 0);
    // Free passengers count as full for display purposes
    map[k].f   += fullCnt + freeCnt;
    map[k].h   += halfCnt;
    map[k].amt += Number(rb.total_fare ?? rb.revenue ?? 0);
  }

  // ── POS tickets ──
  for (const t of posTix) {
    const ssCode = stageCode(t.from_stop);
    const esCode = stageCode(t.to_stop);
    if (ssCode === '???' && esCode === '???') continue;
    const k = `${ssCode}|||${esCode}`;
    if (!map[k]) map[k] = { ss: ssCode, es: esCode, f: 0, h: 0, l: 0, p: 0, amt: 0 };
    const cnt = Number(t.ticket_count ?? 0);
    const hasLuggage = Number(t.luggage_amount ?? 0) > 0;
    const luggCnt = hasLuggage ? 1 : 0;
    const passCnt = Math.max(0, cnt - luggCnt);
    if ((t as any).ticket_type === 'half') {
      map[k].h += passCnt;
    } else {
      map[k].f += passCnt;
    }
    map[k].l   += luggCnt;
    map[k].amt += Number(t.fare ?? 0);
  }

  return Object.values(map).sort((a, b) =>
    a.ss.localeCompare(b.ss, undefined, { numeric: true })
  );
};

const getNextTicketNumber = async (busId: string | null): Promise<number | null> => {
  if (!busId) return null;
  try {
    const { data, error } = await supabase.rpc('increment_ticket_number', {
      p_bus_id: busId,
    });
    if (error) throw error;
    return typeof data === 'number' ? data : null;
  } catch (e) {
    console.warn('[TicketNum] RPC failed:', e);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Printer (no-op on iOS / dev; store to AsyncStorage instead)
// ─────────────────────────────────────────────────────────────────────────────
let NyxPrinter: any = null, PrinterStatus: any = null, PrintAlign: any = null;
if (Platform.OS === 'android') {
  try { const n=require('nyx-printer-react-native'); NyxPrinter=n.default; PrinterStatus=n.PrinterStatus; PrintAlign=n.PrintAlign; } catch(_){}
}

const MOCK_PRINT_KEY = 'mock_print_log';
const mockPrint = async (lines: {text:string;textSize?:number;align?:string}[]) => {
  try {
    const existing = await AsyncStorage.getItem(MOCK_PRINT_KEY);
    const log: any[] = existing ? JSON.parse(existing) : [];
    log.push({ ts: new Date().toISOString(), lines });
    await AsyncStorage.setItem(MOCK_PRINT_KEY, JSON.stringify(log.slice(-50)));
  } catch(e) { console.warn('mockPrint error', e); }
};

class Printer {
  private lines: {text:string;textSize?:number;align?:string}[] = [];
  private useReal: boolean;

  constructor() {
    this.useReal = Platform.OS === 'android' && !!NyxPrinter;
  }

  async checkReady(): Promise<boolean> {
    if (!this.useReal) return true;
    const ret = await NyxPrinter.getPrinterStatus();
    if (ret !== PrinterStatus.SDK_OK) {
      Alert.alert('Printer Error', PrinterStatus.msg(ret));
      return false;
    }
    return true;
  }

  async text(text: string, opts?: {textSize?:number; align?:string}) {
    this.lines.push({text, ...opts});
    if (this.useReal) {
      const alignVal = opts?.align === 'CENTER' ? PrintAlign.CENTER : undefined;
      await NyxPrinter.printText(text, {textSize: opts?.textSize, align: alignVal});
    }
  }

  async finish() {
    if (this.useReal) {
      await NyxPrinter.printEndAutoOut();
    } else {
      await mockPrint(this.lines);
      showToast('Saved to print log (no printer connected)');
    }
    this.lines = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Print alignment helpers — receipt paper ~32 chars wide at normal font size
// ─────────────────────────────────────────────────────────────────────────────
const PRINT_WIDTH = 32;

const printLR = (label: string, value: string, width = PRINT_WIDTH): string => {
  const lbl = String(label ?? '');
  const val = String(value ?? '');
  const space = Math.max(1, width - lbl.length - val.length);
  return lbl + ' '.repeat(space) + val;
};

// Fixed column widths: SS(5) ES(5) F(3) H(3) L(3) P(3) AMT(rest)
const printStageRow = (ss: string, es: string, f: string, h: string, l: string, p: string, amt: string): string => {
  const ssP  = String(ss  ?? '').slice(0, 5).padEnd(5);
  const esP  = String(es  ?? '').slice(0, 5).padEnd(5);
  const fP   = String(f   ?? '').slice(0, 3).padEnd(3);
  const hP   = String(h   ?? '').slice(0, 3).padEnd(3);
  const lP   = String(l   ?? '').slice(0, 3).padEnd(3);
  const pP   = String(p   ?? '').slice(0, 3).padEnd(3);
  const amtP = String(amt ?? '').slice(0, 7).padStart(7);
  return `${ssP} ${esP} ${fP} ${hP} ${lP} ${pP} ${amtP}`;
};

const DIVIDER = '--------------------------------';

// ─────────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────────
const TABS = [
  {key:'ticket', label:'Ticket', Icon:Ticket},
  {key:'trip',   label:'Trip',   Icon:Bus},
  {key:'riders', label:'Riders', Icon:Users},
  {key:'report', label:'Report', Icon:BarChart3},
];

// ─────────────────────────────────────────────────────────────────────────────
// Status Badge
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_CFG: Record<string,{bg:string;text:string;label:string}> = {
  running:  {bg:'#E8F5E9',text:'#2E7D32',label:'Running'},
  paused:   {bg:'#FFF8E1',text:'#F57F17',label:'Paused'},
  completed:{bg:'#E3F2FD',text:'#1565C0',label:'Completed'},
  cancelled:{bg:'#FFEBEE',text:'#C62828',label:'Cancelled'},
};
const StatusBadge = ({status}:{status:string}) => {
  const c = STATUS_CFG[status] ?? {bg:'#F5F5F5',text:'#616161',label:status};
  return <View style={[sh.statusBadge,{backgroundColor:c.bg}]}><Text style={[sh.statusText,{color:c.text}]}>{c.label}</Text></View>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pulsing verify row
// ─────────────────────────────────────────────────────────────────────────────
const PendingVerifyRow = ({item,onVerify,verifying}:{item:any;onVerify:(id:string)=>void;verifying:string|null}) => {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(()=>{ const l=Animated.loop(Animated.sequence([Animated.timing(pulse,{toValue:.55,duration:700,useNativeDriver:true}),Animated.timing(pulse,{toValue:1,duration:700,useNativeDriver:true})])); l.start(); return()=>l.stop(); },[pulse]);
  return (
    <Animated.View style={[sh.pendingRow,{opacity:pulse}]}>
      <View style={sh.pendingLeft}><View style={sh.pendingIconWrap}><UserCheck size={18} color="#f57c00"/></View>
        <View style={{flex:1}}><Text style={sh.pendingRoute}>{item.from||'?'} → {item.to||'?'}</Text><Text style={sh.pendingMeta}>₹{item.fare??item.amount??0}{item.bus_number?`  ·  🚌 ${item.bus_number}`:''}</Text></View>
      </View>
      <TouchableOpacity style={sh.pendingVerifyBtn} onPress={()=>onVerify(item.ticket_id)} disabled={verifying===item.ticket_id}>
        {verifying===item.ticket_id?<ActivityIndicator size="small" color="#fff"/>:<><CheckCircle size={14} color="#fff"/><Text style={sh.pendingVerifyBtnText}>Verify</Text></>}
      </TouchableOpacity>
    </Animated.View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Start Trip Modal
// ─────────────────────────────────────────────────────────────────────────────
const StartTripModal = ({visible,onClose,onStarted}:{visible:boolean;onClose:()=>void;onStarted:(payload?:{direction:string;route_name?:string;start_time:string})=>void}) => {
  const [routes,setRoutes]=useState<any[]>([]);
  const [sel,setSel]=useState<any>(null);
  const [dir,setDir]=useState('up');
  const [loading,setLoading]=useState(false);
  const [fetching,setFetching]=useState(false);
  useEffect(()=>{if(visible){setSel(null);(async()=>{setFetching(true);try{const r=await api.get('/conductor/routes');setRoutes(r.data?.routes||[]);}catch{setRoutes([]);}finally{setFetching(false);}})();}}, [visible]);
  const start=async()=>{
    if(!sel){Alert.alert('Select Route','Please select a route first.');return;}
    setLoading(true);
    try{
      const r=await api.post('/conductor/trip/start',{route_id:sel,direction:dir});
      if(r.data?.success){
        showToast('Trip started!');
        const selectedRoute = routes.find((x:any)=>x.id===sel);
        onStarted({direction:dir, route_name:selectedRoute?.name, start_time:new Date().toISOString()});
        onClose();
      }
    }
    catch(e:any){Alert.alert('Error',e?.response?.data?.error||'Failed to start trip.');}
    finally{setLoading(false);}
  };
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sh.modalOverlay}><View style={sh.bottomSheet}>
        <View style={sh.sheetHandle}/>
        <View style={sh.modalHeader}><Text style={sh.modalTitle}>Start New Trip</Text><TouchableOpacity onPress={onClose}><X size={24} color="#444"/></TouchableOpacity></View>
        <Text style={sh.inputLabel}>Select Route</Text>
        {fetching?<ActivityIndicator color="#00b7f3" style={{marginVertical:12}}/>:(
          <ScrollView style={{maxHeight:200}} showsVerticalScrollIndicator={false}>
            {routes.length===0?<Text style={sh.emptyNote}>No routes available</Text>:routes.map((r:any)=>(
              <TouchableOpacity key={r.id} style={[sh.routeOption,sel===r.id&&sh.routeOptionSelected]} onPress={()=>setSel(r.id)}>
                <Navigation size={16} color={sel===r.id?'#00b7f3':'#999'}/><Text style={[sh.routeOptionText,sel===r.id&&{color:'#00b7f3',fontWeight:'600'}]}>{r.name}</Text>
                {sel===r.id&&<CheckCircle size={16} color="#00b7f3"/>}
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        <Text style={[sh.inputLabel,{marginTop:16}]}>Direction</Text>
        <View style={sh.dirRow}>
          {[{key:'up',label:'Forward (UP)'},{key:'dn',label:'Return (DN)'}].map(d=>(
            <TouchableOpacity key={d.key} style={[sh.dirBtn,dir===d.key&&sh.dirBtnActive]} onPress={()=>setDir(d.key)}>
              <Text style={[sh.dirBtnText,dir===d.key&&{color:'#fff'}]}>{d.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={[sh.primaryBtn,loading&&{opacity:.6}]} onPress={start} disabled={loading}>
          {loading?<ActivityIndicator color="#fff"/>:<><Play size={18} color="#fff"/><Text style={sh.primaryBtnText}>Start Trip</Text></>}
        </TouchableOpacity>
      </View></View>
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1 — Ticket
// ─────────────────────────────────────────────────────────────────────────────
const halfFare = (full: number): number => Math.ceil(full / 2);

const TicketTab = ({activeTrip,user,busNumber,onTicketIssued,tripNumber}:{activeTrip:any;user:any;busNumber:string;onTicketIssued:(t:POSTicket)=>void;tripNumber:number}) => {
  const tripDirection: string = activeTrip?.direction ?? 'up';
  const getPlaces = useCallback(()=> isDownDirection(tripDirection) ? [...(places as any[])].reverse() : places as any[], [tripDirection]);
  const getBanner = ()=> isDownDirection(tripDirection) ? 'STY → CBE | சத்தி → கோவை' : 'CBE → STY | கோவை → சத்தி';

  const [selStart,setSelStart]   = useState<any>(null);
  const [selDest,setSelDest]     = useState<any>(null);
  const [activeDrop,setActiveDrop] = useState<string|null>('start');
  const [dirErr,setDirErr]       = useState<string|null>(null);
  const [showConfirm,setShowConfirm] = useState(false);
  const [issuing,setIssuing]     = useState(false);
  const [luggageInput,setLuggageInput] = useState('0');

  const [ticketType,setTicketType] = useState<'full'|'half'>('full');
  const [fullCount,setFullCount]   = useState(1);
  const [halfCount,setHalfCount]   = useState(0);

  useEffect(()=>{
    setSelStart(null);setSelDest(null);setDirErr(null);setActiveDrop('start');
    setTicketType('full');setFullCount(1);setHalfCount(0);
    setLuggageInput('0');
  },[tripDirection]);

  const getFare = useCallback((sk:string,ek:string):number=>(fareMatrix as any)?.[sk]?.[ek]??0,[]);

  const baseFullFare  = (selStart?.key&&selDest?.key) ? getFare(selStart.key,selDest.key) : 0;
  const baseHalfFare  = halfFare(baseFullFare);
  const fullTotal     = baseFullFare * fullCount;
  const halfTotal     = baseHalfFare * halfCount;
  const luggageAmount = parseAmount(luggageInput);
  const hasPassengerTickets = fullCount > 0 || halfCount > 0;
  const isLuggageOnlyTicket = luggageAmount > 0 && !hasPassengerTickets;
  const grandTotal    = fullTotal + halfTotal + luggageAmount;
  const totalTickets  = fullCount + halfCount + (luggageAmount > 0 ? 1 : 0);

  useEffect(()=>{
    setDirErr(null);
    if(!selStart?.key||!selDest?.key) return;
    const ss=Number(selStart.label.split('-')[1]), ds=Number(selDest.label.split('-')[1]);
    if(tripDirection==='up'&&ss<ds){setDirErr('Wrong direction — swap stops for UP trip (CBE → STY)');return;}
    if(isDownDirection(tripDirection)&&ss>ds){setDirErr('Wrong direction — swap stops for DN trip (STY → CBE)');return;}
  },[selStart,selDest,tripDirection]);

  const isReady = !!(
    selStart &&
    selDest &&
    !dirErr &&
    (luggageAmount > 0 || (hasPassengerTickets && baseFullFare > 0))
  );

  const handlePrint = async () => {
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
      const luggageOnFull = (fullCount > 0 || isLuggageOnlyTicket) ? luggageAmount : 0;
      const luggageOnHalf = fullCount === 0 && halfCount > 0 ? luggageAmount : 0;
      const luggageTicketOnFull = luggageOnFull > 0 ? 1 : 0;
      const luggageTicketOnHalf = luggageOnHalf > 0 ? 1 : 0;

      const p = new Printer();
      const ready = await p.checkReady();
      if (!ready) { setIssuing(false); return; }

      await p.text('SPS - ZYRAP', { textSize: 28, align: 'CENTER' });
      await p.text(DIVIDER, { align: 'CENTER' });
      const numLine = [
        fullTicketNum  ? `#${fullTicketNum}`  : null,
        halfTicketNum  ? `#${halfTicketNum}`  : null,
      ].filter(Boolean).join(' / ');
      if (numLine) await p.text(`Ticket: ${numLine}`, { textSize: 20, align: 'CENTER' });
      await p.text(`${dp}   ${tp}`, { textSize: 22, align: 'CENTER' });
      await p.text(`Bus: ${busNumber}          CASH`, { textSize: 22 });
      if (luggageAmount > 0) await p.text(`Luggage: Rs ${fareStr(luggageAmount)}`, { textSize: 20 });
      await p.text(DIVIDER, { align: 'CENTER' });
      await p.text(`${fnum}-${fn}`, { textSize: 24 });
      await p.text(`${tnum}-${tn}`, { textSize: 24 });
      await p.text(DIVIDER, { align: 'CENTER' });
      if (fullCount > 0) await p.text(`ADULT(S): ${fullCount} * ${fareStr(baseFullFare)} = ${fareStr(fullTotal)}`, { textSize: 22 });
      if (halfCount > 0) await p.text(`CHILD(S): ${halfCount} * ${fareStr(baseHalfFare)} = ${fareStr(halfTotal)}`, { textSize: 22 });
      if (luggageAmount > 0) await p.text(`LUGGAGE : Rs ${fareStr(luggageAmount)}`, { textSize: 22 });
      await p.text(`Rs : ${fareStr(grandTotal)}`, { textSize: 36, align: 'CENTER' });
      await p.text(DIVIDER, { align: 'CENTER' });
      await p.text(fortune, { textSize: 18, align: 'CENTER' });
      await p.finish();

      if (fullCount > 0 || isLuggageOnlyTicket) {
        const t: POSTicket = {
          id: genId(),
          trip_id: activeTrip?.trip_id ?? null,
          from_stop: selStart.label,
          to_stop: selDest.label,
          from_key: selStart.key,
          to_key: selDest.key,
          ticket_count: fullCount + luggageTicketOnFull,
          fare: fullTotal + luggageOnFull,
          unit_fare: baseFullFare,
          ticket_type: 'full',
          luggage_amount: luggageOnFull,
          ticket_number: fullTicketNum,
          bus_number: busNumber,
          direction: tripDirection,
          issued_at: now.toISOString(),
          synced: false,
        } as any;
        onTicketIssued(t);
      }

      if (halfCount > 0) {
        const halfTime = new Date(now.getTime() + 1);
        const t: POSTicket = {
          id: genId(),
          trip_id: activeTrip?.trip_id ?? null,
          from_stop: selStart.label,
          to_stop: selDest.label,
          from_key: selStart.key,
          to_key: selDest.key,
          ticket_count: halfCount + luggageTicketOnHalf,
          fare: halfTotal + luggageOnHalf,
          unit_fare: baseHalfFare,
          ticket_type: 'half',
          luggage_amount: luggageOnHalf,
          ticket_number: halfTicketNum,
          bus_number: busNumber,
          direction: tripDirection,
          issued_at: halfTime.toISOString(),
          synced: false,
        } as any;
        onTicketIssued(t);
      }

      showToast(`Ticket issued · ₹${grandTotal}`);
      setShowConfirm(false);
      setFullCount(1);
      setHalfCount(0);
      setTicketType('full');
      setLuggageInput('0');
      setActiveDrop(null);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Unknown');
    } finally {
      setIssuing(false);
    }
  };

  return (
    <>
      <ScrollView style={{flex:1}} contentContainerStyle={[tk.scrollContent,{paddingBottom:isReady?190:100}]} showsVerticalScrollIndicator={false}>
        {activeTrip?(
          <View style={tk.activePill}><Bus size={13} color="#2E7D32"/>
            <Text style={tk.activePillText}>
              {routeNameForDirection(activeTrip.route_name, activeTrip?.direction)} · {formatDuration(activeTrip.start_time,null)}
              {tripNumber>0?`  ·  Trip #${tripNumber}`:''}
            </Text>
            <StatusBadge status={activeTrip.status}/>
          </View>
        ):(
          <View style={tk.noTripPill}><AlertCircle size={13} color="#F57F17"/><Text style={tk.noTripPillText}>No active trip — tickets saved locally</Text></View>
        )}
        {activeTrip&&<View style={tk.routeBanner}><ArrowUpDown size={14} color="#00b7f3"/><Text style={tk.routeBannerText}>{getBanner()}</Text></View>}
        {busNumber!=='N/A'&&<View style={tk.busPill}><Bus size={13} color="#1565C0"/><Text style={tk.busPillText}>🚌 {busNumber}</Text></View>}

        <View style={tk.ticketCard}>
          {!activeTrip ? (
            <View style={tk.startTripPrompt}>
              <AlertCircle size={18} color="#F57F17"/>
              <Text style={tk.startTripPromptTitle}>No Active Trip</Text>
              <Text style={tk.startTripPromptText}>Please start a trip from the Trip tab to issue tickets.</Text>
            </View>
          ) : (
            <>
              {dirErr&&<View style={tk.dirErr}><AlertCircle size={14} color="#C62828"/><Text style={tk.dirErrText}>{dirErr}</Text></View>}

          <View style={tk.tripSelectorBar}>
            <TouchableOpacity style={tk.tripSide} onPress={()=>setActiveDrop(p=>p==='start'?null:'start')}>
              <Navigation size={15} color="#666"/>
              <View style={tk.tripSideCol}>
                <Text style={tk.tripSideHint}>Leaving From</Text>
                <Text style={tk.tripSideText} numberOfLines={1} ellipsizeMode="tail">
                  {selStart ? selStart.label.split('-').slice(2).join(' ') || selStart.label.split('-').slice(1).join(' ') : 'Select start'}
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[tk.swapBtn,(!selStart||!selDest)&&{opacity:.4}]}
              onPress={()=>{if(selStart&&selDest){const t=selStart;setSelStart(selDest);setSelDest(t);}}}
              disabled={!selStart||!selDest}
            >
              <ArrowUpDown size={15} color="#4B5563"/>
            </TouchableOpacity>
            <TouchableOpacity style={tk.tripSide} onPress={()=>setActiveDrop(p=>p==='destination'?null:'destination')}>
              <Navigation size={15} color="#666"/>
              <View style={tk.tripSideCol}>
                <Text style={tk.tripSideHint}>Going To</Text>
                <Text style={tk.tripSideText} numberOfLines={1} ellipsizeMode="tail">
                  {selDest ? selDest.label.split('-').slice(2).join(' ') || selDest.label.split('-').slice(1).join(' ') : 'Select destination'}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
          {activeDrop==='start'&&(
            <View style={tk.placesGrid}>
              {getPlaces().map((p:any)=>{
                const dis=selDest?.key===p.key,sel=selStart?.key===p.key;
                return(
                  <TouchableOpacity key={`s-${p.key}`} style={[tk.chip,sel&&tk.chipSel,dis&&tk.chipDis]} disabled={dis} onPress={()=>{setSelStart(p);setActiveDrop('destination');}}>
                    <Text style={[tk.chipText,sel&&tk.chipTextSel,dis&&tk.chipTextDis]}>{p.label.split('-')[1]} {p.label.split('-')[2]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {activeDrop==='destination'&&(
            <View style={tk.placesGrid}>
              {getPlaces().filter((_:any,idx:number)=>{if(!selStart)return true;const si=getPlaces().findIndex((p:any)=>p.key===selStart.key);return idx>si;}).map((p:any)=>{
                const dis=selStart?.key===p.key,sel=selDest?.key===p.key;
                return(
                  <TouchableOpacity key={`d-${p.key}`} style={[tk.chip,sel&&tk.chipSel,dis&&tk.chipDis]} disabled={dis} onPress={()=>{setSelDest(p);setActiveDrop(null);}}>
                    <Text style={[tk.chipText,sel&&tk.chipTextSel,dis&&tk.chipTextDis]}>{p.label.split('-')[1]} {p.label.split('-')[2]}</Text>
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
              <TouchableOpacity style={[tk.stepBtn,fullCount<=0&&tk.stepBtnDisabled]} onPress={()=>setFullCount(v=>Math.max(0,v-1))} disabled={fullCount<=0}>
                <Minus size={16} color={fullCount<=0?'#b9c4cf':'#fff'}/>
              </TouchableOpacity>
              <TextInput style={tk.countInput} keyboardType="numeric" value={String(fullCount)} onChangeText={(v)=>setFullCount(Math.max(0, Number(v.replace(/[^0-9]/g,''))||0))}/>
              <TouchableOpacity style={tk.stepBtn} onPress={()=>setFullCount(v=>v+1)}>
                <Plus size={18} color="#fff"/>
              </TouchableOpacity>
            </View>
            <View style={tk.countCell}>
              <TouchableOpacity style={[tk.stepBtn,halfCount<=0&&tk.stepBtnDisabled]} onPress={()=>setHalfCount(v=>Math.max(0,v-1))} disabled={halfCount<=0}>
                <Minus size={16} color={halfCount<=0?'#b9c4cf':'#fff'}/>
              </TouchableOpacity>
              <TextInput style={tk.countInput} keyboardType="numeric" value={String(halfCount)} onChangeText={(v)=>setHalfCount(Math.max(0, Number(v.replace(/[^0-9]/g,''))||0))}/>
              <TouchableOpacity style={tk.stepBtn} onPress={()=>setHalfCount(v=>v+1)}>
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

              <TouchableOpacity style={[tk.ticketPrintBtn,!isReady&&{opacity:.5}]} onPress={()=>setShowConfirm(true)} disabled={!isReady}>
                <Text style={tk.ticketPrintText}>PRINT TICKET</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>

      <Modal animationType="slide" transparent visible={showConfirm} onRequestClose={()=>setShowConfirm(false)}>
        <View style={sh.modalOverlay}><View style={sh.bottomSheet}>
          <View style={sh.sheetHandle}/>
          <View style={{alignItems:'center',marginBottom:16}}><PrinterIcon size={32} color="#00b7f3"/><Text style={sh.modalTitle}>Confirm Ticket</Text></View>
          <View style={tk.detailRow}><Text style={tk.detailLabel}>Bus</Text><Text style={tk.detailVal}>{busNumber}</Text></View>
          <View style={tk.detailRow}><Text style={tk.detailLabel}>From</Text><Text style={tk.detailVal}>{selStart?.label?.split('-')[0]}</Text></View>
          <View style={tk.detailRow}><Text style={tk.detailLabel}>To</Text><Text style={tk.detailVal}>{selDest?.label?.split('-')[0]}</Text></View>
          {luggageAmount>0&&<View style={tk.detailRow}><Text style={tk.detailLabel}>Luggage</Text><Text style={tk.detailVal}>₹{fareStr(luggageAmount)}</Text></View>}
          {fullCount>0&&<View style={tk.detailRow}><Text style={tk.detailLabel}>Adult</Text><Text style={tk.detailVal}>{fullCount} × ₹{fareStr(baseFullFare)} = ₹{fareStr(fullTotal)}</Text></View>}
          {halfCount>0&&<View style={tk.detailRow}><Text style={tk.detailLabel}>Child</Text><Text style={[tk.detailVal,{color:'#FF9800'}]}>{halfCount} × ₹{fareStr(baseHalfFare)} = ₹{fareStr(halfTotal)}</Text></View>}
          <View style={tk.fareDivider}/>
          <View style={tk.detailRow}><Text style={tk.fareTotalLabel}>Total ({totalTickets} tickets)</Text><Text style={tk.fareTotalVal}>₹{fareStr(grandTotal)}</Text></View>
          <View style={{flexDirection:'row',gap:12,marginTop:16}}>
            <TouchableOpacity style={sh.cancelBtn} onPress={()=>setShowConfirm(false)}><Text style={sh.cancelBtnText}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity style={[sh.primaryBtn,{flex:1},issuing&&{opacity:.6}]} onPress={handlePrint} disabled={issuing}>
              {issuing?<ActivityIndicator color="#fff"/>:<><PrinterIcon size={16} color="#fff"/><Text style={sh.primaryBtnText}>Issue Ticket</Text></>}
            </TouchableOpacity>
          </View>
        </View></View>
      </Modal>
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TAB 2 — Trip
// ─────────────────────────────────────────────────────────────────────────────
const TripTab = ({dashboard,onRefresh,pendingRequests,verifyingTicket,onVerifyTicket,tripNumber,posHook}:{dashboard:any;onRefresh:(payload?:{direction:string;route_name?:string;start_time:string})=>void|Promise<void>;pendingRequests:any[];verifyingTicket:string|null;onVerifyTicket:(id:string)=>void;tripNumber:number;posHook:ReturnType<typeof usePOSTickets>}) => {
  const [changing,setChanging]=useState(false);
  const [startModal,setStartModal]=useState(false);
  const at=dashboard?.active_trip;

  const activePOSTix   = posHook.tickets.filter((t:any)=>t.trip_id===at?.trip_id);
  const activePOSCount = activePOSTix.reduce((s:number,t:any)=>s+t.ticket_count,0);
  const activePOSFare  = activePOSTix.reduce((s:number,t:any)=>s+t.fare,0);

  const [appOnlyTickets,setAppOnlyTickets] = useState(0);
  const [appOnlyFare,setAppOnlyFare]       = useState(0);
  const [appTripLoading,setAppTripLoading] = useState(false);

  useEffect(() => {
    const tid = at?.trip_id;
    if (!tid) { setAppOnlyTickets(0); setAppOnlyFare(0); return; }
    let cancelled = false;
    setAppTripLoading(true);
    (async () => {
      try {
        const {data, error} = await supabase
          .from('tickets')
          .select('ticket_count,total_fare,fare')
          .eq('trip_id', tid)
          .neq('payment_method', 'pos');
        if (error) throw error;
        const rows: any[] = data || [];
        const count = rows.reduce((s, r) => s + Number(r.ticket_count ?? 1), 0);
        const total = rows.reduce((s, r) => {
          const cnt = Number(r.ticket_count ?? 1);
          const unit = Number(r.fare ?? 0);
          const t = r.total_fare != null ? Number(r.total_fare) : unit * cnt;
          return s + t;
        }, 0);
        if (!cancelled) { setAppOnlyTickets(count); setAppOnlyFare(total); }
      } catch (e) {
        if (!cancelled) { setAppOnlyTickets(0); setAppOnlyFare(0); }
      } finally {
        if (!cancelled) setAppTripLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [at?.trip_id]);

  const totalFareCombined = appOnlyFare + activePOSFare;

  const changeStatus=async(s:string)=>{
    if(!at)return;
    Alert.alert('Confirm',s==='completed'?'End this trip?':s==='paused'?'Pause?':'Resume?',[{text:'Cancel',style:'cancel'},{text:'Yes',onPress:async()=>{
      setChanging(true);
      try{await api.post(`/conductor/trip/${at.trip_id}/status`,{status:s});showToast(s==='completed'?'Trip ended!':s==='paused'?'Trip paused':'Trip resumed');onRefresh();}
      catch(e:any){Alert.alert('Error',e?.response?.data?.error||'Could not change status.');}
      finally{setChanging(false);}
    }}]);
  };

  return (
    <ScrollView style={{flex:1}} contentContainerStyle={{padding:16}} showsVerticalScrollIndicator={false}>

      {pendingRequests.length>0&&(
        <View style={sh.pendingSection}>
          <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
            <View style={{flexDirection:'row',alignItems:'center',gap:8}}><Bell size={17} color="#f57c00"/><Text style={sh.pendingSectionTitle}>Verification Requests</Text><View style={sh.pendingCountBadge}><Text style={sh.pendingCountText}>{pendingRequests.length}</Text></View></View>
            <Text style={{fontSize:11,fontWeight:'700',color:'#f57c00'}}>● LIVE</Text>
          </View>
          <Text style={{fontSize:12,color:'#888',marginBottom:10}}>Tap Verify to confirm passenger ticket</Text>
          {pendingRequests.map((i:any)=><PendingVerifyRow key={i.ticket_id} item={i} onVerify={onVerifyTicket} verifying={verifyingTicket}/>)}
        </View>
      )}

      <View style={sh.card}>
        {at?(
          <>
            <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
              <View>
                <Text style={{fontSize:10,color:'#888',fontWeight:'700',letterSpacing:1.5,marginBottom:2}}>
                  ACTIVE TRIP{tripNumber>0 ? ` · #${tripNumber}` : ''}
                </Text>
                <Text style={{fontSize:20,fontWeight:'700',color:'#1a2332'}}>{routeNameForDirection(at.route_name, at?.direction)}</Text>
              </View>
              <StatusBadge status={at.status}/>
            </View>

            <View style={{flexDirection:'row',gap:12,marginBottom:14,flexWrap:'wrap'}}>
              <View style={{flexDirection:'row',alignItems:'center',gap:4}}><Clock size={13} color="#888"/><Text style={{fontSize:12,color:'#888'}}>Started {formatTime(at.start_time)}</Text></View>
              <View style={{flexDirection:'row',alignItems:'center',gap:4}}><Timer size={13} color="#888"/><Text style={{fontSize:12,color:'#888'}}>{formatDuration(at.start_time,null)}</Text></View>
              {(at.bus_number||dashboard?.bus?.vehicle_number)&&<View style={{flexDirection:'row',alignItems:'center',gap:4}}><Bus size={13} color="#888"/><Text style={{fontSize:12,color:'#888'}}>{at.bus_number??dashboard?.bus?.vehicle_number}</Text></View>}
            </View>

            <View style={sh.inlineStats}>
              <View style={sh.inlineStat}>
                <Ticket size={15} color="#00b7f3"/>
                <Text style={sh.inlineStatVal}>{appTripLoading ? '…' : appOnlyTickets}</Text>
                <Text style={sh.inlineStatLabel}>App Tkts</Text>
              </View>
              <View style={sh.inlineStatDivider}/>
              {activePOSCount>0&&<><View style={sh.inlineStat}><PrinterIcon size={15} color="#7B1FA2"/><Text style={[sh.inlineStatVal,{color:'#7B1FA2'}]}>{activePOSCount}</Text><Text style={sh.inlineStatLabel}>POS Tkts</Text></View><View style={sh.inlineStatDivider}/></>}
              <View style={sh.inlineStat}>
                <DollarSign size={15} color="#4CAF50"/>
                <Text style={[sh.inlineStatVal,{color:'#4CAF50'}]}>₹{appTripLoading ? '…' : Number(totalFareCombined).toFixed(0)}</Text>
                <Text style={sh.inlineStatLabel}>Total</Text>
              </View>
              {pendingRequests.length>0&&<><View style={sh.inlineStatDivider}/><View style={sh.inlineStat}><UserCheck size={15} color="#f57c00"/><Text style={[sh.inlineStatVal,{color:'#f57c00'}]}>{pendingRequests.length}</Text><Text style={sh.inlineStatLabel}>Pending</Text></View></>}
            </View>

            <View style={{flexDirection:'row',gap:8,marginBottom:12,flexWrap:'wrap'}}>
              <View style={[tt.dirBadge,{backgroundColor:isDownDirection(at.direction)?'#EDE7F6':'#E3F2FD'}]}>
                <Text style={[tt.dirBadgeText,{color:isDownDirection(at.direction)?'#7B1FA2':'#1565C0'}]}>
                  {isDownDirection(at.direction)?'↓ DN  STY → CBE':'↑ UP  CBE → STY'}
                </Text>
              </View>
            </View>

            <View style={sh.tripActions}>
              {at.status==='running'&&<TouchableOpacity style={[sh.tripAction,{backgroundColor:'#FFF8E1'}]} onPress={()=>changeStatus('paused')} disabled={changing}><Pause size={17} color="#F57F17"/><Text style={[sh.tripActionText,{color:'#F57F17'}]}>Pause</Text></TouchableOpacity>}
              {at.status==='paused'&&<TouchableOpacity style={[sh.tripAction,{backgroundColor:'#E8F5E9'}]} onPress={()=>changeStatus('running')} disabled={changing}><Play size={17} color="#2E7D32"/><Text style={[sh.tripActionText,{color:'#2E7D32'}]}>Resume</Text></TouchableOpacity>}
              <TouchableOpacity style={[sh.tripAction,{backgroundColor:'#FCE4EC'}]} onPress={()=>changeStatus('completed')} disabled={changing}>
                {changing?<ActivityIndicator size="small" color="#C62828"/>:<Square size={17} color="#C62828"/>}
                <Text style={[sh.tripActionText,{color:'#C62828'}]}>End Trip</Text>
              </TouchableOpacity>
            </View>
          </>
        ):(
          <View style={{alignItems:'center',paddingVertical:24}}>
            <Bus size={48} color="#ccc"/><Text style={{fontSize:18,fontWeight:'700',color:'#999',marginTop:8}}>No Active Trip</Text>
            <Text style={{fontSize:13,color:'#bbb',marginTop:4,marginBottom:16,textAlign:'center'}}>Start a new trip when you're ready</Text>
            <TouchableOpacity style={sh.primaryBtn} onPress={()=>setStartModal(true)}><Play size={18} color="#fff"/><Text style={sh.primaryBtnText}>Start Trip</Text></TouchableOpacity>
          </View>
        )}
      </View>

      {at&&<TouchableOpacity style={sh.newTripBtn} onPress={()=>setStartModal(true)}><PlusCircle size={17} color="#00b7f3"/><Text style={{color:'#00b7f3',fontWeight:'600',fontSize:14}}>Start Another Trip</Text></TouchableOpacity>}

      <StartTripModal visible={startModal} onClose={()=>setStartModal(false)} onStarted={onRefresh}/>
    </ScrollView>
  );
};
const tt = StyleSheet.create({
  dirBadge:{paddingHorizontal:10,paddingVertical:4,borderRadius:10,alignSelf:'flex-start'},
  dirBadgeText:{fontSize:11,fontWeight:'700'},
});

// ─────────────────────────────────────────────────────────────────────────────
// TAB 3 — Riders
// ─────────────────────────────────────────────────────────────────────────────
const RidersTab = ({activeTrip,pendingRequests,onVerifyTicket,verifyingTicket,posTickets}:{activeTrip:any;pendingRequests:any[];onVerifyTicket:(id:string)=>void;verifyingTicket:string|null;posTickets:POSTicket[]}) => {
  const [data,setData]=useState<any>(null);
  const [loading,setLoading]=useState(false);
  useEffect(()=>{if(activeTrip?.trip_id)fetchP();else setData(null);},[activeTrip?.trip_id]);
  const fetchP=async()=>{setLoading(true);try{const r=await api.get(`/conductor/passengers/${activeTrip.trip_id}`);setData(r.data);}catch{Alert.alert('Error','Could not load passengers');}finally{setLoading(false);}};
  const pendingIds=new Set((pendingRequests||[]).map((p:any)=>p.ticket_id));
  const tripPOS=posTickets.filter(t=>t.trip_id===activeTrip?.trip_id);

  const allPassengers: any[] = data?.passengers ?? [];
  const appOnlyPassengers = allPassengers.filter((p: any) => {
    if ((p.payment_method ?? '').toLowerCase() === 'pos') return false;
    if (!p.user_id && !p.passenger_id) return false;
    const hasFrom = p.from && p.from !== 'Unknown' && p.from.trim() !== '';
    const hasTo   = p.to   && p.to   !== 'Unknown' && p.to.trim()   !== '';
    if (!hasFrom && !hasTo) return false;
    return true;
  });

  const sorted = [...appOnlyPassengers].sort(
    (a: any, b: any) =>
      (pendingIds.has(a.ticket_id) ? 0 : 1) - (pendingIds.has(b.ticket_id) ? 0 : 1)
  );
  const posPassengerCount=tripPOS.reduce((s,t)=>s+t.ticket_count,0);

  if(!activeTrip)return(
    <View style={{flex:1,justifyContent:'center',alignItems:'center',padding:40}}>
      <Users size={56} color="#ddd"/><Text style={{fontSize:18,color:'#bbb',fontWeight:'700',marginTop:12}}>No Active Trip</Text>
      <Text style={{fontSize:13,color:'#ccc',marginTop:6,textAlign:'center'}}>Start a trip to see passengers</Text>
    </View>
  );

  return (
    <View style={{flex:1}}>
      <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',padding:16,paddingBottom:8}}>
        <View>
          <Text style={{fontSize:18,fontWeight:'800',color:'#1a2332'}}>Passengers</Text>
          <Text style={{fontSize:12,color:'#888'}}>
            {sorted.length+posPassengerCount} on board
            {tripPOS.length>0?` · ${posPassengerCount} via POS`:''}
            {pendingRequests.length>0?` · ${pendingRequests.length} pending`:''}
          </Text>
        </View>
        <TouchableOpacity onPress={fetchP} style={{padding:8}}><RefreshCw size={20} color="#00b7f3"/></TouchableOpacity>
      </View>
      {loading?<ActivityIndicator size="large" color="#00b7f3" style={{marginTop:60}}/>:(
        <ScrollView contentContainerStyle={{paddingHorizontal:16,paddingBottom:20}}>
          {tripPOS.length>0&&(
            <View style={{marginBottom:12}}>
              <View style={rr.secHeader}><PrinterIcon size={13} color="#7B1FA2"/><Text style={rr.secLabel}>POS TICKETS · {posPassengerCount} passengers</Text></View>
              {tripPOS.map(t=>{
                const isHalf=(t as any).ticket_type==='half';
                return(
                <View key={t.id} style={[rr.posCard,isHalf&&{backgroundColor:'#FFF8E1',borderColor:'#FFE082'}]}>
                  <View style={rr.posLeft}>
                    <View style={[rr.posAvatar,isHalf&&{backgroundColor:'#FFF3E0'}]}>
                      <PrinterIcon size={14} color={isHalf?'#E65100':'#7B1FA2'}/>
                    </View>
                    <View style={{flex:1}}>
                      <Text style={[rr.posRoute,isHalf&&{color:'#E65100'}]}>
                        {(()=>{
                          const f=posStopLabel(t.from_stop);
                          const to=posStopLabel(t.to_stop);
                          if(f==='?'&&to==='?') return `₹${t.unit_fare} ticket (stop data unavailable)`;
                          return `${f} → ${to}`;
                        })()}
                      </Text>
                      <View style={{flexDirection:'row',gap:6,marginTop:3,alignItems:'center'}}>
                        <Text style={[rr.posAmt,isHalf&&{color:'#E65100'}]}>₹{t.unit_fare}</Text>
                        <Text style={{fontSize:12,color:'#888'}}>× {t.ticket_count}</Text>
                        <Text style={{fontSize:12,color:'#888'}}>= ₹{t.fare}</Text>
                        <View style={[rr.posBadge,{backgroundColor:isHalf?'#E65100':'#7B1FA2'}]}>
                          <Text style={rr.posBadgeText}>{isHalf?'HALF':'FULL'}</Text>
                        </View>
                      </View>
                    </View>
                  </View>
                  <View style={[rr.verifiedPill,isHalf&&{backgroundColor:'#FFF3E0'}]}>
                    <CheckCircle size={11} color={isHalf?'#E65100':'#4CAF50'}/>
                    <Text style={[rr.verifiedText,isHalf&&{color:'#E65100'}]}>Verified</Text>
                  </View>
                </View>
                );
              })}
            </View>
          )}

          {sorted.length===0&&tripPOS.length===0?(
            <View style={{alignItems:'center',paddingVertical:40}}><Users size={48} color="#ccc"/><Text style={{fontSize:15,color:'#bbb',marginTop:10}}>No passengers yet</Text></View>
          ):sorted.length>0&&(
            <View>
              <View style={rr.secHeader}><Users size={13} color="#00b7f3"/><Text style={[rr.secLabel,{color:'#00b7f3'}]}>APP TICKETS · {sorted.length}</Text></View>
              {sorted.map((item:any)=>{
                const ip=pendingIds.has(item.ticket_id);
                return(
                  <View key={item.ticket_id} style={[sh.passengerCard,ip&&sh.passengerCardPending]}>
                    {ip&&<View style={sh.pendingPill}><Bell size={10} color="#fff"/><Text style={sh.pendingPillText}>Verification Requested</Text></View>}
                    <View style={{flexDirection:'row',alignItems:'center',gap:12,padding:12}}>
                      <View style={[sh.passengerAvatar,ip&&{backgroundColor:'#fff3e0'}]}><User size={16} color={ip?'#f57c00':'#00b7f3'}/></View>
                      <View style={{flex:1}}>
                        <Text style={{fontSize:14,fontWeight:ip?'700':'600',color:ip?'#f57c00':'#1a2332'}}>{item.from||'?'} → {item.to||'?'}</Text>
                        <View style={{flexDirection:'row',gap:8,marginTop:3}}>
                          <Text style={{fontSize:13,color:'#00b7f3',fontWeight:'700'}}>₹{item.amount}</Text>
                          {item.is_verified&&<Text style={{fontSize:11,color:'#4CAF50',fontWeight:'600'}}>✓ Verified</Text>}
                          {item.is_free&&<Text style={{fontSize:11,color:'#9C27B0',fontWeight:'600'}}>🎉 Free</Text>}
                        </View>
                      </View>
                      {!item.is_verified&&(
                        <TouchableOpacity style={[sh.verifyBtn,ip&&{backgroundColor:'#f57c00',paddingHorizontal:14}]} onPress={()=>onVerifyTicket(item.ticket_id)} disabled={verifyingTicket===item.ticket_id}>
                          {verifyingTicket===item.ticket_id?<ActivityIndicator size="small" color="#fff"/>:<Text style={{color:'#fff',fontSize:12,fontWeight:'700'}}>Verify</Text>}
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
};
const rr=StyleSheet.create({
  secHeader:{flexDirection:'row',alignItems:'center',gap:6,paddingVertical:6,paddingHorizontal:2,marginBottom:6},
  secLabel:{fontSize:11,fontWeight:'800',color:'#7B1FA2',letterSpacing:.5},
  posCard:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',backgroundColor:'#F3E5F5',borderRadius:12,padding:12,marginBottom:8,borderWidth:1,borderColor:'#CE93D8'},
  posLeft:{flexDirection:'row',alignItems:'center',gap:10,flex:1},
  posAvatar:{width:34,height:34,borderRadius:17,backgroundColor:'#EDE7F6',justifyContent:'center',alignItems:'center'},
  posRoute:{fontSize:14,fontWeight:'600',color:'#4A148C'},
  posAmt:{fontSize:13,color:'#7B1FA2',fontWeight:'700'},
  posBadge:{backgroundColor:'#7B1FA2',borderRadius:6,paddingHorizontal:6,paddingVertical:2},
  posBadgeText:{fontSize:9,color:'#fff',fontWeight:'800'},
  verifiedPill:{flexDirection:'row',alignItems:'center',gap:3,backgroundColor:'#E8F5E9',paddingHorizontal:8,paddingVertical:4,borderRadius:8},
  verifiedText:{fontSize:11,color:'#2E7D32',fontWeight:'700'},
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage Filter — app tickets are included in filtered data and merged into F column
// ─────────────────────────────────────────────────────────────────────────────
const StageFilter = ({tripId,baseTickets,baseCollection,posTix,direction,onPrint,appBreakdown}:{tripId:any;baseTickets:any;baseCollection:any;posTix?:any[];direction?:string;onPrint:(d:any)=>void;appBreakdown?:any[]}) => {
  const [stops,setStops]=useState<any[]>([]);
  const [loading,setLoading]=useState(false);
  const [fromStop,setFrom]=useState<any>(null);
  const [toStop,setTo]=useState<any>(null);
  const [pFrom,setPFrom]=useState(false);
  const [pTo,setPTo]=useState(false);
  const [filtered,setFiltered]=useState<any>(null);
  const [filtering,setFiltering]=useState(false);
  const [open,setOpen]=useState(false);
  useEffect(()=>{if(open&&tripId&&stops.length===0){(async()=>{setLoading(true);try{const r=await api.get(`/conductor/trip/${tripId}/stages`);setStops(r.data?.stops||[]);}catch{}finally{setLoading(false);}})();}}, [open,tripId]);
  useEffect(()=>{setStops([]);setFrom(null);setTo(null);setFiltered(null);setOpen(false);},[tripId]);

  const apply = async(f:any,t:any) => {
    if(!f && !t){ setFiltered(null); return; }
    setFiltering(true);
    try{
      const stopMap: Record<string,string> = (stops||[]).reduce((acc:any,s:any) => { acc[s.id] = s.name; return acc; }, {});

      let q:any = supabase.from('tickets')
        .select('ticket_type,payment_method,ticket_count,total_fare,fare,from_stop_id,to_stop_id')
        .eq('trip_id', tripId)
        .neq('payment_method', 'pos');

      if(f?.id && !t?.id) {
        q = q.eq('from_stop_id', f.id);
      } else if(!f?.id && t?.id) {
        q = q.eq('to_stop_id', t.id);
      }
      // If both selected, fetch all and filter by range in JS

      const {data, error} = await q;
      if(error) throw error;
      let rows:any[] = data || [];

      if(f?.id && t?.id) {
        const stopOrder: Record<string, number> = {};
        stops.forEach((s: any, idx: number) => { stopOrder[s.id] = idx; });
        const fIdx = stopOrder[f.id] ?? -1;
        const tIdx = stopOrder[t.id] ?? Infinity;
        const [rangeStart, rangeEnd] = fIdx <= tIdx ? [fIdx, tIdx] : [tIdx, fIdx];

        rows = rows.filter((r: any) => {
          const fromIdx = stopOrder[r.from_stop_id] ?? -1;
          const toIdx   = stopOrder[r.to_stop_id]   ?? Infinity;
          return (
            (fromIdx >= rangeStart && fromIdx <= rangeEnd) ||
            (toIdx   >= rangeStart && toIdx   <= rangeEnd) ||
            (fromIdx <= rangeStart && toIdx   >= rangeEnd)
          );
        });
      }

      // Build per-stop-pair breakdown with stage CODES (not names)
      const map: Record<string, {ss:string; es:string; from:string; to:string; full_count:number; half_count:number; free_count:number; total_fare:number}> = {};
      let full = 0, half = 0, free = 0, tickets = 0, collection = 0;
      for(const r of rows){
        const cnt = Number(r.ticket_count ?? 1);
        const pm  = String(r.payment_method ?? '').toLowerCase();
        const tt  = (r.ticket_type ?? 'full') as string;
        const unit = Number(r.fare ?? 0);
        const total = r.total_fare != null ? Number(r.total_fare) : unit * cnt;
        const fromName = stopMap[r.from_stop_id] ?? 'Unknown';
        const toName   = stopMap[r.to_stop_id]   ?? 'Unknown';
        // Use stage codes as keys for consistent merging
        const ssCode = stageCodeFromName(fromName);
        const esCode = stageCodeFromName(toName);
        const k = `${ssCode}|||${esCode}`;
        if(!map[k]) map[k] = {ss: ssCode, es: esCode, from: fromName, to: toName, full_count:0, half_count:0, free_count:0, total_fare:0};
        const isFree = pm === 'fr';
        if(isFree){ map[k].free_count += cnt; free += cnt; }
        else if(tt === 'half'){ map[k].half_count += cnt; half += cnt; }
        else { map[k].full_count += cnt; full += cnt; }
        map[k].total_fare += total;
        tickets += cnt;
        collection += total;
      }
      const breakdown = Object.values(map);
      setFiltered({tickets, collection, full, half, free, breakdown});
    } catch { Alert.alert('Error','Could not filter'); setFiltered(null); }
    finally { setFiltering(false); }
  };
  const selF=(s:any)=>{setFrom(s);setPFrom(false);apply(s,toStop);};
  const selT=(s:any)=>{setTo(s);setPTo(false);apply(fromStop,s);};
  const clear=()=>{setFrom(null);setTo(null);setFiltered(null);};
  const isFilt=!!(fromStop||toStop);
  const isDN = isDownDirection(direction);
  const orderedStops = isDN ? [...stops].reverse() : stops;
  const posTixArr = posTix||[];

  // Filter POS tickets by range (same flexible matching)
  const matchedPOS = isFilt
    ? posTixArr.filter((t:any)=>{
        const tFromName = englishStop(t.from_stop).toLowerCase().trim();
        const tToName   = englishStop(t.to_stop).toLowerCase().trim();
        const selFromName = fromStop ? englishStop(fromStop.name).toLowerCase().trim() : null;
        const selToName   = toStop   ? englishStop(toStop.name).toLowerCase().trim()   : null;

        if (fromStop && toStop) {
          const stopOrder: Record<string, number> = {};
          orderedStops.forEach((s: any, idx: number) => {
            const sName = englishStop(s.name).toLowerCase().trim();
            stopOrder[sName] = idx;
          });
          const fIdx = stopOrder[selFromName!] ?? -1;
          const tIdx = stopOrder[selToName!]   ?? Infinity;
          const [rangeStart, rangeEnd] = fIdx <= tIdx ? [fIdx, tIdx] : [tIdx, fIdx];
          const ticketFromIdx = stopOrder[tFromName] ?? -1;
          const ticketToIdx   = stopOrder[tToName]   ?? Infinity;
          return (
            (ticketFromIdx >= rangeStart && ticketFromIdx <= rangeEnd) ||
            (ticketToIdx   >= rangeStart && ticketToIdx   <= rangeEnd) ||
            (ticketFromIdx <= rangeStart && ticketToIdx   >= rangeEnd)
          );
        }
        const fromOk = !selFromName || tFromName.includes(selFromName) || selFromName.includes(tFromName);
        const toOk   = !selToName   || tToName.includes(selToName)     || selToName.includes(tToName);
        return fromOk && toOk;
      })
    : posTixArr;

  // Filter app breakdown by range when both stops selected
  const matchedAppBreakdown: any[] = isFilt && filtered
    ? (filtered.breakdown ?? [])
    : (appBreakdown ?? []);

  // Combined rows merge app + POS with stage numbers
  const combinedRows = isFilt && !filtering
    ? buildCombinedStageRows(filtered?.breakdown ?? [], matchedPOS)
    : buildCombinedStageRows(appBreakdown ?? [], posTixArr);

  const posStageCnt = matchedPOS.reduce((s:number,t:any)=>s+t.ticket_count,0);
  const posStageAmt = matchedPOS.reduce((s:number,t:any)=>s+t.fare,0);
  const appTix = isFilt ? (filtered?.tickets ?? 0) : baseTickets;
  const appCol = isFilt ? (filtered?.collection ?? 0) : baseCollection;
  const dTix = appTix + posStageCnt;
  const dCol = appCol + posStageAmt;

  // Combined F/H totals for display (app + POS merged)
  const dF = combinedRows.reduce((s, r) => s + r.f, 0);
  const dH = combinedRows.reduce((s, r) => s + r.h, 0);
  const dFr = isFilt ? (filtered?.free ?? 0) : null;

  const printBreakdown = combinedRows.map(r => ({
    ss: r.ss, es: r.es,
    full_count: r.f, half_count: r.h, free_count: r.l,
    total_fare: r.amt,
  }));

  return (
    <View style={sf.wrapper}>
      <TouchableOpacity style={[sf.toggle,open&&sf.toggleActive]} onPress={()=>setOpen(v=>!v)} activeOpacity={.7}>
        <BarChart3 size={14} color={open?'#fff':'#00b7f3'}/><Text style={[sf.toggleText,open&&{color:'#fff'}]}>Stage Filter</Text>
        {isFilt&&<View style={sf.activeDot}/>}<Text style={{fontSize:12,color:open?'#fff':'#00b7f3'}}>{open?'▲':'▼'}</Text>
      </TouchableOpacity>
      {open&&(
        <View style={sf.panel}>
          <View style={{flexDirection:'row',alignItems:'center',gap:6,marginBottom:8}}>
            <View style={[sf.dirBadge,{backgroundColor:isDN?'#EDE7F6':'#E3F2FD'}]}>
              <Text style={[sf.dirBadgeText,{color:isDN?'#7B1FA2':'#1565C0'}]}>{isDN?'↓ DN  STY → CBE':'↑ UP  CBE → STY'}</Text>
            </View>
          </View>
          <View style={sf.statsRow}>
            <View style={sf.stat}><Ticket size={14} color="#00b7f3"/><Text style={[sf.statVal,{color:'#00b7f3'}]}>{dTix}</Text><Text style={sf.statLabel}>Tickets</Text></View>
            <View style={sf.statDivider}/>
            <View style={sf.stat}><DollarSign size={14} color="#4CAF50"/><Text style={[sf.statVal,{color:'#4CAF50'}]}>₹{Number(dCol).toFixed(2)}</Text><Text style={sf.statLabel}>Revenue</Text></View>
            {posStageCnt>0&&<><View style={sf.statDivider}/><View style={sf.stat}><PrinterIcon size={12} color="#7B1FA2"/><Text style={[sf.statVal,{color:'#7B1FA2',fontSize:13}]}>{posStageCnt}</Text><Text style={sf.statLabel}>POS</Text></View></>}
            {(dF > 0 || dH > 0) && (
              <><View style={sf.statDivider}/><View style={sf.stat}><Text style={[sf.statVal,{color:'#1a2332',fontSize:13}]}>{dF}F{dH>0?` · ${dH}H`:''}{dFr&&dFr>0?` · ${dFr}FR`:''}</Text><Text style={sf.statLabel}>Break</Text></View></>
            )}
          </View>
          {loading?<ActivityIndicator size="small" color="#00b7f3" style={{marginVertical:10}}/>:orderedStops.length===0?<Text style={sf.noStops}>No stops yet.</Text>:(
            <>
              <View style={sf.pickerRow}>
                <TouchableOpacity style={[sf.picker,fromStop&&sf.pickerActive]} onPress={()=>{setPFrom(v=>!v);setPTo(false);}}>
                  <Text style={[sf.pickerText,fromStop&&{color:'#00b7f3',fontWeight:'700'}]} numberOfLines={1}>{fromStop?englishStop(fromStop.name):'From Stage'}</Text>
                  {fromStop&&<TouchableOpacity onPress={()=>{setFrom(null);apply(null,toStop);}} hitSlop={{top:8,bottom:8,left:8,right:8}}><X size={12} color="#00b7f3"/></TouchableOpacity>}
                </TouchableOpacity>
                <Text style={{color:'#ccc',fontSize:16}}>→</Text>
                <TouchableOpacity style={[sf.picker,toStop&&sf.pickerActive]} onPress={()=>{setPTo(v=>!v);setPFrom(false);}}>
                  <Text style={[sf.pickerText,toStop&&{color:'#00b7f3',fontWeight:'700'}]} numberOfLines={1}>{toStop?englishStop(toStop.name):'To Stage'}</Text>
                  {toStop&&<TouchableOpacity onPress={()=>{setTo(null);apply(fromStop,null);}} hitSlop={{top:8,bottom:8,left:8,right:8}}><X size={12} color="#00b7f3"/></TouchableOpacity>}
                </TouchableOpacity>
              </View>
              {pFrom&&<View style={sf.dropdown}><Text style={sf.dropdownLabel}>FROM STAGE  ({isDN?'STY → CBE':'CBE → STY'})</Text><ScrollView style={{maxHeight:160}} nestedScrollEnabled>{orderedStops.map((s:any)=>(<TouchableOpacity key={s.id} style={[sf.dropdownOption,fromStop?.id===s.id&&sf.dropdownOptionActive]} onPress={()=>selF(s)}><View style={{flex:1}}><Text style={sf.dropdownName}>{englishStop(s.name)}</Text><Text style={sf.dropdownSub}>{shortStop(s.name)}</Text></View>{fromStop?.id===s.id&&<CheckCircle size={13} color="#00b7f3"/>}</TouchableOpacity>))}</ScrollView></View>}
              {pTo&&<View style={sf.dropdown}><Text style={sf.dropdownLabel}>TO STAGE  ({isDN?'STY → CBE':'CBE → STY'})</Text><ScrollView style={{maxHeight:160}} nestedScrollEnabled>{orderedStops.map((s:any)=>(<TouchableOpacity key={s.id} style={[sf.dropdownOption,toStop?.id===s.id&&sf.dropdownOptionActive]} onPress={()=>selT(s)}><View style={{flex:1}}><Text style={sf.dropdownName}>{englishStop(s.name)}</Text><Text style={sf.dropdownSub}>{shortStop(s.name)}</Text></View>{toStop?.id===s.id&&<CheckCircle size={13} color="#00b7f3"/>}</TouchableOpacity>))}</ScrollView></View>}
              {filtering&&<ActivityIndicator size="small" color="#00b7f3" style={{marginTop:8}}/>}
              {isFilt&&!filtering&&(
                <>
                  <View style={sf.resultBadge}><CheckCircle size={12} color="#4CAF50"/><Text style={sf.resultText} numberOfLines={2}>{dTix} ticket{dTix!==1?'s':''}{fromStop?` from ${englishStop(fromStop.name)}`:''}{toStop?` to ${englishStop(toStop.name)}`:''}{' · '}₹{Number(dCol).toFixed(2)}</Text><TouchableOpacity onPress={clear} style={{marginLeft:4}}><X size={12} color="#888"/></TouchableOpacity></View>
                  <TouchableOpacity style={sf.printBtn} onPress={()=>onPrint({fromStop,toStop,tickets:dTix,collection:dCol,full:dF,half:dH,free:dFr,breakdown:printBreakdown})}>
                    <PrinterIcon size={14} color="#fff"/><Text style={sf.printBtnText}>Print Stage Report</Text>
                  </TouchableOpacity>
                </>
              )}
              {/* Stage table — always show combined rows when open */}
              {!filtering&&combinedRows.length>0&&(
                <View style={sf.table}>
                  <View style={sf.tableHeader}>{['SS','ES','F','H','L','P','AMT'].map((h,i)=><Text key={i} style={[sf.th,i===6&&{flex:1.8,textAlign:'right'}]}>{h}</Text>)}</View>
                  {combinedRows.map((rb, i) => (
                    <View key={i} style={[sf.tableRow, i%2===0&&{backgroundColor:'#F7FAFC'}]}>
                      <Text style={sf.td} numberOfLines={1}>{rb.ss}</Text>
                      <Text style={sf.td} numberOfLines={1}>{rb.es}</Text>
                      <Text style={sf.td}>{rb.f > 0 ? rb.f : '-'}</Text>
                      <Text style={sf.td}>{rb.h > 0 ? rb.h : '-'}</Text>
                      <Text style={sf.td}>{rb.l > 0 ? rb.l : '0'}</Text>
                      <Text style={sf.td}>0</Text>
                      <Text style={[sf.td,{flex:1.8,textAlign:'right',color:'#00b7f3',fontWeight:'700'}]}>₹{Number(rb.amt).toFixed(2)}</Text>
                    </View>
                  ))}
                </View>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
};
const sf = StyleSheet.create({
  wrapper:{marginTop:10,marginBottom:4},toggle:{flexDirection:'row',alignItems:'center',gap:6,alignSelf:'flex-start',paddingHorizontal:12,paddingVertical:7,borderRadius:20,borderWidth:1.5,borderColor:'#00b7f3',backgroundColor:'#F0FAFF',marginBottom:8},
  toggleActive:{backgroundColor:'#00b7f3',borderColor:'#00b7f3'},toggleText:{fontSize:13,fontWeight:'600',color:'#00b7f3'},activeDot:{width:7,height:7,borderRadius:4,backgroundColor:'#FF5252'},
  panel:{backgroundColor:'#F0FAFF',borderRadius:12,padding:12,borderWidth:1,borderColor:'#B3E5FC',marginBottom:4},statsRow:{flexDirection:'row',backgroundColor:'#fff',borderRadius:10,padding:10,marginBottom:12,alignItems:'center'},
  stat:{flex:1,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:4},statVal:{fontSize:14,fontWeight:'800'},statLabel:{fontSize:10,color:'#888'},statDivider:{width:1,backgroundColor:'#e0e0e0',height:22,marginHorizontal:4},
  noStops:{fontSize:12,color:'#aaa',textAlign:'center',paddingVertical:8,fontStyle:'italic'},pickerRow:{flexDirection:'row',alignItems:'center',gap:8},
  picker:{flex:1,flexDirection:'row',alignItems:'center',gap:6,backgroundColor:'#fff',borderRadius:10,paddingHorizontal:10,paddingVertical:9,borderWidth:1.5,borderColor:'#ddd'},pickerActive:{borderColor:'#00b7f3',backgroundColor:'#E8F7FF'},pickerText:{fontSize:13,color:'#aaa',flex:1},
  dropdown:{backgroundColor:'#fff',borderRadius:10,marginTop:8,borderWidth:1,borderColor:'#e0e0e0',overflow:'hidden'},dropdownLabel:{fontSize:10,fontWeight:'700',color:'#888',letterSpacing:.5,paddingHorizontal:12,paddingTop:8,paddingBottom:4},
  dropdownOption:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:9,paddingHorizontal:12,borderBottomWidth:1,borderBottomColor:'#F0F4F8'},dropdownOptionActive:{backgroundColor:'#E8F7FF'},dropdownName:{fontSize:13,color:'#1a2332',fontWeight:'600'},dropdownSub:{fontSize:11,color:'#888',marginTop:1},
  resultBadge:{flexDirection:'row',alignItems:'center',gap:5,marginTop:8,backgroundColor:'#E8F5E9',paddingHorizontal:10,paddingVertical:5,borderRadius:8,alignSelf:'flex-start',flexShrink:1},resultText:{fontSize:11,color:'#2E7D32',fontWeight:'600',flexShrink:1},
  printBtn:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6,marginTop:8,backgroundColor:'#00b7f3',paddingVertical:9,paddingHorizontal:14,borderRadius:10},printBtnText:{color:'#fff',fontSize:13,fontWeight:'700'},
  dirBadge:{paddingHorizontal:10,paddingVertical:4,borderRadius:10,alignSelf:'flex-start'},dirBadgeText:{fontSize:11,fontWeight:'700'},
  table:{marginTop:10,borderRadius:8,overflow:'hidden'},
  tableHeader:{flexDirection:'row',backgroundColor:'#1a2332',paddingVertical:7,paddingHorizontal:8},
  th:{flex:1,fontSize:10,fontWeight:'700',color:'#fff',textAlign:'center'},
  tableRow:{flexDirection:'row',paddingVertical:7,paddingHorizontal:8},
  td:{flex:1,fontSize:11,color:'#333',textAlign:'center'},
});

// ─────────────────────────────────────────────────────────────────────────────
// TAB 4 — Report
// ─────────────────────────────────────────────────────────────────────────────

const TripReportSection = ({dashboard, posHook}: {dashboard:any; posHook:ReturnType<typeof usePOSTickets>}) => {
  const [reportTrip,setReportTrip] = useState<any>(null);
  const [report,setReport] = useState<any>(null);
  const [appTrip,setAppTrip] = useState<any>(null);
  const [loading,setLoading] = useState(false);
  const [printing,setPrinting] = useState(false);

  const recentTrips = dashboard?.recent_trips ?? [];
  const at = dashboard?.active_trip;

  useEffect(()=>{
    const id = reportTrip;
    if(!id){ setReport(null); setAppTrip(null); return; }
    setReport(null); setAppTrip(null);
    (async()=>{
      setLoading(true);
      try{
        const r=await api.get(`/conductor/trip/${id}/report`);
        setReport(r.data);
      } catch{ Alert.alert('Error','Could not load report'); }

      try{
        const {data:rows, error} = await supabase.from('tickets').select('ticket_type,payment_method,ticket_count,total_fare,fare,from_stop_id,to_stop_id,luggage_amount').eq('trip_id', id).neq('payment_method', 'pos');
        if(error) throw error;
        const appRows:any[] = rows || [];
        const stopIds = [...new Set(appRows.flatMap(r => [r.from_stop_id, r.to_stop_id]).filter(Boolean))];
        const stopMap: Record<string,string> = {};
        if(stopIds.length){
          const {data:stops, error:stopErr} = await supabase.from('stops').select('id, stop_name').in('id', stopIds);
          if(!stopErr){ (stops || []).forEach((s:any)=>{ stopMap[String(s.id)] = s.stop_name; }); }
        }
        // Build breakdown with stage codes as keys
        const map: Record<string,any> = {};
        let full=0,half=0,free=0,tickets=0,collection=0,luggage=0,luggageCount=0;
        for(const r of appRows){
          const cnt=Number(r.ticket_count??1), pm=String(r.payment_method??'').toLowerCase(), tt=(r.ticket_type??'full') as string;
          const hasLuggage=Number(r.luggage_amount??0)>0, passengerCnt=Math.max(0,cnt-(hasLuggage?1:0));
          luggage+=Number(r.luggage_amount??0); if(hasLuggage) luggageCount+=1;
          const unit=Number(r.fare??0), total=r.total_fare!=null?Number(r.total_fare):unit*cnt;
          const fromName=stopMap[String(r.from_stop_id)]??'Unknown', toName=stopMap[String(r.to_stop_id)]??'Unknown';
          // Use stage codes as map keys so they merge correctly with POS
          const ssCode = stageCodeFromName(fromName);
          const esCode = stageCodeFromName(toName);
          const k=`${ssCode}|||${esCode}`;
          if(!map[k]) map[k]={from:fromName,to:toName,full_count:0,half_count:0,free_count:0,total_fare:0};
          const isFree=pm==='fr';
          if(isFree){map[k].free_count+=passengerCnt;free+=passengerCnt;}
          else if(tt==='half'){map[k].half_count+=passengerCnt;half+=passengerCnt;}
          else{map[k].full_count+=passengerCnt;full+=passengerCnt;}
          map[k].total_fare+=total; tickets+=cnt; collection+=total;
        }
        const breakdown=Object.values(map);
        setAppTrip({tickets,collection,full,half,free,breakdown,luggage,luggageCount});
      } catch{
        setAppTrip({tickets:0,collection:0,full:0,half:0,free:0,breakdown:[],luggage:0,luggageCount:0});
      } finally{ setLoading(false); }
    })();
  },[reportTrip]);

  const tripPOSTix = (posHook?.tickets||[]).filter((t:any)=>t.trip_id===reportTrip);
  const posLuggageCnt = tripPOSTix.reduce((s:number,t:any)=>s+(Number(t.luggage_amount??0)>0?1:0),0);
  const appSummary=appTrip||{};
  const appCollection=Number(appSummary.collection??0), appLuggage=Number(appSummary.luggage??0), appLuggageCnt=Number(appSummary.luggageCount??0);
  const appFullCnt=Number(appSummary.full??0), appHalfCnt=Number(appSummary.half??0), appFreeCnt=Number(appSummary.free??0);

  // Combined stage rows — app tickets merged into F/H columns alongside POS
  const combinedStageRows = buildCombinedStageRows(appSummary.breakdown ?? [], tripPOSTix);

  // Grand totals derived from combined rows
  const grandFull = combinedStageRows.reduce((s, r) => s + r.f, 0);
  const grandHalf = combinedStageRows.reduce((s, r) => s + r.h, 0);
  const grandLuggageCnt = combinedStageRows.reduce((s, r) => s + r.l, 0) + appLuggageCnt;
  const grandCollection = appCollection + tripPOSTix.reduce((s:number,t:any)=>s+t.fare,0);
  const grandFree = appFreeCnt; // free count tracked separately

  const totalLuggage=appLuggage+tripPOSTix.reduce((s:number,t:any)=>s+Number(t.luggage_amount??0),0);

  // ── TRIP SHEET PRINT ─────────────────────────────────────────────────────
  const handlePrint = async () => {
    setPrinting(true);
    try{
      const fmt=(n:number)=>n%1===0?`${n}.00`:n.toFixed(2);
      const busNum=report?.bus_number??tripPOSTix[0]?.bus_number??'N/A';
      const wayBill=report?.way_bill_number??report?.waybill??report?.way_bill??'—';
      const tripNum=report?.trip_number??'';
      const routeName=report?.route_name??'';
      const now=new Date();
      const dateStr=now.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'2-digit'}).replace(/\//g,'/');
      const timeStr=now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
      const startTime=report?.start_time ? new Date(report.start_time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false}) : '—';

      const posSortedTix = [...tripPOSTix].filter(t=>t.ticket_number).sort((a,b)=>Number(a.ticket_number)-Number(b.ticket_number));
      const ticketRangeStr = posSortedTix.length >= 2
        ? `${posSortedTix[0].ticket_number} - ${posSortedTix[posSortedTix.length-1].ticket_number}`
        : posSortedTix.length === 1 ? String(posSortedTix[0].ticket_number) : '';

      const p=new Printer(); const ready=await p.checkReady(); if(!ready){setPrinting(false);return;}

      await p.text('SPS - ZYRAP', {textSize:22, align:'CENTER'});
      await p.text('TRIP SHEET', {textSize:26, align:'CENTER'});
      await p.text(`${dateStr}  ${timeStr}`, {textSize:18, align:'CENTER'});
      await p.text(DIVIDER);
      await p.text(printLR('WAY BILL No.:', wayBill), {textSize:18});
      await p.text(printLR('BUS NUMBER:', busNum), {textSize:18});
      await p.text(printLR('MACHINE ID:', 'SPS-POS-01'), {textSize:18});
      await p.text(DIVIDER);
      await p.text(`TRIP No. : ${tripNum}`, {textSize:20, align:'CENTER'});
      await p.text(printLR('BUS START:', `${dateStr} ${startTime}`), {textSize:18});
      await p.text(`${routeName}`, {textSize:20, align:'CENTER'});
      if (ticketRangeStr) await p.text(printLR('TICKET No.:', ticketRangeStr), {textSize:18});
      await p.text(DIVIDER);

      await p.text(printStageRow('SS','ES','F','H','L','P','AMT'), {textSize:18});
      await p.text(DIVIDER);

      // Combined rows: stage numbers + app+POS merged into F/H
      for (const row of combinedStageRows) {
        await p.text(
          printStageRow(row.ss, row.es, String(row.f||'-'), String(row.h||'-'), String(row.l||0), '0', fmt(row.amt)),
          {textSize:17}
        );
      }
      if (combinedStageRows.length === 0) await p.text('  (no stage data)', {textSize:17});

      await p.text(DIVIDER);
      await p.text(printLR('FULL :', String(grandFull)), {textSize:20});
      if (grandHalf > 0) await p.text(printLR('HALF :', String(grandHalf)), {textSize:20});
      if (grandFree > 0) await p.text(printLR('FREE :', String(grandFree)), {textSize:20});
      await p.text(printLR('LUGG :', String(grandLuggageCnt)), {textSize:20});
      await p.text(DIVIDER);
      await p.text(printLR('TRP TOTAL Rs.:', fmt(grandCollection)), {textSize:22});
      await p.text(DIVIDER);
      await p.text('** Safe Journey **', {align:'CENTER'});
      await p.finish();
    } catch(e:any){Alert.alert('Print Error',e.message||'Unknown');}
    finally{setPrinting(false);}
  };

  const printStageReport = async (data:any) => {
    try{
      const fmt=(n:number)=>n%1===0?`${n}`:n.toFixed(2);
      const p=new Printer(); const ready=await p.checkReady(); if(!ready)return;
      const fE=data.fromStop?englishStop(data.fromStop.name):'All', tE=data.toStop?englishStop(data.toStop.name):'All';
      await p.text('SPS - ZYRAP',{textSize:32,align:'CENTER'});
      await p.text(`${new Date().toLocaleString()}`,{textSize:20});
      await p.text(DIVIDER);
      await p.text('STAGE REPORT',{textSize:26,align:'CENTER'});
      await p.text(DIVIDER);
      await p.text(`From : ${fE}`);
      await p.text(`To   : ${tE}`);
      await p.text(DIVIDER);
      await p.text(printLR('Tickets:', String(data.tickets)));
      await p.text(printLR('F:', String(data.full??0)) + '  ' + printLR('H:', String(data.half??0)) + '  FR:' + String(data.free??0));
      await p.text(printLR('Rs.', fmt(Number(data.collection))),{textSize:32});
      await p.text(DIVIDER);
      await p.text('** Safe Journey **',{align:'CENTER'});
      await p.finish();
    } catch(e:any){Alert.alert('Print Error',e.message||'Unknown');}
  };

  return (
    <View>
      <View style={rp4.sectionHeader}>
        <Receipt size={16} color="#1a2332"/>
        <Text style={rp4.sectionTitle}>Trip Sheet</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom:10}}>
        {at&&(
          <TouchableOpacity
            style={[rp4.tripChip, reportTrip===at.trip_id&&rp4.tripChipActive]}
            onPress={()=>setReportTrip(reportTrip===at.trip_id?null:at.trip_id)}
          >
            <Text style={[rp4.tripChipText, reportTrip===at.trip_id&&{color:'#fff'}]}>
              Active Trip {at.trip_number?`#${at.trip_number}`:''}
            </Text>
          </TouchableOpacity>
        )}
        {recentTrips.slice(0,10).map((trip:any,i:number)=>(
          <TouchableOpacity
            key={trip.trip_id}
            style={[rp4.tripChip, reportTrip===trip.trip_id&&rp4.tripChipActive]}
            onPress={()=>setReportTrip(reportTrip===trip.trip_id?null:trip.trip_id)}
          >
            <Text style={[rp4.tripChipText, reportTrip===trip.trip_id&&{color:'#fff'}]}>
              {routeNameForDirection(trip.route_name, trip.direction)?.split(' ')[0]||`Trip ${i+1}`}
              {trip.trip_number?` #${trip.trip_number}`:''}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {!reportTrip&&(
        <View style={rp4.emptyCard}>
          <Receipt size={36} color="#ccc"/>
          <Text style={{fontSize:14,color:'#bbb',marginTop:8}}>Select a trip to view its trip sheet</Text>
        </View>
      )}

      {reportTrip&&loading&&<ActivityIndicator size="large" color="#00b7f3" style={{marginVertical:30}}/>}

      {reportTrip&&!loading&&report&&(
        <View style={rp4.reportCard}>
          {/* ── Trip Sheet Header Card ── */}
          <View style={ts.headerBox}>
            <Text style={ts.headerTitle}>TRIP SHEET</Text>
            <Text style={ts.headerMeta}>{new Date().toLocaleDateString('en-GB')}  {new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false})}</Text>
          </View>

          <View style={ts.metaGrid}>
            <View style={ts.metaRow}><Text style={ts.metaKey}>WAY BILL No.</Text><Text style={ts.metaVal}>{report?.way_bill_number??report?.waybill??report?.way_bill??'—'}</Text></View>
            <View style={ts.metaRow}><Text style={ts.metaKey}>BUS NUMBER</Text><Text style={ts.metaVal}>{report?.bus_number??tripPOSTix[0]?.bus_number??'N/A'}</Text></View>
            <View style={ts.metaRow}><Text style={ts.metaKey}>TRIP No.</Text><Text style={ts.metaVal}>{report?.trip_number??'—'}</Text></View>
            <View style={ts.metaRow}><Text style={ts.metaKey}>BUS START</Text><Text style={ts.metaVal}>{formatTime(report?.start_time)}</Text></View>
            <View style={ts.metaRow}><Text style={ts.metaKey}>ROUTE</Text><Text style={[ts.metaVal,{flex:2}]}>{report?.route_name??'—'}</Text></View>
            <View style={ts.metaRow}><Text style={ts.metaKey}>STATUS</Text><StatusBadge status={report.status}/></View>
          </View>

          <View style={{flexDirection:'row',justifyContent:'flex-end',marginBottom:10}}>
            <TouchableOpacity style={[rp4.printBtn,printing&&{opacity:.6}]} onPress={handlePrint} disabled={printing}>
              {printing?<ActivityIndicator size="small" color="#fff"/>:<><PrinterIcon size={13} color="#fff"/><Text style={rp4.printBtnText}>Print Trip Sheet</Text></>}
            </TouchableOpacity>
          </View>

          {/* Stage Table — stage numbers, app+POS merged into F/H */}
          {combinedStageRows.length > 0 && (
            <View style={{marginBottom:12}}>
              <View style={ts.tableHeader}>
                {['SS','ES','F','H','L','P','AMT'].map((h,i)=>(
                  <Text key={i} style={[ts.th, i===6&&{flex:2,textAlign:'right'}]}>{h}</Text>
                ))}
              </View>
              {combinedStageRows.map((rb, i) => (
                <View key={i} style={[ts.tableRow, i%2===0&&{backgroundColor:'#F7FAFC'}]}>
                  <Text style={ts.td} numberOfLines={1}>{rb.ss}</Text>
                  <Text style={ts.td} numberOfLines={1}>{rb.es}</Text>
                  <Text style={ts.td}>{rb.f > 0 ? rb.f : '-'}</Text>
                  <Text style={ts.td}>{rb.h > 0 ? rb.h : '-'}</Text>
                  <Text style={ts.td}>{rb.l > 0 ? rb.l : '0'}</Text>
                  <Text style={ts.td}>0</Text>
                  <Text style={[ts.td,{flex:2,textAlign:'right',color:'#00b7f3',fontWeight:'700'}]}>
                    {Number(rb.amt).toFixed(2)}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {/* Totals — app and POS combined, no separate lines */}
          <View style={ts.totalsBox}>
            <View style={ts.totalRow}><Text style={ts.totalKey}>FULL</Text><Text style={ts.totalVal}>{grandFull}</Text></View>
            {grandHalf > 0 && <View style={ts.totalRow}><Text style={ts.totalKey}>HALF</Text><Text style={[ts.totalVal,{color:'#FF9800'}]}>{grandHalf}</Text></View>}
            {grandFree > 0 && <View style={ts.totalRow}><Text style={ts.totalKey}>FREE</Text><Text style={[ts.totalVal,{color:'#4CAF50'}]}>{grandFree}</Text></View>}
            <View style={ts.totalRow}><Text style={ts.totalKey}>LUGG</Text><Text style={ts.totalVal}>{grandLuggageCnt}</Text></View>
            <View style={[ts.totalRow,{borderTopWidth:1,borderTopColor:'#ddd',marginTop:4,paddingTop:6}]}>
              <Text style={[ts.totalKey,{fontSize:15,fontWeight:'700'}]}>TRP TOTAL Rs.</Text>
              <Text style={[ts.totalVal,{fontSize:20,color:'#00b7f3',fontWeight:'900'}]}>{grandCollection.toFixed(2)}</Text>
            </View>
          </View>

          <StageFilter
            tripId={reportTrip}
            baseTickets={appSummary.tickets??0}
            baseCollection={appSummary.collection??0}
            posTix={tripPOSTix}
            direction={report.direction}
            onPrint={printStageReport}
            appBreakdown={appSummary.breakdown??[]}
          />
        </View>
      )}
    </View>
  );
};

// Trip Sheet screen styles
const ts = StyleSheet.create({
  headerBox:{backgroundColor:'#1a2332',borderRadius:10,padding:12,marginBottom:12,alignItems:'center'},
  headerTitle:{fontSize:20,fontWeight:'900',color:'#fff',letterSpacing:1},
  headerMeta:{fontSize:12,color:'#90CAF9',marginTop:4},
  metaGrid:{backgroundColor:'#F7FAFC',borderRadius:10,padding:10,marginBottom:10},
  metaRow:{flexDirection:'row',alignItems:'center',paddingVertical:5,borderBottomWidth:1,borderBottomColor:'#EEF2F7'},
  metaKey:{fontSize:12,color:'#888',fontWeight:'700',width:110,letterSpacing:.3},
  metaVal:{fontSize:13,color:'#1a2332',fontWeight:'600',flex:1},
  tableHeader:{flexDirection:'row',backgroundColor:'#1a2332',paddingVertical:8,paddingHorizontal:10,borderRadius:6,marginBottom:2},
  th:{flex:1,fontSize:11,fontWeight:'800',color:'#fff',textAlign:'center'},
  tableRow:{flexDirection:'row',paddingVertical:7,paddingHorizontal:10,borderRadius:4},
  td:{flex:1,fontSize:12,color:'#333',textAlign:'center'},
  totalsBox:{backgroundColor:'#F0F4F8',borderRadius:10,padding:12,marginTop:4},
  totalRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:4},
  totalKey:{fontSize:13,color:'#555',fontWeight:'700',letterSpacing:.5},
  totalVal:{fontSize:16,fontWeight:'800',color:'#1a2332'},
});

// ── Section 2: Status Report ──────────────────────────────────────────────────
const StatusReportSection = ({dashboard, posHook}: {dashboard:any; posHook:ReturnType<typeof usePOSTickets>}) => {
  const [appTickets,setAppTickets] = useState<Record<string,any>>({});
  const [appLoading,setAppLoading] = useState<Record<string,boolean>>({});
  const [printingStatus,setPrintingStatus] = useState<string|null>(null);
  const [expandedTrip,setExpandedTrip] = useState<string|null>(null);

  const recentTrips: any[] = dashboard?.recent_trips ?? [];
  const posByTrip = posHook.todayByTrip();

  const todayTripIds: string[] = recentTrips.filter((t:any)=>{
    const today=new Date().toDateString();
    return t.start_time && new Date(t.start_time).toDateString()===today;
  }).map((t:any)=>t.trip_id as string);

  const allTripIds = Array.from(new Set([...Object.keys(posByTrip), ...todayTripIds]));

  const backendTrip=(id:string)=>recentTrips.find((t:any)=>t.trip_id===id);

  const fetchAppTickets = async (tripId:string) => {
    if(appTickets[tripId]||appLoading[tripId]) return;
    setAppLoading(p=>({...p,[tripId]:true}));
    try{
      const r=await api.get(`/conductor/trip/${tripId}/report`);
      // Also fetch stop names so we can build stage codes for app tickets
      const reportData = r.data || {};
      // Enrich route_breakdown with stage codes
      const rawBreakdown: any[] = reportData.route_breakdown ?? [];
      setAppTickets(p=>({...p,[tripId]:reportData}));
    }
    catch{ setAppTickets(p=>({...p,[tripId]:{}})); }
    finally{ setAppLoading(p=>({...p,[tripId]:false})); }
  };

  // Combined sorted stage rows for a trip (app + POS merged, stage numbers)
  const getCombinedRows = (tripId: string) => {
    const posTix = posByTrip[tripId]||[];
    const appBreakdown = appTickets[tripId]?.route_breakdown||[];
    return buildCombinedStageRows(appBreakdown, posTix);
  };

  // ── STATUS REPORT PRINT ─────────────────────────────────────────────────
  const printStatusReport = async (tripId:string, idx:number) => {
    setPrintingStatus(tripId);
    try{
      const bt=backendTrip(tripId);
      const posTix=posByTrip[tripId]||[];
      const reportData=appTickets[tripId]||{};
      const summary=reportData?.summary;
      const busNum=posTix[0]?.bus_number??bt?.bus_number??'N/A';
      const wayBill=bt?.way_bill_number??bt?.waybill??bt?.way_bill??'—';
      const tripNum=bt?.trip_number??(idx+1);
      const firstT=posTix[0]?.issued_at??bt?.start_time;
      const dt=firstT?new Date(firstT):new Date();
      const dateStr=dt.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'2-digit'}).replace(/\//g,'/');
      const timeStr=dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
      const posTotal=posTix.reduce((s:number,t:any)=>s+t.fare,0);
      const posLuggCnt=posTix.reduce((s:number,t:any)=>s+(Number(t.luggage_amount??0)>0?1:0),0);
      const rawBackendTotal=Number(summary?.total_collection??bt?.collection??0);
      const appTotal=Math.max(0,rawBackendTotal-posTotal);
      const appFreeCnt=Number(summary?.total_free??0);
      const grandTotal=appTotal+posTotal;

      // Combined sorted stage rows
      const stages = getCombinedRows(tripId);
      const grandFull = stages.reduce((s, r) => s + r.f, 0);
      const grandHalf = stages.reduce((s, r) => s + r.h, 0);

      const tripsSoFar=allTripIds.slice(0,idx+1);
      const totColl=tripsSoFar.reduce((sum,tid)=>{
        const b=backendTrip(tid), pTix=posByTrip[tid]||[], pAmt=pTix.reduce((s:number,t:any)=>s+t.fare,0);
        const rSum=appTickets[tid]?.summary, rTot=Number(rSum?.total_collection??b?.collection??0);
        return sum+Math.max(0,rTot-pAmt)+pAmt;
      },0);

      const fmt=(n:number)=>n%1===0?`${n}.00`:n.toFixed(2);

      const p=new Printer(); const ready=await p.checkReady(); if(!ready){setPrintingStatus(null);return;}

      await p.text('SPS - ZYRAP', {textSize:22, align:'CENTER'});
      await p.text('STATUS REPORT', {textSize:26, align:'CENTER'});
      await p.text(printLR(`BUS:${busNum}`, `WB:${wayBill}`), {textSize:18});
      await p.text(`${dateStr}  ${timeStr}`, {textSize:18, align:'CENTER'});
      await p.text(`TRIP No. : ${tripNum}`, {textSize:22, align:'CENTER'});
      await p.text(DIVIDER);

      await p.text(printStageRow('SS','ES','F','H','L','P','AMT'), {textSize:18});
      await p.text(DIVIDER);

      // Combined stage rows with stage numbers, app+POS merged
      for (const s of stages) {
        await p.text(
          printStageRow(s.ss, s.es, String(s.f||'-'), String(s.h||'-'), String(s.l||0), '0', fmt(s.amt)),
          {textSize:17}
        );
      }
      if (stages.length === 0) await p.text('  (no stage data)', {textSize:17});

      await p.text(DIVIDER);
      await p.text(printLR('FULL :', String(grandFull)), {textSize:20});
      if (grandHalf > 0) await p.text(printLR('HALF :', String(grandHalf)), {textSize:20});
      if (appFreeCnt > 0) await p.text(printLR('FREE :', String(appFreeCnt)), {textSize:20});
      await p.text(printLR('LUGG :', String(posLuggCnt)), {textSize:20});
      await p.text(DIVIDER);
      await p.text(printLR('TRIP.COLL Rs.:', fmt(grandTotal)), {textSize:20});
      await p.text(printLR('TOT.COLL  Rs.:', fmt(totColl)), {textSize:20});
      await p.text(DIVIDER);
      await p.text('** Safe Journey **', {align:'CENTER'});
      await p.finish();
    } catch(e:any){Alert.alert('Print Error',e.message||'Unknown');}
    finally{setPrintingStatus(null);}
  };

  return (
    <View>
      <View style={rp4.sectionHeader}>
        <BarChart3 size={16} color="#1a2332"/>
        <Text style={rp4.sectionTitle}>Status Report</Text>
      </View>

      {allTripIds.length===0&&(
        <View style={rp4.emptyCard}>
          <BarChart3 size={36} color="#ccc"/>
          <Text style={{fontSize:14,color:'#bbb',marginTop:8}}>No trips today</Text>
        </View>
      )}

      {allTripIds.map((tripId,idx)=>{
        const bt=backendTrip(tripId);
        const posTix=posByTrip[tripId]||[];
        const posTotal=posTix.reduce((s:number,t:any)=>s+t.fare,0);
        const posCnt=posTix.reduce((s:number,t:any)=>s+t.ticket_count,0);
        const reportData=appTickets[tripId]||{};
        const summary=reportData?.summary;
        const rawBackendTotal=Number(summary?.total_collection??bt?.collection??0);
        const appTotal=Math.max(0,rawBackendTotal-posTotal);
        const grandTotal=posTotal+appTotal;
        const busNum=posTix[0]?.bus_number??bt?.bus_number??'N/A';
        const dir=posTix[0]?.direction??bt?.direction??'';
        const tripNum=bt?.trip_number??(idx+1);
        const firstT=posTix[0]?.issued_at??bt?.start_time;
        const wayBill=bt?.way_bill_number??bt?.waybill??bt?.way_bill??'—';
        const isOpen=expandedTrip===tripId;

        const appFreeCnt=Number(summary?.total_free??0);
        const posLuggCnt=posTix.reduce((s:number,t:any)=>s+(Number(t.luggage_amount??0)>0?1:0),0);

        // Combined stage rows (used in expanded view + for grand totals)
        const combinedRows = isOpen ? getCombinedRows(tripId) : [];
        const grandFull = isOpen ? combinedRows.reduce((s, r) => s + r.f, 0) : 0;
        const grandHalf = isOpen ? combinedRows.reduce((s, r) => s + r.h, 0) : 0;

        const tripsSoFar=allTripIds.slice(0,idx+1);
        const totColl=tripsSoFar.reduce((sum,tid)=>{
          const b=backendTrip(tid), pTix=posByTrip[tid]||[], pAmt=pTix.reduce((s:number,t:any)=>s+t.fare,0);
          const rSum=appTickets[tid]?.summary, rTot=Number(rSum?.total_collection??b?.collection??0);
          return sum+Math.max(0,rTot-pAmt)+pAmt;
        },0);

        // For collapsed view: use summary data from API
        const collapsedFull = Number(summary?.total_full??0) + posTix.filter((t:any)=>(t.ticket_type??'full')!=='half').reduce((s:number,t:any)=>s+Math.max(0,t.ticket_count-(Number(t.luggage_amount??0)>0?1:0)),0);
        const collapsedHalf = Number(summary?.total_half??0) + posTix.filter((t:any)=>t.ticket_type==='half').reduce((s:number,t:any)=>s+Math.max(0,t.ticket_count-(Number(t.luggage_amount??0)>0?1:0)),0);

        return (
          <View key={tripId} style={rp4.statusCard}>
            <View style={rp4.statusCardHeader}>
              <View style={{flex:1}}>
                <Text style={rp4.statusCardTitle}>BUS: {busNum}  ·  TRIP #{tripNum}</Text>
                <Text style={rp4.statusCardMeta}>WB: {wayBill}  ·  {dir.toUpperCase()}  ·  {firstT?formatTime(firstT):'—'}</Text>
              </View>
              <View style={{alignItems:'flex-end',gap:4}}>
                <Text style={rp4.statusCardAmt}>₹{grandTotal.toFixed(2)}</Text>
                <TouchableOpacity
                  style={[rp4.expandBtn]}
                  onPress={()=>{
                    const next=isOpen?null:tripId;
                    setExpandedTrip(next);
                    if(next) fetchAppTickets(next);
                  }}
                >
                  <Text style={{fontSize:11,color:'#00b7f3',fontWeight:'700'}}>{isOpen?'▲ Less':'▼ Detail'}</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={rp4.srCountsRow}>
              <View style={rp4.srCountChip}><Text style={rp4.srCountLabel}>FULL</Text><Text style={[rp4.srCountVal,{color:'#1a2332'}]}>{collapsedFull}</Text></View>
              {collapsedHalf>0&&<View style={rp4.srCountChip}><Text style={rp4.srCountLabel}>HALF</Text><Text style={[rp4.srCountVal,{color:'#E65100'}]}>{collapsedHalf}</Text></View>}
              {appFreeCnt>0&&<View style={rp4.srCountChip}><Text style={rp4.srCountLabel}>FREE</Text><Text style={[rp4.srCountVal,{color:'#4CAF50'}]}>{appFreeCnt}</Text></View>}
              <View style={rp4.srCountChip}><Text style={rp4.srCountLabel}>LUGG</Text><Text style={[rp4.srCountVal,{color:'#888'}]}>{posLuggCnt}</Text></View>
            </View>

            <View style={rp4.srCollRow}>
              <View style={{flex:1}}><Text style={rp4.srCollLabel}>TRIP.COLL Rs.</Text><Text style={rp4.srCollVal}>₹{grandTotal.toFixed(2)}</Text></View>
              <View style={rp4.srCollDivider}/>
              <View style={{flex:1,alignItems:'flex-end'}}><Text style={rp4.srCollLabel}>TOT.COLL Rs.</Text><Text style={[rp4.srCollVal,{color:'#00b7f3'}]}>₹{totColl.toFixed(2)}</Text></View>
            </View>

            {isOpen&&(
              <View style={{padding:10,borderTopWidth:1,borderTopColor:'#e0e0e0'}}>
                {appLoading[tripId]?(
                  <ActivityIndicator size="small" color="#1a2332" style={{marginVertical:8}}/>
                ):(
                  <>
                    {/* Combined stage table — stage numbers, app+POS in same F/H columns */}
                    <View style={rp4.srTableHdr}>
                      {['SS','ES','F','H','L','P','AMT'].map((h,i)=><Text key={i} style={[rp4.srTh,i===6&&{flex:2,textAlign:'right'}]}>{h}</Text>)}
                    </View>
                    {combinedRows.map((s,i)=>(
                      <View key={i} style={[rp4.srTr, i%2===0&&{backgroundColor:'#F0F4F8'}]}>
                        <Text style={rp4.srTd} numberOfLines={1}>{s.ss}</Text>
                        <Text style={rp4.srTd} numberOfLines={1}>{s.es}</Text>
                        <Text style={rp4.srTd}>{s.f > 0 ? s.f : '-'}</Text>
                        <Text style={rp4.srTd}>{s.h > 0 ? s.h : '-'}</Text>
                        <Text style={rp4.srTd}>{s.l > 0 ? s.l : '0'}</Text>
                        <Text style={rp4.srTd}>0</Text>
                        <Text style={[rp4.srTd,{flex:2,textAlign:'right',fontWeight:'700'}]}>{s.amt.toFixed(2)}</Text>
                      </View>
                    ))}
                    {combinedRows.length===0&&<Text style={{fontSize:11,color:'#aaa',textAlign:'center',paddingVertical:6}}>No stage data</Text>}
                    {/* Grand totals from combined rows */}
                    {(grandFull > 0 || grandHalf > 0) && (
                      <View style={{flexDirection:'row',gap:12,paddingTop:6,marginTop:4,borderTopWidth:1,borderTopColor:'#e0e0e0'}}>
                        <Text style={{fontSize:11,color:'#1a2332',fontWeight:'700'}}>F: {grandFull}</Text>
                        {grandHalf > 0 && <Text style={{fontSize:11,color:'#E65100',fontWeight:'700'}}>H: {grandHalf}</Text>}
                      </View>
                    )}
                  </>
                )}
              </View>
            )}

            <TouchableOpacity
              style={[rp4.srPrintBtn, printingStatus===tripId&&{opacity:.6}]}
              onPress={()=>printStatusReport(tripId,idx)}
              disabled={printingStatus===tripId}
            >
              {printingStatus===tripId?<ActivityIndicator size="small" color="#fff"/>:<><PrinterIcon size={13} color="#fff"/><Text style={rp4.srPrintBtnText}>Print Status Report</Text></>}
            </TouchableOpacity>
          </View>
        );
      })}
    </View>
  );
};

// ── Section 3: Collection Report ─────────────────────────────────────────────
const CollectionReportSection = ({dashboard, posHook}: {dashboard:any; posHook:ReturnType<typeof usePOSTickets>}) => {
  const [period,setPeriod] = useState('today');
  const [collection,setCollection] = useState<any>(null);
  const [collLoading,setCollLoading] = useState(false);
  const [expenses,setExpenses] = useState({diesel:'0',driver:'0',conductor:'0',tollgate:'0',pooja:'0',others:'0'});
  const [printing,setPrinting] = useState(false);

  useEffect(()=>{ fetchCol('today'); },[]);

  const fetchCol = async (p:string) => {
    setCollLoading(true);
    try{ const r=await api.get(`/conductor/collection/summary?period=${p}`); setCollection(r.data); }
    catch{} finally{setCollLoading(false);}
  };

  const recentTrips: any[] = dashboard?.recent_trips ?? [];
  const posByTrip = posHook.todayByTrip();

  const todayTripIds: string[] = recentTrips.filter((t:any)=>{
    const today=new Date().toDateString();
    return t.start_time && new Date(t.start_time).toDateString()===today;
  }).map((t:any)=>t.trip_id as string);
  const allTripIds = Array.from(new Set([...Object.keys(posByTrip), ...todayTripIds]));
  const backendTrip=(id:string)=>recentTrips.find((t:any)=>t.trip_id===id);

  const totalExpenses = Object.values(expenses).reduce((s,v)=>s+parseAmount(v),0);

  const tripRows = allTripIds.map((tripId,idx)=>{
    const bt=backendTrip(tripId);
    const posTix=posByTrip[tripId]||[];
    const posAmt=posTix.reduce((s:number,t:any)=>s+t.fare,0);
    const backendTotal=Number(bt?.collection??0);
    const grandAmt=Math.max(backendTotal, posAmt);
    return {
      trip: idx+1,
      route: bt?.route_name?.split(' ')[0]||'01',
      amount: grandAmt,
    };
  });
  const totalCollection = tripRows.reduce((s,r)=>s+r.amount,0);
  const netTotal = totalCollection - totalExpenses;

  const printCollectionReport = async () => {
    setPrinting(true);
    try{
      const now=new Date();
      const dateStr=now.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'2-digit'}).replace(/\//g,'/');
      const timeStr=now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
      const busNum=dashboard?.bus?.vehicle_number??dashboard?.active_trip?.bus_number??'N/A';
      const machineId='SPS-POS-01';
      const fmt=(n:number)=>n%1===0?`${n}.00`:n.toFixed(2);

      const p=new Printer(); const ready=await p.checkReady(); if(!ready){setPrinting(false);return;}
      await p.text('SPS - ZYRAP',{textSize:22,align:'CENTER'});
      await p.text('COLLECTION REPORT',{textSize:24,align:'CENTER'});
      await p.text(`${dateStr}   ${timeStr}`,{textSize:18,align:'CENTER'});
      await p.text(printLR('BUS NUMBER:', busNum),{textSize:18});
      await p.text(printLR('MACHINE ID:', machineId),{textSize:18});
      await p.text(DIVIDER);

      const tripHdr = 'TRIP   ROUTE      AMOUNT'.padEnd(PRINT_WIDTH);
      await p.text(tripHdr,{textSize:18});
      await p.text(DIVIDER);

      for(const row of tripRows){
        const tripStr = String(row.trip).padEnd(6);
        const routeStr = row.route.slice(0,10).padEnd(10);
        const amtStr = fmt(row.amount).padStart(8);
        await p.text(`${tripStr} ${routeStr}${amtStr}`,{textSize:18});
      }
      await p.text(DIVIDER);
      await p.text(printLR('TOTAL Rs. :', fmt(totalCollection)),{textSize:20});
      await p.text(DIVIDER);
      await p.text('EXPENSES',{textSize:22,align:'CENTER'});
      await p.text(DIVIDER);
      await p.text(printLR('DIESEL    :', fmt(parseAmount(expenses.diesel))),{textSize:18});
      await p.text(printLR('DRIVER    :', fmt(parseAmount(expenses.driver))),{textSize:18});
      await p.text(printLR('CONDUCTOR :', fmt(parseAmount(expenses.conductor))),{textSize:18});
      await p.text(printLR('TOLLGATE  :', fmt(parseAmount(expenses.tollgate))),{textSize:18});
      await p.text(printLR('POOJA     :', fmt(parseAmount(expenses.pooja))),{textSize:18});
      await p.text(printLR('OTHERS    :', fmt(parseAmount(expenses.others))),{textSize:18});
      await p.text(DIVIDER);
      await p.text(printLR('TOTAL Rs. :', fmt(totalExpenses)),{textSize:18});
      await p.text(DIVIDER);
      await p.text(printLR('NET TOTAL Rs. :', fmt(netTotal)),{textSize:22});
      await p.text(DIVIDER);
      await p.text('** Safe Journey **',{align:'CENTER'});
      await p.finish();
    } catch(e:any){Alert.alert('Print Error',e.message||'Unknown');}
    finally{setPrinting(false);}
  };

  const expenseFields: {key:keyof typeof expenses; label:string}[] = [
    {key:'diesel',   label:'DIESEL'},
    {key:'driver',   label:'DRIVER'},
    {key:'conductor',label:'CONDUCTOR'},
    {key:'tollgate', label:'TOLLGATE'},
    {key:'pooja',    label:'POOJA'},
    {key:'others',   label:'OTHERS'},
  ];

  return (
    <View>
      <View style={rp4.sectionHeader}>
        <DollarSign size={16} color="#1a2332"/>
        <Text style={rp4.sectionTitle}>Collection Report</Text>
      </View>

      <View style={rp4.receiptCard}>
        <Text style={rp4.receiptTitle}>COLLECTION REPORT</Text>
        <Text style={rp4.receiptMeta}>{new Date().toLocaleDateString('en-GB')}  {new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false})}</Text>
        <Text style={rp4.receiptMeta}>BUS: {dashboard?.bus?.vehicle_number??dashboard?.active_trip?.bus_number??'N/A'}</Text>
        <View style={rp4.receiptDivider}/>

        <View style={rp4.receiptTableRow}>
          <Text style={[rp4.receiptTh,{width:40}]}>TRIP</Text>
          <Text style={[rp4.receiptTh,{flex:1}]}>ROUTE</Text>
          <Text style={[rp4.receiptTh,{width:90,textAlign:'right'}]}>AMOUNT</Text>
        </View>
        <View style={rp4.receiptDivider}/>

        {tripRows.map((row,i)=>(
          <View key={i} style={rp4.receiptTableRow}>
            <Text style={[rp4.receiptTd,{width:40,fontWeight:'700'}]}>{row.trip}</Text>
            <Text style={[rp4.receiptTd,{flex:1}]}>{row.route}</Text>
            <Text style={[rp4.receiptTd,{width:90,textAlign:'right'}]}>{row.amount.toFixed(2)}</Text>
          </View>
        ))}
        {tripRows.length===0&&<Text style={{textAlign:'center',color:'#aaa',fontSize:12,paddingVertical:8}}>No trips today</Text>}

        <View style={rp4.receiptDivider}/>
        <View style={rp4.receiptTotalRow}>
          <Text style={rp4.receiptTotalLabel}>TOTAL Rs. :</Text>
          <Text style={rp4.receiptTotalVal}>{totalCollection.toFixed(2)}</Text>
        </View>
        <View style={rp4.receiptDivider}/>

        <Text style={[rp4.receiptTh,{textAlign:'center',marginBottom:6}]}>EXPENSES</Text>
        {expenseFields.map(({key,label})=>(
          <View key={key} style={rp4.expenseRow}>
            <Text style={rp4.expenseLabel}>{label}</Text>
            <Text style={rp4.expenseColon}>:</Text>
            <TextInput
              style={rp4.expenseInput}
              keyboardType="numeric"
              value={expenses[key]}
              onChangeText={v=>setExpenses(prev=>({...prev,[key]:v}))}
              placeholder="0.00"
              placeholderTextColor="#bbb"
            />
          </View>
        ))}
        <View style={rp4.receiptDivider}/>
        <View style={rp4.receiptTotalRow}>
          <Text style={rp4.receiptTotalLabel}>TOTAL Rs. :</Text>
          <Text style={rp4.receiptTotalVal}>{totalExpenses.toFixed(2)}</Text>
        </View>
        <View style={rp4.receiptDivider}/>
        <View style={rp4.receiptTotalRow}>
          <Text style={[rp4.receiptTotalLabel,{fontSize:15}]}>NET TOTAL Rs. :</Text>
          <Text style={[rp4.receiptTotalVal,{fontSize:20,color:'#00b7f3'}]}>{netTotal.toFixed(2)}</Text>
        </View>
      </View>

      <TouchableOpacity style={[rp4.printBtnLarge,printing&&{opacity:.6}]} onPress={printCollectionReport} disabled={printing}>
        {printing?<ActivityIndicator color="#fff"/>:<><PrinterIcon size={16} color="#fff"/><Text style={rp4.printBtnLargeText}>Print Collection Report</Text></>}
      </TouchableOpacity>

      <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:20,marginBottom:12}}>
        <Text style={sh.sectionTitle}>Collection History</Text>
        <View style={{flexDirection:'row',gap:4}}>
          {['today','week','month'].map(p=>(
            <TouchableOpacity key={p} style={[sh.periodTab,period===p&&sh.periodTabActive]} onPress={()=>{setPeriod(p);fetchCol(p);}}>
              <Text style={[sh.periodTabText,period===p&&sh.periodTabTextActive]}>{p.charAt(0).toUpperCase()+p.slice(1)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      {collLoading?<ActivityIndicator color="#00b7f3" style={{marginVertical:16}}/>:(
        <>
          <View style={{flexDirection:'row',marginBottom:16}}>
            {[{label:'Total',val:`₹${collection?.total||0}`},{label:'Trips',val:collection?.trips||0},{label:'Tickets',val:collection?.tickets||0}].map(i=>(
              <View key={i.label} style={{flex:1,alignItems:'center'}}>
                <Text style={{fontSize:20,fontWeight:'800',color:'#1a2332'}}>{i.val}</Text>
                <Text style={{fontSize:11,color:'#888',marginTop:2}}>{i.label}</Text>
              </View>
            ))}
          </View>
          {(collection?.daily?.length??0)>0&&(()=>{
            const max=Math.max(...collection.daily.map((d:any)=>d.collection),1);
            return (
              <View style={{flexDirection:'row',alignItems:'flex-end',height:110,gap:4,backgroundColor:'#F7FAFC',borderRadius:12,padding:10}}>
                {collection.daily.map((d:any,i:number)=>(
                  <View key={i} style={{flex:1,alignItems:'center',justifyContent:'flex-end'}}>
                    <Text style={{fontSize:7,color:'#888',marginBottom:2}}>₹{d.collection}</Text>
                    <View style={{width:'80%',backgroundColor:'#00b7f3',borderRadius:3,minHeight:4,height:Math.max(4,(d.collection/max)*75)}}/>
                    <Text style={{fontSize:7,color:'#aaa',marginTop:4}}>{d.date?.slice(5)}</Text>
                  </View>
                ))}
              </View>
            );
          })()}
        </>
      )}
    </View>
  );
};

const rp4 = StyleSheet.create({
  sectionHeader:{flexDirection:'row',alignItems:'center',gap:8,paddingVertical:10,paddingHorizontal:2,marginBottom:8,borderBottomWidth:1.5,borderBottomColor:'#1a2332'},
  sectionTitle:{fontSize:16,fontWeight:'900',color:'#1a2332',letterSpacing:.5},
  emptyCard:{alignItems:'center',padding:30,backgroundColor:'#F7FAFC',borderRadius:12,marginBottom:12},
  tripChip:{paddingHorizontal:12,paddingVertical:7,borderRadius:20,backgroundColor:'#F0F4F8',marginRight:8,borderWidth:1,borderColor:'#ddd'},
  tripChipActive:{backgroundColor:'#1a2332',borderColor:'#1a2332'},
  tripChipText:{fontSize:12,fontWeight:'600',color:'#666'},
  reportCard:{backgroundColor:'#fff',borderRadius:14,padding:14,borderWidth:1,borderColor:'#e0e0e0',elevation:2,marginBottom:8},
  printBtn:{flexDirection:'row',alignItems:'center',gap:5,backgroundColor:'#1a2332',paddingHorizontal:12,paddingVertical:7,borderRadius:10},
  printBtnText:{color:'#fff',fontSize:12,fontWeight:'700'},
  statusCard:{backgroundColor:'#fff',borderRadius:14,marginBottom:10,overflow:'hidden',borderWidth:1,borderColor:'#e0e0e0',elevation:2},
  statusCardHeader:{flexDirection:'row',alignItems:'flex-start',padding:12,backgroundColor:'#1a2332'},
  statusCardTitle:{fontSize:13,fontWeight:'800',color:'#fff'},
  statusCardMeta:{fontSize:11,color:'#90CAF9',marginTop:2},
  statusCardAmt:{fontSize:18,fontWeight:'900',color:'#00b7f3'},
  expandBtn:{paddingHorizontal:8,paddingVertical:4,backgroundColor:'#fff',borderRadius:8,marginTop:4},
  srCountsRow:{flexDirection:'row',paddingHorizontal:10,paddingVertical:8,gap:6,flexWrap:'wrap',borderBottomWidth:1,borderBottomColor:'#f0f0f0'},
  srCountChip:{flexDirection:'row',alignItems:'center',gap:4,backgroundColor:'#F0F4F8',paddingHorizontal:10,paddingVertical:5,borderRadius:8},
  srCountLabel:{fontSize:10,color:'#888',fontWeight:'700'},
  srCountVal:{fontSize:14,fontWeight:'900',marginLeft:4},
  srCollRow:{flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingVertical:10,borderBottomWidth:1,borderBottomColor:'#e8e8e8',backgroundColor:'#F7FAFC'},
  srCollDivider:{width:1,backgroundColor:'#e0e0e0',height:32,marginHorizontal:8},
  srCollLabel:{fontSize:10,color:'#888',fontWeight:'700'},
  srCollVal:{fontSize:16,fontWeight:'900',color:'#1a2332',marginTop:2},
  srTableHdr:{flexDirection:'row',backgroundColor:'#E8EDF2',paddingVertical:6,paddingHorizontal:8},
  srTh:{flex:1,fontSize:9,fontWeight:'800',color:'#1a2332',textAlign:'center'},
  srTr:{flexDirection:'row',paddingVertical:6,paddingHorizontal:8},
  srTd:{flex:1,fontSize:10,color:'#333',textAlign:'center'},
  srPrintBtn:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6,margin:10,backgroundColor:'#1a2332',paddingVertical:10,borderRadius:9},
  srPrintBtnText:{color:'#fff',fontSize:13,fontWeight:'700'},
  receiptCard:{backgroundColor:'#fff',borderRadius:14,padding:16,borderWidth:1.5,borderColor:'#1a2332',marginBottom:12},
  receiptTitle:{fontSize:18,fontWeight:'900',color:'#1a2332',textAlign:'center',letterSpacing:1,marginBottom:4},
  receiptMeta:{fontSize:12,color:'#444',textAlign:'center',marginBottom:2},
  receiptDivider:{height:1,backgroundColor:'#ddd',marginVertical:8,borderStyle:'dashed'},
  receiptTableRow:{flexDirection:'row',alignItems:'center',paddingVertical:5},
  receiptTh:{fontSize:11,fontWeight:'800',color:'#1a2332',letterSpacing:.5},
  receiptTd:{fontSize:13,color:'#333'},
  receiptTotalRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:2},
  receiptTotalLabel:{fontSize:13,fontWeight:'700',color:'#1a2332'},
  receiptTotalVal:{fontSize:16,fontWeight:'900',color:'#1a2332'},
  expenseRow:{flexDirection:'row',alignItems:'center',paddingVertical:4},
  expenseLabel:{width:100,fontSize:13,color:'#444',fontWeight:'600'},
  expenseColon:{width:20,fontSize:13,color:'#888',textAlign:'center'},
  expenseInput:{flex:1,fontSize:13,color:'#1a2332',borderBottomWidth:1,borderBottomColor:'#ddd',paddingVertical:2,paddingHorizontal:4,textAlign:'right'},
  printBtnLarge:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8,backgroundColor:'#1a2332',paddingVertical:14,borderRadius:12,marginBottom:4},
  printBtnLargeText:{color:'#fff',fontSize:15,fontWeight:'700'},
});

const ReportTab = ({dashboard,user,posHook}:{dashboard:any;user:any;posHook:ReturnType<typeof usePOSTickets>}) => {
  const [activeSection,setActiveSection] = useState<'trip'|'status'|'collection'>('trip');

  const stats = dashboard?.today_stats||{};
  const posSummary = posHook.todaySummary();
  const appOnlyCollection = Math.max(0,(stats.total_collection||0)-posSummary.total);
  const appOnlyTickets    = Math.max(0,(stats.tickets_sold||0)-posSummary.rows);
  const grandTodayTotal   = appOnlyCollection + posSummary.total;
  const grandTodayTickets = appOnlyTickets    + posSummary.count;

  const SECTIONS = [
    {key:'trip'      as const, label:'Trip Sheet',    Icon:Receipt},
    {key:'status'    as const, label:'Status Report', Icon:BarChart3},
    {key:'collection'as const, label:'Collection',    Icon:DollarSign},
  ];

  return (
    <ScrollView style={{flex:1}} contentContainerStyle={{padding:16,paddingBottom:40}} showsVerticalScrollIndicator={false}>
      {user&&(
        <View style={sh.conductorCard}>
          <View style={sh.conductorAvatar}><BadgeCheck size={26} color="#00b7f3"/></View>
          <View>
            <Text style={{fontSize:16,fontWeight:'700',color:'#1a2332'}}>{user.name||'Conductor'}</Text>
            <Text style={{fontSize:12,color:'#888',marginTop:2}}>ID: {user.conductor_id||user.id}{dashboard?.bus?` · 🚌 ${dashboard.bus.vehicle_number}`:''}</Text>
          </View>
        </View>
      )}

      <View style={sh.statsGrid}>
        {[
          {Icon:Bus,         label:'Trips',       val:stats.trips_completed??0,          color:'#9C27B0'},
          {Icon:Ticket,      label:'App Tickets',  val:appOnlyTickets,                    color:'#00b7f3'},
          {Icon:PrinterIcon, label:'POS Tickets',  val:posSummary.count,                 color:'#7B1FA2'},
          {Icon:TrendingUp,  label:'Collection',   val:`₹${grandTodayTotal.toFixed(0)}`, color:'#4CAF50'},
        ].map(i=>(
          <View key={i.label} style={sh.statCard}>
            <View style={[sh.statIconBg,{backgroundColor:i.color+'18'}]}><i.Icon size={20} color={i.color}/></View>
            <Text style={[sh.statVal,{color:i.color}]}>{i.val}</Text>
            <Text style={sh.statLabel}>{i.label}</Text>
          </View>
        ))}
      </View>

      <View style={rpt.sectionTabs}>
        {SECTIONS.map(s=>(
          <TouchableOpacity
            key={s.key}
            style={[rpt.sectionTab, activeSection===s.key&&rpt.sectionTabActive]}
            onPress={()=>setActiveSection(s.key)}
          >
            <s.Icon size={14} color={activeSection===s.key?'#fff':'#666'}/>
            <Text style={[rpt.sectionTabText, activeSection===s.key&&{color:'#fff'}]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{marginTop:4}}>
        {activeSection==='trip'       && <TripReportSection   dashboard={dashboard} posHook={posHook}/>}
        {activeSection==='status'     && <StatusReportSection  dashboard={dashboard} posHook={posHook}/>}
        {activeSection==='collection' && <CollectionReportSection dashboard={dashboard} posHook={posHook}/>}
      </View>
    </ScrollView>
  );
};

const rpt = StyleSheet.create({
  sectionTabs:{flexDirection:'row',gap:6,marginTop:16,marginBottom:8,flexWrap:'wrap'},
  sectionTab:{flexDirection:'row',alignItems:'center',gap:5,paddingHorizontal:12,paddingVertical:8,borderRadius:20,backgroundColor:'#F0F4F8',borderWidth:1,borderColor:'#ddd'},
  sectionTabActive:{backgroundColor:'#1a2332',borderColor:'#1a2332'},
  sectionTabText:{fontSize:12,fontWeight:'600',color:'#666'},
});

// ─────────────────────────────────────────────────────────────────────────────
// Trip number helpers
// ─────────────────────────────────────────────────────────────────────────────
const IST_OFFSET_MINUTES = 330;
const getIstDateKey = (d: Date = new Date()): string => {
  const istMs = d.getTime() + IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
};
const getTripNumberKey = (busId: string): string => `trip_num_${busId}_${getIstDateKey()}`;
const getIstDayRangeIso = (d: Date = new Date()): {startIso: string; endIso: string} => {
  const offsetMs = IST_OFFSET_MINUTES * 60 * 1000;
  const istNow = new Date(d.getTime() + offsetMs);
  const y = istNow.getUTCFullYear(), m = istNow.getUTCMonth(), day = istNow.getUTCDate();
  const startUtc = new Date(Date.UTC(y, m, day, 0, 0, 0) - offsetMs);
  const endUtc = new Date(Date.UTC(y, m, day + 1, 0, 0, 0) - offsetMs);
  return {startIso: startUtc.toISOString(), endIso: endUtc.toISOString()};
};
const loadTripNumber = async (busId: string): Promise<number> => {
  const fallback = async (): Promise<number> => {
    try { const val = await AsyncStorage.getItem(getTripNumberKey(busId)); return val ? parseInt(val, 10) : 0; }
    catch { return 0; }
  };
  try {
    const { startIso, endIso } = getIstDayRangeIso();
    const { data, error } = await supabase.from('trips').select('trip_number').eq('bus_id', busId).not('trip_number', 'is', null).gte('start_time', startIso).lt('start_time', endIso).order('trip_number', { ascending: false }).limit(1);
    if (error) throw error;
    const num = Number(data?.[0]?.trip_number ?? 0);
    return Number.isFinite(num) && num > 0 ? num : await fallback();
  } catch { return fallback(); }
};
const incrementTripNumber = async (busId: string, tripId?: string | null): Promise<number> => {
  const { startIso, endIso } = getIstDayRangeIso();
  let latest = 0;
  try {
    const { data, error } = await supabase.from('trips').select('trip_number').eq('bus_id', busId).not('trip_number', 'is', null).gte('start_time', startIso).lt('start_time', endIso).order('trip_number', { ascending: false }).limit(1);
    if (error) throw error;
    const v = Number(data?.[0]?.trip_number ?? 0);
    latest = Number.isFinite(v) ? v : 0;
  } catch {
    try { const val = await AsyncStorage.getItem(getTripNumberKey(busId)); latest = val ? parseInt(val, 10) : 0; }
    catch { latest = 0; }
  }
  const nextNum = latest + 1;
  if (tripId) {
    try { const { error } = await supabase.from('trips').update({ trip_number: nextNum }).eq('id', tripId); if (error) console.warn('[TripNumber] DB update failed:', error.message); }
    catch (e) { console.warn('[TripNumber] Supabase update threw:', e); }
  }
  try { await AsyncStorage.setItem(getTripNumberKey(busId), String(nextNum)); }
  catch { /* ignore */ }
  return nextNum;
};

// ─────────────────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────────────────
const POSScreen = ({user,onLogout}:{user:any;onLogout?:()=>void}) => {
  const [activeTab,setActiveTab]=useState('ticket');
  const [dashboard,setDashboard]=useState<any>(null);
  const [dashLoading,setDashLoading]=useState(true);
  const [verifyingTicket,setVerifyingTicket]=useState<string|null>(null);
  const [accessToken,setAccessToken]=useState<string|null>(null);
  const [localTripNumber,setLocalTripNumber]=useState<number>(0);
  const posHook=usePOSTickets();

  useEffect(()=>{AsyncStorage.getItem('access_token').then(t=>setAccessToken(t)).catch(()=>{});},[]);
  const {pendingRequests,clearTicket}=useVerificationRealtime(dashboard?.active_trip?.trip_id,dashboard?.active_trip?.status);
  useEffect(()=>{fetchDashboard();},[]);

  useEffect(() => {
    const counterBusId = dashboard?.active_trip?.bus_id ?? dashboard?.bus?.id;
    if (!counterBusId) return;
    let cancelled = false;
    const offsetMs = IST_OFFSET_MINUTES * 60 * 1000;
    const nowIst = new Date(Date.now() + offsetMs);
    const y = nowIst.getUTCFullYear(), m = nowIst.getUTCMonth(), day = nowIst.getUTCDate();
    const nextMidnightUtc = new Date(Date.UTC(y, m, day + 1, 0, 0, 0) - offsetMs);
    const delay = Math.max(0, nextMidnightUtc.getTime() - Date.now());
    const t = setTimeout(async () => {
      if (cancelled) return;
      const num = await loadTripNumber(counterBusId);
      if (!cancelled) setLocalTripNumber(num);
    }, delay);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dashboard?.active_trip?.bus_id, dashboard?.bus?.id]);

  const fetchDashboard=async()=>{
    try{
      const r=await api.get('/conductor/dashboard');
      setDashboard(r.data);
      const busId = r.data?.active_trip?.bus_id ?? r.data?.bus?.id;
      if(busId){ const num = await loadTripNumber(busId); setLocalTripNumber(num); }
    }catch(e){console.error(e);}finally{setDashLoading(false);}
  };

  const handleTripStarted = async (started?: {direction:string;route_name?:string;start_time:string}) => {
    try {
      if (started) {
        setDashboard((prev:any)=>{
          if (!prev || prev?.active_trip?.trip_id) return prev;
          return { ...prev, active_trip: { ...(prev.active_trip || {}), trip_id: null, route_name: started.route_name || prev?.active_trip?.route_name || '', direction: started.direction, start_time: started.start_time, status: 'running', bus_number: prev?.bus?.vehicle_number ?? prev?.active_trip?.bus_number, }, };
        });
      }
      let dash:any = null;
      for (let i = 0; i < 6; i++) {
        const r = await api.get('/conductor/dashboard'); dash = r.data;
        if (dash?.active_trip?.trip_id) break;
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 700));
      }
      if (!dash) return;
      const busId = dash?.active_trip?.bus_id ?? dash?.bus?.id;
      const tripId = dash?.active_trip?.trip_id ?? dash?.active_trip?.id ?? null;
      let nextNum: number | null = null;
      if (busId) {
        const existingTripNumber = Number(dash?.active_trip?.trip_number ?? 0);
        if (Number.isFinite(existingTripNumber) && existingTripNumber > 0) { setLocalTripNumber(existingTripNumber); }
        else { nextNum = await incrementTripNumber(busId, tripId); setLocalTripNumber(nextNum); }
      }
      setDashboard(nextNum != null && dash?.active_trip ? {...dash, active_trip: {...dash.active_trip, trip_number: nextNum}} : dash);
    } catch(e){ console.error(e); } finally { setDashLoading(false); }
  };

  const handleVerify=async(id:string)=>{
    setVerifyingTicket(id);
    try{await api.post(`/conductor/ticket/${id}/verify`);clearTicket(id);showToast('Ticket verified! ✓');fetchDashboard();}
    catch(e:any){Alert.alert('Error',e?.response?.data?.error||'Could not verify ticket.');}
    finally{setVerifyingTicket(null);}
  };

  const at=dashboard?.active_trip;
  const displayTripNumber = Number(localTripNumber ?? 0) || Number(at?.trip_number ?? 0) || 0;
  const busNum: string = at?.bus_number ?? at?.vehicle_number ?? dashboard?.bus?.vehicle_number ?? user?.bus_number ?? 'N/A';

  if(dashLoading)return(
    <SafeAreaView style={{flex:1,backgroundColor:'#F0F4F8',justifyContent:'center',alignItems:'center'}}>
      <ActivityIndicator size="large" color="#00b7f3"/><Text style={{marginTop:12,color:'#888'}}>Loading…</Text>
    </SafeAreaView>
  );
  
  return (
    <SafeAreaView style={{flex:1,backgroundColor:'#F0F4F8'}}>
      <View style={sh.topBar}>
        <View>
          <View style={sh.conductorBadge}><BadgeCheck size={11} color="#fff"/><Text style={sh.conductorBadgeText}>CONDUCTOR</Text></View>
          <View style={{flexDirection:'row',alignItems:'center',gap:6}}>
            <Text style={sh.topBarTitle}>BusPOS</Text>
            {displayTripNumber>0&&(
              <View style={sh.tripNumBadge}>
                <Text style={sh.tripNumText}>Trip #{displayTripNumber}</Text>
              </View>
            )}
          </View>
        </View>
        <View style={{flexDirection:'row',alignItems:'center',gap:10}}>
          {pendingRequests.length>0&&(
            <TouchableOpacity onPress={()=>setActiveTab('trip')} style={sh.pendingBell}>
              <Bell size={20} color="#f57c00"/><View style={sh.bellBadge}><Text style={sh.bellBadgeText}>{pendingRequests.length}</Text></View>
            </TouchableOpacity>
          )}
          {posHook.todaySummary().unsynced > 0 && (
            <TouchableOpacity onPress={() => posHook.syncPending()} style={sh.unsyncedBadge}>
              {posHook.syncing?<ActivityIndicator size="small" color="#F57F17"/>:<Text style={sh.unsyncedText}>⬆ {posHook.todaySummary().unsynced}</Text>}
            </TouchableOpacity>
          )}
          {busNum!=='N/A'&&<Text style={{fontSize:12,color:'#888'}}>🚌 {busNum}</Text>}
          {onLogout&&<TouchableOpacity onPress={onLogout} style={{padding:6}}><LogOut size={20} color="#999"/></TouchableOpacity>}
        </View>
      </View>

      <View style={{flex:1}}>
        {activeTab==='ticket'&&<TicketTab activeTrip={at} user={user} busNumber={busNum} onTicketIssued={posHook.saveTicket} tripNumber={displayTripNumber}/>}
        {activeTab==='trip'  &&<TripTab dashboard={dashboard} onRefresh={handleTripStarted} pendingRequests={pendingRequests} verifyingTicket={verifyingTicket} onVerifyTicket={handleVerify} tripNumber={displayTripNumber} posHook={posHook}/>}
        {activeTab==='riders'&&<RidersTab activeTrip={at} pendingRequests={pendingRequests} onVerifyTicket={handleVerify} verifyingTicket={verifyingTicket} posTickets={posHook.tickets}/>}
        {activeTab==='report'&&<ReportTab dashboard={dashboard} user={user} posHook={posHook}/>}
      </View>

      <View style={sh.tabBar}>
        {TABS.map(tab=>{
          const isActive=activeTab===tab.key;
          const badge=tab.key==='trip'&&pendingRequests.length>0;
          return(
            <TouchableOpacity key={tab.key} style={sh.tabItem} onPress={()=>setActiveTab(tab.key)} activeOpacity={.7}>
              <View style={[sh.tabIconWrap,isActive&&sh.tabIconWrapActive]}>
                <tab.Icon size={22} color={isActive?'#00b7f3':'#aaa'}/>
                {badge&&<View style={sh.tabBadge}><Text style={sh.tabBadgeText}>{pendingRequests.length}</Text></View>}
              </View>
              <Text style={[sh.tabLabel,isActive&&sh.tabLabelActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared styles
// ─────────────────────────────────────────────────────────────────────────────
const sh=StyleSheet.create({
  topBar:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:16,paddingTop:4,paddingBottom:8},
  conductorBadge:{flexDirection:'row',alignItems:'center',backgroundColor:'#00b7f3',paddingHorizontal:7,paddingVertical:2,borderRadius:10,alignSelf:'flex-start',marginBottom:2,gap:3},
  conductorBadgeText:{color:'#fff',fontSize:9,fontWeight:'800',letterSpacing:1},
  topBarTitle:{fontSize:22,fontWeight:'900',color:'#1a2332'},
  tripNumBadge:{backgroundColor:'#E3F2FD',paddingHorizontal:8,paddingVertical:2,borderRadius:8,borderWidth:1,borderColor:'#90CAF9'},
  tripNumText:{fontSize:11,color:'#1565C0',fontWeight:'700'},
  tabBar:{flexDirection:'row',backgroundColor:'#fff',borderTopWidth:1,borderTopColor:'#eee',paddingBottom:Platform.OS==='ios'?16:6,paddingTop:6,elevation:10},
  tabItem:{flex:1,alignItems:'center'},
  tabIconWrap:{padding:6,borderRadius:12,position:'relative'},
  tabIconWrapActive:{backgroundColor:'#E8F7FF'},
  tabLabel:{fontSize:10,color:'#aaa',fontWeight:'600',marginTop:1},
  tabLabelActive:{color:'#00b7f3'},
  tabBadge:{position:'absolute',top:2,right:2,minWidth:14,height:14,borderRadius:7,backgroundColor:'#f57c00',justifyContent:'center',alignItems:'center',paddingHorizontal:2},
  tabBadgeText:{color:'#fff',fontSize:8,fontWeight:'800'},
  unsyncedBadge:{flexDirection:'row',alignItems:'center',backgroundColor:'#FFF8E1',paddingHorizontal:8,paddingVertical:4,borderRadius:10,borderWidth:1,borderColor:'#FFE082'},
  unsyncedText:{fontSize:11,color:'#F57F17',fontWeight:'700'},
  pendingBell:{position:'relative',padding:4},
  bellBadge:{position:'absolute',top:0,right:0,minWidth:16,height:16,borderRadius:8,backgroundColor:'#f57c00',justifyContent:'center',alignItems:'center',paddingHorizontal:3},
  bellBadgeText:{color:'#fff',fontSize:9,fontWeight:'800'},
  pendingSection:{backgroundColor:'#FFF8F0',borderRadius:14,padding:12,marginBottom:10,borderWidth:1.5,borderColor:'#f57c00'},
  pendingSectionTitle:{fontSize:14,fontWeight:'800',color:'#f57c00'},
  pendingCountBadge:{backgroundColor:'#f57c00',borderRadius:9,minWidth:20,height:20,justifyContent:'center',alignItems:'center',paddingHorizontal:5},
  pendingCountText:{color:'#fff',fontSize:10,fontWeight:'800'},
  pendingRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',backgroundColor:'#fff',borderRadius:10,padding:11,marginBottom:8,borderWidth:1.5,borderColor:'#ffcc80'},
  pendingLeft:{flexDirection:'row',alignItems:'center',flex:1,marginRight:10,gap:10},
  pendingIconWrap:{width:34,height:34,borderRadius:17,backgroundColor:'#fff3e0',justifyContent:'center',alignItems:'center'},
  pendingRoute:{fontSize:13,fontWeight:'700',color:'#1a2332'},
  pendingMeta:{fontSize:11,color:'#888',marginTop:2},
  pendingVerifyBtn:{flexDirection:'row',alignItems:'center',gap:4,backgroundColor:'#4CAF50',paddingHorizontal:12,paddingVertical:8,borderRadius:9},
  pendingVerifyBtnText:{color:'#fff',fontSize:12,fontWeight:'800'},
  card:{backgroundColor:'#fff',borderRadius:16,padding:16,elevation:2,marginBottom:6},
  inlineStats:{flexDirection:'row',backgroundColor:'#F7FAFC',borderRadius:10,padding:11,marginBottom:12},
  inlineStat:{flexDirection:'row',alignItems:'center',flex:1,justifyContent:'center',gap:4},
  inlineStatVal:{fontSize:15,fontWeight:'700',color:'#00b7f3'},
  inlineStatLabel:{fontSize:11,color:'#888'},
  inlineStatDivider:{width:1,backgroundColor:'#e0e0e0',marginHorizontal:6},
  tripActions:{flexDirection:'row',gap:8,flexWrap:'wrap'},
  tripAction:{flex:1,minWidth:70,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:4,paddingVertical:10,borderRadius:10},
  tripActionText:{fontSize:12,fontWeight:'600'},
  newTripBtn:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6,marginTop:8,paddingVertical:10,borderRadius:10,borderWidth:1.5,borderColor:'#00b7f3',borderStyle:'dashed',backgroundColor:'#F0FAFF'},
  recentTripRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:12,borderBottomWidth:1,borderBottomColor:'#F0F4F8'},
  recentTripRoute:{fontSize:14,fontWeight:'600',color:'#1a2332'},
  statusBadge:{flexDirection:'row',alignItems:'center',gap:3,paddingHorizontal:7,paddingVertical:3,borderRadius:10},
  statusText:{fontSize:10,fontWeight:'700'},
  modalOverlay:{flex:1,backgroundColor:'rgba(0,0,0,0.5)',justifyContent:'flex-end'},
  bottomSheet:{backgroundColor:'#fff',borderTopLeftRadius:22,borderTopRightRadius:22,padding:20,maxHeight:'88%'},
  sheetHandle:{width:40,height:4,backgroundColor:'#ddd',borderRadius:2,alignSelf:'center',marginBottom:14},
  modalHeader:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:14},
  modalTitle:{fontSize:18,fontWeight:'800',color:'#1a2332'},
  reportRoute:{fontSize:20,fontWeight:'700',color:'#1a2332',marginBottom:6},
  summaryRow:{flexDirection:'row',gap:8,marginBottom:12,flexWrap:'wrap'},
  summaryCard:{flex:1,minWidth:70,backgroundColor:'#F7FAFC',borderRadius:10,padding:10,alignItems:'center'},
  summaryNum:{fontSize:18,fontWeight:'800',color:'#1a2332'},
  summaryLabel:{fontSize:10,color:'#888',marginTop:2},
  tableHeader:{flexDirection:'row',backgroundColor:'#1a2332',borderRadius:8,paddingVertical:7,paddingHorizontal:10,marginBottom:2},
  th:{flex:1,fontSize:10,fontWeight:'700',color:'#fff',textAlign:'center'},
  tableRow:{flexDirection:'row',paddingVertical:7,paddingHorizontal:10,borderRadius:4},
  td:{flex:1,fontSize:11,color:'#333',textAlign:'center'},
  inputLabel:{fontSize:13,fontWeight:'600',color:'#444',marginBottom:8},
  routeOption:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:11,paddingHorizontal:14,borderRadius:10,borderWidth:1.5,borderColor:'#e0e0e0',marginBottom:8,backgroundColor:'#FAFAFA'},
  routeOptionSelected:{borderColor:'#00b7f3',backgroundColor:'#F0FAFF'},
  routeOptionText:{flex:1,fontSize:14,color:'#333'},
  dirRow:{flexDirection:'row',gap:10,marginBottom:20},
  dirBtn:{flex:1,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6,paddingVertical:10,borderRadius:10,borderWidth:1.5,borderColor:'#e0e0e0',backgroundColor:'#FAFAFA'},
  dirBtnActive:{backgroundColor:'#00b7f3',borderColor:'#00b7f3'},
  dirBtnText:{fontSize:13,color:'#666',fontWeight:'600'},
  primaryBtn:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8,backgroundColor:'#00b7f3',paddingVertical:14,borderRadius:12},
  primaryBtnText:{color:'#fff',fontSize:16,fontWeight:'700'},
  cancelBtn:{flex:1,backgroundColor:'#f0f0f0',paddingVertical:14,borderRadius:12,alignItems:'center'},
  cancelBtnText:{fontSize:15,color:'#666',fontWeight:'600'},
  emptyNote:{fontSize:14,color:'#aaa',marginTop:8,textAlign:'center'},
  passengerCard:{marginBottom:8,borderRadius:12,backgroundColor:'#fff',elevation:1,overflow:'hidden'},
  passengerCardPending:{borderWidth:1.5,borderColor:'#f57c00',backgroundColor:'#fff8f0'},
  passengerAvatar:{width:36,height:36,borderRadius:18,backgroundColor:'#E8F4FD',justifyContent:'center',alignItems:'center'},
  pendingPill:{flexDirection:'row',alignItems:'center',gap:4,backgroundColor:'#f57c00',paddingHorizontal:10,paddingVertical:4},
  pendingPillText:{color:'#fff',fontSize:10,fontWeight:'800',letterSpacing:.5},
  verifyBtn:{backgroundColor:'#4CAF50',paddingHorizontal:12,paddingVertical:7,borderRadius:8},
  conductorCard:{flexDirection:'row',alignItems:'center',gap:14,backgroundColor:'#fff',borderRadius:14,padding:16,marginBottom:16,elevation:1},
  conductorAvatar:{width:52,height:52,borderRadius:26,backgroundColor:'#E8F7FF',justifyContent:'center',alignItems:'center'},
  statsGrid:{flexDirection:'row',flexWrap:'wrap',gap:10},
  statCard:{flex:1,minWidth:'45%',backgroundColor:'#F7FAFC',borderRadius:12,padding:14,alignItems:'center'},
  statIconBg:{width:38,height:38,borderRadius:19,justifyContent:'center',alignItems:'center'},
  statVal:{fontSize:20,fontWeight:'800',marginTop:6},
  statLabel:{fontSize:11,color:'#888',marginTop:2},
  sectionTitle:{fontSize:15,fontWeight:'700',color:'#1a2332',marginBottom:10},
  periodTab:{paddingHorizontal:10,paddingVertical:5,borderRadius:14,backgroundColor:'#F0F4F8'},
  periodTabActive:{backgroundColor:'#00b7f3'},
  periodTabText:{fontSize:11,color:'#666',fontWeight:'600'},
  periodTabTextActive:{color:'#fff'},
});

const tk=StyleSheet.create({
  scrollContent:{paddingTop:8},
  activePill:{flexDirection:'row',alignItems:'center',gap:8,marginHorizontal:16,marginBottom:8,backgroundColor:'#E8F5E9',borderRadius:20,paddingHorizontal:14,paddingVertical:7,alignSelf:'flex-start'},
  activePillText:{fontSize:12,color:'#2E7D32',fontWeight:'600'},
  noTripPill:{flexDirection:'row',alignItems:'center',gap:8,marginHorizontal:16,marginBottom:8,backgroundColor:'#FFF8E1',borderRadius:20,paddingHorizontal:14,paddingVertical:7,alignSelf:'flex-start'},
  noTripPillText:{fontSize:12,color:'#F57F17',fontWeight:'600'},
  routeBanner:{flexDirection:'row',alignItems:'center',gap:8,marginHorizontal:16,marginBottom:6,backgroundColor:'#e6f7fd',borderRadius:10,paddingHorizontal:14,paddingVertical:8,borderWidth:1,borderColor:'#b3ecf7'},
  routeBannerText:{fontSize:14,color:'#00b7f3',fontWeight:'600',flex:1},
  busPill:{flexDirection:'row',alignItems:'center',gap:6,marginHorizontal:16,marginBottom:8,backgroundColor:'#E3F2FD',borderRadius:20,paddingHorizontal:14,paddingVertical:7,alignSelf:'flex-start'},
  busPillText:{fontSize:12,color:'#1565C0',fontWeight:'600'},
  dirErr:{flexDirection:'row',alignItems:'flex-start',gap:8,backgroundColor:'#FFEBEE',borderRadius:10,padding:10,marginBottom:12,borderWidth:1,borderColor:'#FFCDD2'},
  dirErrText:{fontSize:13,color:'#C62828',flex:1,lineHeight:18},
  ticketCard:{marginHorizontal:16,marginBottom:16,backgroundColor:'#fff',borderRadius:12,padding:14,borderWidth:1,borderColor:'#e7e7e7'},
  startTripPrompt:{alignItems:'center',justifyContent:'center',paddingVertical:18,paddingHorizontal:8},
  startTripPromptTitle:{fontSize:18,fontWeight:'700',color:'#1a2332',marginTop:8},
  startTripPromptText:{fontSize:13,color:'#6B7280',textAlign:'center',marginTop:6,lineHeight:18},
  tripSelectorBar:{flexDirection:'row',alignItems:'center',backgroundColor:'#F1F1F3',borderRadius:18,paddingVertical:10,paddingHorizontal:10,marginBottom:12},
  tripSide:{flex:1,flexDirection:'row',alignItems:'center',gap:6,minWidth:0},
  tripSideCol:{flex:1,minWidth:0},
  tripSideHint:{fontSize:11,color:'#6B7280',fontWeight:'600'},
  tripSideText:{fontSize:15,fontWeight:'700',color:'#374151'},
  swapBtn:{width:36,height:36,borderRadius:18,backgroundColor:'#fff',borderWidth:1,borderColor:'#d8d8dc',justifyContent:'center',alignItems:'center',marginHorizontal:10},
  fieldLabel:{fontSize:14,fontWeight:'600',color:'#333',marginBottom:6,marginTop:6},
  fieldInput:{backgroundColor:'#f8f8f8',borderRadius:6,borderWidth:1,borderColor:'#ddd',paddingHorizontal:10,paddingVertical:10,marginBottom:8,color:'#1a1a1a'},
  fieldInputText:{fontSize:15,color:'#444'},
  countHeaderRow:{flexDirection:'row',gap:10,marginTop:6},
  countHead:{flex:1,fontSize:20,fontWeight:'700',color:'#333'},
  countInputRow:{flexDirection:'row',gap:10,marginTop:6},
  countCell:{flex:1,flexDirection:'row',alignItems:'center',gap:6},
  countInput:{flex:1,backgroundColor:'#f8f8f8',borderRadius:6,borderWidth:1,borderColor:'#ddd',paddingHorizontal:10,paddingVertical:8,fontSize:18,color:'#1a1a1a',textAlign:'center'},
  stepBtn:{width:32,height:32,borderRadius:16,backgroundColor:'#00b7f3',justifyContent:'center',alignItems:'center'},
  stepBtnDisabled:{backgroundColor:'#e7edf3'},
  payWrap:{alignItems:'center',marginTop:14,marginBottom:8},
  payLabel:{fontSize:34,color:'#8a8a8a',fontWeight:'700'},
  payValue:{fontSize:52,color:'#1f2a7a',fontWeight:'800',marginTop:-8},
  payMeta:{fontSize:16,color:'#777',fontWeight:'700'},
  ticketPrintBtn:{marginTop:10,backgroundColor:'#f39c12',borderRadius:8,paddingVertical:13,alignItems:'center'},
  ticketPrintText:{fontSize:20,fontWeight:'800',color:'#fff'},
  placesGrid:{marginBottom:14,backgroundColor:'#fff',borderRadius:10,borderWidth:1,borderColor:'#e2e8f0',overflow:'hidden'},
  chip:{paddingVertical:11,paddingHorizontal:12,borderBottomWidth:1,borderBottomColor:'#eef2f7',backgroundColor:'#fff'},
  chipSel:{backgroundColor:'#E8F7FF'},
  chipDis:{backgroundColor:'#f8fafc',opacity:.55},
  chipText:{fontSize:14,color:'#334155',fontWeight:'600'},
  chipTextSel:{color:'#0284c7'},
  chipTextDis:{color:'#999'},
  fareDivider:{height:1,backgroundColor:'#e0e0e0',marginVertical:8},
  fareTotalLabel:{fontSize:16,color:'#1a1a1a',fontWeight:'700'},
  fareTotalVal:{fontSize:18,color:'#00b7f3',fontWeight:'700'},
  detailRow:{flexDirection:'row',justifyContent:'space-between',paddingVertical:8},
  detailLabel:{fontSize:15,color:'#666',fontWeight:'500'},
  detailVal:{fontSize:15,color:'#1a1a1a',fontWeight:'600',flex:1,textAlign:'right',marginLeft:16},
});

export {POSScreen as default};