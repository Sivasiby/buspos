// PrinterScreen.js
import React, {useState, useEffect, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Platform,
  DeviceEventEmitter,
  Alert,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  Printer,
  Scan,
  Monitor,
  Box,
  CheckCircle,
  XCircle,
  Terminal,
  Trash2,
  ChevronRight,
} from 'lucide-react-native';

// ─── NYX imports (Android only) ───────────────────────────────────────────────
let NyxPrinter = null;
let PrinterStatus = null;
let PrintAlign = null;
let BarcodeTextPosition = null;
let BitmapType = null;
let LcdOpt = null;

if (Platform.OS === 'android') {
  const nyx = require('nyx-printer-react-native');
  NyxPrinter = nyx.default;
  PrinterStatus = nyx.PrinterStatus;
  PrintAlign = nyx.PrintAlign;
  BarcodeTextPosition = nyx.BarcodeTextPosition;
  BitmapType = nyx.BitmapType;
  LcdOpt = nyx.LcdOpt;
}

// ─── Theme ─────────────────────────────────────────────────────────────────────
const COLORS = {
  bg: '#0F0F0F',
  surface: '#1A1A1A',
  border: '#2A2A2A',
  primary: '#FFFFFF',
  secondary: '#888888',
  accent: '#FFFFFF',
  success: '#AAAAAA',
  error: '#666666',
};

// ─── Section Card ──────────────────────────────────────────────────────────────
const SectionCard = ({title, icon: Icon, children}) => (
  <View style={styles.card}>
    <View style={styles.cardHeader}>
      <Icon size={16} color={COLORS.primary} strokeWidth={1.5} />
      <Text style={styles.cardTitle}>{title}</Text>
    </View>
    <View style={styles.cardBody}>{children}</View>
  </View>
);

// ─── Action Row ────────────────────────────────────────────────────────────────
const ActionRow = ({label, onPress, disabled}) => (
  <TouchableOpacity
    style={[styles.actionRow, disabled && styles.actionRowDisabled]}
    onPress={onPress}
    disabled={disabled}
    activeOpacity={0.6}>
    <Text style={[styles.actionLabel, disabled && styles.actionLabelDisabled]}>
      {label}
    </Text>
    <ChevronRight
      size={14}
      color={disabled ? COLORS.border : COLORS.secondary}
      strokeWidth={1.5}
    />
  </TouchableOpacity>
);

