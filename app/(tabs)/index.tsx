import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function Index() {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const token = await AsyncStorage.getItem('token');
        const raw   = await AsyncStorage.getItem('user');

        if (token && raw) {
          const user = JSON.parse(raw);
          if (user?.role === 'conductor') {
            router.replace('/(tabs)/Screens/BusPOS');
            return;
          }
        }
        // No valid session → go to login
        router.replace('/(tabs)/Screens/login');
      } catch (e) {
        router.replace('/(tabs)/Screens/login');
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  return (
    <View style={styles.splash}>
      <ActivityIndicator size="large" color="#f0a500" />
    </View>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#080808',
    justifyContent: 'center',
    alignItems: 'center',
  },
});