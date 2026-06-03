/**
 * App.tsx — root entry point
 *
 * Flow:  splash → (check AsyncStorage) → LoginScreen or Tab Navigator (Home, Trip, Tickets)
 */

import React, {useState, useEffect, useRef, useCallback} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  View,
  TouchableOpacity,
  Text,
} from 'react-native';
import {SafeAreaView, SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {NavigationContainer} from '@react-navigation/native';
import {useNavigationBuilder, createNavigatorFactory, TabRouter} from '@react-navigation/core';
import {Home, Bus, Ticket, Settings, FlaskConical, Smartphone} from 'lucide-react-native';
import PagerView from 'react-native-pager-view';

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

const STORAGE_KEY = 'conductor_user';

const ACTIVE_COLOR   = '#00b7f3';
const INACTIVE_COLOR = '#999';
const TAB_BG         = '#000000';
const TAB_BORDER     = '#333';
const TAB_HEIGHT     = 60;

// ─── Custom swipeable navigator ───────────────────────────────────────────────
// Built with createNavigatorFactory + useNavigationBuilder so we own the full
// layout. PagerView is the ONLY place screens render — no double rendering.
// NavigationContainer is still in the tree so useNavigation / navigate() work.
function SwipeableTabNavigator({ initialRouteName, children, screenOptions, onLogout }: any) {
  const { state, navigation, descriptors, NavigationContent } = useNavigationBuilder(TabRouter, {
    children,
    screenOptions,
    initialRouteName,
  });

  const insets   = useSafeAreaInsets();
  const pagerRef = useRef<PagerView>(null);
  const prevIndex = useRef(state.index);

  useEffect(() => {
    if (state.index !== prevIndex.current) {
      pagerRef.current?.setPage(state.index);
      prevIndex.current = state.index;
    }
  }, [state.index]);

  const handlePageSelected = useCallback(
    (e: {nativeEvent: {position: number}}) => {
      const newIndex = e.nativeEvent.position;
      if (newIndex !== state.index) {
        navigation.navigate(state.routes[newIndex].name);
      }
    },
    [state, navigation],
  );

  const handleTabPress = useCallback(
    (index: number, routeName: string) => {
      pagerRef.current?.setPage(index);
      if (index !== state.index) {
        navigation.navigate(routeName);
      }
    },
    [state.index, navigation],
  );

  return (
    <NavigationContent>
      <View style={styles.container}>
        {/* Swipeable pages — only place screens are rendered */}
        <PagerView
          ref={pagerRef}
          style={styles.pager}
          initialPage={state.index}
          onPageSelected={handlePageSelected}
          overdrag={false}>
          {state.routes.map(route => (
            <View key={route.key} style={styles.page}>
              {descriptors[route.key].render()}
            </View>
          ))}
        </PagerView>

        {/* Bottom tab bar */}
        <View style={[styles.tabBar, {paddingBottom: insets.bottom > 0 ? insets.bottom : 5}]}>
          {state.routes.map((route: any, index: number) => {
            const { options } = descriptors[route.key];
            const label  = (options.tabBarLabel as string) ?? route.name;
            const active = state.index === index;
            const color  = active ? ACTIVE_COLOR : INACTIVE_COLOR;
            const IconComponent = options.tabBarIcon as
              | React.ComponentType<{color: string; size: number}>
              | undefined;
            const badge = options.tabBarBadge as string | undefined;

            return (
              <TouchableOpacity
                key={route.key}
                style={styles.tabItem}
                onPress={() => handleTabPress(index, route.name)}
                activeOpacity={0.7}>
                <View>
                  {IconComponent && <IconComponent color={color} size={22} />}
                  {badge != null && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{badge}</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.tabLabel, {color}]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </NavigationContent>
  );
}

// Create the navigator ONCE at module level — never inside a component
const createSwipeableTabs = createNavigatorFactory(SwipeableTabNavigator);
const SwipeTabs = createSwipeableTabs();

// ─── Tab Navigator ─────────────────────────────────────────────────────────────
function TabNavigator({ onLogout }: { onLogout: () => void }) {
  return (
    <SwipeTabs.Navigator initialRouteName="Home" onLogout={onLogout}>
      <SwipeTabs.Screen name="Home"     component={HomeScreen}
        options={{ tabBarLabel: 'Home',     tabBarIcon: ({color, size}: any) => <Home     color={color} size={size} /> }} />
      <SwipeTabs.Screen name="Report"   component={ReportScreen}
        options={{ tabBarLabel: 'Reports',   tabBarIcon: ({color, size}: any) => <Ticket   color={color} size={size} /> }} />
      <SwipeTabs.Screen name="Trip"     component={TripScreen}
        options={{ tabBarLabel: 'App',     tabBarIcon: ({color, size}: any) => <Smartphone      color={color} size={size} /> }} />
      <SwipeTabs.Screen name="Settings"
        options={{ tabBarLabel: 'Settings', tabBarIcon: ({color, size}: any) => <Settings color={color} size={size} /> }}>
        {() => <SettingsScreen onLogout={onLogout} />}
      </SwipeTabs.Screen>
      {__DEV__ && (
        <SwipeTabs.Screen name="Test" component={TestScreen}
          options={{ tabBarLabel: 'Test', tabBarIcon: ({color, size}: any) => <FlaskConical color={color} size={size} />, tabBarBadge: 'DEV' }} />
      )}
    </SwipeTabs.Navigator>
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
      <SafeAreaProvider>
        <SafeAreaView style={styles.splash}>
          <ActivityIndicator size="large" color="#00b7f3" />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!user) {
    return (
      <SafeAreaProvider>
        <LoginScreen onLoginSuccess={handleLoginSuccess} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <TripProvider>
        <View style={{flex: 1, backgroundColor: '#000000'}}>
          <NavigationContainer>
            <TabNavigator onLogout={handleLogout} />
          </NavigationContainer>
        </View>
      </TripProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000000',
  },
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  pager: {
    flex: 1,
  },
  page: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: TAB_BG,
    borderTopWidth: 1,
    borderTopColor: TAB_BORDER,
    paddingTop: 8,
    alignItems: 'center',
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tabLabel: {
    fontSize: 10,
    marginTop: 2,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: '#ef4444',
    borderRadius: 6,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  badgeText: {
    color: '#fff',
    fontSize: 7,
    fontWeight: '700',
  },
});