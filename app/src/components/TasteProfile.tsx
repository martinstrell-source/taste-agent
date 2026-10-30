// "Your taste": what the app has learned about the user, and their edits to it. Hiding something the app
// inferred, or adding something it missed, changes the next Discover; the weekly rebuild keeps the edits.
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, SheetHeader } from '@/components/ui';
import {
  addAvoid, addCuisine, addDish, cuisineLabel, forgetReason, hideCuisine, hideDish, loadTaste, removeAvoid,
  unhideCuisine, unhideDish, type Taste,
} from '@/lib/taste';
import { colors, radius } from '@/lib/theme';

export default function TasteProfile({ visible, onClose }: { visible: boolean; onClose: (changed: boolean) => void }) {
  const insets = useSafeAreaInsets();
  const [taste, setTaste] = useState<Taste | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  async function reload() {
    try {
      setTaste(await loadTaste());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (visible) {
      setTaste(null);
      setChanged(false);
      setError(null);
      reload();
    }
  }, [visible]);

  // run an edit, then show the result
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
      setChanged(true);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => onClose(changed)}>
      <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SheetHeader title="Your taste" action="Done" onAction={() => onClose(changed)} />
        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
          <Text style={styles.lead}>
            What the app has learned from your places and answers. Remove what isn't you and add what's missing; the next Discover uses it.
          </Text>
          {error && <Text style={styles.error}>{error}</Text>}
          {!taste ? (
            <ActivityIndicator style={{ marginTop: 24 }} />
          ) : (
            <>
              <Section title="Cuisines you lean toward" hint="Ranked by how much more often you save them than most people.">
                <Tags items={taste.cuisines.map((c) => ({ key: c.cuisine, label: c.label }))} onRemove={(k) => act(() => hideCuisine(k))()} />
                {taste.cuisines.length === 0 && <Text style={styles.muted}>None yet.</Text>}
                <AddField placeholder="Add a cuisine, e.g. Burmese" onAdd={(v) => act(() => addCuisine(v))()} />
                <Hidden items={taste.hiddenCuisines.map((c) => ({ key: c, label: cuisineLabel(c) }))} onRestore={(k) => act(() => unhideCuisine(k))()} />
              </Section>

              <Section title="Dishes you love">
                <Tags items={taste.dishes.map((d) => ({ key: d.dish, label: d.dish }))} onRemove={(k) => act(() => hideDish(k))()} />
                {taste.dishes.length === 0 && <Text style={styles.muted}>None yet.</Text>}
                <AddField placeholder="Add a dish, e.g. khao soi" onAdd={(v) => act(() => addDish(v))()} />
                <Hidden items={taste.hiddenDishes.map((d) => ({ key: d, label: d }))} onRestore={(k) => act(() => unhideDish(k))()} />
              </Section>

              <Section title="You avoid" hint="Discover leaves out places like these.">
                <Tags items={taste.avoid.map((a) => ({ key: a, label: a }))} onRemove={(k) => act(() => removeAvoid(k))()} />
                {taste.avoid.length === 0 && <Text style={styles.muted}>Nothing yet.</Text>}
                <AddField placeholder="e.g. American Chinese, chain buffets" onAdd={(v) => act(() => addAvoid(v))()} />
              </Section>

              {taste.noes.length > 0 && (
                <Section title='Your "Not for me" reasons' hint="Discover also leaves out places like these. Remove a reason to stop that; the place itself stays out.">
                  {taste.noes.map((n) => (
                    <View key={n.google_place_id} style={styles.noRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.noName}>{n.name ?? 'A place'}</Text>
                        <Text style={styles.muted}>{n.note}</Text>
                      </View>
                      <Pressable onPress={act(() => forgetReason(n.google_place_id))} hitSlop={10} accessibilityLabel="Remove this reason">
                        <Icon name="xmark.circle.fill" color={colors.muted} size={20} />
                      </Pressable>
                    </View>
                  ))}
                </Section>
              )}

              {taste.placesCounted > 0 && (
                <Text style={styles.foot}>Learned from about {taste.placesCounted} of your saved places; it updates weekly.</Text>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {!!hint && <Text style={styles.muted}>{hint}</Text>}
      {children}
    </View>
  );
}

function Tags({ items, onRemove }: { items: { key: string; label: string }[]; onRemove: (key: string) => void }) {
  return (
    <View style={styles.tags}>
      {items.map((t) => (
        <Pressable key={t.key} onPress={() => onRemove(t.key)} style={styles.tag} accessibilityLabel={`Remove ${t.label}`}>
          <Text style={styles.tagText} maxFontSizeMultiplier={1}>
            {t.label}
          </Text>
          <Icon name="xmark" color={colors.muted} size={11} />
        </Pressable>
      ))}
    </View>
  );
}

function Hidden({ items, onRestore }: { items: { key: string; label: string }[]; onRestore: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <Text style={styles.hidden}>
      Removed:{' '}
      {items.map((t, i) => (
        <Text key={t.key}>
          {i > 0 ? ', ' : ''}
          <Text style={styles.restore} onPress={() => onRestore(t.key)}>
            {t.label}
          </Text>
        </Text>
      ))}
      <Text style={styles.muted}> (tap to put back)</Text>
    </Text>
  );
}

function AddField({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }) {
  const [v, setV] = useState('');
  const add = () => {
    if (!v.trim()) return;
    onAdd(v.trim());
    setV('');
  };
  return (
    <View style={styles.addRow}>
      <TextInput
        style={styles.input}
        value={v}
        onChangeText={setV}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        returnKeyType="done"
        onSubmitEditing={add}
      />
      <Pressable onPress={add} style={[styles.addBtn, !v.trim() && { opacity: 0.4 }]} disabled={!v.trim()} accessibilityLabel="Add">
        <Icon name="plus" color="#fff" size={16} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 16, gap: 18 },
  lead: { fontSize: 15, lineHeight: 21, color: colors.muted },
  error: { color: colors.danger, fontSize: 15 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 19 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: radius.pill,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line,
  },
  tagText: { fontSize: 14, fontWeight: '600', color: colors.text },
  hidden: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  restore: { color: colors.text, fontWeight: '600', textDecorationLine: 'underline' },
  addRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1, backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: radius.m,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text,
  },
  addBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  noRow: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  noName: { fontSize: 15, fontWeight: '700', color: colors.text },
  foot: { fontSize: 13, color: colors.muted, textAlign: 'center', marginTop: 4 },
});