// ─── Main Screen ───────────────────────────────────────────────────────────────
export default function PrinterScreen() {
  const [logs, setLogs] = useState([]);
  const [printerReady, setPrinterReady] = useState(null); // null=unchecked, true, false
  const isAndroid = Platform.OS === 'android';

  const log = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString('en-US', {hour12: false});
    setLogs(prev => [{timestamp, message, type}, ...prev].slice(0, 50));
  }, []);

  // ── Scanner listener (Android only) ──────────────────────────────────────────
  useEffect(() => {
    if (!isAndroid) return;
    const sub = DeviceEventEmitter.addListener('onScanResult', res => {
      log(`Scan result: ${JSON.stringify(res)}`, 'success');
    });
    return () => sub.remove();
  }, [isAndroid, log]);

  // ── Printer Status ────────────────────────────────────────────────────────────
  const checkPrinterStatus = async () => {
    if (!isAndroid) {
      log('Printer not supported on iOS', 'error');
      return false;
    }
    try {
      const ret = await NyxPrinter.getPrinterStatus();
      if (ret !== PrinterStatus.SDK_OK) {
        log(`Printer error: ${PrinterStatus.msg(ret)}`, 'error');
        setPrinterReady(false);
        return false;
      }
      log('Printer ready', 'success');
      setPrinterReady(true);
      return true;
    } catch (e) {
      log(`Status check failed: ${e.message}`, 'error');
      setPrinterReady(false);
      return false;
    }
  };

  // ── Print Test Receipt ────────────────────────────────────────────────────────
  const printTestReceipt = async () => {
    const ready = await checkPrinterStatus();
    if (!ready) return;
    try {
      const weights = [1, 1, 1, 1];
      const colStyles = [
        {align: PrintAlign.CENTER},
        {align: PrintAlign.CENTER},
        {align: PrintAlign.CENTER},
        {align: PrintAlign.CENTER},
      ];

      await NyxPrinter.printText('TEST RECEIPT', {
        textSize: 48,
        align: PrintAlign.CENTER,
      });
      await NyxPrinter.printText(`\nOrder Time:\t${new Date().toISOString()}\n`, {
        align: PrintAlign.CENTER,
      });
      await NyxPrinter.printTableText(
        ['ITEM', 'QTY', 'PRICE', 'TOTAL'],
        weights,
        colStyles,
      );
      await NyxPrinter.printTableText(
        ['Sample Item', '2', '10.00', '20.00'],
        weights,
        colStyles,
      );
      await NyxPrinter.printText('\nTotal: \t\t20.00\n', {
        align: PrintAlign.CENTER,
      });
      await NyxPrinter.printQrCode(
        Date.now().toString(),
        300,
        300,
        PrintAlign.CENTER,
      );
      await NyxPrinter.printText('\n', {});
      await NyxPrinter.printBarcode(
        Date.now().toString(),
        300,
        150,
        BarcodeTextPosition.TEXT_BELOW,
        PrintAlign.CENTER,
      );
      await NyxPrinter.printText('\n*** Print Complete ***', {
        align: PrintAlign.CENTER,
      });
      await NyxPrinter.printEndAutoOut();
      log('Test receipt printed successfully', 'success');
    } catch (e) {
      log(`Print failed: ${e.message}`, 'error');
    }
  };

  // ── Print Text Only ───────────────────────────────────────────────────────────
  const printSimpleText = async () => {
    const ready = await checkPrinterStatus();
    if (!ready) return;
    try {
      await NyxPrinter.printText('Hello from React Native\n', {
        textSize: 32,
        align: PrintAlign.CENTER,
      });
      await NyxPrinter.printEndAutoOut();
      log('Simple text printed', 'success');
    } catch (e) {
      log(`Print failed: ${e.message}`, 'error');
    }
  };

  // ── LCD Controls ──────────────────────────────────────────────────────────────
  const lcdInit = async () => {
    if (!isAndroid) return log('LCD not supported on iOS', 'error');
    try {
      await NyxPrinter.configLcd(LcdOpt.INIT);
      log('LCD initialized', 'success');
    } catch (e) {
      log(`LCD init failed: ${e.message}`, 'error');
    }
  };

  const lcdWakeup = async () => {
    if (!isAndroid) return log('LCD not supported on iOS', 'error');
    try {
      await NyxPrinter.configLcd(LcdOpt.INIT);
      await NyxPrinter.configLcd(LcdOpt.WAKEUP);
      log('LCD wake up', 'success');
    } catch (e) {
      log(`LCD wakeup failed: ${e.message}`, 'error');
    }
  };

  const lcdSleep = async () => {
    if (!isAndroid) return log('LCD not supported on iOS', 'error');
    try {
      await NyxPrinter.configLcd(LcdOpt.INIT);
      await NyxPrinter.configLcd(LcdOpt.SLEEP);
      log('LCD sleep', 'success');
    } catch (e) {
      log(`LCD sleep failed: ${e.message}`, 'error');
    }
  };

  const lcdReset = async () => {
    if (!isAndroid) return log('LCD not supported on iOS', 'error');
    try {
      await NyxPrinter.configLcd(LcdOpt.INIT);
      await NyxPrinter.configLcd(LcdOpt.RESET);
      log('LCD reset', 'success');
    } catch (e) {
      log(`LCD reset failed: ${e.message}`, 'error');
    }
  };

  // ── Scanner ───────────────────────────────────────────────────────────────────
  const cameraScan = async () => {
    if (!isAndroid) return log('Scanner not supported on iOS', 'error');
    try {
      await NyxPrinter.scan({});
      log('Camera scan triggered', 'info');
    } catch (e) {
      log(`Camera scan failed: ${e.message}`, 'error');
    }
  };

  const infraredScan = async () => {
    if (!isAndroid) return log('Scanner not supported on iOS', 'error');
    try {
      await NyxPrinter.qscScan();
      log('Infrared scan triggered', 'info');
    } catch (e) {
      log(`Infrared scan failed: ${e.message}`, 'error');
    }
  };

  // ── Cash Box ──────────────────────────────────────────────────────────────────
  const openCashBox = async () => {
    if (!isAndroid) return log('Cash box not supported on iOS', 'error');
    try {
      await NyxPrinter.openCashBox();
      log('Cash box opened', 'success');
    } catch (e) {
      log(`Cash box failed: ${e.message}`, 'error');
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Printer size={18} color={COLORS.primary} strokeWidth={1.5} />
          <Text style={styles.headerTitle}>NYX Printer</Text>
        </View>
        <View style={styles.statusBadge}>
          {printerReady === null ? (
            <Text style={styles.statusText}>—</Text>
          ) : printerReady ? (
            <>
              <CheckCircle size={12} color={COLORS.primary} strokeWidth={1.5} />
              <Text style={styles.statusText}>Ready</Text>
            </>
          ) : (
            <>
              <XCircle size={12} color={COLORS.secondary} strokeWidth={1.5} />
              <Text style={styles.statusText}>Error</Text>
            </>
          )}
        </View>
      </View>

      {/* iOS warning banner */}
      {!isAndroid && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningText}>
            NYX hardware is Android-only. Running in log-only mode on iOS.
          </Text>
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>

        {/* Printer */}
        <SectionCard title="Printer" icon={Printer}>
          <ActionRow label="Check Status" onPress={checkPrinterStatus} />
          <ActionRow label="Print Test Receipt" onPress={printTestReceipt} />
          <ActionRow label="Print Simple Text" onPress={printSimpleText} />
        </SectionCard>

        {/* LCD */}
        <SectionCard title="LCD Display" icon={Monitor}>
          <ActionRow label="Initialize" onPress={lcdInit} />
          <ActionRow label="Wake Up" onPress={lcdWakeup} />
          <ActionRow label="Sleep" onPress={lcdSleep} />
          <ActionRow label="Reset" onPress={lcdReset} />
        </SectionCard>

        {/* Scanner */}
        <SectionCard title="Scanner" icon={Scan}>
          <ActionRow label="Camera Scan" onPress={cameraScan} />
          <ActionRow label="Infrared Scan (Soft Trigger)" onPress={infraredScan} />
        </SectionCard>

        {/* Cash Box */}
        <SectionCard title="Cash Box" icon={Box}>
          <ActionRow label="Open Cash Box" onPress={openCashBox} />
        </SectionCard>

        {/* Log Console */}
        <View style={styles.logContainer}>
          <View style={styles.logHeader}>
            <View style={styles.headerLeft}>
              <Terminal size={14} color={COLORS.secondary} strokeWidth={1.5} />
              <Text style={styles.logTitle}>Console</Text>
            </View>
            <TouchableOpacity onPress={() => setLogs([])}>
              <Trash2 size={14} color={COLORS.secondary} strokeWidth={1.5} />
            </TouchableOpacity>
          </View>
          {logs.length === 0 ? (
            <Text style={styles.logEmpty}>No logs yet</Text>
          ) : (
            logs.map((entry, i) => (
              <View key={i} style={styles.logRow}>
                <Text style={styles.logTime}>{entry.timestamp}</Text>
                <Text
                  style={[
                    styles.logMessage,
                    entry.type === 'success' && styles.logSuccess,
                    entry.type === 'error' && styles.logError,
                  ]}>
                  {entry.message}
                </Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    color: COLORS.primary,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statusText: {
    color: COLORS.secondary,
    fontSize: 12,
    fontWeight: '500',
  },
  warningBanner: {
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  warningText: {
    color: COLORS.secondary,
    fontSize: 12,
    lineHeight: 16,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 12,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  cardTitle: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  cardBody: {
    paddingVertical: 4,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  actionRowDisabled: {
    opacity: 0.4,
  },
  actionLabel: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '400',
  },
  actionLabelDisabled: {
    color: COLORS.secondary,
  },
  logContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
    marginTop: 4,
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  logTitle: {
    color: COLORS.secondary,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  logEmpty: {
    color: COLORS.secondary,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 24,
  },
  logRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  logTime: {
    color: COLORS.secondary,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    paddingTop: 1,
    minWidth: 68,
  },
  logMessage: {
    color: COLORS.secondary,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
    lineHeight: 18,
  },
  logSuccess: {
    color: COLORS.primary,
  },
  logError: {
    color: COLORS.secondary,
    textDecorationLine: 'line-through',
  },
});
