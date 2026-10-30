import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '@/lib/supabase';
import { colors, radius } from '@/lib/theme';
import { Button } from '@/components/ui';

// Email sign-in with a one-time code (no link to tap, so it works in Expo Go). A new email gets a new
// account (onboarding follows). A password sign-in is tucked behind a link, for Apple's review account.
export default function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code' | 'password'>('email');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (error) {
      setMessage(
        /signups not allowed|not found/i.test(error.message)
          ? 'New accounts are closed right now.'
          : /rate limit|too many/i.test(error.message)
            ? 'Too many codes requested. Wait a few minutes and try again.'
            : error.message,
      );
      return;
    }
    setStep('code');
  }

  async function verify() {
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
    setBusy(false);
    if (error) setMessage(/expired|invalid/i.test(error.message) ? 'That code is wrong or expired.' : error.message);
    // on success, the root layout sees the new session and shows the app
  }

  async function passwordSignIn() {
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setMessage(/invalid/i.test(error.message) ? 'Wrong email or password.' : error.message);
  }

  return (
    <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.box}>
        <Text style={styles.title}>Taste Agent</Text>
        {step === 'email' ? (
          <>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="send"
              onSubmitEditing={sendCode}
            />
            <Button title="Send code" onPress={sendCode} disabled={busy || !email.includes('@')} busy={busy} />
            <Pressable onPress={() => { setStep('password'); setMessage(null); }} hitSlop={8}>
              <Text style={styles.small}>Sign in with a password</Text>
            </Pressable>
          </>
        ) : step === 'password' ? (
          <>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
            />
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              textContentType="password"
              returnKeyType="done"
              onSubmitEditing={passwordSignIn}
            />
            <Button title="Sign in" onPress={passwordSignIn} disabled={busy || !email.includes('@') || !password} busy={busy} />
            <Pressable onPress={() => { setStep('email'); setPassword(''); setMessage(null); }}>
              <Text style={styles.link}>Use an email code instead</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.label}>Code from the email to {email.trim()}</Text>
            <TextInput
              style={[styles.input, styles.code]}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, ''))}
              placeholder="123456"
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={10}
              returnKeyType="done"
              onSubmitEditing={verify}
            />
            <Button title="Sign in" onPress={verify} disabled={busy || code.length < 6} busy={busy} />
            <Pressable
              onPress={() => {
                setStep('email');
                setCode('');
                setMessage(null);
              }}>
              <Text style={styles.link}>Use a different email</Text>
            </Pressable>
          </>
        )}
        {message && <Text style={styles.error}>{message}</Text>}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center' },
  box: { paddingHorizontal: 24, gap: 12 },
  title: { fontSize: 36, fontWeight: '800', color: colors.text, letterSpacing: -0.8, marginBottom: 16 },
  label: { fontSize: 15, color: colors.muted },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.m,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
    color: colors.text,
  },
  code: { fontSize: 24, letterSpacing: 6 },
  link: { color: colors.text, fontWeight: '600', fontSize: 15, textAlign: 'center', marginTop: 8 },
  small: { color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: 12 },
  error: { color: colors.danger, fontSize: 15, marginTop: 4 },
});
