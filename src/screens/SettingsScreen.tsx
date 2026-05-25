import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Image,
  Platform,
  Alert,
  ActivityIndicator,
  ToastAndroid,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Printer, RotateCcw, QrCode, Bus, ChevronRight, Check, LogOut } from 'lucide-react-native';
import ImageResizer from '@bam.tech/react-native-image-resizer';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../lib/supabase';

// ─── NYX imports (Android only) ───────────────────────────────────────────────
let NyxPrinter: any = null;
let PrinterStatus: any = null;
let PrintAlign: any = null;
let BitmapType: any = null;

if (Platform.OS === 'android') {
  const nyx = require('nyx-printer-react-native');
  NyxPrinter = nyx.default;
  PrinterStatus = nyx.PrinterStatus;
  PrintAlign = nyx.PrintAlign;
  BitmapType = nyx.BitmapType;
}

const showToast = (msg: string) => {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
};

// ─── JWT decode helper ──────────────────────────────────────────────────────
const jwtDecodePayload = (token: string): any => {
  try {
    // Split JWT and pad base64url to standard base64
    const part = token.split('.')[1];
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    // Decode base64 char by char — works in Hermes without Buffer/atob/escape
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const std = padded.replace(/-/g, '+').replace(/_/g, '/');
    let bytes = '';
    for (let i = 0; i < std.length; i += 4) {
      const c0 = chars.indexOf(std[i]);
      const c1 = chars.indexOf(std[i + 1]);
      const c2 = chars.indexOf(std[i + 2]);
      const c3 = chars.indexOf(std[i + 3]);
      // eslint-disable-next-line no-bitwise
      bytes += String.fromCharCode((c0 << 2) | (c1 >> 4));
      // eslint-disable-next-line no-bitwise
      if (std[i + 2] !== '=') bytes += String.fromCharCode(((c1 & 15) << 4) | (c2 >> 2));
      // eslint-disable-next-line no-bitwise
      if (std[i + 3] !== '=') bytes += String.fromCharCode(((c2 & 3) << 6) | c3);
    }
    return JSON.parse(bytes);
  } catch {
    return null;
  }
};

// ─── Default promo content ────────────────────────────────────────────────────
const DEFAULTS = {
  title: 'ZYRAP',
  subtitle: 'Smart Bus Ticketing — Now on Play Store',
  step1: 'Download ZYRAP from Google Play Store',
  step2: 'Buy tickets & pay via UPI instantly',
  step3: 'Or use your Credit Points to ride free',
  footer: 'Scan the QR below to get started',
  tagline: 'Fast · Cashless · Paperless',
};

// ─── Convert bundled asset to base64 for printBitmap ─────────────────────────
const getQrBase64 = async () => {
  const source = Image.resolveAssetSource(require('../qr2.png'));
const resized = await ImageResizer.createResizedImage(
    source.uri,
    400,  // width — 55mm roll at 8 dots/mm = 440px, but 576 gives sharper output
    400,  // height
    'JPEG',
    90,   // quality
    0,    // rotation
    undefined,
    false,
    { mode: 'contain' },
  );
  const base64 = await RNFS.readFile(resized.uri, 'base64');
  return base64;
};

