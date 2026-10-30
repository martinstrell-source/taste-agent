import * as Location from 'expo-location';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { readTaste, saveTaste, starterPlaces, type StarterPlace, type TasteRead } from '@/lib/onboard';
import { colors, radius } from '@/lib/theme';
import { Button, Chip } from '@/components/ui';

type Props = {
  visible: boolean;
  onDone: (opts: { importNext: boolean }) => void; // importNext: open the import screen after
};

type Step = 'welcome' | 'location' | 'taste' | 'review' | 'rate';
type Rating = 'love' | 'want' | 'no';
const RATINGS: { key: Rating; label: string; color: string }[] = [
  { key: 'love', label: 'Love it', color: colors.favorite },
  { key: 'want', label: 'Want to go', color: colors.saved },
  { key: 'no', label: 'Not for me', color: colors.muted },
];

export default function Onboarding({ visible, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('welcome');
  const [near, setNear] = useState<{ lat: number; lng: number } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<TasteRead | null>(null);
  const [chosen, setChosen] = useState<Record<number, number | null>>({}); // place index -> candidate index (null = skip)
  const [dishes, setDishes] = useState<string[]>([]);
  const [starter, setStarter] = useState<StarterPlace[] | null>(null); // well-known places near them, to rate
  const [rated, setRated] = useState<Record<string, Rating>>({});

  async function askLocation() {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.granted) {
        const pos = (await Location.getLastKnownPositionAsync()) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
        setNear({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      }
    } catch {
      /* fine without it */
    }
    setStep('taste');
  }

  async function doRead() {
    setBusy(true);
    setError(null);
    try {
      const r = await readTaste(text, near);
      if (r.message) {
        setError(r.message);
        return;
      }
      setRead(r);
      setChosen(Object.fromEntries(r.places.map((p, i) => [i, p.candidates.length ? 0 : null])));
      setDishes(r.dishes);
      setStep('review');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const named = read
    ? read.places
        .map((p, i) => (chosen[i] == null ? null : { name: p.name, cuisine: p.cuisine, candidate: p.candidates[chosen[i] as number] }))
        .filter((x): x is NonNullable<typeof x> => !!x)
    : [];

  // next: rate well-known places nearby (needs their location)
  async function goRate() {
    setStep('rate');
    if (starter || !near) return;
    try {
      const r = await starterPlaces(near, named.map((p) => p.candidate.google_place_id));
      setStarter(r.places);
    } catch {
      setStarter([]);
    }
  }

  async function doSave(importNext: boolean) {
    if (!read) return;
    setBusy(true);
    setError(null);
    try {
      const fromRating = (starter ?? [])
        .filter((p) => rated[p.google_place_id] === 'love' || rated[p.google_place_id] === 'want')
        .map((p) => ({ name: p.name, candidate: p, list: rated[p.google_place_id] === 'love' ? ('favorites' as const) : ('want_to_go' as const) }));
      const noes = (starter ?? []).filter((p) => rated[p.google_place_id] === 'no').map((p) => ({ google_place_id: p.google_place_id, name: p.name }));
      await saveTaste({ places: [...named, ...fromRating], noes, dishes, cuisines: read.cuisines, dislikes: read.dislikes, text });
      onDone({ importNext });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const kept = read ? read.places.filter((_, i) => chosen[i] != null).length : 0;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.wrap, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
          {step === 'welcome' && (
            <>
              <Text style={styles.title}>Taste Agent</Text>
              <Text style={styles.lead}>Keep the places you want to try, see them when you're nearby, and find new ones that fit your taste, at home or traveling.</Text>
              <Text style={styles.body}>Start by telling it a few places you love. It takes a minute.</Text>
              <Button title="Get started" style={styles.mt} onPress={() => setStep('location')} />
            </>
          )}

          {step === 'location' && (
            <>
              <Text style={styles.title}>Your location</Text>
              <Text style={styles.body}>Used to show your places and new picks near you, and to find the right restaurants when you name them. It stays on your phone except for those searches.</Text>
              <Button title="Continue" icon="location.fill" style={styles.mt} onPress={askLocation} />
            </>
          )}

          {step === 'taste' && (
            <>
              <Text style={styles.title}>What do you love?</Text>
              <Text style={styles.body}>Name a few restaurants that best show your taste, and any dishes you love. Any order, any style.</Text>
              <TextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                multiline
                autoFocus
                placeholder={'Kin Khao, Burma Superstar, Tartine…\nI love khao soi and xiao long bao.'}
                placeholderTextColor={colors.muted}
              />
              {error && <Text style={styles.error}>{error}</Text>}
              <Button title="Next" style={styles.mt} onPress={doRead} busy={busy} disabled={!text.trim()} />
            </>
          )}

          {step === 'review' && read && (
            <>
              <Text style={styles.title}>Is this right?</Text>
              {read.places.length > 0 && <Text style={styles.body}>Tap the right match for each, or Skip.</Text>}
              {read.places.map((p, i) => (
                <View key={i} style={styles.place}>
                  <Text style={styles.placeName}>{p.name}</Text>
                  {p.candidates.length === 0 && <Text style={styles.muted}>Not found on Google; skipped.</Text>}
                  {p.candidates.map((c, j) => (
                    <Pressable key={c.google_place_id} onPress={() => setChosen((x) => ({ ...x, [i]: j }))} style={[styles.cand, chosen[i] === j && styles.candOn]}>
                      <Text style={styles.candName}>{c.name}</Text>
                      {!!c.address && <Text style={styles.muted} numberOfLines={1}>{c.address}</Text>}
                    </Pressable>
                  ))}
                  {p.candidates.length > 0 && (
                    <Pressable onPress={() => setChosen((x) => ({ ...x, [i]: null }))} hitSlop={6}>
                      <Text style={[styles.skip, chosen[i] == null && { color: colors.text, fontWeight: '700' }]}>Skip</Text>
                    </Pressable>
                  )}
                </View>
              ))}
              {dishes.length > 0 && (
                <>
                  <Text style={styles.section}>Dishes you love</Text>
                  <View style={styles.chips}>
                    {dishes.map((d) => (
                      <Pressable key={d} style={styles.chip} onPress={() => setDishes((x) => x.filter((y) => y !== d))}>
                        <Text style={styles.chipText}>{d}</Text>
                        <Text style={styles.chipX}>✕</Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}
              {read.cuisines.length > 0 && <Text style={styles.muted}>Cuisines: {read.cuisines.join(', ')}</Text>}
              {error && <Text style={styles.error}>{error}</Text>}
              {near ? (
                <Button title="Next" style={styles.mt} onPress={goRate} />
              ) : (
                <>
                  <Button title={kept ? `Save ${kept} and show me places` : 'Show me places'} style={styles.mt} onPress={() => doSave(false)} busy={busy} />
                  <Button title="Save, then import my lists" icon="square.and.arrow.down" kind="outline" onPress={() => doSave(true)} disabled={busy} />
                </>
              )}
              <Pressable onPress={() => setStep('taste')} hitSlop={8}>
                <Text style={styles.back}>Back</Text>
              </Pressable>
            </>
          )}

          {step === 'rate' && read && (
            <>
              <Text style={styles.title}>Know any of these?</Text>
              <Text style={styles.body}>Well-known places near you. Tap what fits and skip the ones you don't know.</Text>
              {starter === null && <ActivityIndicator style={{ marginVertical: 24 }} />}
              {starter?.length === 0 && <Text style={styles.muted}>Couldn't find places near you to show. You can go on.</Text>}
              {(starter ?? []).map((p) => {
                const area = p.address?.split(',')[1]?.trim();
                const facts = [p.kind, p.rating ? `${p.rating.toFixed(1)} ★` : null, area].filter(Boolean).join(' · ');
                return (
                  <View key={p.google_place_id} style={styles.place}>
                    <Text style={styles.placeName}>{p.name}</Text>
                    <Text style={styles.muted} numberOfLines={1}>{facts}</Text>
                    <View style={styles.chips}>
                      {RATINGS.map((r) => (
                        <Chip
                          key={r.key}
                          label={r.label}
                          color={r.color}
                          on={rated[p.google_place_id] === r.key}
                          onPress={() =>
                            setRated((x) => {
                              const n = { ...x };
                              if (n[p.google_place_id] === r.key) delete n[p.google_place_id];
                              else n[p.google_place_id] = r.key;
                              return n;
                            })
                          }
                        />
                      ))}
                    </View>
                  </View>
                );
              })}
              {error && <Text style={styles.error}>{error}</Text>}
              <Button title="Show me places" style={styles.mt} onPress={() => doSave(false)} busy={busy} disabled={starter === null} />
              <Button title="Save, then import my lists" icon="square.and.arrow.down" kind="outline" onPress={() => doSave(true)} disabled={busy || starter === null} />
              <Pressable onPress={() => setStep('review')} hitSlop={8}>
                <Text style={styles.back}>Back</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 24, gap: 16 },
  title: { fontSize: 30, fontWeight: '800', color: colors.text },
  lead: { fontSize: 19, lineHeight: 26, color: colors.text },
  body: { fontSize: 16, lineHeight: 22, color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  input: {
    minHeight: 130, borderWidth: 1, borderColor: colors.line, borderRadius: radius.m, padding: 12, fontSize: 16,
    color: colors.text, backgroundColor: colors.card, textAlignVertical: 'top',
  },
  mt: { marginTop: 4 },
  error: { color: colors.danger, fontSize: 15 },
  place: { gap: 6, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  placeName: { fontSize: 17, fontWeight: '700', color: colors.text },
  cand: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.m, padding: 10, backgroundColor: colors.card },
  candOn: { borderColor: colors.saved, borderWidth: 2 },
  candName: { fontSize: 15, fontWeight: '600', color: colors.text },
  skip: { fontSize: 14, color: colors.muted, paddingVertical: 2 },
  section: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 12, height: 34 },
  chipText: { fontSize: 14, fontWeight: '600', color: colors.text },
  chipX: { fontSize: 12, color: colors.muted },
  back: { fontSize: 15, color: colors.muted, textAlign: 'center', paddingVertical: 6 },
});
