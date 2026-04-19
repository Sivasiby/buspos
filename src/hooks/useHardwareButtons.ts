import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';

const DOUBLE_PRESS_DELAY = 800; // ms window for double press

interface UseHardwareButtonsOptions {
  onPowerDoublePress?: () => void;
}

export function useHardwareButtons({ onPowerDoublePress }: UseHardwareButtonsOptions = {}) {
  const lastPowerPressTime = useRef<number | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      // Power button press: app goes from active → background (screen off)
      if (prevState === 'active' && nextState === 'background') {
        const now = Date.now();

        if (
          lastPowerPressTime.current !== null &&
          now - lastPowerPressTime.current <= DOUBLE_PRESS_DELAY
        ) {
          console.log('[HardwareButtons] Power button double press detected');
          onPowerDoublePress?.();
          lastPowerPressTime.current = null;
        } else {
          lastPowerPressTime.current = now;
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, [onPowerDoublePress]);
}
