/**
 * ticketNotification.js
 *
 * Shared service for:
 *  - Sending notifee notifications for new online tickets
 *  - Sending notifee notifications for verification requests
 *  - Printing a ticket from a notification action (foreground & background)
 *
 * Ticket data is persisted to AsyncStorage so the background handler can
 * read it without needing React state.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import notifee, { AndroidImportance, AndroidStyle, EventType } from '@notifee/react-native';
import { supabase } from '../../lib/supabase';
import { getRandomFortune } from '../utils/fortune';

// ─── Constants ────────────────────────────────────────────────────────────────
const CHANNEL_NEW_TICKET   = 'channel_new_ticket';
const CHANNEL_VERIFICATION = 'channel_verification';
const TICKET_STORE_PREFIX  = '@notif_ticket_';

// ─── Permission request ───────────────────────────────────────────────────────
export async function requestNotificationPermission() {
  try {
    await notifee.requestPermission();
  } catch {}
  await ensureChannels();
}

// ─── Channel setup ────────────────────────────────────────────────────────────
let channelsCreated = false;
export async function ensureChannels() {
  if (Platform.OS !== 'android') return;
  if (channelsCreated) return;
  await notifee.createChannel({
    id: CHANNEL_NEW_TICKET,
    name: 'New Tickets',
    importance: AndroidImportance.HIGH,
    vibration: true,
    sound: 'default',
  });
  await notifee.createChannel({
    id: CHANNEL_VERIFICATION,
    name: 'Verification Requests',
    importance: AndroidImportance.HIGH,
    vibration: true,
    sound: 'default',
  });
  channelsCreated = true;
}

// ─── Persist / retrieve ticket data for background print ─────────────────────
export async function storeTicketForNotif(notifId, ticketItem) {
  try {
    await AsyncStorage.setItem(
      `${TICKET_STORE_PREFIX}${notifId}`,
      JSON.stringify(ticketItem),
    );
  } catch {}
}

export async function getStoredTicket(notifId) {
  try {
    const raw = await AsyncStorage.getItem(`${TICKET_STORE_PREFIX}${notifId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function removeStoredTicket(notifId) {
  try {
    await AsyncStorage.removeItem(`${TICKET_STORE_PREFIX}${notifId}`);
  } catch {}
}

// ─── Format helpers ───────────────────────────────────────────────────────────

// Returns { tamil, stage } from stop name like "1-11-புங்கம்பள்ளி"
function parseStop(name) {
  if (!name || name === '?') return { tamil: name || '?', stage: null };
  const parts = name.split('-');
  const stage = parts.length >= 2 ? parts[1].trim() : null;
  const tamil = parts.length >= 3 ? parts.slice(2).join('-').trim() : parts[0].trim();
  return { tamil: tamil || name, stage };
}

// "புங்கம்பள்ளி (11)"
function stopLabel(name) {
  const { tamil, stage } = parseStop(name);
  return stage ? `${tamil} (${stage})` : tamil;
}

function fmtFare(fare) {
  const n = Number(fare ?? 0);
  return `₹${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
}

function relativeTime(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

// ─── Send: New Online Ticket ──────────────────────────────────────────────────
/**
 * @param {object} ticket  — shape from onlineTickets state
 *   { ticket_id, username, tamil_name, fare, ticket_count,
 *     from, to, payment_method, booking_status, created_at }
 */
