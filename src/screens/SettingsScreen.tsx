import React, {useState} from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  Switch,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Settings,
  LogOut,
  Bell,
  Moon,
  Info,
  ChevronRight,
} from 'lucide-react-native';

type SettingItemProps = {
  icon: React.ReactNode;
  title: string;
  description?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
};

const SettingItem = ({
  icon,
  title,
  description,
  onPress,
  rightElement,
}: SettingItemProps) => (
  <TouchableOpacity
    style={ss.item}
    onPress={onPress}
    activeOpacity={0.7}
    disabled={!onPress}>
    <View style={ss.itemLeft}>
      <View style={ss.iconWrap}>{icon}</View>
      <View style={ss.itemText}>
        <Text style={ss.itemTitle}>{title}</Text>
        {description && <Text style={ss.itemDesc}>{description}</Text>}
      </View>
    </View>
    {rightElement || (onPress && <ChevronRight size={20} color="#999" />)}
  </TouchableOpacity>
);

export default function SettingsScreen() {
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [darkModeEnabled, setDarkModeEnabled] = useState(true);

  const handleLogout = async () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            try {
              await AsyncStorage.multiRemove(['conductor_user', 'access_token']);
              Alert.alert('Logged Out', 'You have been logged out successfully.');
            } catch {
              Alert.alert('Error', 'Failed to logout');
            }
          },
        },
      ],
    );
  };

  const handleAbout = () => {
    Alert.alert(
      'About BusPOS',
      'BusPOS Conductor Terminal\nVersion 1.0.0\n\n© 2024 SPS - ZYRAP',
    );
  };

  return (
    <SafeAreaView style={ss.safeArea}>
      <View style={ss.header}>
        <Settings size={28} color="#00b7f3" />
        <Text style={ss.headerTitle}>Settings</Text>
      </View>

      <ScrollView style={ss.scroll} showsVerticalScrollIndicator={false}>
        {/* Preferences Section */}
        <Text style={ss.sectionTitle}>Preferences</Text>
        <View style={ss.section}>
          <SettingItem
            icon={<Bell size={22} color="#00b7f3" />}
            title="Notifications"
            description="Enable ticket alerts"
            rightElement={
              <Switch
                value={notificationsEnabled}
                onValueChange={setNotificationsEnabled}
                trackColor={{false: '#767577', true: '#00b7f3'}}
                thumbColor="#fff"
              />
            }
          />
          <SettingItem
            icon={<Moon size={22} color="#00b7f3" />}
            title="Dark Mode"
            description="Use dark theme"
            rightElement={
              <Switch
                value={darkModeEnabled}
                onValueChange={setDarkModeEnabled}
                trackColor={{false: '#767577', true: '#00b7f3'}}
                thumbColor="#fff"
              />
            }
          />
        </View>

        {/* Account Section */}
        <Text style={ss.sectionTitle}>Account</Text>
        <View style={ss.section}>
          <SettingItem
            icon={<LogOut size={22} color="#F44336" />}
            title="Logout"
            description="Sign out of your account"
            onPress={handleLogout}
          />
        </View>

        {/* About Section */}
        <Text style={ss.sectionTitle}>About</Text>
        <View style={ss.section}>
          <SettingItem
            icon={<Info size={22} color="#00b7f3" />}
            title="About"
            description="App version and info"
            onPress={handleAbout}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const ss = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fff',
  },
  scroll: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 24,
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  section: {
    backgroundColor: '#1a1a1a',
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  itemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#0d1b2e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemText: {
    flex: 1,
  },
  itemTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  itemDesc: {
    fontSize: 13,
    color: '#888',
    marginTop: 2,
  },
});
