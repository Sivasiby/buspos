/**
 * App.tsx — root entry point
 *
 * Flow:  splash → (check AsyncStorage) → LoginScreen or Tab Navigator (Home, Trip, Tickets)
 */

import React, {useState, useEffect} from 'react';
import {ActivityIndicator, StyleSheet} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {NavigationContainer} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {Home, Bus, Ticket, Settings, FlaskConical} from 'lucide-react-native';

import './global.css';
import { requestNotificationPermission } from './src/services/ticketNotification';

import LoginScreen from './src/screens/LoginScreen';
import {TripProvider} from './src/context/TripContext';
import HomeScreen  from './src/screens/HomeScreen';
import TripScreen  from './src/screens/TripScreen';
import TicketScreen from './src/screens/TicketScreen';
import ReportScreen from './src/components/ReportScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import TestScreen from './src/screens/Test';

const Tab = createBottomTabNavigator();

const STORAGE_KEY = 'conductor_user';

// Icon components for tabs
const HomeIcon = ({color, size}: {color: string; size: number}) => <Home size={size} color={color} />;
const BusIcon = ({color, size}: {color: string; size: number}) => <Bus size={size} color={color} />;
const TicketIcon = ({color, size}: {color: string; size: number}) => <Ticket size={size} color={color} />;
const SettingsIcon = ({color, size}: {color: string; size: number}) => <Settings size={size} color={color} />;
const TestIcon = ({color, size}: {color: string; size: number}) => <FlaskConical size={size} color={color} />;

// Tab Navigator Component
function TabNavigator({ onLogout }: { onLogout: () => void }) {
  return (
    <Tab.Navigator
      id="main-tabs"
      screenOptions={{
        tabBarActiveTintColor: '#00b7f3',
        tabBarInactiveTintColor: '#999',
        tabBarStyle: {
          backgroundColor: '#000000',
          borderTopWidth: 1,
          borderTopColor: '#333',
          paddingBottom: 5,
          height: 60,
        },
        headerShown: false,
      }}>
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: HomeIcon,
        }}
      />
      <Tab.Screen
        name="Trip"
        component={TripScreen}
        options={{
          tabBarLabel: 'Trip',
          tabBarIcon: BusIcon,
        }}
      />
      <Tab.Screen
        name="Report"
        component={ReportScreen}
        options={{
          tabBarLabel: 'Report',
          tabBarIcon: TicketIcon,
        }}
      />
      <Tab.Screen
        name="Settings"
        options={{
          tabBarLabel: 'Settings',
          tabBarIcon: SettingsIcon,
        }}>
        {() => <SettingsScreen onLogout={onLogout} />}
      </Tab.Screen>
      {__DEV__ && (
        <Tab.Screen
          name="Test"
          component={TestScreen}
          options={{
            tabBarLabel: 'Test',
            tabBarIcon: TestIcon,
            tabBarBadge: 'DEV',
          }}
        />
      )}
    </Tab.Navigator>
  );
}

export default function App() {
  const [user, setUser]         = useState<any>(null);
  const [checking, setChecking] = useState(true);

  // Restore saved session on launch
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(raw => {
        if (raw) {
          setUser(JSON.parse(raw));
          requestNotificationPermission().catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  const handleLoginSuccess = async (userData: any) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(userData));
    } catch {}
    requestNotificationPermission().catch(() => {});
    setUser(userData);
  };

  const handleLogout = async () => {
    try {
      await AsyncStorage.multiRemove([STORAGE_KEY, 'access_token', 'selected_bus']);
    } catch {}
    setUser(null);
  };

  // Splash / checking state
  if (checking) {
    return (
      <SafeAreaView style={styles.splash}>
        <ActivityIndicator size="large" color="#00b7f3" />
      </SafeAreaView>
    );
  }

  if (!user) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <TripProvider>
      <SafeAreaView style={{flex: 1, backgroundColor: '#000000'}}>
        <NavigationContainer>
          <TabNavigator onLogout={handleLogout} />
        </NavigationContainer>
      </SafeAreaView>
    </TripProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000000',
  },
});