export async function sendNewTicketNotification(ticket) {
  await ensureChannels();

  const notifId = `new_ticket_${ticket.ticket_id}`;
  const from    = stopLabel(ticket.from);
  const to      = stopLabel(ticket.to);
  const name    = ticket.tamil_name || '';
  const fare    = fmtFare(ticket.fare);
  const count   = ticket.ticket_count > 1 ? ` ×${ticket.ticket_count}` : '';
  const method  = (ticket.payment_method || 'online').toUpperCase();
  const timeAgo = relativeTime(ticket.created_at);

  const title = `🎫 ${name}${count}  •  ${fare}`;
  const body  = `${from} → ${to}  •  ${timeAgo}`;

  await storeTicketForNotif(notifId, ticket);

  await notifee.displayNotification({
    id: notifId,
    title,
    body,
    android: {
      channelId: CHANNEL_NEW_TICKET,
      importance: AndroidImportance.HIGH,
      style: { type: AndroidStyle.BIGTEXT, text: `${from} → ${to}\n${method}  •  ${fare}${count}  •  ${timeAgo}` },
      pressAction: { id: 'default' },
      actions: [
        { title: '🖨️ Print', pressAction: { id: 'print', launchActivity: 'default' } },
        { title: '✕ Dismiss', pressAction: { id: 'dismiss' } },
      ],
    },
    ios: {
      foregroundPresentationOptions: { alert: true, sound: true, badge: false },
    },
  });
}

// ─── Send: Verification Request ───────────────────────────────────────────────
/**
 * @param {object} ticket  — shape from PendingTicket / pendingRequests
 *   { ticket_id, username, fare, from, to, requested_at }
 */
export async function sendVerificationNotification(ticket) {
  await ensureChannels();

  const notifId   = `verif_${ticket.ticket_id}`;
  const from      = stopLabel(ticket.from);
  const to        = stopLabel(ticket.to);
  const tamilName  = ticket.tamil_name || '';
  const appId      = ticket.user_app_id ?? null;
  const nameWithId = appId ? `${appId} • ${tamilName}` : tamilName;
  const fare      = fmtFare(ticket.fare);
  const timeAgo   = relativeTime(ticket.requested_at);

  const title = `🔔 ${nameWithId}`;
  const body  = `${from} → ${to}  •  ${fare}  •  ${timeAgo}`;

  await storeTicketForNotif(notifId, ticket);

  await notifee.displayNotification({
    id: notifId,
    title,
    body,
    android: {
      channelId: CHANNEL_VERIFICATION,
      importance: AndroidImportance.HIGH,
      style: { type: AndroidStyle.BIGTEXT, text: `${from} → ${to}\nFare: ${fare}  •  ${timeAgo}` },
      pressAction: { id: 'default' },
      actions: [
        { title: '🖨️ Print & Verify', pressAction: { id: 'print', launchActivity: 'default' } },
        { title: '✕ Dismiss', pressAction: { id: 'dismiss' } },
      ],
    },
    ios: {
      foregroundPresentationOptions: { alert: true, sound: true, badge: false },
    },
  });
}

// ─── Cancel a notification by id ─────────────────────────────────────────────
export async function cancelTicketNotification(notifId) {
  try {
    await notifee.cancelNotification(notifId);
  } catch {}
  await removeStoredTicket(notifId);
}

// ─── Core print logic (shared foreground + background) ───────────────────────
/**
 * Prints a ticket exactly as handlePrintVerification does in TripScreen.
 * Returns ticketInfo object on success (for testing-mode modal), throws on error.
 */
