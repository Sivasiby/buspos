import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Home, Ticket, Settings, LucideIcon } from 'lucide-react-native';

// Import Screens
import HomeScreen from './src/screens/HomeScreen';
import TicketScreen from './src/screens/TicketScreen';
import ManageScreen from './src/screens/ManageScreen';

const Tab = createBottomTabNavigator();

const COLORS = {
  bg: '#0F0F0F',
  surface: '#1A1A1A',
  border: '#2A2A2A',
  primary: '#FFFFFF',
  secondary: '#888888',
  accent: '#FFFFFF',
};

const getTabBarIcon = (routeName: string, focused: boolean, color: string, size: number) => {
  let Icon: LucideIcon = Home;

  if (routeName === 'Home') {
    Icon = Home;
  } else if (routeName === 'Tickets') {
    Icon = Ticket;
  } else if (routeName === 'Manage') {
    Icon = Settings;
  }

  return <Icon size={size} color={color} strokeWidth={focused ? 2 : 1.5} />;
};

export default function App() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: {
            backgroundColor: COLORS.surface,
            borderTopColor: COLORS.border,
            borderTopWidth: 1,
            paddingBottom: 5,
            paddingTop: 5,
            height: 60,
          },
          tabBarActiveTintColor: COLORS.primary,
          tabBarInactiveTintColor: COLORS.secondary,
          tabBarIcon: ({ focused, color, size }) => getTabBarIcon(route.name, focused, color, size),
        })}
      >
        <Tab.Screen name="Home" component={HomeScreen} />
        <Tab.Screen name="Tickets" component={TicketScreen} />
        <Tab.Screen name="Manage" component={ManageScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
