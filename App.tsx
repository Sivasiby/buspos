/**
 * App.tsx — root entry point
 *
 * Flow:  splash → (check AsyncStorage) → LoginScreen or POSScreen
 *
 * No react-navigation needed — we just swap components via state.
 */

import React, {useState, useEffect} from 'react';
import {ActivityIndicator, View, StyleSheet} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import LoginScreen from './src/screens/LoginScreen';
import POSScreen   from './src/screens/Posscreen';

// ─── Adjust the import paths above if your folder layout differs ──────────────
//   e.g. if App.tsx sits inside src/, use:
//     import LoginScreen from './screens/LoginScreen';
//     import POSScreen   from './screens/POSScreen';

const STORAGE_KEY = 'conductor_user';

export default function App() {
  const [user, setUser]         = useState<any>(null);
  const [checking, setChecking] = useState(true);

  // Restore saved session on launch
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(raw => { if (raw) setUser(JSON.parse(raw)); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  const handleLoginSuccess = async (userData: any) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(userData));
    } catch {}
    setUser(userData);
  };

  const handleLogout = async () => {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {}
    setUser(null);
  };

  // Splash / checking state
  if (checking) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#00b7f3" />
      </View>
    );
  }

  if (!user) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  return <POSScreen user={user} onLogout={handleLogout} />;
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0d1b2e',
  },
});