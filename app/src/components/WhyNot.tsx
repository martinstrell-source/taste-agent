// After "Not interested": an optional reason, so Discover can leave out places like this one.
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Chip } from '@/components/ui';
import type { NearbyPlace } from '@/lib/supabase';
import { colors, radius } from '@/lib/theme';

const REASONS = ['Not my kind of food', 'Looks touristy', 'Looks like a chain', 'Too pricey', 'Too far'];

export default function WhyNot({ place, onDone }: { place: NearbyPlace | null; onDone: (note: string | null) => void }) {
  const insets = useSafeAreaInsets();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [words, setWords] = useState('');
  useEffect(() => {
    if (place) {
      setChosen(new Set());
      setWords('');
    }
  }, [place]);

  const note = [...REASONS.filter((r) => chosen.has(r)), words.trim()].filter(Boolean).join('; ');
  const toggle = (r: string) =>
    setChosen((x) => {
      const n = new Set(x);
      if (n.has(r)) n.delete(r);
      else n.add(r);
      return n;
    });

  return (
    <Modal visible={!!place} transparent animationType="slide" onRequestClose={() => onDone(null)}>
      <Pressable style={styles.backdrop} onPress={() => onDone(null)} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.handle} />
          <Text style={styles.title}>Why not {place?.name}?</Text>
          <Text style={styles.hint}>Optional. New picks will leave out places like this.</Text>
          <View style={styles.chips}>
            {REASONS.map((r) => (
              <Chip key={r} label={r} on={chosen.has(r)} onPress={() => toggle(r)} />
            ))}
          </View>
          <TextInput
            style={styles.input}
            value={words}
            onChangeText={setWords}
            placeholder="In your words, e.g. looks like American Chinese"
            placeholderTextColor={colors.muted}
            returnKeyType="done"
            onSubmitEditing={() => onDone(note || null)}
          />
          <View style={styles.row}>
            <Button title="Skip" kind="secondary" style={{ flex: 1 }} onPress={() => onDone(null)} />
            <Button title="Save" style={{ flex: 2 }} disabled={!note} onPress={() => onDone(note)} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 20, paddingTop: 8, gap: 12 },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: 4 },
  title: { fontSize: 22, fontWeight: '800', color: colors.text },
  hint: { fontSize: 14, color: colors.muted, marginTop: -6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: {
    backgroundColor: colors.bg, borderColor: colors.line, borderWidth: 1, borderRadius: radius.m,
    paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, color: colors.text,
  },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
});
