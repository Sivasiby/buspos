import React, {useState, useCallback, useEffect, useRef} from 'react';
import {
  StyleSheet, Text, TouchableOpacity, View, ScrollView,
  Platform, Modal, Alert, ActivityIndicator, ToastAndroid,
  Animated, FlatList,
} from 'react-native';
import {SafeAreaView}            from 'react-native-safe-area-context';
import AsyncStorage              from '@react-native-async-storage/async-storage';
import {
  Receipt, ArrowUpDown, Printer, Minus, Plus,
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
// Safely display a POS stop name — handles UUIDs stored by old code
// A UUID like "9941f9ec-f5c5-4d36-..." is not a useful display name
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const posStopLabel = (s: string): string => {
  if (!s || s.trim() === '') return '?';
  if (UUID_RE.test(s.trim())) return '?';   // old UUID-stored stop
  return englishStop(s);
};
const shortStop   = (n: string) => { if (!n||n==='Unknown') return '?'; const p=n.split('-'); return p.length>=3?p.slice(2).join('-').trim():p[p.length-1].trim()||p[0].trim(); };
const englishStop = (n: string) => (!n||n==='Unknown') ? '?' : n.split('-')[0].trim();
const fareStr     = (n: number) => n%1===0 ? `${n}.00` : n.toFixed(2);
const genId       = () => `pos_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

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

// DB writes are handled entirely by usePOSTickets hook (insertToSupabase)
// ─────────────────────────────────────────────────────────────────────────────
// Printer
// ─────────────────────────────────────────────────────────────────────────────
let NyxPrinter: any = null, PrinterStatus: any = null, PrintAlign: any = null;
if (Platform.OS === 'android') {
  try { const n=require('nyx-printer-react-native'); NyxPrinter=n.default; PrinterStatus=n.PrinterStatus; PrintAlign=n.PrintAlign; } catch(_){}
}

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
const StartTripModal = ({visible,onClose,onStarted}:{visible:boolean;onClose:()=>void;onStarted:()=>void}) => {
  const [routes,setRoutes]=useState<any[]>([]);
  const [sel,setSel]=useState<any>(null);
  const [dir,setDir]=useState('up');
  const [loading,setLoading]=useState(false);
  const [fetching,setFetching]=useState(false);
  useEffect(()=>{if(visible){setSel(null);(async()=>{setFetching(true);try{const r=await api.get('/conductor/routes');setRoutes(r.data?.routes||[]);}catch{setRoutes([]);}finally{setFetching(false);}})();}}, [visible]);
  const start=async()=>{
    if(!sel){Alert.alert('Select Route','Please select a route first.');return;}
    setLoading(true);
    try{const r=await api.post('/conductor/trip/start',{route_id:sel,direction:dir});if(r.data?.success){showToast('Trip started!');onStarted();onClose();}}
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
// Trip Report Modal — merged App + POS, printable
// ─────────────────────────────────────────────────────────────────────────────
const TripReportModal = ({visible,tripId,onClose,posHook}:{visible:boolean;tripId:any;onClose:()=>void;posHook?:ReturnType<typeof usePOSTickets>}) => {
  const [report,setReport]=useState<any>(null);
  const [appTrip,setAppTrip]=useState<any>(null);
  const [loading,setLoading]=useState(false);
  const [printing,setPrinting]=useState(false);

  useEffect(()=>{
    if(visible&&tripId){
      setReport(null);
      setAppTrip(null);
      (async()=>{
        setLoading(true);
        try{const r=await api.get(`/conductor/trip/${tripId}/report`);setReport(r.data);}
        catch{Alert.alert('Error','Could not load report');}
        try{
          const {data:rows, error} = await supabase
            .from('tickets')
            .select('ticket_type,payment_method,ticket_count,total_fare,fare,from_stop_id,to_stop_id')
            .eq('trip_id', tripId)
            .neq('payment_method', 'pos');

          if(error) throw error;
          const appRows:any[] = rows || [];

          const stopIds = [...new Set(appRows.flatMap(r => [r.from_stop_id, r.to_stop_id]).filter(Boolean))];
          const stopMap: Record<string,string> = {};

          if(stopIds.length){
            const {data:stops, error:stopErr} = await supabase
              .from('stops')
              .select('id, stop_name')
              .in('id', stopIds);

            if(!stopErr){
              (stops || []).forEach((s:any)=>{ stopMap[String(s.id)] = s.stop_name; });
            }
          }

          const map: Record<string,{
            from:string; to:string;
            full_count:number; half_count:number; free_count:number;
            total_fare:number;
          }> = {};

          let full = 0, half = 0, free = 0, tickets = 0, collection = 0;

          for(const r of appRows){
            const cnt = Number(r.ticket_count ?? 1);
            const pm  = String(r.payment_method ?? '').toLowerCase();
            const tt  = (r.ticket_type ?? 'full') as string;

            const unit = Number(r.fare ?? 0);
            const total = r.total_fare != null ? Number(r.total_fare) : unit * cnt;

            const fromName = stopMap[String(r.from_stop_id)] ?? 'Unknown';
            const toName   = stopMap[String(r.to_stop_id)]   ?? 'Unknown';
            const k = `${fromName}|||${toName}`;
            if(!map[k]) map[k] = {from:fromName,to:toName,full_count:0,half_count:0,free_count:0,total_fare:0};

            const isFree = pm === 'fr';
            if(isFree){
              map[k].free_count += cnt; free += cnt;
            } else if(tt === 'half'){
              map[k].half_count += cnt; half += cnt;
            } else {
              map[k].full_count += cnt; full += cnt;
            }

            map[k].total_fare += total;
            tickets += cnt;
            collection += total;
          }

          const breakdown = Object.values(map).sort((a,b)=>b.total_fare - a.total_fare);
          setAppTrip({tickets, collection, full, half, free, breakdown});
        }catch(e){
          setAppTrip({tickets:0, collection:0, full:0, half:0, free:0, breakdown:[]});
        }
        finally{setLoading(false);}
      })();
    }
  },[visible,tripId]);

  // ── POS data for this trip ──────────────────────────────────────────────
  const tripPOSTix = (posHook?.tickets||[]).filter((t:any)=>t.trip_id===tripId);
  const posCnt     = tripPOSTix.reduce((s:number,t:any)=>s+t.ticket_count,0);
  const posAmt     = tripPOSTix.reduce((s:number,t:any)=>s+t.fare,0);

  // ── POS breakdown from local hook (authoritative for type split) ─────────
  const posFullCnt = tripPOSTix
    .filter((t:any)=>(t.ticket_type??'full')==='full')
    .reduce((s:number,t:any)=>s+t.ticket_count,0);
  const posHalfCnt = tripPOSTix
    .filter((t:any)=>t.ticket_type==='half')
    .reduce((s:number,t:any)=>s+t.ticket_count,0);

  // ── App-only counts (Supabase non-pos) ─────────────────────────────────
  const appSummary = appTrip || {};
  const appCollection  = Number(appSummary.collection ?? 0);
  const appFullCnt     = Number(appSummary.full ?? 0);
  const appHalfCnt     = Number(appSummary.half ?? 0);
  const appFreeCnt     = Number(appSummary.free ?? 0);
  const appPassengers  = Number(appSummary.tickets ?? 0);

  // ── Grand totals — computed locally so they're always accurate ───────────
  const grandCollection = appCollection + posAmt;
  const grandFull       = appFullCnt  + posFullCnt;   // app full  + POS full
  const grandHalf       = appHalfCnt  + posHalfCnt;   // app half  + POS half
  const grandFree       = appFreeCnt;
  const grandPassengers = grandFull + grandHalf + grandFree;

  // ── Clean app breakdown (strip unknown stops) ─────────────────────────────
  const cleanBreakdown = (appSummary.breakdown||[]).filter((rb:any)=>{
    const f=englishStop(rb.from), t=englishStop(rb.to);
    return (f && f!=='?' && f.trim()!=='') || (t && t!=='?' && t.trim()!=='');
  });

  // ── POS breakdown grouped by from → to — full/half split ───────────────
  const posMap:Record<string,{from:string;to:string;fullCount:number;halfCount:number;count:number;fare:number}> = {};
  for(const t of tripPOSTix){
    const f=posStopLabel(t.from_stop), to=posStopLabel(t.to_stop);
    const k=`${f}|||${to}`;
    if(!posMap[k]) posMap[k]={from:f,to:to,fullCount:0,halfCount:0,count:0,fare:0};
    if((t as any).ticket_type==='half'){
      posMap[k].halfCount+=t.ticket_count;
    } else {
      posMap[k].fullCount+=t.ticket_count;
    }
    posMap[k].count+=t.ticket_count;
    posMap[k].fare +=t.fare;
  }
  const posBreakdownRows=Object.values(posMap);

  // ── Print ───────────────────────────────────────────────────────────────
  const handlePrint=async()=>{
    if(Platform.OS!=='android'||!NyxPrinter){Alert.alert('Notice','Printer only on Android.');return;}
    setPrinting(true);
    try{
      const ret=await NyxPrinter.getPrinterStatus();
      if(ret!==PrinterStatus.SDK_OK){Alert.alert('Printer Error',PrinterStatus.msg(ret));return;}
      const fmt=(n:number)=>n%1===0?`${n}`:n.toFixed(2);
      const busNum=report?.bus_number??tripPOSTix[0]?.bus_number??'N/A';
      const dir=(report?.direction??tripPOSTix[0]?.direction??'').toUpperCase();
      const today=new Date().toLocaleDateString('en-GB').replace(/\//g,'-');

      await NyxPrinter.printText('SPS - ZYRAP',{textSize:28,align:PrintAlign.CENTER});
      await NyxPrinter.printText('TRIP REPORT',{textSize:24,align:PrintAlign.CENTER});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      await NyxPrinter.printText(`${report?.route_name||''}`,{textSize:22,align:PrintAlign.CENTER});
      await NyxPrinter.printText(`Date : ${today}  Bus : ${busNum}`,{textSize:18});
      await NyxPrinter.printText(`Dir  : ${dir}  Status : ${(report?.status||'').toUpperCase()}`,{textSize:18});
      await NyxPrinter.printText(`Time : ${formatTime(report?.start_time)}${report?.end_time?` - ${formatTime(report.end_time)}`:' - ongoing'}`,{textSize:18});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      await NyxPrinter.printText(`App Full : ${appFullCnt}   Half : ${appHalfCnt}   Free : ${appFreeCnt}`,{textSize:18});
      if(posCnt>0){
        await NyxPrinter.printText(`POS Full : ${posFullCnt}   Half : ${posHalfCnt}   Rs.${fmt(posAmt)}`,{textSize:18});
      }
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      await NyxPrinter.printText(`Total Tickets : ${grandPassengers}`,{textSize:20});
      await NyxPrinter.printText(`Rs. ${fmt(grandCollection)}`,{textSize:36,align:PrintAlign.CENTER});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      // App stage rows
      if(cleanBreakdown.length>0){
        await NyxPrinter.printText('App Stage-wise:',{textSize:18});
        for(const rb of cleanBreakdown){
          await NyxPrinter.printText(
            `${englishStop(rb.from)} -> ${englishStop(rb.to)}
  F:${rb.full_count||0} H:${rb.half_count||0} FR:${rb.free_count||0}  Rs.${fmt(Number(rb.total_fare??rb.revenue??0))}`,
            {textSize:17}
          );
          await NyxPrinter.printText('- - - - - - - - - - - - - - - -',{align:PrintAlign.CENTER});
        }
      }
      // POS stage rows
      if(posBreakdownRows.length>0){
        await NyxPrinter.printText('POS Stage-wise:',{textSize:18});
        for(const rb of posBreakdownRows){
          await NyxPrinter.printText(
            `${rb.from} -> ${rb.to}
  Tickets:${rb.count}  Rs.${fmt(rb.fare)}`,
            {textSize:17}
          );
          await NyxPrinter.printText('- - - - - - - - - - - - - - - -',{align:PrintAlign.CENTER});
        }
      }
      await NyxPrinter.printText('** Safe Journey **',{align:PrintAlign.CENTER});
      await NyxPrinter.printEndAutoOut();
      showToast('Trip report printed!');
    }catch(e:any){Alert.alert('Print Error',e.message||'Unknown');}
    finally{setPrinting(false);}
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={sh.modalOverlay}>
        <View style={[sh.bottomSheet,{maxHeight:'95%'}]}>
          <View style={sh.sheetHandle}/>
          <View style={sh.modalHeader}>
            <Text style={sh.modalTitle}>Trip Report</Text>
            <View style={{flexDirection:'row',alignItems:'center',gap:10}}>
              {report&&(
                <TouchableOpacity
                  style={[tr.printBtn,printing&&{opacity:.6}]}
                  onPress={handlePrint}
                  disabled={printing}
                >
                  {printing
                    ? <ActivityIndicator size="small" color="#fff"/>
                    : <><Printer size={14} color="#fff"/><Text style={tr.printBtnText}>Print</Text></>
                  }
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={onClose}><X size={24} color="#444"/></TouchableOpacity>
            </View>
          </View>

          {loading
            ? <ActivityIndicator size="large" color="#00b7f3" style={{marginVertical:40}}/>
            : report
            ? (
              <ScrollView showsVerticalScrollIndicator={false}>
                {/* Route + status */}
                <Text style={sh.reportRoute}>{report.route_name}</Text>
                <View style={{flexDirection:'row',alignItems:'center',gap:8,marginBottom:12,flexWrap:'wrap'}}>
                  <StatusBadge status={report.status}/>
                  <Text style={{fontSize:12,color:'#888'}}>
                    {formatTime(report.start_time)}
                    {report.end_time?` – ${formatTime(report.end_time)}`:'– ongoing'}
                    {' · '}{formatDuration(report.start_time,report.end_time)}
                  </Text>
                  {(report.bus_number||tripPOSTix[0]?.bus_number)&&
                    <Text style={{fontSize:12,color:'#888'}}>🚌 {report.bus_number??tripPOSTix[0]?.bus_number}</Text>}
                </View>

                {/* Summary cards */}
                <View style={sh.summaryRow}>
                  {[
                    {label:'Full',    val:grandFull,                        color:'#1a2332'},
                    {label:'Half',    val:grandHalf,                        color:'#FF9800'},
                    {label:'Free',    val:grandFree,                        color:'#4CAF50'},
                    {label:'POS',     val:`${posCnt} · ₹${posAmt.toFixed(0)}`, color:'#7B1FA2'},
                    {label:'Total',   val:`₹${grandCollection.toFixed(0)}`, color:'#00b7f3'},
                  ].map(i=>(
                    <View key={i.label} style={sh.summaryCard}>
                      <Text style={[sh.summaryNum,{color:i.color}]}>{i.val}</Text>
                      <Text style={sh.summaryLabel}>{i.label}</Text>
                    </View>
                  ))}
                </View>

                {/* Source legend */}
                {posCnt>0&&(
                  <View style={{flexDirection:'row',gap:8,marginBottom:12,flexWrap:'wrap'}}>
                    <View style={tr.legendChip}>
                      <Users size={10} color="#00b7f3"/>
                      <Text style={[tr.legendText,{color:'#00b7f3'}]}>
                        App: {appPassengers} ({appFullCnt}F{appHalfCnt>0?` · ${appHalfCnt}H`:''}){appFreeCnt>0?` · ${appFreeCnt}FR`:''} · ₹{appCollection.toFixed(0)}
                      </Text>
                    </View>
                    <View style={[tr.legendChip,{backgroundColor:'#EDE7F6',borderColor:'#CE93D8'}]}>
                      <Printer size={10} color="#7B1FA2"/>
                      <Text style={[tr.legendText,{color:'#7B1FA2'}]}>
                        POS: {posCnt} ({posFullCnt}F{posHalfCnt>0?` · ${posHalfCnt}H`:''}) · ₹{posAmt.toFixed(0)}
                      </Text>
                    </View>
                  </View>
                )}

                {/* App stage breakdown */}
                {cleanBreakdown.length>0&&(
                  <View style={{marginTop:4}}>
                    <View style={tr.secHeader}>
                      <Users size={12} color="#00b7f3"/>
                      <Text style={[tr.secLabel,{color:'#00b7f3'}]}>APP STAGES</Text>
                    </View>
                    <View style={sh.tableHeader}>
                      {['SS','ES','F','H','FR','AMT'].map((h,i)=>(
                        <Text key={i} style={[sh.th,h==='AMT'&&{flex:1.8,textAlign:'right'}]}>{h}</Text>
                      ))}
                    </View>
                    {cleanBreakdown.map((rb:any,i:number)=>(
                      <View key={i} style={[sh.tableRow,i%2===0&&{backgroundColor:'#F7FAFC'}]}>
                        <Text style={sh.td} numberOfLines={1}>{englishStop(rb.from)}</Text>
                        <Text style={sh.td} numberOfLines={1}>{englishStop(rb.to)}</Text>
                        <Text style={sh.td}>{rb.full_count>0?rb.full_count:'-'}</Text>
                        <Text style={sh.td}>{rb.half_count>0?rb.half_count:'-'}</Text>
                        <Text style={sh.td}>{rb.free_count>0?rb.free_count:'-'}</Text>
                        <Text style={[sh.td,{flex:1.8,textAlign:'right',color:'#00b7f3',fontWeight:'700'}]}>
                          ₹{Number(rb.total_fare??rb.revenue??0).toFixed(0)}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* POS stage breakdown */}
                {posBreakdownRows.length>0&&(
                  <View style={{marginTop:12}}>
                    <View style={tr.secHeader}>
                      <Printer size={12} color="#7B1FA2"/>
                      <Text style={tr.secLabel}>POS STAGES</Text>
                    </View>
                    <View style={[sh.tableHeader,{backgroundColor:'#7B1FA2'}]}>
                      {['From','To','F','H','Amt'].map((h,i)=>(
                        <Text key={i} style={[sh.th,i===4&&{flex:1.8,textAlign:'right'}]}>{h}</Text>
                      ))}
                    </View>
                    {posBreakdownRows.map((rb,i)=>(
                      <View key={i} style={[sh.tableRow,{backgroundColor:i%2===0?'#F3E5F5':'#EDE7F6'}]}>
                        <Text style={[sh.td,{color:'#4A148C'}]} numberOfLines={1}>{rb.from}</Text>
                        <Text style={[sh.td,{color:'#4A148C'}]} numberOfLines={1}>{rb.to}</Text>
                        <Text style={[sh.td,{color:'#1565C0',fontWeight:'700'}]}>{rb.fullCount>0?rb.fullCount:'-'}</Text>
                        <Text style={[sh.td,{color:'#E65100',fontWeight:'700'}]}>{rb.halfCount>0?rb.halfCount:'-'}</Text>
                        <Text style={[sh.td,{flex:1.8,textAlign:'right',color:'#7B1FA2',fontWeight:'700'}]}>
                          ₹{rb.fare.toFixed(0)}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* Grand total footer */}
                <View style={tr.grandTotal}>
                  <Text style={tr.grandTotalLabel}>
                    Grand Total — {grandPassengers} tickets
                  </Text>
                  <Text style={tr.grandTotalAmt}>₹{grandCollection.toFixed(0)}</Text>
                </View>

                <View style={{height:24}}/>
              </ScrollView>
            )
            : null
          }
        </View>
      </View>
    </Modal>
  );
};
const tr=StyleSheet.create({
  printBtn:{flexDirection:'row',alignItems:'center',gap:5,backgroundColor:'#1a2332',paddingHorizontal:12,paddingVertical:7,borderRadius:10},
  printBtnText:{color:'#fff',fontSize:12,fontWeight:'700'},
  legendChip:{flexDirection:'row',alignItems:'center',gap:4,backgroundColor:'#E3F2FD',paddingHorizontal:8,paddingVertical:4,borderRadius:8,borderWidth:1,borderColor:'#90CAF9'},
  legendText:{fontSize:11,fontWeight:'600'},
  secHeader:{flexDirection:'row',alignItems:'center',gap:6,paddingVertical:5,paddingHorizontal:2,marginBottom:4,marginTop:8},
  secLabel:{fontSize:11,fontWeight:'800',color:'#7B1FA2',letterSpacing:.5},
  grandTotal:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:16,padding:14,backgroundColor:'#1a2332',borderRadius:12},
  grandTotalLabel:{fontSize:13,fontWeight:'700',color:'#fff'},
  grandTotalAmt:{fontSize:22,fontWeight:'900',color:'#00b7f3'},
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage Filter
// ─────────────────────────────────────────────────────────────────────────────
const StageFilter = ({tripId,baseTickets,baseCollection,posTix,direction,onPrint}:{tripId:any;baseTickets:any;baseCollection:any;posTix?:any[];direction?:string;onPrint:(d:any)=>void}) => {
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
    // App (non-POS) stages come from Supabase tickets; POS stages come from local AsyncStorage.
    // This replaces the old backend `/stage-collection` which mixed POS + app.
    if(!f && !t){ setFiltered(null); return; }
    setFiltering(true);

    try{
      const stopMap: Record<string,string> = (stops||[]).reduce((acc:any,s:any) => {
        acc[s.id] = s.name;
        return acc;
      }, {});

      let q:any = supabase
        .from('tickets')
        .select('ticket_type,payment_method,ticket_count,total_fare,fare,from_stop_id,to_stop_id')
        .eq('trip_id', tripId)
        .neq('payment_method', 'pos');

      if(f?.id) q = q.eq('from_stop_id', f.id);
      if(t?.id) q = q.eq('to_stop_id', t.id);

      const {data, error} = await q;
      if(error) throw error;
      const rows:any[] = data || [];

      const map: Record<string, {
        from: string; to: string;
        full_count: number; half_count: number; free_count: number;
        total_fare: number;
      }> = {};

      let full = 0, half = 0, free = 0, tickets = 0, collection = 0;

      for(const r of rows){
        const cnt = Number(r.ticket_count ?? 1);
        const pm  = String(r.payment_method ?? '').toLowerCase();
        const tt  = (r.ticket_type ?? 'full') as string;

        const unit = Number(r.fare ?? 0);
        const total = r.total_fare != null ? Number(r.total_fare) : unit * cnt;

        const fromName = stopMap[r.from_stop_id] ?? 'Unknown';
        const toName   = stopMap[r.to_stop_id]   ?? 'Unknown';
        const k = `${fromName}|||${toName}`;
        if(!map[k]) map[k] = {from: fromName, to: toName, full_count:0, half_count:0, free_count:0, total_fare:0};

        const isFree = pm === 'fr';
        if(isFree){
          map[k].free_count += cnt;
          free += cnt;
        } else if(tt === 'half'){
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

      const breakdown = Object.values(map).sort((a,b) => b.total_fare - a.total_fare);
      setFiltered({tickets, collection, full, half, free, breakdown});
    } catch {
      Alert.alert('Error','Could not filter');
      setFiltered(null);
    } finally {
      setFiltering(false);
    }
  };
  const selF=(s:any)=>{setFrom(s);setPFrom(false);apply(s,toStop);};
  const selT=(s:any)=>{setTo(s);setPTo(false);apply(fromStop,s);};
  const clear=()=>{setFrom(null);setTo(null);setFiltered(null);};
  const isFilt=!!(fromStop||toStop);
  const isDN = direction==='dn'||direction==='return';

  // ── Direction-aware stop list ─────────────────────────────────────────
  // DN trips run STY→CBE so the stops list is reversed
  const orderedStops = isDN ? [...stops].reverse() : stops;

  // ── POS matching for the current stage filter selection ───────────────
  // Match POS tickets by from_key/to_key against selected stop names.
  // A POS ticket matches if:
  //   • fromStop selected  → ticket's from_stop name contains the stop name
  //   • toStop selected    → ticket's to_stop name contains the stop name
  //   • no stop selected   → all POS tickets count (base stats)
  const posTixArr = posTix||[];
  const matchedPOS = isFilt
    ? posTixArr.filter((t:any)=>{
        const tFrom = englishStop(t.from_stop).toLowerCase();
        const tTo   = englishStop(t.to_stop).toLowerCase();
        const selFromName = fromStop ? englishStop(fromStop.name).toLowerCase() : null;
        const selToName   = toStop   ? englishStop(toStop.name).toLowerCase()   : null;
        const fromOk = !selFromName || tFrom.includes(selFromName) || selFromName.includes(tFrom);
        const toOk   = !selToName   || tTo.includes(selToName)     || selToName.includes(tTo);
        return fromOk && toOk;
      })
    : posTixArr;

  const posStageCnt = matchedPOS.reduce((s:number,t:any)=>s+t.ticket_count,0);
  const posStageAmt = matchedPOS.reduce((s:number,t:any)=>s+t.fare,0);

  // ── Totals: App (Supabase non-pos) + matched POS (local) ──────────────
  const appTix = isFilt ? (filtered?.tickets ?? 0) : baseTickets;
  const appCol = isFilt ? (filtered?.collection ?? 0) : baseCollection;

  // POS full/half split for combined F/H header (free is always 0 for POS)
  const posFullTotal = matchedPOS.reduce((s:number,t:any)=> {
    return ((t.ticket_type ?? 'full') === 'half') ? s : s + t.ticket_count;
  }, 0);
  const posHalfTotal = matchedPOS.reduce((s:number,t:any)=> {
    return t.ticket_type === 'half' ? s + t.ticket_count : s;
  }, 0);

  const dTix = appTix + posStageCnt;
  const dCol = appCol + posStageAmt;

  const dF  = isFilt ? ((filtered?.full ?? 0) + posFullTotal) : null;
  const dH  = isFilt ? ((filtered?.half ?? 0) + posHalfTotal) : null;
  const dFr = isFilt ? (filtered?.free ?? 0) : null;

  // App breakdown rows (already non-POS) — still filter unknown stops
  const cleanBreakdown = (filtered?.breakdown||[]).filter((rb:any)=>{
    const f=englishStop(rb.from), t=englishStop(rb.to);
    return (f && f!=='?' && f.trim()!=='') || (t && t!=='?' && t.trim()!=='');
  });

  // ── POS stage rows grouped by from→to — full/half split ──────────────
  const posBreakdownMap: Record<string,{from:string;to:string;fullCount:number;halfCount:number;count:number;fare:number}> = {};
  for(const t of matchedPOS){
    const f=posStopLabel(t.from_stop)||'POS', to=posStopLabel(t.to_stop)||'POS';
    const k=`${f}|||${to}`;
    if(!posBreakdownMap[k]) posBreakdownMap[k]={from:f,to:to,fullCount:0,halfCount:0,count:0,fare:0};
    if((t as any).ticket_type==='half'){
      posBreakdownMap[k].halfCount+=t.ticket_count;
    } else {
      posBreakdownMap[k].fullCount+=t.ticket_count;
    }
    posBreakdownMap[k].count+=t.ticket_count;
    posBreakdownMap[k].fare +=t.fare;
  }
  const posBreakdownRows = Object.values(posBreakdownMap);

  // Combined print breakdown = clean app rows + POS rows
  const printBreakdown = [
    ...cleanBreakdown,
    ...posBreakdownRows.map(r=>({from:r.from,to:r.to,full_count:r.fullCount,half_count:r.halfCount,free_count:0,total_fare:r.fare})),
  ];

  return (
    <View style={sf.wrapper}>
      <TouchableOpacity style={[sf.toggle,open&&sf.toggleActive]} onPress={()=>setOpen(v=>!v)} activeOpacity={.7}>
        <BarChart3 size={14} color={open?'#fff':'#00b7f3'}/><Text style={[sf.toggleText,open&&{color:'#fff'}]}>Stage Filter</Text>
        {isFilt&&<View style={sf.activeDot}/>}<Text style={{fontSize:12,color:open?'#fff':'#00b7f3'}}>{open?'▲':'▼'}</Text>
      </TouchableOpacity>
      {open&&(
        <View style={sf.panel}>
          {/* Direction badge */}
          <View style={{flexDirection:'row',alignItems:'center',gap:6,marginBottom:8}}>
            <View style={[sf.dirBadge,{backgroundColor:isDN?'#EDE7F6':'#E3F2FD'}]}>
              <Text style={[sf.dirBadgeText,{color:isDN?'#7B1FA2':'#1565C0'}]}>{isDN?'↓ DN  STY → CBE':'↑ UP  CBE → STY'}</Text>
            </View>
          </View>
          <View style={sf.statsRow}>
            <View style={sf.stat}><Ticket size={14} color="#00b7f3"/><Text style={[sf.statVal,{color:'#00b7f3'}]}>{dTix}</Text><Text style={sf.statLabel}>Tickets</Text></View>
            <View style={sf.statDivider}/>
            <View style={sf.stat}><DollarSign size={14} color="#4CAF50"/><Text style={[sf.statVal,{color:'#4CAF50'}]}>₹{Number(dCol).toFixed(2)}</Text><Text style={sf.statLabel}>Revenue</Text></View>
            {posStageCnt>0&&<><View style={sf.statDivider}/><View style={sf.stat}><Printer size={12} color="#7B1FA2"/><Text style={[sf.statVal,{color:'#7B1FA2',fontSize:13}]}>{posStageCnt}</Text><Text style={sf.statLabel}>POS</Text></View></>}
            {isFilt&&dF!==null&&(<><View style={sf.statDivider}/><View style={sf.stat}><Text style={[sf.statVal,{color:'#1a2332',fontSize:13}]}>{dF}F{dH&&dH>0?` · ${dH}H`:''}{dFr&&dFr>0?` · ${dFr}FR`:''}</Text><Text style={sf.statLabel}>Break</Text></View></>)}
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
                    <Printer size={14} color="#fff"/><Text style={sf.printBtnText}>Print Stage Report</Text>
                  </TouchableOpacity>
                </>
              )}
              {isFilt&&!filtering&&(cleanBreakdown.length>0||posBreakdownRows.length>0)&&(
                <View style={sf.table}>
                  <View style={sf.tableHeader}>{['SS','ES','F','H','FR','AMT'].map((h,i)=><Text key={i} style={[sf.th,h==='AMT'&&{flex:1.8,textAlign:'right'}]}>{h}</Text>)}</View>
                  {/* App ticket rows */}
                  {cleanBreakdown.map((rb:any,i:number)=>(
                    <View key={`app-${i}`} style={[sf.tableRow,i%2===0&&{backgroundColor:'#F7FAFC'}]}>
                      <Text style={sf.td} numberOfLines={1}>{englishStop(rb.from)}</Text><Text style={sf.td} numberOfLines={1}>{englishStop(rb.to)}</Text>
                      <Text style={sf.td}>{rb.full_count>0?rb.full_count:'-'}</Text><Text style={sf.td}>{rb.half_count>0?rb.half_count:'-'}</Text><Text style={sf.td}>{rb.free_count>0?rb.free_count:'-'}</Text>
                      <Text style={[sf.td,{flex:1.8,textAlign:'right',color:'#00b7f3',fontWeight:'700'}]}>₹{Number(rb.total_fare??rb.revenue??0).toFixed(2)}</Text>
                    </View>
                  ))}
                  {/* POS ticket rows — purple tint with full/half split */}
                  {posBreakdownRows.map((rb,i)=>(
                    <View key={`pos-${i}`} style={[sf.tableRow,{backgroundColor:'#F3E5F5'}]}>
                      <Text style={[sf.td,{color:'#4A148C'}]} numberOfLines={1}>{rb.from}</Text>
                      <Text style={[sf.td,{color:'#4A148C'}]} numberOfLines={1}>{rb.to}</Text>
                      <Text style={[sf.td,{color:'#7B1FA2',fontWeight:'700'}]}>{rb.fullCount>0?rb.fullCount:'-'}</Text>
                      <Text style={[sf.td,{color:'#E65100',fontWeight:'700'}]}>{rb.halfCount>0?rb.halfCount:'-'}</Text>
                      <Text style={sf.td}>-</Text>
                      <Text style={[sf.td,{flex:1.8,textAlign:'right',color:'#7B1FA2',fontWeight:'700'}]}>₹{rb.fare.toFixed(2)}</Text>
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
  dirBadge:{paddingHorizontal:10,paddingVertical:4,borderRadius:10,alignSelf:'flex-start'},dirBadgeText:{fontSize:11,fontWeight:'700'},table:{marginTop:10,borderRadius:8,overflow:'hidden'},tableHeader:{flexDirection:'row',backgroundColor:'#1a2332',paddingVertical:7,paddingHorizontal:8},th:{flex:1,fontSize:10,fontWeight:'700',color:'#fff',textAlign:'center'},tableRow:{flexDirection:'row',paddingVertical:7,paddingHorizontal:8},td:{flex:1,fontSize:11,color:'#333',textAlign:'center'},
});

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1 — Ticket  (Full + Half support)
// ─────────────────────────────────────────────────────────────────────────────
// Ticket type toggle: 'full' | 'half'
// Half fare = ceil(fullFare / 2)  — standard bus half-ticket rule
const halfFare = (full: number): number => Math.ceil(full / 2);

const TicketTab = ({activeTrip,user,busNumber,onTicketIssued,tripNumber}:{activeTrip:any;user:any;busNumber:string;onTicketIssued:(t:POSTicket)=>void;tripNumber:number}) => {
  const tripDirection: string = activeTrip?.direction ?? 'up';
  const getPlaces = useCallback(()=> (tripDirection==='dn'||tripDirection==='return') ? [...(places as any[])].reverse() : places as any[], [tripDirection]);
  const getBanner = ()=> (tripDirection==='dn'||tripDirection==='return') ? 'STY → CBE | சத்தி → கோவை' : 'CBE → STY | கோவை → சத்தி';

  const [selStart,setSelStart]   = useState<any>(null);
  const [selDest,setSelDest]     = useState<any>(null);
  const [activeDrop,setActiveDrop] = useState<string|null>('start');
  const [dirErr,setDirErr]       = useState<string|null>(null);
  const [showConfirm,setShowConfirm] = useState(false);
  const [issuing,setIssuing]     = useState(false);

  // ── Ticket type & counts ──────────────────────────────────────────────
  const [ticketType,setTicketType] = useState<'full'|'half'>('full');
  const [fullCount,setFullCount]   = useState(1);
  const [halfCount,setHalfCount]   = useState(0);

  useEffect(()=>{
    setSelStart(null);setSelDest(null);setDirErr(null);setActiveDrop('start');
    setTicketType('full');setFullCount(1);setHalfCount(0);
  },[tripDirection]);

  const getFare = useCallback((sk:string,ek:string):number=>(fareMatrix as any)?.[sk]?.[ek]??0,[]);

  // ── Fare calculation ──────────────────────────────────────────────────
  const baseFullFare  = (selStart?.key&&selDest?.key) ? getFare(selStart.key,selDest.key) : 0;
  const baseHalfFare  = halfFare(baseFullFare);
  const fullTotal     = baseFullFare * fullCount;
  const halfTotal     = baseHalfFare * halfCount;
  const grandTotal    = fullTotal + halfTotal;
  const totalTickets  = fullCount + halfCount;

  // ── Direction validation ──────────────────────────────────────────────
  useEffect(()=>{
    setDirErr(null);
    if(!selStart?.key||!selDest?.key) return;
    const ss=Number(selStart.label.split('-')[1]), ds=Number(selDest.label.split('-')[1]);
    if(tripDirection==='up'&&ss<ds){setDirErr('Wrong direction — swap stops for UP trip (CBE → STY)');return;}
    if((tripDirection==='dn'||tripDirection==='return')&&ss>ds){setDirErr('Wrong direction — swap stops for DN trip (STY → CBE)');return;}
  },[selStart,selDest,tripDirection]);

  const isReady = selStart && selDest && !dirErr && baseFullFare > 0 && (fullCount > 0 || halfCount > 0);

  // ── Print ─────────────────────────────────────────────────────────────
  const handlePrint = async () => {
    if (Platform.OS !== 'android') {
      Alert.alert('Notice', 'Printer only on Android.');
      setShowConfirm(false);
      return;
    }
    setIssuing(true);
    try {
      const ret = await NyxPrinter.getPrinterStatus();
      if (ret !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(ret));
        return;
      }
      const now = new Date();
      const dp = now.toLocaleDateString('en-GB').replace(/\//g, '-');
      const tp = now.toLocaleTimeString('en-GB', { hour12: false });
      const fortune = getRandomFortune();
      const fn = selStart?.label?.split('-')[2] ?? selStart?.label ?? '';
      const tn = selDest?.label?.split('-')[2] ?? selDest?.label ?? '';
      const fnum = selStart?.label?.split('-')[1] ?? '';
      const tnum = selDest?.label?.split('-')[1] ?? '';
  
      // ── Fetch ticket numbers before printing ───────────────────────────────
      const busId = activeTrip?.bus_id ?? null;
      
      // We need one number for full, one for half (if mixed)
      // Get the starting number — subsequent ones increment from it
      const firstTicketNum = await getNextTicketNumber(busId);
      let fullTicketNum: number | null = firstTicketNum;
      let halfTicketNum: number | null = null;
      
      if (halfCount > 0 && fullCount > 0) {
        // Both types — get a second number for the half ticket record
        halfTicketNum = await getNextTicketNumber(busId);
      } else if (halfCount > 0 && fullCount === 0) {
        // Only half tickets
        halfTicketNum = firstTicketNum;
        fullTicketNum = null;
      }
  
      await NyxPrinter.printText('SPS - ZYRAP', { textSize: 28, align: PrintAlign.CENTER });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      // ── Ticket number line ─────────────────────────────────────────────────
      const numLine = [
        fullTicketNum  ? `#${fullTicketNum}`  : null,
        halfTicketNum  ? `#${halfTicketNum}`  : null,
      ].filter(Boolean).join(' / ');
      if (numLine) {
        await NyxPrinter.printText(`Ticket: ${numLine}`, { textSize: 20, align: PrintAlign.CENTER });
      }
      await NyxPrinter.printText(`${dp}   ${tp}`, { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText(`Bus: ${busNumber}          CASH`, { textSize: 22 });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(`${fnum}-${fn}`, { textSize: 24 });
      await NyxPrinter.printText(`${tnum}-${tn}`, { textSize: 24 });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      if (fullCount > 0)
        await NyxPrinter.printText(
          `ADULT(S): ${fullCount} * ${fareStr(baseFullFare)} = ${fareStr(fullTotal)}`,
          { textSize: 22 },
        );
      if (halfCount > 0)
        await NyxPrinter.printText(
          `CHILD(S): ${halfCount} * ${fareStr(baseHalfFare)} = ${fareStr(halfTotal)}`,
          { textSize: 22 },
        );
      await NyxPrinter.printText(`Rs : ${fareStr(grandTotal)}`, { textSize: 36, align: PrintAlign.CENTER });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(fortune, { textSize: 18, align: PrintAlign.CENTER });
      await NyxPrinter.printEndAutoOut();
  
      // ── Save full tickets with ticket_number ───────────────────────────────
      if (fullCount > 0) {
        const t: POSTicket = {
          id: genId(),
          trip_id: activeTrip?.trip_id ?? null,
          from_stop: selStart.label,
          to_stop: selDest.label,
          from_key: selStart.key,
          to_key: selDest.key,
          ticket_count: fullCount,
          fare: fullTotal,
          unit_fare: baseFullFare,
          ticket_type: 'full',
          ticket_number: fullTicketNum,   // ← NEW
          bus_number: busNumber,
          direction: tripDirection,
          issued_at: now.toISOString(),
          synced: false,
        } as any;
        onTicketIssued(t);
      }
  
      // ── Save half tickets with ticket_number ───────────────────────────────
      if (halfCount > 0) {
        const halfTime = new Date(now.getTime() + 1);
        const t: POSTicket = {
          id: genId(),
          trip_id: activeTrip?.trip_id ?? null,
          from_stop: selStart.label,
          to_stop: selDest.label,
          from_key: selStart.key,
          to_key: selDest.key,
          ticket_count: halfCount,
          fare: halfTotal,
          unit_fare: baseHalfFare,
          ticket_type: 'half',
          ticket_number: halfTicketNum,   // ← NEW
          bus_number: busNumber,
          direction: tripDirection,
          issued_at: halfTime.toISOString(),
          synced: false,
        } as any;
        onTicketIssued(t);
      }
  
      showToast(`Ticket printed · ₹${grandTotal}`);
      setShowConfirm(false);
      setSelStart(null);
      setSelDest(null);
      setFullCount(1);
      setHalfCount(0);
      setTicketType('full');
      setActiveDrop('start');
    } catch (e: any) {
      Alert.alert('Print Error', e.message || 'Unknown');
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
              {activeTrip.route_name} · {formatDuration(activeTrip.start_time,null)}
              {tripNumber>0?`  ·  Trip #${tripNumber}`:''}
            </Text>
            <StatusBadge status={activeTrip.status}/>
          </View>
        ):(
          <View style={tk.noTripPill}><AlertCircle size={13} color="#F57F17"/><Text style={tk.noTripPillText}>No active trip — tickets saved locally</Text></View>
        )}
        {activeTrip&&<View style={tk.routeBanner}><ArrowUpDown size={14} color="#00b7f3"/><Text style={tk.routeBannerText}>{getBanner()}</Text></View>}
        {busNumber!=='N/A'&&<View style={tk.busPill}><Bus size={13} color="#1565C0"/><Text style={tk.busPillText}>🚌 {busNumber}</Text></View>}

        <View style={tk.section}>
          <Text style={tk.sectionTitle}>Journey Details</Text>
          <Text style={tk.sectionSub}>Select start and destination</Text>
          {dirErr&&<View style={tk.dirErr}><AlertCircle size={14} color="#C62828"/><Text style={tk.dirErrText}>{dirErr}</Text></View>}
          <View style={tk.placesWrap}>
            {/* Start stop */}
            <TouchableOpacity style={[tk.selHeader,activeDrop==='start'&&tk.selHeaderActive]} onPress={()=>setActiveDrop(p=>p==='start'?null:'start')} activeOpacity={.7}>
              <Text style={tk.selLabel}>Starting Place</Text>
              <Text style={[tk.selValue,!selStart&&tk.selPlaceholder]}>{selStart?selStart.label.split('-')[0]:'Select starting place'}</Text>
            </TouchableOpacity>
            {activeDrop==='start'&&(
              <View style={tk.placesGrid}>
                {getPlaces().map((p:any)=>{const dis=selDest?.key===p.key,sel=selStart?.key===p.key;return(<TouchableOpacity key={`s-${p.key}`} style={[tk.chip,sel&&tk.chipSel,dis&&tk.chipDis]} disabled={dis} onPress={()=>{setSelStart(p);setActiveDrop('destination');}}><Text style={[tk.chipText,sel&&tk.chipTextSel,dis&&tk.chipTextDis]}>{p.label.split('-')[1]} {p.label.split('-')[2]}</Text></TouchableOpacity>);})}
              </View>
            )}
            {/* Destination stop */}
            <TouchableOpacity style={[tk.selHeader,activeDrop==='destination'&&tk.selHeaderActive]} onPress={()=>setActiveDrop(p=>p==='destination'?null:'destination')} activeOpacity={.7}>
              <Text style={tk.selLabel}>Destination Place</Text>
              <Text style={[tk.selValue,!selDest&&tk.selPlaceholder]}>{selDest?selDest.label.split('-')[0]:'Select destination place'}</Text>
            </TouchableOpacity>
            {activeDrop==='destination'&&(
              <View style={tk.placesGrid}>
                {getPlaces().filter((_:any,idx:number)=>{if(!selStart)return true;const si=getPlaces().findIndex((p:any)=>p.key===selStart.key);return idx>si;}).map((p:any)=>{const dis=selStart?.key===p.key,sel=selDest?.key===p.key;return(<TouchableOpacity key={`d-${p.key}`} style={[tk.chip,sel&&tk.chipSel,dis&&tk.chipDis]} disabled={dis} onPress={()=>{setSelDest(p);setActiveDrop(null);}}><Text style={[tk.chipText,sel&&tk.chipTextSel,dis&&tk.chipTextDis]}>{p.label.split('-')[1]} {p.label.split('-')[2]}</Text></TouchableOpacity>);})}
              </View>
            )}
            {(selStart||selDest)&&(
              <TouchableOpacity style={[tk.revBtn,(!selStart||!selDest)&&tk.revBtnDis]} onPress={()=>{if(selStart&&selDest){const t=selStart;setSelStart(selDest);setSelDest(t);}}} disabled={!selStart||!selDest}>
                <ArrowUpDown size={24} color={!selStart||!selDest?'#ccc':'#00b7f3'}/>
              </TouchableOpacity>
            )}
          </View>

          {/* ── Ticket type + counts ──────────────────────────────────── */}
          {selStart&&selDest&&!dirErr&&baseFullFare>0&&(
            <View style={tk.ticketTypeWrap}>

              {/* Full tickets row */}
              <View style={tk.ticketTypeRow}>
                <View style={tk.ticketTypeLabelWrap}>
                  <View style={[tk.typeBadge,{backgroundColor:'#E3F2FD'}]}>
                    <Text style={[tk.typeBadgeText,{color:'#1565C0'}]}>FULL</Text>
                  </View>
                  <View>
                    <Text style={tk.typeLabel}>Adult Ticket</Text>
                    <Text style={tk.typePrice}>₹{fareStr(baseFullFare)} each</Text>
                  </View>
                </View>
                <View style={tk.countCtrl}>
                  <TouchableOpacity style={[tk.countBtn,fullCount<=0&&tk.countBtnDis]} onPress={()=>setFullCount(p=>Math.max(0,p-1))} disabled={fullCount<=0}>
                    <Minus color={fullCount<=0?'#ccc':'#00b7f3'} size={20}/>
                  </TouchableOpacity>
                  <Text style={tk.countNum}>{fullCount}</Text>
                  <TouchableOpacity style={tk.countBtn} onPress={()=>setFullCount(p=>p+1)}>
                    <Plus color="#00b7f3" size={20}/>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Half tickets row */}
              <View style={[tk.ticketTypeRow,{borderTopWidth:1,borderTopColor:'#f0f0f0',marginTop:8,paddingTop:12}]}>
                <View style={tk.ticketTypeLabelWrap}>
                  <View style={[tk.typeBadge,{backgroundColor:'#FFF3E0'}]}>
                    <Text style={[tk.typeBadgeText,{color:'#E65100'}]}>HALF</Text>
                  </View>
                  <View>
                    <Text style={tk.typeLabel}>Child Ticket</Text>
                    <Text style={tk.typePrice}>₹{fareStr(baseHalfFare)} each</Text>
                  </View>
                </View>
                <View style={tk.countCtrl}>
                  <TouchableOpacity style={[tk.countBtn,halfCount<=0&&tk.countBtnDis]} onPress={()=>setHalfCount(p=>Math.max(0,p-1))} disabled={halfCount<=0}>
                    <Minus color={halfCount<=0?'#ccc':'#FF9800'} size={20}/>
                  </TouchableOpacity>
                  <Text style={[tk.countNum,halfCount>0&&{color:'#FF9800'}]}>{halfCount}</Text>
                  <TouchableOpacity style={tk.countBtn} onPress={()=>setHalfCount(p=>p+1)}>
                    <Plus color="#FF9800" size={20}/>
                  </TouchableOpacity>
                </View>
              </View>

            </View>
          )}
        </View>

        {/* ── Fare breakdown card ───────────────────────────────────────── */}
        {isReady&&(
          <View style={tk.section}>
            <View style={tk.fareCard}>
              <View style={tk.fareHdr}><Receipt size={22} color="#00b7f3"/><Text style={tk.fareTitle}>Fare Breakdown</Text></View>
              {fullCount>0&&(
                <View style={tk.fareRow}>
                  <Text style={tk.fareLabel}>Adult × {fullCount}</Text>
                  <Text style={tk.fareVal}>₹{fareStr(fullTotal)}</Text>
                </View>
              )}
              {halfCount>0&&(
                <View style={tk.fareRow}>
                  <Text style={[tk.fareLabel,{color:'#FF9800'}]}>Child × {halfCount}</Text>
                  <Text style={[tk.fareVal,{color:'#FF9800'}]}>₹{fareStr(halfTotal)}</Text>
                </View>
              )}
              <View style={tk.fareDivider}/>
              <View style={tk.fareRow}>
                <Text style={tk.fareTotalLabel}>Total  ({totalTickets} ticket{totalTickets!==1?'s':''})</Text>
                <Text style={tk.fareTotalVal}>₹{fareStr(grandTotal)}</Text>
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      {isReady&&(
        <View style={tk.printBar}>
          <TouchableOpacity style={tk.printBtn} onPress={()=>setShowConfirm(true)}>
            <Printer color="#fff" size={22} style={{marginBottom:4}}/>
            <Text style={tk.printBtnText}>Print Ticket</Text>
            <Text style={tk.printBtnAmt}>₹{grandTotal}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Confirm modal ─────────────────────────────────────────────── */}
      <Modal animationType="slide" transparent visible={showConfirm} onRequestClose={()=>setShowConfirm(false)}>
        <View style={sh.modalOverlay}><View style={sh.bottomSheet}>
          <View style={sh.sheetHandle}/>
          <View style={{alignItems:'center',marginBottom:16}}><Printer size={32} color="#00b7f3"/><Text style={sh.modalTitle}>Confirm Ticket</Text></View>
          <View style={tk.detailRow}><Text style={tk.detailLabel}>Bus</Text><Text style={tk.detailVal}>{busNumber}</Text></View>
          <View style={tk.detailRow}><Text style={tk.detailLabel}>From</Text><Text style={tk.detailVal}>{selStart?.label?.split('-')[0]}</Text></View>
          <View style={tk.detailRow}><Text style={tk.detailLabel}>To</Text><Text style={tk.detailVal}>{selDest?.label?.split('-')[0]}</Text></View>
          {fullCount>0&&<View style={tk.detailRow}><Text style={tk.detailLabel}>Adult</Text><Text style={tk.detailVal}>{fullCount} × ₹{fareStr(baseFullFare)} = ₹{fareStr(fullTotal)}</Text></View>}
          {halfCount>0&&<View style={tk.detailRow}><Text style={[tk.detailLabel,{color:'#FF9800'}]}>Child</Text><Text style={[tk.detailVal,{color:'#FF9800'}]}>{halfCount} × ₹{fareStr(baseHalfFare)} = ₹{fareStr(halfTotal)}</Text></View>}
          <View style={tk.fareDivider}/>
          <View style={tk.detailRow}><Text style={tk.fareTotalLabel}>Total ({totalTickets} tickets)</Text><Text style={tk.fareTotalVal}>₹{fareStr(grandTotal)}</Text></View>
          <View style={{flexDirection:'row',gap:12,marginTop:16}}>
            <TouchableOpacity style={sh.cancelBtn} onPress={()=>setShowConfirm(false)}><Text style={sh.cancelBtnText}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity style={[sh.primaryBtn,{flex:1},issuing&&{opacity:.6}]} onPress={handlePrint} disabled={issuing}>
              {issuing?<ActivityIndicator color="#fff"/>:<><Printer size={16} color="#fff"/><Text style={sh.primaryBtnText}>Print & Issue</Text></>}
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
const TripTab = ({dashboard,onRefresh,pendingRequests,verifyingTicket,onVerifyTicket,tripNumber,posHook}:{dashboard:any;onRefresh:()=>void;pendingRequests:any[];verifyingTicket:string|null;onVerifyTicket:(id:string)=>void;tripNumber:number;posHook:ReturnType<typeof usePOSTickets>}) => {
  const [changing,setChanging]=useState(false);
  const [startModal,setStartModal]=useState(false);
  const [reportTrip,setReportTrip]=useState<any>(null);
  const at=dashboard?.active_trip;

  // ── RULE: POS = AsyncStorage (local hook), App = Supabase (non-pos only) ─
  const activePOSTix   = posHook.tickets.filter((t:any)=>t.trip_id===at?.trip_id);
  const activePOSCount = activePOSTix.reduce((s:number,t:any)=>s+t.ticket_count,0);  // passengers
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
      try{
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

  const displayPOSCount = activePOSCount; // always from local hook
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

  const printStage=async(data:any)=>{
    if(Platform.OS!=='android'||!NyxPrinter){Alert.alert('Notice','Printer only on Android.');return;}
    try{
      const ret=await NyxPrinter.getPrinterStatus();if(ret!==PrinterStatus.SDK_OK){Alert.alert('Printer Error',PrinterStatus.msg(ret));return;}
      const bn=at?.bus_number??dashboard?.bus?.vehicle_number??'N/A';
      const fmt=(n:number)=>n%1===0?`${n}`:n.toFixed(2);
      const fE=data.fromStop?englishStop(data.fromStop.name):'All',fL=data.fromStop?shortStop(data.fromStop.name):'';
      const tE=data.toStop?englishStop(data.toStop.name):'All',tL=data.toStop?shortStop(data.toStop.name):'';
      await NyxPrinter.printText('SPS - ZYRAP',{textSize:32,align:PrintAlign.CENTER});
      await NyxPrinter.printText(`${new Date().toLocaleString()}  Bus: ${bn}`,{textSize:20});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      await NyxPrinter.printText('STAGE REPORT',{textSize:26,align:PrintAlign.CENTER});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      await NyxPrinter.printText(`From : ${fE}${fL?' ('+fL+')':''}\nTo   : ${tE}${tL?' ('+tL+')':''}`,{});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      await NyxPrinter.printText(`Tickets: ${data.tickets}  F:${data.full??0} H:${data.half??0} FR:${data.free??0}`,{});
      await NyxPrinter.printText(`Rs. ${fmt(Number(data.collection))}`,{textSize:32,align:PrintAlign.CENTER});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      if(data.breakdown?.length>0){await NyxPrinter.printText('Stage-wise:',{});for(const rb of data.breakdown){await NyxPrinter.printText(`${englishStop(rb.from)} -> ${englishStop(rb.to)}\n  F:${rb.full_count??0} H:${rb.half_count??0} FR:${rb.free_count??0}  Rs.${fmt(Number(rb.total_fare??rb.revenue??0))}`,{});await NyxPrinter.printText('- - - - - - - - - - - - - - - -',{align:PrintAlign.CENTER});}}
      await NyxPrinter.printText('** Safe Journey **',{align:PrintAlign.CENTER});
      await NyxPrinter.printEndAutoOut();showToast('Stage report printed!');
    }catch(e:any){Alert.alert('Print Error',e.message||'Unknown');}
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
                <Text style={{fontSize:20,fontWeight:'700',color:'#1a2332'}}>{at.route_name}</Text>
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
              {displayPOSCount>0&&<><View style={sh.inlineStat}><Printer size={15} color="#7B1FA2"/><Text style={[sh.inlineStatVal,{color:'#7B1FA2'}]}>{displayPOSCount}</Text><Text style={sh.inlineStatLabel}>POS Tkts</Text></View><View style={sh.inlineStatDivider}/></>}
              <View style={sh.inlineStat}>
                <DollarSign size={15} color="#4CAF50"/>
                <Text style={[sh.inlineStatVal,{color:'#4CAF50'}]}>₹{appTripLoading ? '…' : Number(totalFareCombined).toFixed(0)}</Text>
                <Text style={sh.inlineStatLabel}>Total</Text>
              </View>
              {pendingRequests.length>0&&<><View style={sh.inlineStatDivider}/><View style={sh.inlineStat}><UserCheck size={15} color="#f57c00"/><Text style={[sh.inlineStatVal,{color:'#f57c00'}]}>{pendingRequests.length}</Text><Text style={sh.inlineStatLabel}>Pending</Text></View></>}
            </View>
            <StageFilter tripId={at.trip_id} baseTickets={appOnlyTickets} baseCollection={appOnlyFare} posTix={activePOSTix} direction={at?.direction} onPrint={printStage}/>
            <View style={sh.tripActions}>
              {at.status==='running'&&<TouchableOpacity style={[sh.tripAction,{backgroundColor:'#FFF8E1'}]} onPress={()=>changeStatus('paused')} disabled={changing}><Pause size={17} color="#F57F17"/><Text style={[sh.tripActionText,{color:'#F57F17'}]}>Pause</Text></TouchableOpacity>}
              {at.status==='paused'&&<TouchableOpacity style={[sh.tripAction,{backgroundColor:'#E8F5E9'}]} onPress={()=>changeStatus('running')} disabled={changing}><Play size={17} color="#2E7D32"/><Text style={[sh.tripActionText,{color:'#2E7D32'}]}>Resume</Text></TouchableOpacity>}
              <TouchableOpacity style={[sh.tripAction,{backgroundColor:'#E3F2FD'}]} onPress={()=>setReportTrip(at.trip_id)}><BarChart3 size={17} color="#1565C0"/><Text style={[sh.tripActionText,{color:'#1565C0'}]}>Report</Text></TouchableOpacity>
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
      {(dashboard?.recent_trips||[]).length>0&&(
        <View style={[sh.card,{marginTop:12}]}>
          <Text style={sh.sectionTitle}>Recent Trips</Text>
          {dashboard.recent_trips.slice(0,5).map((trip:any,i:number)=>(
            <TouchableOpacity key={i} style={sh.recentTripRow} onPress={()=>setReportTrip(trip.trip_id)}>
              <View style={{flex:1}}><Text style={sh.recentTripRoute}>{trip.route_name}</Text><Text style={{fontSize:11,color:'#888',marginTop:2}}>{formatDate(trip.start_time)} · {trip.direction}</Text><View style={{flexDirection:'row',gap:8,marginTop:4}}><Text style={{fontSize:12,color:'#666'}}>🎟 {trip.tickets_sold}</Text><Text style={{fontSize:12,color:'#4CAF50'}}>₹{trip.collection}</Text></View></View>
              <View style={{alignItems:'flex-end',gap:6}}><StatusBadge status={trip.status}/><ChevronRight size={18} color="#ccc"/></View>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <StartTripModal visible={startModal} onClose={()=>setStartModal(false)} onStarted={onRefresh}/>
      <TripReportModal visible={!!reportTrip} tripId={reportTrip} onClose={()=>setReportTrip(null)} posHook={posHook}/>
    </ScrollView>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TAB 3 — Riders
// FIX 2: Filter out POS tickets (payment_method === 'pos') from App Tickets
// ─────────────────────────────────────────────────────────────────────────────
const RidersTab = ({activeTrip,pendingRequests,onVerifyTicket,verifyingTicket,posTickets}:{activeTrip:any;pendingRequests:any[];onVerifyTicket:(id:string)=>void;verifyingTicket:string|null;posTickets:POSTicket[]}) => {
  const [data,setData]=useState<any>(null);
  const [loading,setLoading]=useState(false);
  useEffect(()=>{if(activeTrip?.trip_id)fetchP();else setData(null);},[activeTrip?.trip_id]);
  const fetchP=async()=>{setLoading(true);try{const r=await api.get(`/conductor/passengers/${activeTrip.trip_id}`);setData(r.data);}catch{Alert.alert('Error','Could not load passengers');}finally{setLoading(false);}};
  const pendingIds=new Set((pendingRequests||[]).map((p:any)=>p.ticket_id));
  const tripPOS=posTickets.filter(t=>t.trip_id===activeTrip?.trip_id);

  // ── FIX 2: Exclude POS tickets from the App Tickets list ─────────────────
  // POS tickets inserted via Supabase (Fix 1) have no user_id and no
  // from_stop/to_stop text — the backend returns them with empty/null stops.
  // We guard with THREE signals so no POS row ever bleeds through:
  //   1. payment_method === 'pos'  (explicit field if backend returns it)
  //   2. user_id is null/empty     (POS tickets have no app user)
  //   3. both from AND to are empty/null (POS DB rows have no stop text)
  const allPassengers: any[] = data?.passengers ?? [];
  const appOnlyPassengers = allPassengers.filter((p: any) => {
    // Signal 1: explicit payment_method
    if ((p.payment_method ?? '').toLowerCase() === 'pos') return false;
    // Signal 2: no user_id means it was inserted by the POS device, not the app
    if (!p.user_id && !p.passenger_id) return false;
    // Signal 3: both stops are missing — POS DB rows have empty from_stop/to_stop
    const hasFrom = p.from && p.from !== 'Unknown' && p.from.trim() !== '';
    const hasTo   = p.to   && p.to   !== 'Unknown' && p.to.trim()   !== '';
    if (!hasFrom && !hasTo) return false;
    return true;
  });
   
  const sorted = [...appOnlyPassengers].sort(
    (a: any, b: any) =>
      (pendingIds.has(a.ticket_id) ? 0 : 1) - (pendingIds.has(b.ticket_id) ? 0 : 1)
  );
  console.log("sorted",sorted)
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

          {/* ── POS Tickets ─────────────────────────────────────────────── */}
          {tripPOS.length>0&&(
            <View style={{marginBottom:12}}>
              <View style={rr.secHeader}><Printer size={13} color="#7B1FA2"/><Text style={rr.secLabel}>POS TICKETS · {posPassengerCount} passengers</Text></View>
              {tripPOS.map(t=>{
                const isHalf=(t as any).ticket_type==='half';
                return(
                <View key={t.id} style={[rr.posCard,isHalf&&{backgroundColor:'#FFF8E1',borderColor:'#FFE082'}]}>
                  <View style={rr.posLeft}>
                    <View style={[rr.posAvatar,isHalf&&{backgroundColor:'#FFF3E0'}]}>
                      <Printer size={14} color={isHalf?'#E65100':'#7B1FA2'}/>
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

          {/* ── App Tickets (non-POS only) ───────────────────────────────── */}
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
// TAB 4 — Report
// FIX 3: appTickets from backend already excludes POS because the backend
//        /trip/report endpoint groups by stage — but bt.tickets_sold from
//        the dashboard DOES include POS (since Fix 1 writes them to DB).
//        We correct the "App" counts by subtracting POS counts.
// ─────────────────────────────────────────────────────────────────────────────
const ReportTab = ({dashboard,user,posHook}:{dashboard:any;user:any;posHook:ReturnType<typeof usePOSTickets>}) => {
  const [collection,setCollection]   = useState<any>(null);
  const [collLoading,setCollLoading] = useState(false);
  const [period,setPeriod]           = useState('today');
  const [expandedTrip,setExpandedTrip] = useState<string|null>(null);
  const [appTickets,setAppTickets]   = useState<Record<string,any>>({});  // stores full report per tripId
  const [appLoading,setAppLoading]   = useState<Record<string,boolean>>({});

  useEffect(()=>{fetchCol('today');},[]);
  const fetchCol=async(p:string)=>{
    setCollLoading(true);
    try{const r=await api.get(`/conductor/collection/summary?period=${p}`);setCollection(r.data);}
    catch{}finally{setCollLoading(false);}
  };

  const fetchAppTickets=async(tripId:string)=>{
    if(appTickets[tripId]||appLoading[tripId]) return;
    setAppLoading(p=>({...p,[tripId]:true}));
    try{
      const r=await api.get(`/conductor/trip/${tripId}/report`);
      // Store full report so we can use summary.total_collection accurately
      setAppTickets(p=>({...p,[tripId]:r.data||{}}));
    }catch{
      setAppTickets(p=>({...p,[tripId]:{}}));
    }finally{
      setAppLoading(p=>({...p,[tripId]:false}));
    }
  };

  const stats    = dashboard?.today_stats||{};
  const posByTrip= posHook.todayByTrip();
  const posSummary = posHook.todaySummary();

  const recentTripIds: string[] = (dashboard?.recent_trips||[])
    .filter((t:any)=>{
      const today=new Date().toDateString();
      return t.start_time && new Date(t.start_time).toDateString()===today;
    })
    .map((t:any)=>t.trip_id as string);

  const allTripIds = Array.from(new Set([...Object.keys(posByTrip), ...recentTripIds]));

  const backendTrip=(id:string)=>(dashboard?.recent_trips||[]).find((t:any)=>t.trip_id===id);

  const max = collection?.daily?Math.max(...collection.daily.map((d:any)=>d.collection),1):1;

  const mergedStages=(tripId:string)=>{
    const posStages    = posHook.stageBreakdown(posByTrip[tripId]||[]);
    const appBreakdown = appTickets[tripId]?.route_breakdown||[];
    const map:Record<string,{from:string;to:string;count:number;fare:number;posCount:number;appCount:number}> = {};

    // Add POS stages from local hook
    for(const s of posStages){
      const k=`${s.from}|||${s.to}`;
      if(!map[k]) map[k]={from:s.from,to:s.to,count:0,fare:0,posCount:0,appCount:0};
      map[k].count    += s.count;
      map[k].fare     += s.fare;
      map[k].posCount += s.count;
    }
    // Add App breakdown from backend — skip POS rows to avoid double-count.
    // POS tickets in DB have null stop IDs so backend returns them with
    // empty/null from+to strings. Skip any row where both stops are blank.
    for(const rb of appBreakdown){
      const f=englishStop(rb.from), t=englishStop(rb.to);
      const validFrom = f && f !== '?' && f.trim() !== '';
      const validTo   = t && t !== '?' && t.trim() !== '';
      if(!validFrom && !validTo) continue; // POS row — already counted above
      const k=`${f}|||${t}`;
      if(!map[k]) map[k]={from:f,to:t,count:0,fare:0,posCount:0,appCount:0};
      const appCnt = (rb.full_count||0)+(rb.half_count||0)+(rb.free_count||0);
      const appFare= Number(rb.total_fare??rb.revenue??0);
      map[k].count    += appCnt;
      map[k].fare     += appFare;
      map[k].appCount += appCnt;
    }
    return Object.values(map).sort((a,b)=>b.fare-a.fare);
  };

  const printDailyReport=async(tripId:string)=>{
    if(Platform.OS!=='android'||!NyxPrinter){Alert.alert('Notice','Printer only on Android.');return;}
    try{
      const ret=await NyxPrinter.getPrinterStatus();
      if(ret!==PrinterStatus.SDK_OK){Alert.alert('Printer Error',PrinterStatus.msg(ret));return;}

      const bt      = backendTrip(tripId);
      const posTix  = posByTrip[tripId]||[];
      const stages  = mergedStages(tripId);

      const posTotal = posTix.reduce((s,t)=>s+t.fare,0);
      const posCnt   = posTix.reduce((s,t)=>s+t.ticket_count,0);

      // Use the fetched report summary if available (more accurate — backend computed),
      // otherwise fall back to dashboard bt values. Either way subtract local POS totals.
      // POS = local hook (posTix), App = backend DB minus local POS
      const reportSummary = appTickets[tripId]?.summary;
      const rawBackendTotal = Number(reportSummary?.total_collection ?? bt?.collection ?? 0);
      const rawBackendRows  = Number(reportSummary
        ? ((reportSummary.total_full||0)+(reportSummary.total_half||0)+(reportSummary.total_free||0))
        : (bt?.tickets_sold || 0));
      const appTotal = Math.max(0, rawBackendTotal - posTotal);
      const appCnt   = Math.max(0, rawBackendRows  - posTix.length);  // backend rows - POS rows

      const grandTotal = posTotal + appTotal;   // POS(local) + App(DB)
      const grandCnt   = posCnt   + appCnt;     // POS passengers + App rows

      const busNum = posTix[0]?.bus_number ?? bt?.bus_number ?? 'N/A';
      const dir    = posTix[0]?.direction  ?? bt?.direction  ?? '';
      const today  = new Date().toLocaleDateString('en-GB').replace(/\//g,'-');
      const fmt    = (n:number)=>n%1===0?`${n}`:n.toFixed(2);

      await NyxPrinter.printText('SPS - ZYRAP',{textSize:28,align:PrintAlign.CENTER});
      await NyxPrinter.printText('DAILY TRIP REPORT',{textSize:22,align:PrintAlign.CENTER});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      await NyxPrinter.printText(`Date : ${today}\nBus  : ${busNum}\nDir  : ${dir.toUpperCase()}`,{textSize:20});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      await NyxPrinter.printText(`App Tickets : ${appCnt}   Rs.${fmt(appTotal)}`,{textSize:18});
      await NyxPrinter.printText(`POS Tickets : ${posCnt}   Rs.${fmt(posTotal)}`,{textSize:18});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      await NyxPrinter.printText(`Total : ${grandCnt} tickets`,{textSize:20});
      await NyxPrinter.printText(`Rs. ${fmt(grandTotal)}`,{textSize:32,align:PrintAlign.CENTER});
      await NyxPrinter.printText('--------------------------------',{align:PrintAlign.CENTER});
      if(stages.length>0){
        await NyxPrinter.printText('Stage-wise Collection:',{textSize:20});
        for(const s of stages){
          await NyxPrinter.printText(
            `${s.from} -> ${s.to}\n  Tickets: ${s.count}   Rs.${fmt(s.fare)}`,
            {textSize:18},
          );
          await NyxPrinter.printText('- - - - - - - - - - - - - - - -',{align:PrintAlign.CENTER});
        }
      }
      await NyxPrinter.printText('** End of Report **',{align:PrintAlign.CENTER});
      await NyxPrinter.printEndAutoOut();
      showToast('Daily report printed!');
    }catch(e:any){Alert.alert('Print Error',e.message||'Unknown');}
  };

  // ── RULE: POS = AsyncStorage (local hook), App = backend DB ───────────────
  // posSummary comes from local hook (AsyncStorage) — authoritative for POS
  // stats.* comes from backend DB — includes POS rows, so subtract local POS
  const appOnlyCollection = Math.max(0, (stats.total_collection||0) - posSummary.total);
  const appOnlyTickets    = Math.max(0, (stats.tickets_sold||0)    - posSummary.rows);  // rows not passengers
  const grandTodayTotal   = appOnlyCollection + posSummary.total;   // app(DB) + POS(local)
  const grandTodayTickets = appOnlyTickets    + posSummary.count;   // app rows + POS passengers

  return (
    <ScrollView style={{flex:1}} contentContainerStyle={{padding:16,paddingBottom:40}} showsVerticalScrollIndicator={false}>

      {/* Conductor card */}
      {user&&(
        <View style={sh.conductorCard}>
          <View style={sh.conductorAvatar}><BadgeCheck size={26} color="#00b7f3"/></View>
          <View>
            <Text style={{fontSize:16,fontWeight:'700',color:'#1a2332'}}>{user.name||'Conductor'}</Text>
            <Text style={{fontSize:12,color:'#888',marginTop:2}}>ID: {user.conductor_id||user.id}{dashboard?.bus?` · 🚌 ${dashboard.bus.vehicle_number}`:''}</Text>
          </View>
        </View>
      )}

      {/* ── Today's Stats — app + POS combined (de-duped) ───────────────────── */}
      <Text style={sh.sectionTitle}>Today's Stats</Text>
      <View style={sh.statsGrid}>
        {[
          {Icon:Bus,       label:'Trips',       val:stats.trips_completed??0,      color:'#9C27B0'},
          {Icon:Ticket,    label:'App Tickets',  val:appOnlyTickets,                color:'#00b7f3'},
          {Icon:Printer,   label:'POS Tickets',  val:posSummary.count,             color:'#7B1FA2'},
          {Icon:TrendingUp,label:'Collection',   val:`₹${grandTodayTotal.toFixed(0)}`, color:'#4CAF50'},
        ].map(i=>(
          <View key={i.label} style={sh.statCard}>
            <View style={[sh.statIconBg,{backgroundColor:i.color+'18'}]}><i.Icon size={20} color={i.color}/></View>
            <Text style={[sh.statVal,{color:i.color}]}>{i.val}</Text>
            <Text style={sh.statLabel}>{i.label}</Text>
          </View>
        ))}
      </View>

      {/* POS + App summary pill */}
      {posSummary.count > 0 && (
        <View style={rp.posSummaryRow}>
          <View style={rp.posSummaryChip}>
            <Printer size={11} color="#7B1FA2"/>
            <Text style={rp.posSummaryText}>
              POS: {posSummary.count} ({posSummary.full}F{posSummary.half>0?` · ${posSummary.half}H`:''}) · ₹{posSummary.total.toFixed(0)}
            </Text>
          </View>
          <View style={rp.appSummaryChip}>
            <Users size={11} color="#00b7f3"/>
            <Text style={rp.appSummaryText}>App: {appOnlyTickets} tickets · ₹{appOnlyCollection.toFixed(0)}</Text>
          </View>
        </View>
      )}

      {/* ── Daily Trip Report — merged app + POS ────────────────────────────── */}
      {allTripIds.length > 0 && (
        <View style={{marginTop:20}}>
          <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <Text style={sh.sectionTitle}>Daily Report</Text>
            <View style={rp.totalPill}>
              <Text style={rp.totalPillText}>₹{grandTodayTotal.toFixed(0)} · {grandTodayTickets} tickets</Text>
            </View>
          </View>

          {allTripIds.map((tripId,idx)=>{
            const bt       = backendTrip(tripId);
            const posTix   = posByTrip[tripId]||[];
            const posTotal = posTix.reduce((s,t)=>s+t.fare,0);
            const posCnt   = posTix.reduce((s,t)=>s+t.ticket_count,0);

            // POS = local hook (posTix), App = backend DB minus local POS
            const reportSummary = appTickets[tripId]?.summary;
            const rawBackendTotal = Number(reportSummary?.total_collection ?? bt?.collection ?? 0);
            const rawBackendRows  = Number(reportSummary
              ? ((reportSummary.total_full||0)+(reportSummary.total_half||0)+(reportSummary.total_free||0))
              : (bt?.tickets_sold || 0));
            // Subtract local POS from backend totals to get app-only values
            const appTotal = Math.max(0, rawBackendTotal - posTotal);
            const appCnt   = Math.max(0, rawBackendRows  - posTix.length);  // rows not passengers

            const grandTotal = posTotal + appTotal;   // POS(local) + App(DB)
            const grandCnt   = posCnt   + appCnt;     // POS passengers + App rows
            const busNum   = posTix[0]?.bus_number??bt?.bus_number??'N/A';
            const dir      = posTix[0]?.direction??bt?.direction??'';
            const firstT   = posTix[0]?.issued_at??bt?.start_time;
            const isOpen   = expandedTrip===tripId;
            const stages   = isOpen ? mergedStages(tripId) : [];
            const isLoadingApp = appLoading[tripId];

            return (
              <View key={tripId} style={rp.tripCard}>
                {/* Header */}
                <TouchableOpacity style={rp.tripHeader} onPress={()=>{
                  const next=isOpen?null:tripId;
                  setExpandedTrip(next);
                  if(next) fetchAppTickets(next);
                }} activeOpacity={.7}>
                  <View style={rp.tripLeft}>
                    <View style={rp.tripBadge}><Text style={rp.tripBadgeText}>{idx+1}</Text></View>
                    <View>
                      <Text style={rp.tripTitle}>
                        {bt?.route_name ? `${bt.route_name} · ` : ''}{dir.toUpperCase()}  🚌 {busNum}
                      </Text>
                      <Text style={rp.tripMeta}>
                        {firstT?formatTime(firstT):''} · {grandCnt} ticket{grandCnt!==1?'s':''}
                        {posCnt>0?`  (${posCnt} POS + ${appCnt} App)`:''}
                      </Text>
                    </View>
                  </View>
                  <View style={{alignItems:'flex-end',gap:4}}>
                    <Text style={rp.tripAmt}>₹{grandTotal.toFixed(0)}</Text>
                    <Text style={{fontSize:12,color:'#aaa'}}>{isOpen?'▲':'▼ stages'}</Text>
                  </View>
                </TouchableOpacity>

                {/* Expanded: stage breakdown */}
                {isOpen&&(
                  <View style={rp.stageWrap}>

                    {/* Source legend */}
                    <View style={{flexDirection:'row',gap:8,marginBottom:8}}>
                      {appCnt>0&&<View style={rp.legendChip}><Users size={10} color="#00b7f3"/><Text style={[rp.legendText,{color:'#00b7f3'}]}>App: {appCnt} · ₹{appTotal.toFixed(0)}</Text></View>}
                      {posCnt>0&&<View style={[rp.legendChip,{backgroundColor:'#EDE7F6',borderColor:'#CE93D8'}]}><Printer size={10} color="#7B1FA2"/><Text style={[rp.legendText,{color:'#7B1FA2'}]}>POS: {posCnt} · ₹{posTotal.toFixed(0)}</Text></View>}
                    </View>

                    {isLoadingApp?(
                      <ActivityIndicator size="small" color="#00b7f3" style={{marginVertical:8}}/>
                    ):(
                      <>
                        <View style={rp.stageHdr}>
                          {['From','To','Count','Amount'].map(h=><Text key={h} style={rp.stageTh}>{h}</Text>)}
                        </View>
                        {stages.map((s,i)=>(
                          <View key={i} style={[rp.stageTr,i%2===0&&{backgroundColor:'#fff'}]}>
                            <Text style={rp.stageTd} numberOfLines={1}>{s.from}</Text>
                            <Text style={rp.stageTd} numberOfLines={1}>{s.to}</Text>
                            <Text style={rp.stageTd}>{s.count}</Text>
                            <Text style={[rp.stageTd,{color:'#00b7f3',fontWeight:'700'}]}>₹{s.fare.toFixed(0)}</Text>
                          </View>
                        ))}
                        {stages.length===0&&<Text style={{fontSize:12,color:'#aaa',textAlign:'center',paddingVertical:8}}>No stage data yet</Text>}
                      </>
                    )}

                    {/* Grand total row */}
                    <View style={rp.stageTotalRow}>
                      <Text style={rp.stageTotalLabel}>Grand Total — {grandCnt} tickets</Text>
                      <Text style={rp.stageTotalAmt}>₹{grandTotal.toFixed(0)}</Text>
                    </View>

                    {/* Print button */}
                    <TouchableOpacity style={rp.printBtn} onPress={()=>printDailyReport(tripId)}>
                      <Printer size={15} color="#fff"/>
                      <Text style={rp.printBtnText}>Print This Trip Report</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* ── Collection chart ─────────────────────────────────────────────── */}
      <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:20,marginBottom:12}}>
        <Text style={sh.sectionTitle}>Collection</Text>
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
          {collection?.daily?.length>0&&(
            <View style={{flexDirection:'row',alignItems:'flex-end',height:110,gap:4,backgroundColor:'#F7FAFC',borderRadius:12,padding:10}}>
              {collection.daily.map((d:any,i:number)=>(
                <View key={i} style={{flex:1,alignItems:'center',justifyContent:'flex-end'}}>
                  <Text style={{fontSize:7,color:'#888',marginBottom:2}}>₹{d.collection}</Text>
                  <View style={{width:'80%',backgroundColor:'#00b7f3',borderRadius:3,minHeight:4,height:Math.max(4,(d.collection/max)*75)}}/>
                  <Text style={{fontSize:7,color:'#aaa',marginTop:4}}>{d.date?.slice(5)}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
};
const rp=StyleSheet.create({
  totalPill:{backgroundColor:'#E8F5E9',paddingHorizontal:10,paddingVertical:4,borderRadius:10},
  totalPillText:{fontSize:12,color:'#2E7D32',fontWeight:'700'},
  posSummaryRow:{flexDirection:'row',gap:8,marginTop:10,marginBottom:4,flexWrap:'wrap'},
  posSummaryChip:{flexDirection:'row',alignItems:'center',gap:4,backgroundColor:'#EDE7F6',paddingHorizontal:10,paddingVertical:5,borderRadius:10,borderWidth:1,borderColor:'#CE93D8'},
  posSummaryText:{fontSize:12,color:'#7B1FA2',fontWeight:'600'},
  appSummaryChip:{flexDirection:'row',alignItems:'center',gap:4,backgroundColor:'#E3F2FD',paddingHorizontal:10,paddingVertical:5,borderRadius:10,borderWidth:1,borderColor:'#90CAF9'},
  appSummaryText:{fontSize:12,color:'#1565C0',fontWeight:'600'},
  tripCard:{backgroundColor:'#fff',borderRadius:14,marginBottom:10,overflow:'hidden',borderWidth:1,borderColor:'#e0e0e0',elevation:2},
  tripHeader:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',padding:14},
  tripLeft:{flexDirection:'row',alignItems:'center',gap:12,flex:1},
  tripBadge:{width:32,height:32,borderRadius:16,backgroundColor:'#E3F2FD',justifyContent:'center',alignItems:'center'},
  tripBadgeText:{fontSize:14,fontWeight:'800',color:'#1565C0'},
  tripTitle:{fontSize:14,fontWeight:'700',color:'#1a2332'},
  tripMeta:{fontSize:12,color:'#888',marginTop:2},
  tripAmt:{fontSize:20,fontWeight:'800',color:'#00b7f3'},
  stageWrap:{backgroundColor:'#F7FAFC',borderTopWidth:1,borderTopColor:'#e0e0e0',padding:12},
  legendChip:{flexDirection:'row',alignItems:'center',gap:4,backgroundColor:'#E3F2FD',paddingHorizontal:8,paddingVertical:4,borderRadius:8,borderWidth:1,borderColor:'#90CAF9'},
  legendText:{fontSize:11,fontWeight:'600'},
  stageHdr:{flexDirection:'row',backgroundColor:'#1a2332',borderRadius:6,paddingVertical:7,paddingHorizontal:8,marginBottom:2},
  stageTh:{flex:1,fontSize:10,fontWeight:'700',color:'#fff',textAlign:'center'},
  stageTr:{flexDirection:'row',paddingVertical:7,paddingHorizontal:8,borderRadius:4},
  stageTd:{flex:1,fontSize:12,color:'#333',textAlign:'center'},
  stageTotalRow:{flexDirection:'row',justifyContent:'space-between',paddingHorizontal:8,paddingVertical:8,borderTopWidth:1,borderTopColor:'#e0e0e0',marginTop:4},
  stageTotalLabel:{fontSize:13,fontWeight:'700',color:'#1a2332'},
  stageTotalAmt:{fontSize:16,fontWeight:'800',color:'#00b7f3'},
  printBtn:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6,marginTop:10,backgroundColor:'#1a2332',paddingVertical:11,borderRadius:10},
  printBtnText:{color:'#fff',fontSize:13,fontWeight:'700'},
});

// ─────────────────────────────────────────────────────────────────────────────
// Trip number helpers
// ─────────────────────────────────────────────────────────────────────────────
const IST_OFFSET_MINUTES = 330; // India Standard Time
const getIstDateKey = (d: Date = new Date()): string => {
  const istMs = d.getTime() + IST_OFFSET_MINUTES * 60 * 1000;
  // Slice UTC date after shifting by +5:30 => IST date key
  return new Date(istMs).toISOString().slice(0, 10);
};

const getTripNumberKey = (busId: string): string => {
  return `trip_num_${busId}_${getIstDateKey()}`;
};

const getIstDayRangeIso = (d: Date = new Date()): {startIso: string; endIso: string} => {
  const offsetMs = IST_OFFSET_MINUTES * 60 * 1000;
  const istNow = new Date(d.getTime() + offsetMs);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const day = istNow.getUTCDate();

  const startUtc = new Date(Date.UTC(y, m, day, 0, 0, 0) - offsetMs);
  const endUtc = new Date(Date.UTC(y, m, day + 1, 0, 0, 0) - offsetMs);
  return {startIso: startUtc.toISOString(), endIso: endUtc.toISOString()};
};

// Supabase: we compute "current trip number" as the MAX trip_number for today (IST) per bus.
// If the expected table/columns are missing, we fall back to AsyncStorage so the app still works.
const loadTripNumber = async (busId: string): Promise<number> => {
  const fallback = async () => {
    try {
      const val = await AsyncStorage.getItem(getTripNumberKey(busId));
      return val ? parseInt(val, 10) : 0;
    } catch {
      return 0;
    }
  };

  try {
    const {startIso, endIso} = getIstDayRangeIso();
    const {data, error} = await supabase
      .from('trips')
      .select('trip_number')
      .eq('bus_id', busId)
      .gte('start_time', startIso)
      .lt('start_time', endIso)
      .order('trip_number', {ascending: false})
      .limit(1);

    if (error) throw error;
    const num = Number(data?.[0]?.trip_number ?? 0);
    return Number.isFinite(num) ? num : 0;
  } catch {
    return fallback();
  }
};

const incrementTripNumber = async (busId: string, tripId?: string | null): Promise<number> => {
  const {startIso, endIso} = getIstDayRangeIso();

  const fallbackLatest = async () => {
    const val = await AsyncStorage.getItem(getTripNumberKey(busId));
    return val ? parseInt(val, 10) : 0;
  };

  let latest = 0;
  try {
    const {data, error} = await supabase
      .from('trips')
      .select('trip_number')
      .eq('bus_id', busId)
      .gte('start_time', startIso)
      .lt('start_time', endIso)
      .order('trip_number', {ascending: false})
      .limit(1);
    if (error) throw error;
    latest = Number(data?.[0]?.trip_number ?? 0);
    if (!Number.isFinite(latest)) latest = 0;
  } catch {
    latest = await fallbackLatest().catch(() => 0);
  }

  const nextNum = latest + 1;

  // Persist "incremented" value to Supabase (trip row), and also store in AsyncStorage as backup/offline.
  try {
    if (tripId) {
      // Most schemas use `id` as PK; we attempt a couple of common alternatives.
      const updateCandidates: Array<{table: string; idColumn: string}> = [
        {table: 'trips', idColumn: 'id'},
        {table: 'trips', idColumn: 'trip_id'},
        {table: 'trip', idColumn: 'id'},
        {table: 'trip', idColumn: 'trip_id'},
      ];

      for (const c of updateCandidates) {
        const {error} = await supabase
          .from(c.table)
          .update({trip_number: nextNum})
          .eq(c.idColumn, tripId);
        if (!error) break;
      }
    }
  } catch (e) {
    // Don't block UI on counter persistence failures.
    console.warn('[TripNumber] Supabase update failed:', e);
  }

  try {
    await AsyncStorage.setItem(getTripNumberKey(busId), String(nextNum));
  } catch {
    // ignore
  }

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
  // ADD THIS — run once then delete
  //useEffect(() => { posHook.clearAll(); }, []);


  useEffect(()=>{AsyncStorage.getItem('access_token').then(t=>setAccessToken(t)).catch(()=>{});},[]);
  const {pendingRequests,clearTicket}=useVerificationRealtime(dashboard?.active_trip?.trip_id,dashboard?.active_trip?.status);
  useEffect(()=>{fetchDashboard();},[]);

  // IST midnight reset: when the date changes, reload today's trip counter for this bus.
  useEffect(() => {
    const counterBusId = dashboard?.active_trip?.bus_id ?? dashboard?.bus?.id;
    if (!counterBusId) return;

    let cancelled = false;
    const offsetMs = IST_OFFSET_MINUTES * 60 * 1000;
    const nowIst = new Date(Date.now() + offsetMs);
    const y = nowIst.getUTCFullYear();
    const m = nowIst.getUTCMonth();
    const day = nowIst.getUTCDate();
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
      if(busId){
        const num = await loadTripNumber(busId);
        setLocalTripNumber(num);
      }
    }catch(e){console.error(e);}finally{setDashLoading(false);}
  };

  const handleTripStarted = async () => {
    try {
      const r = await api.get('/conductor/dashboard');
      const dash = r.data;
      const busId = dash?.active_trip?.bus_id ?? dash?.bus?.id;
      const tripId = dash?.active_trip?.trip_id ?? dash?.active_trip?.id ?? null;

      let nextNum: number | null = null;
      if (busId) {
        const existingTripNumber = Number(dash?.active_trip?.trip_number ?? 0);
        if (Number.isFinite(existingTripNumber) && existingTripNumber > 0) {
          setLocalTripNumber(existingTripNumber);
        } else {
          nextNum = await incrementTripNumber(busId, tripId);
          setLocalTripNumber(nextNum);
        }
      }

      // Ensure UI reads the updated number even if backend/dashboard lags.
      setDashboard(
        nextNum != null && dash?.active_trip
          ? {...dash, active_trip: {...dash.active_trip, trip_number: nextNum}}
          : dash,
      );
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
      {/* Top bar */}
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
              {posHook.syncing
                ? <ActivityIndicator size="small" color="#F57F17" />
                : <Text style={sh.unsyncedText}>⬆ {posHook.todaySummary().unsynced}</Text>
              }
            </TouchableOpacity>
          )}
          {busNum!=='N/A'&&<Text style={{fontSize:12,color:'#888'}}>🚌 {busNum}</Text>}
          {onLogout&&<TouchableOpacity onPress={onLogout} style={{padding:6}}><LogOut size={20} color="#999"/></TouchableOpacity>}
        </View>
      </View>

      {/* Tab content */}
      <View style={{flex:1}}>
        {activeTab==='ticket'&&<TicketTab activeTrip={at} user={user} busNumber={busNum} onTicketIssued={posHook.saveTicket} tripNumber={displayTripNumber}/>}
        {activeTab==='trip'  &&<TripTab dashboard={dashboard} onRefresh={handleTripStarted} pendingRequests={pendingRequests} verifyingTicket={verifyingTicket} onVerifyTicket={handleVerify} tripNumber={displayTripNumber} posHook={posHook}/>}
        {activeTab==='riders'&&<RidersTab activeTrip={at} pendingRequests={pendingRequests} onVerifyTicket={handleVerify} verifyingTicket={verifyingTicket} posTickets={posHook.tickets}/>}
        {activeTab==='report'&&<ReportTab dashboard={dashboard} user={user} posHook={posHook}/>}
      </View>

      {/* Tab bar */}
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
  section:{marginBottom:24,paddingHorizontal:20},
  sectionTitle:{fontSize:20,fontWeight:'700',color:'#1a1a1a',marginBottom:4},
  sectionSub:{fontSize:14,color:'#666',lineHeight:20,marginBottom:16},
  placesWrap:{position:'relative',marginBottom:20},
  selHeader:{backgroundColor:'#fff',borderRadius:12,padding:16,borderWidth:1,borderColor:'#eee',marginBottom:8},
  selHeaderActive:{borderColor:'#00b7f3',backgroundColor:'#f0f9ff'},
  selLabel:{fontSize:12,color:'#666',marginBottom:4,fontWeight:'500'},
  selValue:{fontSize:18,color:'#1a1a1a',fontWeight:'600'},
  selPlaceholder:{color:'#999',fontWeight:'400'},
  placesGrid:{flexDirection:'row',flexWrap:'wrap',gap:8,marginBottom:16,paddingHorizontal:4},
  chip:{backgroundColor:'#fff',paddingVertical:10,paddingHorizontal:16,borderRadius:20,borderWidth:1,borderColor:'#e0e0e0'},
  chipSel:{backgroundColor:'#00b7f3',borderColor:'#00b7f3'},
  chipDis:{backgroundColor:'#f5f5f5',borderColor:'#f0f0f0',opacity:.5},
  chipText:{fontSize:14,color:'#333',fontWeight:'500'},
  chipTextSel:{color:'#fff'},
  chipTextDis:{color:'#999'},
  revBtn:{position:'absolute',right:16,top:36,backgroundColor:'#fff',borderRadius:24,width:48,height:48,justifyContent:'center',alignItems:'center',elevation:6,zIndex:10,borderWidth:2,borderColor:'#f0f0f0'},
  revBtnDis:{backgroundColor:'#f8f8f8',borderColor:'#eaeaea'},
  countWrap:{backgroundColor:'#fff',borderRadius:12,padding:16,flexDirection:'row',alignItems:'center',justifyContent:'space-between',borderWidth:1,borderColor:'#eee',marginTop:12},
  countLabel:{fontSize:16,color:'#1a1a1a',fontWeight:'600'},
  countCtrl:{flexDirection:'row',alignItems:'center',backgroundColor:'#f8f9fa',borderRadius:24,borderWidth:1,borderColor:'#eee'},
  countBtn:{padding:8,borderRadius:20,backgroundColor:'#fff'},
  countBtnDis:{backgroundColor:'#f5f5f5'},
  countNum:{fontSize:18,fontWeight:'700',color:'#1a1a1a',paddingHorizontal:16,minWidth:40,textAlign:'center'},
  fareCard:{backgroundColor:'#fff',borderRadius:16,padding:20,elevation:4,borderWidth:1,borderColor:'#f0f0f0'},
  fareHdr:{flexDirection:'row',alignItems:'center',marginBottom:16},
  fareTitle:{fontSize:18,fontWeight:'700',color:'#1a1a1a',marginLeft:12},
  fareRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:8},
  fareLabel:{fontSize:14,color:'#666',fontWeight:'500'},
  fareVal:{fontSize:14,color:'#1a1a1a',fontWeight:'600'},
  fareDivider:{height:1,backgroundColor:'#e0e0e0',marginVertical:8},
  fareTotalLabel:{fontSize:16,color:'#1a1a1a',fontWeight:'700'},
  fareTotalVal:{fontSize:18,color:'#00b7f3',fontWeight:'700'},
  printBar:{backgroundColor:'#F2F2F2',paddingTop:16,paddingHorizontal:20,paddingBottom:Platform.OS==='ios'?34:20,borderTopWidth:1,borderTopColor:'#e0e0e0',elevation:10},
  printBtn:{backgroundColor:'#00b7f3',borderRadius:16,padding:16,alignItems:'center',justifyContent:'center',elevation:6},
  printBtnText:{color:'#fff',fontSize:18,fontWeight:'700',marginBottom:4},
  printBtnAmt:{color:'#e6f7fd',fontSize:16,fontWeight:'600'},
  detailRow:{flexDirection:'row',justifyContent:'space-between',paddingVertical:8},
  ticketTypeWrap:{backgroundColor:'#fff',borderRadius:14,padding:16,borderWidth:1,borderColor:'#eee',marginTop:4},
  ticketTypeRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},
  ticketTypeLabelWrap:{flexDirection:'row',alignItems:'center',gap:10,flex:1},
  typeBadge:{paddingHorizontal:8,paddingVertical:3,borderRadius:8,marginRight:2},
  typeBadgeText:{fontSize:10,fontWeight:'900',letterSpacing:0.5},
  typeLabel:{fontSize:14,fontWeight:'600',color:'#1a1a1a'},
  typePrice:{fontSize:12,color:'#888',marginTop:1},
  detailLabel:{fontSize:15,color:'#666',fontWeight:'500'},
  detailVal:{fontSize:15,color:'#1a1a1a',fontWeight:'600',flex:1,textAlign:'right',marginLeft:16},
});

export {POSScreen as default};