import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class Ticket extends Model {
  static table = 'tickets';

  @field('local_id')      localId;       // e.g. "pos_1711012345_abc12"
  @field('trip_id')       tripId;        // activeTrip.trip_id (uuid | null)
  @field('from_stop')     fromStop;      // full label e.g. "Athipalayam-017-..."
  @field('to_stop')       toStop;
  @field('from_key')      fromKey;       // fareMatrix key
  @field('to_key')        toKey;
  @field('ticket_count')  ticketCount;   // number
  @field('fare')          fare;          // total fare (unit_fare × count)
  @field('unit_fare')     unitFare;
  @field('ticket_type')   ticketType;    // 'full' | 'half'
  @field('luggage_amount') luggageAmount;
  @field('ticket_number') ticketNumber;  // sequential number from RPC
  @field('bus_number')    busNumber;
  @field('trip_number')   tripNumber;
  @field('direction')     direction;     // 'up' | 'dn'
  @field('issued_at')     issuedAt;      // ISO timestamp string
  @field('synced')        synced;        // 0 = unsynced, 1 = synced to Supabase

  @readonly @date('created_at') createdAt;
  @readonly @date('updated_at') updatedAt;
}