export async function printTicketFromNotif(notifId) {
  const ticket = await getStoredTicket(notifId);
  if (!ticket) throw new Error('Ticket data not found for notification.');

  const testingMode = await AsyncStorage.getItem('testing_mode');
  const isTestingMode = testingMode === 'true';

  let NyxPrinter = null;
  let PrinterStatus = null;
  let PrintAlign = null;
  if (Platform.OS === 'android') {
    const nyx = require('nyx-printer-react-native');
    NyxPrinter = nyx.default;
    PrinterStatus = nyx.PrinterStatus;
    PrintAlign = nyx.PrintAlign;
  }

  if (!isTestingMode) {
    if (Platform.OS !== 'android' || !NyxPrinter) return;
    const statusRet = await NyxPrinter.getPrinterStatus();
    if (statusRet !== PrinterStatus.SDK_OK) {
      throw new Error(PrinterStatus.msg(statusRet));
    }
  }

  // Bus info — match TripScreen: selected_bus first, then active trip bus
  const storedBusRaw = await AsyncStorage.getItem('selected_bus');
  const storedBus = storedBusRaw ? JSON.parse(storedBusRaw) : null;
  const busId = storedBus?.id ?? null;

  // Trip number — primary source: AsyncStorage (written by TripScreen on every set)
  let tripNumber = 0;
  let busnumFromTrip = null;
  try {
    const storedTripNum = await AsyncStorage.getItem('active_trip_number');
    if (storedTripNum) tripNumber = Number(storedTripNum) || 0;
  } catch {}

  // Bus number from active trip (always needed regardless of trip number source)
  try {
    const conductorRaw = await AsyncStorage.getItem('conductor_user');
    const conductorStored = conductorRaw ? JSON.parse(conductorRaw) : null;
    const conductorId = conductorStored?.id ?? conductorStored?.user_id ?? conductorStored?.conductor_id ?? conductorStored?.user?.id ?? null;
    if (conductorId) {
      const { data: activeRows } = await supabase
        .from('trips')
        .select('id, trip_number, bus_id')
        .eq('conductor_id', conductorId)
        .in('status', ['running', 'paused'])
        .order('start_time', { ascending: false })
        .limit(1);
      const activeRow = activeRows?.[0] ?? null;
      if (activeRow) {
        // Only use DB trip_number if AsyncStorage didn't give us one
        if (!tripNumber) {
          tripNumber = Number(activeRow.trip_number ?? 0);
          // Last-resort: count trips since session baseline
          if (!tripNumber && activeRow.id) {
            try {
              let sinceIso = null;
              try { sinceIso = await AsyncStorage.getItem('trip_report_reset_after_iso'); } catch {}
              if (!sinceIso) {
                const d = new Date();
                d.setHours(0, 0, 0, 0);
                sinceIso = d.toISOString();
              }
              const { count: tripCount } = await supabase
                .from('trips')
                .select('id', { count: 'exact', head: true })
                .eq('conductor_id', conductorId)
                .gte('start_time', sinceIso)
                .neq('id', activeRow.id);
              tripNumber = (tripCount ?? 0) + 1;
            } catch {}
          }
        }
        const tripBusId = activeRow.bus_id ?? null;
        if (tripBusId) {
          const { data: busRow } = await supabase
            .from('buses')
            .select('bus_number')
            .eq('id', tripBusId)
            .single();
          busnumFromTrip = busRow?.bus_number ?? null;
        }
      }
    }
  } catch {}

  // Get next ticket number via Supabase RPC
  let ticketNum = null;
  if (busId) {
    try {
      const { data } = await supabase.rpc('increment_ticket_number', { p_bus_id: busId });
      ticketNum = typeof data === 'number' ? data : null;
    } catch {}
  }

  const now    = new Date();
  const dp     = now.toLocaleDateString('en-GB').replace(/\//g, '-');
  const tp     = now.toLocaleTimeString('en-GB', { hour12: false });
  const fortune = getRandomFortune();

  // Bus number: match TripScreen — dashboard?.bus?.vehicle_number ?? storedBus?.bus_number
  const busNum = busnumFromTrip ?? storedBus?.bus_number ?? 'N/A';

  const fareN   = Number(ticket.fare ?? 0);
  const fareStr = (n) => (n % 1 === 0 ? `${n}.00` : Number(n).toFixed(2));

  // Stop name parsing — identical to TripScreen's handlePrintVerification
  const fromParts = (ticket.from || '').split('-');
  const toParts   = (ticket.to   || '').split('-');
  const fn = fromParts.length >= 3 ? fromParts.slice(2).join('-').trim() : (ticket.from || '');
  const tn = toParts.length   >= 3 ? toParts.slice(2).join('-').trim()   : (ticket.to   || '');

  const ticketInfo = {
    header:       'SPS - ZYRAP',
    ticketNumber: ticketNum ? `Ticket #: ${ticketNum}` : null,
    separator:    '--------------------------------',
    busInfo:      `Bus: ${busNum}`,
    tripInfo:     tripNumber > 0 ? `Trip #: ${tripNumber}` : null,
    dateTime:     `${dp}  ${tp}`,
    route:        `${fn}  to  ${tn}`,
    fullFare:     `ADULT   Rs ${fareStr(fareN)}`,
    halfFare:     null,
    luggageFare:  null,
    fortune,
    footer:       'Powered by RoutePass',
    total:        fareN,
  };

  // Verify ticket in Supabase
  try {
    await supabase.from('tickets').update({ is_verified: true }).eq('id', ticket.ticket_id);
  } catch {}

  if (isTestingMode) {
    await cancelTicketNotification(notifId);
    return { ticketInfo, isTestingMode: true };
  }

  await NyxPrinter.printText(ticketInfo.header, { textSize: 28, align: PrintAlign.CENTER });
  if (ticketInfo.ticketNumber) {
    await NyxPrinter.printText(ticketInfo.ticketNumber, { textSize: 24, align: PrintAlign.CENTER });
  }
  await NyxPrinter.printText(ticketInfo.separator, { align: PrintAlign.CENTER });
  await NyxPrinter.printText(ticketInfo.busInfo, { textSize: 24, align: PrintAlign.CENTER });
  if (ticketInfo.tripInfo) {
    await NyxPrinter.printText(ticketInfo.tripInfo, { textSize: 24, align: PrintAlign.CENTER });
  }
  await NyxPrinter.printText(ticketInfo.dateTime, { textSize: 24, align: PrintAlign.CENTER });
  await NyxPrinter.printText(ticketInfo.separator, { align: PrintAlign.CENTER });
  await NyxPrinter.printText(ticketInfo.route, { textSize: 24, align: PrintAlign.CENTER });
  await NyxPrinter.printText(ticketInfo.separator, { align: PrintAlign.CENTER });
  await NyxPrinter.printText(ticketInfo.fullFare, { textSize: 24, align: PrintAlign.CENTER });
  await NyxPrinter.printText(ticketInfo.separator, { align: PrintAlign.CENTER });
  await NyxPrinter.printText(ticketInfo.fortune, { textSize: 18, align: PrintAlign.CENTER });
  await NyxPrinter.printText(ticketInfo.separator, { align: PrintAlign.CENTER });
  await NyxPrinter.printText(ticketInfo.footer, { textSize: 18, align: PrintAlign.CENTER });
  await NyxPrinter.printEndAutoOut();

  await cancelTicketNotification(notifId);
  return { ticketInfo, isTestingMode: false };
}

// ─── Foreground event handler (call once in your root component / screen) ─────
/**
 * Call this inside a useEffect in TripScreen (or App).
 * Returns the unsubscribe function.
 *
 * onPrintSuccess(notifId, ticket) — called after a successful foreground print
 * so TripScreen can update its local state.
 */
export function registerForegroundHandler(onPrintSuccess) {
  return notifee.onForegroundEvent(async ({ type, detail }) => {
    const { notification, pressAction } = detail;
    const notifId = notification?.id;
    if (!notifId) return;

    if (type === EventType.ACTION_PRESS) {
      if (pressAction?.id === 'print') {
        try {
          const ticket = await getStoredTicket(notifId);
          const result = await printTicketFromNotif(notifId);
          if (onPrintSuccess && ticket) onPrintSuccess(notifId, ticket, result);
        } catch (e) {
          console.warn('[TicketNotif] foreground print error:', e?.message);
        }
      } else if (pressAction?.id === 'dismiss') {
        await cancelTicketNotification(notifId);
      }
    } else if (type === EventType.DISMISSED) {
      await removeStoredTicket(notifId);
    }
  });
}
