import { Stack } from 'expo-router';

export default function Layout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* Auth */}
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)/Screens/login" />

      {/* Main app */}
      <Stack.Screen name="(tabs)/Screens/BusPOS" />
    </Stack>
  );
}