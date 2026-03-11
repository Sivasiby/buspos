import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import api from '../API/api';

export default function LoginScreen() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [error, setError]       = useState('');
  const [deviceId, setDeviceId] = useState('POS-WEB');

  useEffect(() => {
    (async () => {
      try {
        let id = await AsyncStorage.getItem('device_id');
        if (!id) {
          id = 'POS-' + Math.random().toString(36).substr(2, 9).toUpperCase();
          await AsyncStorage.setItem('device_id', id);
        }
        setDeviceId(id);
      } catch (e) {
        setDeviceId('POS-' + Date.now());
      }
    })();
  }, []);

  const handleLogin = async () => {
    setError('');
    const em = email.trim().toLowerCase();
    const pw = password.trim();

    if (!em || !pw) {
      setError('Please enter your email and password.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/auth/login', {
        email: em,
        password: pw,
        device_id: deviceId,
      });

      const { access_token, role } = res.data;

      if (!access_token) {
        setError('Unexpected server response.');
        return;
      }

      if (role !== 'conductor') {
        setError(`Access denied. Conductors only.\nYour role: ${role}`);
        return;
      }

      const user = { role };
      await AsyncStorage.setItem('token', access_token);
      await AsyncStorage.setItem('user', JSON.stringify(user));

      // Navigate to BusPOS dashboard
      router.replace('/(tabs)/Screens/BusPOS');

    } catch (e) {
      console.error('Login error:', e);
      const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message || '';
      setError(msg || 'Login failed. Check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <StatusBar barStyle="light-content" backgroundColor="#080808" />

      {/* ── Brand ── */}
      <View style={styles.brand}>
        <Text style={styles.busIcon}>🚌</Text>
        <Text style={styles.appName}>TransitPOS</Text>
        <Text style={styles.appSub}>CONDUCTOR TERMINAL</Text>
        <View style={styles.divider} />
      </View>

      {/* ── Card ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>▸ SIGN IN</Text>

        {/* Email */}
        <Text style={styles.label}>EMAIL</Text>
        <View style={[styles.inputWrap, error && !password && styles.inputError]}>
          <Text style={styles.inputIcon}>✉️</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={v => { setEmail(v); setError(''); }}
            placeholder="Enter your email"
            placeholderTextColor="#444"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            returnKeyType="next"
          />
        </View>

        {/* Password */}
        <Text style={styles.label}>PASSWORD</Text>
        <View style={[styles.inputWrap, error && styles.inputError]}>
          <Text style={styles.inputIcon}>🔒</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={v => { setPassword(v); setError(''); }}
            placeholder="Enter password"
            placeholderTextColor="#444"
            secureTextEntry={!showPass}
            returnKeyType="done"
            onSubmitEditing={handleLogin}
          />
          <TouchableOpacity onPress={() => setShowPass(v => !v)} style={styles.eyeBtn}>
            <Text style={styles.eyeIcon}>{showPass ? '🙈' : '👁️'}</Text>
          </TouchableOpacity>
        </View>

        {/* Error */}
        {!!error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorIcon}>✗</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Login button */}
        <TouchableOpacity
          style={[styles.loginBtn, loading && styles.loginBtnDisabled]}
          onPress={handleLogin}
          disabled={loading}
          activeOpacity={0.85}>
          {loading
            ? <ActivityIndicator color="#000" size="small" />
            : <Text style={styles.loginBtnText}>▶  LOGIN</Text>}
        </TouchableOpacity>

        {/* Server info */}
        <View style={styles.serverRow}>
          <View style={styles.serverDot} />
          <Text style={styles.serverText}>ngrok · untouchably-easier-cheree</Text>
        </View>
      </View>

      {/* ── Footer ── */}
      <Text style={styles.footer}>For conductors only · TransitPOS v3.0</Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#080808',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },

  // Brand
  brand: { alignItems: 'center', marginBottom: 32 },
  busIcon: { fontSize: 48, marginBottom: 10 },
  appName: {
    fontSize: 32,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 4,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier New',
  },
  appSub: {
    fontSize: 11,
    color: '#555',
    letterSpacing: 3,
    marginTop: 4,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier New',
  },
  divider: {
    width: 48,
    height: 2,
    backgroundColor: '#f0a500',
    marginTop: 16,
  },

  // Card
  card: {
    backgroundColor: '#0f0f0f',
    borderWidth: 1,
    borderColor: '#1e1e1e',
    borderLeftWidth: 3,
    borderLeftColor: '#f0a500',
    padding: 20,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 11,
    color: '#888',
    letterSpacing: 2,
    marginBottom: 20,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier New',
  },

  // Labels
  label: {
    fontSize: 9,
    color: '#666',
    letterSpacing: 2,
    marginBottom: 6,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier New',
  },

  // Inputs
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    marginBottom: 14,
    paddingHorizontal: 12,
  },
  inputError: { borderColor: '#a44' },
  inputIcon: { fontSize: 16, marginRight: 10 },
  input: {
    flex: 1,
    color: '#e0d5c0',
    fontSize: 14,
    paddingVertical: 12,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier New',
  },
  eyeBtn: { padding: 4 },
  eyeIcon: { fontSize: 16 },

  // Error
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#2a0a0a',
    borderWidth: 1,
    borderColor: '#a44',
    padding: 10,
    marginBottom: 14,
    gap: 8,
  },
  errorIcon: { color: '#d96', fontSize: 12, marginTop: 1 },
  errorText: {
    flex: 1,
    color: '#d96',
    fontSize: 11,
    letterSpacing: 0.5,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier New',
  },

  // Button
  loginBtn: {
    backgroundColor: '#f0a500',
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  loginBtnDisabled: { backgroundColor: '#4a3a00' },
  loginBtnText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 3,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier New',
  },

  // Server indicator
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 14,
  },
  serverDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4dbb6d',
  },
  serverText: {
    fontSize: 10,
    color: '#444',
    letterSpacing: 1,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier New',
  },

  footer: {
    textAlign: 'center',
    fontSize: 10,
    color: '#2a2a2a',
    letterSpacing: 1,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier New',
  },
});