// ─── Editable field ───────────────────────────────────────────────────────────
const Field = ({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) => (
  <View className="mb-3">
    <Text className="text-zinc-500 text-xs font-bold tracking-widest uppercase mb-1">
      {label}
    </Text>
    <TextInput
      className="bg-zinc-900 border border-white/15 rounded-xl px-4 py-3 text-white text-sm"
      value={value}
      onChangeText={onChange}
      multiline={multiline}
      numberOfLines={multiline ? 2 : 1}
      placeholderTextColor="#52525b"
      style={multiline ? { minHeight: 64, textAlignVertical: 'top' } : {}}
    />
  </View>
);

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function SettingsScreen({ onLogout }: { onLogout?: () => void }) {
  const [content, setContent] = useState({ ...DEFAULTS });
  const [printing, setPrinting] = useState(false);
  const [testingMode, setTestingMode] = useState(false);
  const [newTicketNotif, setNewTicketNotif] = useState(false);
  const [buses, setBuses] = useState<any[]>([]);
  const [currentBus, setCurrentBus] = useState<any>(null);
  const [loadingBuses, setLoadingBuses] = useState(false);
  const [showBusModal, setShowBusModal] = useState(false);
  const [updatingBus, setUpdatingBus] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const saved = await AsyncStorage.getItem('testing_mode');
        setTestingMode(saved === 'true');
      } catch (e) {
        console.error('Failed to load testing mode:', e);
      }
      try {
        const saved = await AsyncStorage.getItem('notif_new_tickets');
        setNewTicketNotif(saved === 'true');
      } catch {}
    };
    loadSettings();
  }, []);

  useEffect(() => {
    fetchBuses();
  }, []);

  const fetchBuses = async () => {
    setLoadingBuses(true);
    try {
      // Get current user from AsyncStorage (custom JWT auth)
      const raw = await AsyncStorage.getItem('conductor_user');
      const stored = raw ? JSON.parse(raw) : null;
      const token = stored?.access_token ?? await AsyncStorage.getItem('access_token');
      if (!token) {
        console.error('[BUS] No access_token found');
        return;
      }
      const payload = jwtDecodePayload(token);
      const userId = payload?.sub;
      console.log('[BUS] decoded userId from JWT:', userId);

      // Fetch user's current bus (disambiguate with foreign key hint)
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('bus_id, buses!users_bus_id_fkey(*)')
        .eq('id', userId)
        .single();

      console.log('[BUS] userData from supabase:', JSON.stringify(userData, null, 2));
      console.log('[BUS] userError:', JSON.stringify(userError, null, 2));

      if (userError) {
        console.error('[BUS] Error fetching user:', userError);
      } else {
        const bus = (userData as any)?.['buses!users_bus_id_fkey'] ?? (userData as any)?.buses ?? null;
        setCurrentBus(bus);
        if (bus) await AsyncStorage.setItem('selected_bus', JSON.stringify(bus));
      }

      // Fetch all active buses
      const { data: busesData, error: busesError } = await supabase
        .from('buses')
        .select('*')
        .eq('is_active', true)
        .order('bus_number');

      console.log('[BUS] busesData:', JSON.stringify(busesData, null, 2));
      console.log('[BUS] busesError:', JSON.stringify(busesError, null, 2));

      if (busesError) {
        console.error('[BUS] Error fetching buses:', busesError);
      } else {
        setBuses(busesData || []);
      }
    } catch (e) {
      console.error('[BUS] Error in fetchBuses:', e);
    } finally {
      setLoadingBuses(false);
    }
  };

  const updateBus = async (busId: string) => {
    setUpdatingBus(true);
    try {
      const raw = await AsyncStorage.getItem('conductor_user');
      const stored = raw ? JSON.parse(raw) : null;
      const token = stored?.access_token ?? await AsyncStorage.getItem('access_token');
      if (!token) { Alert.alert('Error', 'No user logged in'); return; }
      const payload = jwtDecodePayload(token);
      const userId = payload?.sub;
      if (!userId) { Alert.alert('Error', 'Could not identify user'); return; }

      const { error } = await supabase
        .from('users')
        .update({ bus_id: busId })
        .eq('id', userId);

      if (error) {
        Alert.alert('Error', 'Failed to update bus');
        console.error('Error updating bus:', error);
      } else {
        const selectedBus = buses.find(b => b.id === busId);
        setCurrentBus(selectedBus);
        await AsyncStorage.setItem('selected_bus', JSON.stringify(selectedBus));
        setShowBusModal(false);
        showToast(`Bus updated to ${selectedBus?.bus_number}`);
      }
    } catch (e) {
      console.error('Error in updateBus:', e);
      Alert.alert('Error', 'Failed to update bus');
    } finally {
      setUpdatingBus(false);
    }
  };

  const toggleTestingMode = async () => {
    const newValue = !testingMode;
    setTestingMode(newValue);
    try {
      await AsyncStorage.setItem('testing_mode', String(newValue));
      showToast(newValue ? 'Testing mode enabled' : 'Testing mode disabled');
    } catch (e) {
      console.error('Failed to save testing mode:', e);
    }
  };

  const toggleNewTicketNotif = async () => {
    const newValue = !newTicketNotif;
    setNewTicketNotif(newValue);
    try {
      await AsyncStorage.setItem('notif_new_tickets', String(newValue));
      showToast(newValue ? 'New ticket notifications on' : 'New ticket notifications off');
    } catch {}
  };

  const update = (key: keyof typeof DEFAULTS) => (val: string) =>
    setContent(prev => ({ ...prev, [key]: val }));

  const resetToDefaults = () => setContent({ ...DEFAULTS });

  const handlePrint = async () => {
    if (Platform.OS !== 'android' || !NyxPrinter) {
      Alert.alert('Not supported', 'Printing is only available on Android.');
      return;
    }
    setPrinting(true);
    try {
      const status = await NyxPrinter.getPrinterStatus();
      if (status !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(status));
        return;
      }

      const sep = '- - - - - - - - - - -';

await NyxPrinter.printText(content.title, { textSize: 52, align: PrintAlign.CENTER });
await NyxPrinter.printText(content.subtitle, { textSize: 28, align: PrintAlign.CENTER });
await NyxPrinter.printText(sep, { textSize: 24, align: PrintAlign.CENTER });
await NyxPrinter.printText('How it works:', { textSize: 30 });
await NyxPrinter.printText(`1. ${content.step1}`, { textSize: 28 });
await NyxPrinter.printText(`2. ${content.step2}`, { textSize: 28 });
await NyxPrinter.printText(`3. ${content.step3}`, { textSize: 28 });
await NyxPrinter.printText(sep, { textSize: 24, align: PrintAlign.CENTER });
await NyxPrinter.printText(content.footer, { textSize: 30, align: PrintAlign.CENTER });

      const qrBase64 = await getQrBase64();
      await NyxPrinter.printBitmap(qrBase64, BitmapType.BLACK_WHITE, PrintAlign.CENTER);

      await NyxPrinter.printText(' ', { textSize: 20 });
     await NyxPrinter.printText(content.tagline, { textSize: 26, align: PrintAlign.CENTER });
      await NyxPrinter.printEndAutoOut();

      showToast('Flyer printed!');
    } catch (e: any) {
      Alert.alert('Print Error', e.message || 'Unknown error');
    } finally {
      setPrinting(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-black">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}>

        {/* ── Page header ── */}
        <View className="flex-row items-center justify-between mb-6">
          <View>
            <Text className="text-white text-xl font-bold">Promotional Print</Text>
            <Text className="text-zinc-500 text-xs mt-0.5">55 mm receipt · ZYRAP flyer</Text>
          </View>
          <TouchableOpacity
            onPress={resetToDefaults}
            className="flex-row items-center gap-1.5 bg-zinc-900 border border-white/15 px-3 py-2 rounded-xl">
            <RotateCcw size={13} color="#a1a1aa" />
            <Text className="text-zinc-400 text-xs font-semibold">Reset</Text>
          </TouchableOpacity>
        </View>

        {/* ── QR Code preview ── */}
        <View className="items-center mb-6">
          <View className="bg-zinc-900 border border-white/15 rounded-2xl p-3 items-center">
            <View className="flex-row items-center gap-2 mb-3 self-start">
              <QrCode size={14} color="#71717a" />
              <Text className="text-zinc-500 text-xs font-bold tracking-widest uppercase">
                QR Code
              </Text>
            </View>
            {/* White bg simulates print surface; square and dominant */}
            <View
              className="bg-white rounded-xl overflow-hidden"
              style={{ width: 200, height: 200 }}>
              <Image
                source={require('../qr2.png')}
                style={{ width: 200, height: 200 }}
                resizeMode="cover"
              />
            </View>
            <Text className="text-zinc-600 text-[11px] mt-2">
              Printed centered on 55 mm roll
            </Text>
          </View>
        </View>

        {/* ── Content fields ── */}
        <View className="bg-zinc-900/50 border border-white/10 rounded-2xl p-4 mb-4">
          <Text className="text-white text-sm font-bold mb-4 tracking-wide">
            Edit Content
          </Text>

          <Field label="Title" value={content.title} onChange={update('title')} />
          <Field
            label="Subtitle"
            value={content.subtitle}
            onChange={update('subtitle')}
            multiline
          />
          <Field label="Step 1" value={content.step1} onChange={update('step1')} multiline />
          <Field label="Step 2" value={content.step2} onChange={update('step2')} multiline />
          <Field label="Step 3" value={content.step3} onChange={update('step3')} multiline />
          <Field
            label="QR Caption"
            value={content.footer}
            onChange={update('footer')}
            multiline
          />
          <Field label="Tagline / Footer" value={content.tagline} onChange={update('tagline')} />
        </View>

        {/* ── Bus Selection ── */}
        <View className="bg-zinc-900/50 border border-white/10 rounded-2xl p-4 mb-4">
          <Text className="text-white text-sm font-bold mb-3 tracking-wide">Assigned Bus</Text>
          {loadingBuses ? (
            <View className="flex-row items-center justify-center py-4">
              <ActivityIndicator color="#71717a" size="small" />
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => setShowBusModal(true)}
              className="flex-row items-center justify-between bg-zinc-800 border border-white/10 rounded-xl px-4 py-3">
              <View className="flex-row items-center gap-3">
                <Bus size={18} color="#71717a" />
                <View>
                  <Text className="text-white text-sm font-semibold">
                    {currentBus ? currentBus.bus_number : 'No bus assigned'}
                  </Text>
                  {currentBus?.bus_name && (
                    <Text className="text-zinc-500 text-xs">{currentBus.bus_name}</Text>
                  )}
                </View>
              </View>
              <ChevronRight size={16} color="#71717a" />
            </TouchableOpacity>
          )}
        </View>

        {/* ── Notification Settings ── */}
        <View className="bg-zinc-900/50 border border-white/10 rounded-2xl p-4 mb-4">
          <Text className="text-white text-sm font-bold mb-4 tracking-wide">Notifications</Text>

          <View className="flex-row items-center justify-between mb-4">
            <View className="flex-1 pr-4">
              <Text className="text-white text-sm font-semibold">New App Ticket Alerts</Text>
              <Text className="text-zinc-500 text-xs mt-0.5">Notify when a passenger books via the app</Text>
            </View>
            <TouchableOpacity
              onPress={toggleNewTicketNotif}
              className={`w-12 h-7 rounded-full p-1 ${newTicketNotif ? 'bg-sky-500' : 'bg-zinc-700'}`}>
              <View className={`w-5 h-5 rounded-full bg-white ${newTicketNotif ? 'translate-x-5' : 'translate-x-0'}`} />
            </TouchableOpacity>
          </View>

          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-4">
              <Text className="text-white text-sm font-semibold">Verification Requests</Text>
              <Text className="text-zinc-500 text-xs mt-0.5">Always on — cannot be disabled</Text>
            </View>
            <View className="w-12 h-7 rounded-full p-1 bg-sky-500/40">
              <View className="w-5 h-5 rounded-full bg-white/50 translate-x-5" />
            </View>
          </View>
        </View>

        {/* ── Testing Mode Toggle ── */}
        <View className="bg-zinc-900/50 border border-white/10 rounded-2xl p-4 mb-4">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-white text-sm font-bold tracking-wide">Testing Mode</Text>
              <Text className="text-zinc-500 text-xs mt-1">Show tickets in modal instead of printing</Text>
            </View>
            <TouchableOpacity
              onPress={toggleTestingMode}
              className={`w-12 h-7 rounded-full p-1 transition-colors ${
                testingMode ? 'bg-sky-500' : 'bg-zinc-700'
              }`}>
              <View
                className={`w-5 h-5 rounded-full bg-white transition-transform ${
                  testingMode ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Print preview hint ── */}
        <View className="flex-row items-start gap-2 bg-sky-950/50 border border-sky-800/40 rounded-xl px-4 py-3 mb-6">
          <Printer size={14} color="#38bdf8" style={{ marginTop: 1 }} />
          <Text className="text-sky-300 text-xs flex-1 leading-5">
            Prints on a 55 mm thermal roll. QR is scaled to fill roll width and printed
            in black & white for best scan accuracy.
          </Text>
        </View>

        {/* ── Logout ── */}
        {onLogout && (
          <TouchableOpacity
            onPress={() =>
              Alert.alert('Logout', 'Are you sure you want to logout?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Logout', style: 'destructive', onPress: onLogout },
              ])
            }
            className="flex-row items-center justify-center gap-2 border border-red-500/40 bg-red-950/30 rounded-2xl py-4 mb-2">
            <LogOut size={18} color="#f87171" />
            <Text className="text-red-400 text-base font-bold tracking-wide">Logout</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* ── Sticky print button ── */}
      <View className="absolute bottom-0 left-0 right-0 px-4 pb-6 pt-3 bg-black border-t border-white/10">
        <TouchableOpacity
          className={`flex-row items-center justify-center gap-3 bg-sky-500 rounded-2xl py-4 ${printing ? 'opacity-60' : ''}`}
          onPress={handlePrint}
          disabled={printing}>
          {printing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Printer size={18} color="#fff" />
              <Text className="text-white text-base font-bold tracking-wide">
                PRINT FLYER
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Bus Selection Modal ── */}
      <Modal
        visible={showBusModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBusModal(false)}>
        <View className="flex-1 bg-black/80 justify-center items-center px-4">
          <View className="bg-zinc-900 rounded-2xl p-6 w-full max-w-sm border border-white/20">
            <View className="flex-row justify-between items-center mb-4">
              <Text className="text-white text-lg font-bold">Select Bus</Text>
              <TouchableOpacity onPress={() => setShowBusModal(false)}>
                <Text className="text-sky-400 font-semibold">Close</Text>
              </TouchableOpacity>
            </View>

            <ScrollView className="max-h-80 mb-4">
              {buses.length === 0 ? (
                <Text className="text-zinc-500 text-sm text-center py-4">No buses available</Text>
              ) : (
                buses.map((bus) => (
                  <TouchableOpacity
                    key={bus.id}
                    onPress={() => updateBus(bus.id)}
                    disabled={updatingBus}
                    className={`flex-row items-center justify-between p-3 rounded-xl mb-2 ${
                      currentBus?.id === bus.id ? 'bg-sky-500/20 border border-sky-500/40' : 'bg-zinc-800'
                    }`}>
                    <View className="flex-row items-center gap-3">
                      <Bus size={16} color={currentBus?.id === bus.id ? '#38bdf8' : '#71717a'} />
                      <View>
                        <Text className={`text-sm font-semibold ${currentBus?.id === bus.id ? 'text-sky-400' : 'text-white'}`}>
                          {bus.bus_number}
                        </Text>
                        {bus.bus_name && (
                          <Text className="text-zinc-500 text-xs">{bus.bus_name}</Text>
                        )}
                      </View>
                    </View>
                    {currentBus?.id === bus.id && <Check size={16} color="#38bdf8" />}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>

            <TouchableOpacity
              className="bg-zinc-800 rounded-xl py-3 items-center"
              onPress={() => setShowBusModal(false)}>
              <Text className="text-white font-bold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}