import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '@/lib/supabase';
import { colors } from '@/lib/theme';

// Email sign-in with a one-time code (no link to tap, so it works in Expo Go).
// Only existing accounts can sign in for now; testers are added with users.py or onboard.py.
export default function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false },
    });
    setBusy(false);
    if (error) {
      setMessage(
        /signups not allowed|not found/i.test(error.message)
          ? 'There is no account for that email yet.'
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

function Button(props: { title: string; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={({ pressed }) => [styles.button, (props.disabled || pressed) && { opacity: 0.6 }]}>
      {props.busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{props.title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center' },
  box: { paddingHorizontal: 24, gap: 12 },
  title: { fontSize: 32, fontWeight: '700', color: colors.text, marginBottom: 16 },
  label: { fontSize: 15, color: colors.muted },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
    color: colors.text,
  },
  code: { fontSize: 24, letterSpacing: 6 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  link: { color: colors.accent, fontSize: 15, textAlign: 'center', marginTop: 8 },
  error: { color: colors.danger, fontSize: 15, marginTop: 4 },
});
