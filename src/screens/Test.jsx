import React from 'react';
import {
  View,
  Text,
  ScrollView,
  SafeAreaView,
  TouchableOpacity,
  Alert,
  Platform,
  StyleSheet,
} from 'react-native';
import { Printer } from 'lucide-react-native';

let NyxPrinter = null;
let PrinterStatus = null;
if (Platform.OS === 'android') {
  const nyx = require('nyx-printer-react-native');
  NyxPrinter = nyx.default;
  PrinterStatus = nyx.PrinterStatus;
}

const MONO = Platform.OS === 'ios' ? 'Courier New' : 'monospace';

const COLS = [
  { key: 'ss',  label: 'SS',  w: 4 },
  { key: 'es',  label: 'ES',  w: 4 },
  { key: 'f',   label: 'F',   w: 4 },
  { key: 'h',   label: 'H',   w: 4 },
  { key: 'l',   label: 'L',   w: 4 },
  { key: 'p',   label: 'P',   w: 4 },
  { key: 'amt', label: 'AMT', w: 8 },
];

// pad(n, width) — zero-pads a numeric string to `width` digits
const pad = (val, width) => String(val).padStart(width, '0').slice(-width);

const MOCK_ROWS = [
  { ss: '08', es: '17', f: '1',  h: '0', l: '2', p: '3',  amt: '1240' },
  { ss: '09', es: '18', f: '12', h: '1', l: '0', p: '5',  amt: '870'  },
  { ss: '07', es: '16', f: '5',  h: '2', l: '1', p: '2',  amt: '2100' },
  { ss: '10', es: '19', f: '99', h: '0', l: '4', p: '1',  amt: '650'  },
  { ss: '06', es: '15', f: '8',  h: '1', l: '0', p: '4',  amt: '980'  },
];

const FHLP_KEYS = new Set(['f', 'h', 'l', 'p']);

const normalizeRow = row =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      FHLP_KEYS.has(k) ? pad(v, 2) : k === 'amt' ? pad(v, 4) : v,
    ])
  );

// ── Print helpers ─────────────────────────────────────────────────────────────
const buildRow = (values = {}, normalize = false) => {
  const v = normalize ? normalizeRow(values) : values;
  return COLS.map(col => {
    const raw = v[col.key] != null ? String(v[col.key]) : '';
    const padded = raw.slice(0, col.w).padEnd(col.w, ' ');
    return col.key === 'amt' ? padded.padStart(col.w + 1, ' ') : ' ' + padded;
  }).join('');
};

const HEADER_VALUES = { ss: 'SS', es: 'ES', f: ' F', h: ' H', l: ' L', p: ' P', amt: ' AMT' };

// ── Screen row ────────────────────────────────────────────────────────────────
const TableRow = ({ data, isHeader }) => (
  <View style={[styles.row, isHeader && styles.headerRow]}>
    {COLS.map((col, index) => (
      <View
        key={col.key}
        style={[styles.cell, index < COLS.length - 1 && styles.cellBorder]}
      >
        <Text
          style={[
            styles.cellText,
            isHeader ? styles.headerText : styles.bodyText,
            col.key === 'amt' && styles.rightAlign,
          ]}
          numberOfLines={1}
        >
          {isHeader ? col.label : (data ? normalizeRow(data)[col.key] : '') ?? ''}
        </Text>
      </View>
    ))}
  </View>
);

const Divider = () => <View style={styles.divider} />;

// ── Component ─────────────────────────────────────────────────────────────────
const Test = () => {
 const handlePrint = async () => {
    if (Platform.OS !== 'android' || !NyxPrinter) {
      Alert.alert('Android only', 'Requires the NYX printer.');
      return;
    }
    try {
      const status = await NyxPrinter.getPrinterStatus();
      if (status !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(status));
        return;
      }

      const opts = { textSize: 27 };
      const headerOpts = { textSize: 27, bold: true };

      await NyxPrinter.printText(buildRow(HEADER_VALUES), headerOpts);
      await NyxPrinter.printText(' ', { textSize: 8 });

      for (const row of MOCK_ROWS) {
        await NyxPrinter.printText(buildRow(row, true), opts);
      }
      await NyxPrinter.printEndAutoOut();
    } catch (e) {
      Alert.alert('Print Error', e?.message);
    }
  };

  return (
    <SafeAreaView style={styles.bg}>
      <ScrollView contentContainerStyle={styles.scroll}>

        <Text style={styles.title}>Transaction Table</Text>

        <View style={styles.tableWrapper}>
          <Divider />
          <TableRow isHeader />
          <Divider />
          {MOCK_ROWS.map((row, i) => (
            <React.Fragment key={i}>
              <TableRow data={row} />
              <Divider />
            </React.Fragment>
          ))}
        </View>

        <TouchableOpacity style={styles.btn} onPress={handlePrint} activeOpacity={0.8}>
          <Printer size={18} color="#fff" />
          <Text style={styles.btnText}>Print Table</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: '#0f0f0f' },
  scroll: { paddingVertical: 36, paddingHorizontal: 16, gap: 16 },

  title: { color: '#e4e4e7', fontSize: 15, fontWeight: '800', textAlign: 'center' },

  tableWrapper: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#27272a',
    borderRadius: 10,
    overflow: 'hidden',
  },
  divider:    { height: 1, backgroundColor: '#27272a' },
  row:        { flexDirection: 'row', backgroundColor: '#18181b' },
  headerRow:  { backgroundColor: '#1c1c1e' },
  cell: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 6,
    justifyContent: 'center',
  },
  cellBorder: { borderRightWidth: 1, borderRightColor: '#27272a' },
  cellText:   { fontFamily: MONO, fontSize: 11, textAlign: 'left' },
  headerText: { color: '#e4e4e7', fontWeight: '800' },
  bodyText:   { color: '#71717a', fontWeight: '400' },
  rightAlign: { textAlign: 'right' },

  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0ea5e9',
    borderRadius: 14,
    paddingVertical: 14,
    width: '100%',
  },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
});

export default Test;