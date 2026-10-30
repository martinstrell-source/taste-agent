import type { Session } from '@supabase/supabase-js';
import { Stack } from 'expo-router';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider } from 'expo-share-intent';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SignIn from '@/components/SignIn';
import { configError, supabase } from '@/lib/supabase';
import { colors } from '@/lib/theme';

// sharing to the app needs the real build; Expo Go doesn't have the share extension
const SHARE_OFF = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export default function RootLayout() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (configError) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  let body;
  if (configError) {
    body = (
      <View style={styles.center}>
        <Text style={styles.error}>{configError}</Text>
      </View>
    );
  } else if (!ready) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  } else if (!session) {
    body = <SignIn />;
  } else {
    body = <Stack screenOptions={{ headerShown: false }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ShareIntentProvider options={{ disabled: SHARE_OFF, resetOnBackground: false }}>
        <SafeAreaProvider>
          <StatusBar style="dark" />
          {body}
        </SafeAreaProvider>
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.bg },
  error: { color: colors.danger, fontSize: 16, textAlign: 'center' },
});
