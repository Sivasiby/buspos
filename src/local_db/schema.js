import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 2,
  tables: [
    tableSchema({
      name: 'tickets',
      columns: [
        { name: 'local_id',      type: 'string' },            // local pos_* id
        { name: 'trip_id',       type: 'string', isOptional: true },
        { name: 'from_stop',     type: 'string' },
        { name: 'to_stop',       type: 'string' },
        { name: 'from_key',      type: 'string' },
        { name: 'to_key',        type: 'string' },
        { name: 'ticket_count',  type: 'number' },
        { name: 'fare',          type: 'number' },             // total fare
        { name: 'unit_fare',     type: 'number' },
        { name: 'ticket_type',   type: 'string' },             // 'full' | 'half'
        { name: 'luggage_amount', type: 'number' },
        { name: 'ticket_number', type: 'number', isOptional: true },
        { name: 'bus_number',    type: 'string' },
        { name: 'trip_number',   type: 'number', isOptional: true },
        { name: 'direction',     type: 'string' },             // 'up' | 'dn'
        { name: 'issued_at',     type: 'string' },             // ISO timestamp
        { name: 'synced',        type: 'boolean' },            // synced to Supabase?
        { name: 'created_at',    type: 'number' },
        { name: 'updated_at',    type: 'number' },
      ],
    }),
  ],
});