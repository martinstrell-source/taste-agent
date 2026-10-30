import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getPhoto } from '@/lib/capture';
import type { NearbyPlace } from '@/lib/supabase';
import { colors, radius } from '@/lib/theme';
import { Button, Segmented } from '@/components/ui';
import { readBill, REACTION_LABEL, saveVisit, type BillItem, type Reaction } from '@/lib/visits';

type Photo = { base64: string; uri: string };
const MAX_FOOD = 4;

function isoDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function LogVisit({ place, onClose, onSaved }: { place: NearbyPlace | null; onClose: () => void; onSaved: () => void }) {
  const insets = useSafeAreaInsets();
  const [date, setDate] = useState(isoDay());
  const [dateMode, setDateMode] = useState<'today' | 'yesterday' | 'other'>('today');
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [thoughts, setThoughts] = useState('');
  const [bill, setBill] = useState<Photo | null>(null);
  const [keepBill, setKeepBill] = useState(false);
  const [items, setItems] = useState<BillItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const [food, setFood] = useState<Photo[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // fresh form for each place
  useEffect(() => {
    setDate(isoDay());
    setDateMode('today');
    setReaction(null);
    setThoughts('');
    setBill(null);
    setKeepBill(false);
    setItems([]);
    setTotal(null);
    setFood([]);
    setError(null);
  }, [place?.ref]);

  async function addBill(camera: boolean) {
    setError(null);
    try {
      const p = await getPhoto(camera);
      if (!p) return;
      setBill(p);
      setReading(true);
      const r = await readBill(p.base64);
      setItems(r.bill.items);
      setTotal(r.bill.total);
      if (r.bill.date && r.bill.date <= isoDay()) {
        setDate(r.bill.date);
        setDateMode(r.bill.date === isoDay() ? 'today' : r.bill.date === isoDay(-1) ? 'yesterday' : 'other');
      }
      if (r.message) setError(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }

  async function addFood(camera: boolean) {
    setError(null);
    try {
      const p = await getPhoto(camera);
      if (p) setFood((f) => [...f, p].slice(0, MAX_FOOD));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function setItem(i: number, patch: Partial<BillItem>) {
    setItems((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  async function save() {
    if (!place || !reaction) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError('Date should look like 2026-10-28.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveVisit({
        place,
        date,
        reaction,
        thoughts,
        items,
        billTotal: total,
        billPhoto: keepBill && bill ? bill.base64 : null,
        foodPhotos: food.map((f) => f.base64),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const sum = items.reduce((a, i) => a + (i.price ?? 0), 0);

  return (
    <Modal visible={!!place} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {place?.name}
          </Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>When</Text>
          <Segmented
            options={[
              { value: 'today' as const, label: 'Today' },
              { value: 'yesterday' as const, label: 'Yesterday' },
              { value: 'other' as const, label: 'Earlier' },
            ]}
            value={dateMode}
            onChange={(m) => {
              setDateMode(m);
              if (m === 'today') setDate(isoDay());
              if (m === 'yesterday') setDate(isoDay(-1));
            }}
          />
          {dateMode === 'other' && (
            <TextInput style={styles.input} value={date} onChangeText={setDate} placeholder="2026-10-21" keyboardType="numbers-and-punctuation" />
          )}

          <Text style={styles.label}>How was it?</Text>
          <View style={styles.row}>
            {(['love', 'fine', 'no'] as const).map((r) => (
              <Pressable key={r} onPress={() => setReaction(r)} style={[styles.react, reaction === r && styles[`react_${r}`]]}>
                <Text style={[styles.reactText, reaction === r && { color: '#fff' }]}>{REACTION_LABEL[r]}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>Thoughts</Text>
          <TextInput
            style={[styles.input, styles.multi]}
            value={thoughts}
            onChangeText={setThoughts}
            placeholder="What stood out? What would you order again?"
            placeholderTextColor={colors.muted}
            multiline
          />

          <Text style={styles.label}>The bill</Text>
          {!bill ? (
            <View style={styles.row}>
              <Button title="Photo of the bill" icon="camera" kind="secondary" style={{ flex: 1 }} onPress={() => addBill(true)} />
              <Button title="Choose photo" icon="photo" kind="secondary" style={{ flex: 1 }} onPress={() => addBill(false)} />
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              {reading ? (
                <View style={styles.row}>
                  <ActivityIndicator />
                  <Text style={styles.muted}>Reading what you ordered…</Text>
                </View>
              ) : (
                <>
                  {items.map((it, i) => (
                    <View key={i} style={styles.itemRow}>
                      <TextInput style={[styles.input, styles.itemName]} value={it.name} onChangeText={(t) => setItem(i, { name: t })} />
                      <TextInput
                        style={[styles.input, styles.itemPrice]}
                        value={it.price === null ? '' : String(it.price)}
                        onChangeText={(t) => setItem(i, { price: t.trim() === '' ? null : Number(t.replace(/[^0-9.]/g, '')) })}
                        keyboardType="decimal-pad"
                        placeholder="$"
                      />
                      <Pressable onPress={() => setItems((l) => l.filter((_, j) => j !== i))} hitSlop={8}>
                        <Text style={styles.remove}>✕</Text>
                      </Pressable>
                    </View>
                  ))}
                  <Pressable onPress={() => setItems((l) => [...l, { name: '', qty: 1, price: null }])}>
                    <Text style={styles.addItem}>+ Add an item</Text>
                  </Pressable>
                  <Text style={styles.muted}>
                    Items ${sum.toFixed(2)}
                    {total !== null ? `  ·  Bill total $${total.toFixed(2)}` : ''}
                  </Text>
                  <View style={styles.keepRow}>
                    <Text style={styles.text}>Keep the bill photo</Text>
                    <Switch value={keepBill} onValueChange={setKeepBill} />
                  </View>
                  <Text style={styles.small}>Only the items are saved otherwise. Card and payment details are never kept.</Text>
                </>
              )}
            </View>
          )}

          <Text style={styles.label}>Food photos</Text>
          {food.length > 0 && (
            <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
              {food.map((f, i) => (
                <Pressable key={i} onLongPress={() => setFood((l) => l.filter((_, j) => j !== i))}>
                  <Image source={{ uri: f.uri }} style={styles.thumb} />
                </Pressable>
              ))}
            </ScrollView>
          )}
          {food.length < MAX_FOOD && (
            <View style={styles.row}>
              <Button title="Take a photo" icon="camera" kind="secondary" style={{ flex: 1 }} onPress={() => addFood(true)} />
              <Button title="Choose photo" icon="photo" kind="secondary" style={{ flex: 1 }} onPress={() => addFood(false)} />
            </View>
          )}
          {food.length > 0 && <Text style={styles.small}>Press and hold a photo to remove it.</Text>}

          {error && <Text style={styles.error}>{error}</Text>}
          <Button title="Save visit" style={{ marginTop: 8 }} onPress={save} busy={saving} disabled={!reaction || reading} />
          {!reaction && <Text style={styles.small}>Pick how it was to save.</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingBottom: 8, gap: 12 },
  title: { flex: 1, fontSize: 24, fontWeight: '800', color: colors.text },
  cancel: { color: colors.text, fontSize: 17, fontWeight: '600' },
  addItem: { color: colors.saved, fontSize: 15, fontWeight: '700' },
  body: { paddingHorizontal: 16, gap: 10 },
  label: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 10 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  react: { flex: 1, paddingVertical: 12, borderRadius: radius.m, backgroundColor: colors.soft, alignItems: 'center' },
  react_love: { backgroundColor: colors.saved },
  react_fine: { backgroundColor: colors.muted },
  react_no: { backgroundColor: colors.danger },
  reactText: { fontSize: 15, fontWeight: '600', color: colors.text },
  input: { backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: radius.m, paddingHorizontal: 12, paddingVertical: 9, fontSize: 16, color: colors.text },
  multi: { minHeight: 90, textAlignVertical: 'top' },
  itemRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  itemName: { flex: 1, paddingVertical: 7 },
  itemPrice: { width: 80, paddingVertical: 7, textAlign: 'right' },
  remove: { fontSize: 16, color: colors.muted, paddingHorizontal: 4 },
  keepRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  text: { fontSize: 15, color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  small: { fontSize: 12, color: colors.muted },
  thumb: { width: 84, height: 84, borderRadius: 8, backgroundColor: colors.line },
  error: { color: colors.danger, fontSize: 15 },
});
