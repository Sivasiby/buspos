import React, {useState, useRef, useEffect} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Animated,
  StatusBar,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Bus, Mail, Lock, Eye, EyeOff, LogIn} from 'lucide-react-native';
import api from '../api/api';

// ─── Types ────────────────────────────────────────────────────────────────────
type LoginScreenProps = {
  onLoginSuccess: (user: any) => void;
};

// ─── Pulsing dot ──────────────────────────────────────────────────────────────
const PulsingDot = ({
  delay = 0,
  color = '#00b7f3',
}: {
  delay?: number;
  color?: string;
}) => {
  const anim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, {toValue: 1,   duration: 600, useNativeDriver: true}),
        Animated.timing(anim, {toValue: 0.4, duration: 600, useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim, delay]);

  return (
    <Animated.View style={[ls.dot, {backgroundColor: color, opacity: anim}]} />
  );
};

// ─── LoginScreen ──────────────────────────────────────────────────────────────
const LoginScreen = ({onLoginSuccess}: LoginScreenProps) => {
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [showPass, setShowPass]   = useState(false);
  const [loading, setLoading]     = useState(false);

  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(40)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim,  {toValue: 1, duration: 700, useNativeDriver: true}),
      Animated.timing(slideAnim, {toValue: 0, duration: 700, useNativeDriver: true}),
    ]).start();
  }, [fadeAnim, slideAnim]);

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, {toValue: 10,  duration: 60, useNativeDriver: true}),
      Animated.timing(shakeAnim, {toValue: -10, duration: 60, useNativeDriver: true}),
      Animated.timing(shakeAnim, {toValue: 8,   duration: 60, useNativeDriver: true}),
      Animated.timing(shakeAnim, {toValue: -8,  duration: 60, useNativeDriver: true}),
      Animated.timing(shakeAnim, {toValue: 0,   duration: 60, useNativeDriver: true}),
    ]).start();
  };

  // ── Same logic as AuthScreen ──────────────────────────────────────────────
  const handleLogin = async () => {
    if (!email || !password) {
      shake();
      return;
    }
    setLoading(true);

    try {
      const res = await api.post('/auth/login', {
        email,
        password,
      });

      if (res.status === 200) {
        await AsyncStorage.setItem('access_token', res.data.access_token);
        onLoginSuccess(res.data.user ?? res.data);
      }
    } catch (error: any) {
      shake();
      if (error.response?.data?.code === 'invalid_password') {
        Alert.alert('Login Failed', 'Please enter a valid password.');
      } else if (error.response?.data?.code === 'no_user') {
        Alert.alert('Login Failed', 'No user found with this email!');
      } else {
        Alert.alert(
          'Login Failed',
          error.response?.data?.message || 'Could not connect. Check your network.',
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={ls.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#0d1b2e" />

      {/* Decorative blobs */}
      <View style={ls.blobTop} />
      <View style={ls.blobBottom} />

      <KeyboardAvoidingView
        style={ls.kav}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>

        <Animated.View
          style={[ls.inner, {opacity: fadeAnim, transform: [{translateY: slideAnim}]}]}>

          {/* ── Brand ── */}
          <View style={ls.brand}>
            <View style={ls.busIconWrap}>
              <Bus size={38} color="#00b7f3" />
              <View style={ls.dotsRow}>
                <PulsingDot delay={0}   color="#00b7f3" />
                <PulsingDot delay={200} color="#00e5ff" />
                <PulsingDot delay={400} color="#00b7f3" />
              </View>
            </View>
            <Text style={ls.brandName}>BusPOS</Text>
            <Text style={ls.brandSub}>Conductor Terminal</Text>
          </View>

          {/* ── Card ── */}
          <Animated.View style={[ls.card, {transform: [{translateX: shakeAnim}]}]}>
            <Text style={ls.cardTitle}>Welcome Back</Text>
            <Text style={ls.cardSub}>Please sign in to continue</Text>

            {/* Email field */}
            <View style={ls.fieldWrap}>
              <Text style={ls.fieldLabel}>Email</Text>
              <View style={ls.inputRow}>
                <Mail size={20} color="#00b7f3" style={ls.inputIcon} />
                <TextInput
                  style={ls.input}
                  placeholder="Enter your email"
                  placeholderTextColor="#8899aa"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                />
              </View>
            </View>

            {/* Password field */}
            <View style={ls.fieldWrap}>
              <Text style={ls.fieldLabel}>Password</Text>
              <View style={ls.inputRow}>
                <Lock size={20} color="#00b7f3" style={ls.inputIcon} />
                <TextInput
                  style={[ls.input, {flex: 1}]}
                  placeholder="Enter password"
                  placeholderTextColor="#8899aa"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPass}
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                />
                <TouchableOpacity
                  onPress={() => setShowPass(v => !v)}
                  style={ls.eyeBtn}>
                  {showPass
                    ? <EyeOff size={20} color="#556677" />
                    : <Eye    size={20} color="#556677" />}
                </TouchableOpacity>
              </View>
            </View>

            {/* Sign in button */}
            <TouchableOpacity
              style={[ls.loginBtn, loading && {opacity: 0.7}]}
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.85}>
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <LogIn size={20} color="#fff" />
                  <Text style={ls.loginBtnText}>Sign In</Text>
                </>
              )}
            </TouchableOpacity>
          </Animated.View>

          <Text style={ls.footer}>
            🔒 Secured · Contact supervisor for access issues
          </Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const ls = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#0d1b2e'},
  kav:      {flex: 1},
  inner:    {flex: 1, justifyContent: 'center', paddingHorizontal: 24},

  blobTop: {
    position: 'absolute', top: -80, right: -80,
    width: 240, height: 240, borderRadius: 120,
    backgroundColor: '#00b7f322',
  },
  blobBottom: {
    position: 'absolute', bottom: -60, left: -60,
    width: 200, height: 200, borderRadius: 100,
    backgroundColor: '#0077aa22',
  },

  brand: {alignItems: 'center', marginBottom: 36},
  busIconWrap: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#0d2a44',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 8, borderWidth: 2, borderColor: '#00b7f344',
  },
  dotsRow:  {flexDirection: 'row', gap: 5, marginTop: 6},
  dot:      {width: 7, height: 7, borderRadius: 4},
  brandName:{fontSize: 32, fontWeight: '900', color: '#fff', letterSpacing: 1.5, marginTop: 4},
  brandSub: {
    fontSize: 13, color: '#7799bb', fontWeight: '500',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 2,
  },

  card:    {backgroundColor: '#132236', borderRadius: 20, padding: 24, borderWidth: 1, borderColor: '#1e3a55'},
  cardTitle:{fontSize: 24, fontWeight: '800', color: '#fff', marginBottom: 4},
  cardSub:  {fontSize: 13, color: '#7799bb', marginBottom: 24},

  fieldWrap: {marginBottom: 18},
  fieldLabel:{
    fontSize: 12, fontWeight: '700', color: '#7799bb',
    marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1,
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#0d1b2e', borderRadius: 12,
    borderWidth: 1.5, borderColor: '#1e3a55',
    paddingHorizontal: 12, paddingVertical: 4,
  },
  inputIcon:{marginRight: 8},
  input:    {flex: 1, fontSize: 16, color: '#fff', paddingVertical: 12, fontWeight: '500'},
  eyeBtn:   {padding: 6},

  loginBtn:    {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, backgroundColor: '#00b7f3', borderRadius: 14,
    paddingVertical: 16, marginTop: 6,
  },
  loginBtnText:{color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: 0.5},

  footer:{textAlign: 'center', fontSize: 12, color: '#445566', marginTop: 28, paddingBottom: 8},
});

export default LoginScreen;