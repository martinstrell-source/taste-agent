// After "Not interested": an optional reason, so Discover can leave out places like this one.
// Shown inside the place card (a second sheet on top of the card doesn't open reliably on iOS).
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Chip } from '@/components/ui';
import { colors, radius } from '@/lib/theme';

const REASONS = ['Not my kind of food', 'Looks touristy', 'Looks like a chain', 'Too pricey', 'Too far'];

// Save marks it Not for me (with the reason, if any); Cancel goes back without marking it
export default function WhyNot({ name, onDone, onCancel }: { name: string; onDone: (note: string | null) => void; onCancel: () => void }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [words, setWords] = useState('');
  const note = [...REASONS.filter((r) => chosen.has(r)), words.trim()].filter(Boolean).join('; ');
  const toggle = (r: string) =>
    setChosen((x) => {
      const n = new Set(x);
      if (n.has(r)) n.delete(r);
      else n.add(r);
      return n;
    });

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Why not {name}?</Text>
      <Text style={styles.hint}>A reason is optional. Suggestions will leave out places like this.</Text>
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
        <Button title="Cancel" kind="secondary" style={{ flex: 1 }} onPress={onCancel} />
        <Button title="Save" style={{ flex: 2 }} onPress={() => onDone(note || null)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  title: { fontSize: 22, fontWeight: '800', color: colors.text },
  hint: { fontSize: 14, color: colors.muted, marginTop: -6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: {
    backgroundColor: colors.bg, borderColor: colors.line, borderWidth: 1, borderRadius: radius.m,
    paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, color: colors.text,
  },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
});
