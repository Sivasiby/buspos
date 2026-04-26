import React, { createContext, useContext, useMemo, useState } from 'react';
import { usePosTicketCounter } from '../hooks/usePosTicketCounter';

type ActiveTrip = Record<string, any> | null;

type TripContextValue = {
  activeTrip: ActiveTrip;
  setActiveTrip: React.Dispatch<React.SetStateAction<ActiveTrip>>;
  busNumber: string;
  setBusNumber: React.Dispatch<React.SetStateAction<string>>;
  tripNumber: number | null;
  setTripNumber: React.Dispatch<React.SetStateAction<number | null>>;
  posHook: ReturnType<typeof usePosTicketCounter>;
};

const TripContext = createContext<TripContextValue | undefined>(undefined);

type TripProviderProps = {
  children: React.ReactNode;
};

export const TripProvider = ({ children }: TripProviderProps) => {
  const [activeTrip, setActiveTrip] = useState<ActiveTrip>(null);
  const [busNumber, setBusNumber] = useState('');
  const [tripNumber, setTripNumber] = useState<number | null>(null);
  const posHook = usePosTicketCounter();

  const value = useMemo(
    () => ({
      activeTrip,
      setActiveTrip,
      busNumber,
      setBusNumber,
      tripNumber,
      setTripNumber,
      posHook,
    }),
    [activeTrip, busNumber, tripNumber, posHook],
  );

  return <TripContext.Provider value={value}>{children}</TripContext.Provider>;
};

export const useTripContext = () => {
  const context = useContext(TripContext);
  if (!context) {
    throw new Error('useTripContext must be used within TripProvider');
  }
  return context;
};