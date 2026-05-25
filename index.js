/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import notifee, { EventType } from '@notifee/react-native';
import { printTicketFromNotif, cancelTicketNotification, removeStoredTicket } from './src/services/ticketNotification';

// ─── Notifee background event handler ─────────────────────────────────────────
// Runs when a notification action is pressed and the app is in the background or killed.
notifee.onBackgroundEvent(async ({ type, detail }) => {
  const { notification, pressAction } = detail;
  const notifId = notification?.id;
  if (!notifId) return;

  if (type === EventType.ACTION_PRESS) {
    if (pressAction?.id === 'print') {
      try {
        await printTicketFromNotif(notifId);
      } catch (e) {
        console.warn('[Notifee] BG print error:', e?.message);
      }
    } else if (pressAction?.id === 'dismiss') {
      await cancelTicketNotification(notifId);
    }
  } else if (type === EventType.DISMISSED) {
    await removeStoredTicket(notifId);
  }
});

AppRegistry.registerComponent(appName, () => App);
