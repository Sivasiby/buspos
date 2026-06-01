import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { schema } from './schema';
import Ticket from './models/Ticket';

const adapter = new SQLiteAdapter({
  schema,
  dbName: 'ticketingApp',   // your SQLite file name
  jsi: true,                // enables faster JSI mode on Android
  onSetUpError: error => {
    console.error('DB setup error:', error);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [Ticket],
});