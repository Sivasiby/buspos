import React, { createContext, useContext, useState } from 'react';
import { usePOSTickets } from '../hooks/usePOSTickets';

interface ActiveTrip {
  trip_id: string | null;
  route_name?: string;
  direction?: string;
  start_time?: string;
  status?: string;
  bus_id?: string | null;
  bus_number?: string | null;
  conductor_id?: string | null;
  trip_number?: number | null;
  [key: string]: any;
}

type POSHook = ReturnType<typeof usePOSTickets>;

interface TripContextValue {
  activeTrip: ActiveTrip | null;
  setActiveTrip: (trip: ActiveTrip | null) => void;
  busNumber: string;
  setBusNumber: (n: string) => void;
  tripNumber: number;
  setTripNumber: (n: number) => void;
  posHook: POSHook;
}

const stubPosHook: POSHook = {
  tickets: [],
  syncing: false,
  unsyncedCount: 0,
  saveTicket: async () => {},
  syncToDb: async () => {},
  syncPending: async () => {},
  reload: async () => {},
  todayTickets: () => [],
  ticketsForTrip: () => [],
  todayByTrip: () => ({}),
  stageBreakdown: () => [],
  todaySummary: () => ({ trips: 0, rows: 0, count: 0, full: 0, half: 0, luggage: 0, total: 0, unsynced: 0 }),
  tripSummary: () => ({ rows: 0, count: 0, full: 0, half: 0, luggage: 0, total: 0 }),
  clearAll: async () => {},
};

const TripContext = createContext<TripContextValue>({
  activeTrip: null,
  setActiveTrip: () => {},
  busNumber: 'N/A',
  setBusNumber: () => {},
  tripNumber: 0,
  setTripNumber: () => {},
  posHook: stubPosHook,
});

export const TripProvider = ({ children }: { children: React.ReactNode }) => {
  const [activeTrip, setActiveTrip] = useState<ActiveTrip | null>(null);
  const [busNumber, setBusNumber] = useState('N/A');
  const [tripNumber, setTripNumber] = useState(0);
  const posHook = usePOSTickets();

  return (
    <TripContext.Provider value={{ activeTrip, setActiveTrip, busNumber, setBusNumber, tripNumber, setTripNumber, posHook }}>
      {children}
    </TripContext.Provider>
  );
};

export const useTripContext = () => useContext(TripContext);
