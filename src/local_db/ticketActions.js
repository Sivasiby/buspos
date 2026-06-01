import { Q } from '@nozbe/watermelondb';
import { database } from './index';

const tickets = database.get('tickets');

// READ ALL (returns raw WatermelonDB records)
export async function fetchAllTickets() {
  return await tickets.query().fetch();
}

// READ — only unsynced tickets
export async function fetchUnsyncedTickets() {
  return await tickets.query(Q.where('synced', false)).fetch();
}

// READ — tickets for a specific trip
export async function fetchTicketsForTrip(tripId) {
  return await tickets.query(Q.where('trip_id', tripId)).fetch();
}

// DELETE (permanent hard delete)
export async function deleteTicket(ticket) {
  await database.write(async () => {
    await ticket.destroyPermanently();
  });
}