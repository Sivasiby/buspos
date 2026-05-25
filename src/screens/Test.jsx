import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  Alert,
} from 'react-native';
import notifee, {
  AndroidImportance,
  AndroidStyle,
  AuthorizationStatus,
  EventType,
} from '@notifee/react-native';

// ─── Channel ID ───────────────────────────────────────────────────────────────
const CHANNEL_ID = 'ticket_alerts';

// ─── Helper: create channel once ─────────────────────────────────────────────
async function ensureChannel() {
  if (Platform.OS !== 'android') return CHANNEL_ID;
  await notifee.deleteChannel(CHANNEL_ID).catch(() => {});
  await notifee.createChannel({
    id: CHANNEL_ID,
    name: 'Ticket Alerts',
    importance: AndroidImportance.HIGH,
    vibration: true,
    sound: 'default',
  });
  return CHANNEL_ID;
}

// ─── Helper: request permission ───────────────────────────────────────────────
async function requestPermission() {
  const settings = await notifee.requestPermission();
  return (
    settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
  );
}

// ─── Helper: display notification ────────────────────────────────────────────
async function sendTicketNotification({ title, body, ticketId }) {
  const channelId = await ensureChannel();
  await requestPermission();

  await notifee.displayNotification({
    id: ticketId ?? String(Date.now()),
    title,
    body,
    android: {
      channelId,
      importance: AndroidImportance.HIGH,
      style: { type: AndroidStyle.BIGTEXT, text: body },
      pressAction: { id: 'default' },
      actions: [
        {
          title: '🖨️ Print',
          pressAction: { id: 'print', launchActivity: 'default' },
        },
        {
          title: '✕ Cancel',
          pressAction: { id: 'cancel' },
        },
      ],
    },
    ios: {
      categoryId: 'ticket',
      foregroundPresentationOptions: {
        alert: true,
        sound: true,
        badge: true,
      },
    },
  });
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Test() {
  const [log, setLog] = useState([]);
  const [sending, setSending] = useState(false);
  const counterRef = useRef(1);

  const addLog = (msg) =>
    setLog((prev) => [{ id: Date.now(), msg }, ...prev.slice(0, 19)]);

  // ── Foreground event handler ─────────────────────────────────────────────
  useEffect(() => {
    const unsub = notifee.onForegroundEvent(({ type, detail }) => {
      const { notification, pressAction } = detail;
      if (type === EventType.ACTION_PRESS) {
        if (pressAction?.id === 'print') {
          addLog(`✅ Print pressed — ticket #${notification?.id}`);
          Alert.alert('Print', `Printing ticket #${notification?.id}`);
        } else if (pressAction?.id === 'cancel') {
          addLog(`❌ Cancel pressed — ticket #${notification?.id}`);
          notifee.cancelNotification(notification.id);
        }
      } else if (type === EventType.PRESS) {
        addLog(`👆 Notification tapped — #${notification?.id}`);
      } else if (type === EventType.DISMISSED) {
        addLog(`🗑️ Notification dismissed — #${notification?.id}`);
      }
    });
    return () => unsub();
  }, []);

  // ── Test button handler ──────────────────────────────────────────────────
  const handleTest = async () => {
    setSending(true);
    try {
      const num = counterRef.current++;
      const ticketId = `ticket_${num}`;
      await sendTicketNotification({
        title: `🎫 New Ticket #${num}`,
        body: `Passenger: Kumar  •  Stage 5 → 12  •  ₹24`,
        ticketId,
      });
      addLog(`📤 Sent notification #${num}`);
    } catch (e) {
      addLog(`⚠️ Error: ${e?.message ?? String(e)}`);
      Alert.alert('Error', e?.message ?? 'Failed to send notification');
    } finally {
      setSending(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Notifee Test</Text>
        <Text style={styles.headerSubtitle}>Push notifications with action buttons</Text>
      </View>

      {/* Test button */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Send a test notification</Text>
        <Text style={styles.hint}>
          Press the button below. A notification will appear with{' '}
          <Text style={styles.bold}>Print</Text> and{' '}
          <Text style={styles.bold}>Cancel</Text> action buttons.
        </Text>
        <TouchableOpacity
          style={[styles.testBtn, sending && styles.testBtnBusy]}
          onPress={handleTest}
          disabled={sending}
          activeOpacity={0.8}
        >
          <Text style={styles.testBtnText}>
            {sending ? 'Sending…' : '🔔  Send Test Notification'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Action log */}
      {log.length > 0 && (
        <View style={styles.section}>
          <View style={styles.logHeader}>
            <Text style={styles.sectionLabel}>Event Log</Text>
            <TouchableOpacity onPress={() => setLog([])}>
              <Text style={styles.clearBtn}>Clear</Text>
            </TouchableOpacity>
          </View>
          {log.map((entry) => (
            <View key={entry.id} style={styles.logRow}>
              <Text style={styles.logText}>{entry.msg}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Info */}
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>ℹ️ How it works</Text>
        <Text style={styles.infoText}>
          • Tap the button → notification pops up{'\n'}
          • Tap <Text style={styles.bold}>Print</Text> → action fires (foreground & background){'\n'}
          • Tap <Text style={styles.bold}>Cancel</Text> → notification dismissed{'\n'}
          • Swipe away → DISMISSED event logged{'\n'}
          • Works foreground, background & killed state
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d0f',
  },
  scrollContent: {
    paddingBottom: 40,
  },
  header: {
    backgroundColor: '#111113',
    paddingTop: 60,
    paddingBottom: 28,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.4,
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#71717a',
    marginTop: 4,
  },
  section: {
    backgroundColor: '#111113',
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 16,
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#52525b',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },
  hint: {
    fontSize: 14,
    color: '#a1a1aa',
    lineHeight: 21,
    marginBottom: 18,
  },
  bold: {
    fontWeight: '700',
    color: '#e4e4e7',
  },
  testBtn: {
    backgroundColor: '#0ea5e9',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  testBtnBusy: {
    backgroundColor: '#0369a1',
  },
  testBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  clearBtn: {
    fontSize: 12,
    color: '#ef4444',
    fontWeight: '600',
  },
  logRow: {
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#1f1f23',
  },
  logText: {
    fontSize: 13,
    color: '#a1a1aa',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
  },
  infoCard: {
    backgroundColor: '#0c1a2e',
    borderRadius: 14,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#1e3a5f',
  },
  infoTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#38bdf8',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 13,
    color: '#7dd3fc',
    lineHeight: 22,
  },
});