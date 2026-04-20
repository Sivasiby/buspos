import React, { useState } from 'react';
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Printer, RotateCcw, QrCode } from 'lucide-react-native';

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
const getQrBase64 = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    const source = Image.resolveAssetSource(require('../qr.jpg'));
    fetch(source.uri)
      .then(res => res.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          resolve(dataUrl.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      })
      .catch(reject);
  });
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
export default function SettingsScreen() {
  const [content, setContent] = useState({ ...DEFAULTS });
  const [printing, setPrinting] = useState(false);

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

      await NyxPrinter.printText(content.title, { textSize: 36, align: PrintAlign.CENTER });
      await NyxPrinter.printText(content.subtitle, { textSize: 20, align: PrintAlign.CENTER });
      await NyxPrinter.printText(sep, { textSize: 18, align: PrintAlign.CENTER });
      await NyxPrinter.printText('How it works:', { textSize: 22 });
      await NyxPrinter.printText(`1. ${content.step1}`, { textSize: 20 });
      await NyxPrinter.printText(`2. ${content.step2}`, { textSize: 20 });
      await NyxPrinter.printText(`3. ${content.step3}`, { textSize: 20 });
      await NyxPrinter.printText(sep, { textSize: 18, align: PrintAlign.CENTER });
      await NyxPrinter.printText(content.footer, { textSize: 22, align: PrintAlign.CENTER });
      await NyxPrinter.printText(' ', { textSize: 20 });

      const qrBase64 = await getQrBase64();
      await NyxPrinter.printBitmap(qrBase64, BitmapType.BLACK_WHITE, PrintAlign.CENTER);

      await NyxPrinter.printText(' ', { textSize: 20 });
      await NyxPrinter.printText(content.tagline, { textSize: 18, align: PrintAlign.CENTER });
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
                source={require('../qr.jpg')}
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

        {/* ── Print preview hint ── */}
        <View className="flex-row items-start gap-2 bg-sky-950/50 border border-sky-800/40 rounded-xl px-4 py-3 mb-6">
          <Printer size={14} color="#38bdf8" style={{ marginTop: 1 }} />
          <Text className="text-sky-300 text-xs flex-1 leading-5">
            Prints on a 55 mm thermal roll. QR is scaled to fill roll width and printed
            in black & white for best scan accuracy.
          </Text>
        </View>
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
    </SafeAreaView>
  );
}