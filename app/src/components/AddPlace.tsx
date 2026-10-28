import * as Location from 'expo-location';
import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  getPhoto,
  runCapture,
  saveCapture,
  type CaptureResult,
  type CaptureType,
  type Candidate,
  type Found,
} from '@/lib/capture';
import { colors } from '@/lib/theme';

const TABS: { key: CaptureType; label: string; hint: string }[] = [
  { key: 'link', label: 'Link', hint: 'An article, a Google Maps link, a post' },
  { key: 'text', label: 'Text', hint: 'A Reddit comment, a text from a friend, a note' },
  { key: 'photo', label: 'Photo', hint: 'A storefront you walked past, a menu, a screenshot' },
  { key: 'friend', label: 'Friend', hint: 'Someone told you about a place' },
];

type Props = {
  visible: boolean;
  near: { lat: number; lng: number } | null; // where the map is: helps match names to the right place
  onClose: () => void;
  onSaved: () => void;
};

export default function AddPlace({ visible, near, onClose, onSaved }: Props) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<CaptureType>('link');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [friend, setFriend] = useState('');
  const [photo, setPhoto] = useState<{ base64: string; uri: string; where: { lat: number; lng: number } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [chosen, setChosen] = useState<Record<number, string | null>>({}); // place index -> google id (null = none)
  const [status, setStatus] = useState<Record<number, string>>({}); // place index -> "Saved" / "Already on ..."

  function reset() {
    setUrl('');
    setText('');
    setFriend('');
    setPhoto(null);
    setResult(null);
    setChosen({});
    setStatus({});
    setError(null);
  }
  function close() {
    reset();
    onClose();
  }

  async function choosePhoto(camera: boolean) {
    setError(null);
    try {
      const p = await getPhoto(camera);
      if (p) setPhoto(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const ready =
    (tab === 'link' && /^https?:\/\//i.test(url.trim())) ||
    (tab === 'text' && text.trim().length > 2) ||
    (tab === 'friend' && friend.trim() && text.trim().length > 2) ||
    (tab === 'photo' && !!photo);

  async function find() {
    setBusy(true);
    setError(null);
    setResult(null);
    setStatus({});
    try {
      // a photo is matched near where it was taken; otherwise near where you are, or where the map is
      let where = tab === 'photo' ? photo?.where ?? null : null;
      if (!where) {
        const last = await Location.getLastKnownPositionAsync().catch(() => null);
        where = last ? { lat: last.coords.latitude, lng: last.coords.longitude } : near;
      }
      const r = await runCapture({
        type: tab,
        url: tab === 'link' ? url.trim() : undefined,
        text: tab === 'link' ? undefined : text.trim() || undefined,
        friend: tab === 'friend' ? friend.trim() : undefined,
        image_base64: tab === 'photo' ? photo?.base64 : undefined,
        lat: where?.lat,
        lng: where?.lng,
      });
      setResult(r);
      // preselect the best match for each place (food and open come first)
      const pre: Record<number, string | null> = {};
      r.places.forEach((p, i) => (pre[i] = p.candidates[0]?.google_place_id ?? null));
      setChosen(pre);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(i: number, f: Found) {
    const gid = chosen[i];
    const c = f.candidates.find((x) => x.google_place_id === gid);
    if (!c || !result) return;
    setStatus((s) => ({ ...s, [i]: 'Saving…' }));
    try {
      const r = await saveCapture(
        {
          type: tab,
          url: tab === 'link' ? url.trim() : undefined,
          text: text.trim() || undefined,
          friend: friend.trim() || undefined,
        },
        f,
        c,
        result.source,
      );
      setStatus((s) => ({
        ...s,
        [i]: r.saved ? 'Saved to Want to go' : `Already on ${r.alreadyOn === 'favorites' ? 'Favorites' : r.alreadyOn === 'want_to_go' ? 'Want to go' : r.alreadyOn}`,
      }));
      if (r.saved) onSaved();
    } catch (e) {
      setStatus((s) => ({ ...s, [i]: '' }));
      setError((e as Error).message);
    }
  }

  const sourceText = result
    ? [result.source.name, result.source.type === 'walk_by' ? 'walked by' : null].filter(Boolean).join(' · ')
    : '';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Text style={styles.title}>Add a place</Text>
          <Pressable onPress={close} hitSlop={10}>
            <Text style={styles.link}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
          <View style={styles.tabs}>
            {TABS.map((t) => (
              <Pressable
                key={t.key}
                onPress={() => {
                  setTab(t.key);
                  setResult(null);
                  setError(null);
                }}
                style={[styles.tab, tab === t.key && styles.tabOn]}>
                <Text style={[styles.tabText, tab === t.key && styles.tabTextOn]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.hint}>{TABS.find((t) => t.key === tab)?.hint}</Text>

          {tab === 'link' && (
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              placeholder="Paste a link"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          )}
          {tab === 'friend' && (
            <TextInput
              style={styles.input}
              value={friend}
              onChangeText={setFriend}
              placeholder="Who told you? (e.g. Alex)"
              placeholderTextColor={colors.muted}
              autoCapitalize="words"
            />
          )}
          {(tab === 'text' || tab === 'friend') && (
            <TextInput
              style={[styles.input, styles.multi]}
              value={text}
              onChangeText={setText}
              placeholder={tab === 'friend' ? 'What they said: the place, what to get' : 'Paste or type the text'}
              placeholderTextColor={colors.muted}
              multiline
            />
          )}
          {tab === 'photo' && (
            <View style={{ gap: 10 }}>
              <View style={styles.row}>
                <Pressable style={styles.secondary} onPress={() => choosePhoto(true)}>
                  <Text style={styles.secondaryText}>Take a photo</Text>
                </Pressable>
                <Pressable style={styles.secondary} onPress={() => choosePhoto(false)}>
                  <Text style={styles.secondaryText}>Choose a photo</Text>
                </Pressable>
              </View>
              {photo && <Image source={{ uri: photo.uri }} style={styles.preview} resizeMode="cover" />}
              {photo && (
                <TextInput
                  style={styles.input}
                  value={text}
                  onChangeText={setText}
                  placeholder="Add a note (optional)"
                  placeholderTextColor={colors.muted}
                />
              )}
            </View>
          )}

          <Pressable style={[styles.primary, (!ready || busy) && { opacity: 0.5 }]} onPress={find} disabled={!ready || busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Find the place</Text>}
          </Pressable>
          {busy && <Text style={styles.hint}>Reading it… this can take 10 to 20 seconds.</Text>}
          {error && <Text style={styles.error}>{error}</Text>}
          {result?.message && <Text style={styles.hint}>{result.message}</Text>}

          {result && result.places.length > 0 && (
            <View style={{ gap: 14, marginTop: 6 }}>
              {!!sourceText && <Text style={styles.source}>Source: {sourceText}</Text>}
              {result.places.map((f, i) => (
                <View key={i} style={styles.found}>
                  <Text style={styles.foundName}>{f.name}</Text>
                  {!!f.note && <Text style={styles.text}>{f.note}</Text>}
                  {f.dishes.length > 0 && <Text style={styles.muted}>Dishes: {f.dishes.join(', ')}</Text>}
                  <Text style={styles.label}>Which one is it?</Text>
                  {f.candidates.map((c) => (
                    <Option key={c.google_place_id} c={c} on={chosen[i] === c.google_place_id} onPress={() => setChosen((x) => ({ ...x, [i]: c.google_place_id }))} />
                  ))}
                  <Pressable onPress={() => setChosen((x) => ({ ...x, [i]: null }))} style={styles.option}>
                    <Text style={[styles.radio, chosen[i] === null && styles.radioOn]}>{chosen[i] === null ? '●' : '○'}</Text>
                    <Text style={styles.muted}>{f.candidates.length ? 'None of these' : 'No match found on Google'}</Text>
                  </Pressable>
                  {status[i] ? (
                    <Text style={styles.done}>{status[i]}</Text>
                  ) : (
                    <Pressable
                      style={[styles.primary, styles.saveBtn, !chosen[i] && { opacity: 0.5 }]}
                      onPress={() => save(i, f)}
                      disabled={!chosen[i]}>
                      <Text style={styles.primaryText}>Save to Want to go</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Option({ c, on, onPress }: { c: Candidate; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.option}>
      <Text style={[styles.radio, on && styles.radioOn]}>{on ? '●' : '○'}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.optName}>
          {c.name}
          {!c.open ? '  (closed)' : ''}
        </Text>
        {!!c.address && <Text style={styles.muted}>{c.address}</Text>}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingBottom: 8 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  link: { color: colors.accent, fontSize: 17, fontWeight: '600' },
  body: { paddingHorizontal: 16, gap: 12 },
  tabs: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  tab: { flex: 1, paddingVertical: 9, alignItems: 'center' },
  tabOn: { backgroundColor: colors.text },
  tabText: { fontSize: 15, color: colors.text },
  tabTextOn: { color: '#fff', fontWeight: '600' },
  hint: { fontSize: 14, color: colors.muted },
  input: { backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: colors.text },
  multi: { minHeight: 110, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10 },
  secondary: { flex: 1, backgroundColor: '#EFE8DD', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600', color: colors.text },
  preview: { width: '100%', height: 200, borderRadius: 10, backgroundColor: colors.line },
  primary: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  saveBtn: { backgroundColor: colors.saved, marginTop: 4 },
  error: { color: colors.danger, fontSize: 15 },
  source: { fontSize: 14, color: colors.muted, fontStyle: 'italic' },
  found: { backgroundColor: colors.card, borderRadius: 12, padding: 14, gap: 6, borderWidth: 1, borderColor: colors.line },
  foundName: { fontSize: 19, fontWeight: '700', color: colors.text },
  text: { fontSize: 15, color: colors.text, lineHeight: 21 },
  muted: { fontSize: 14, color: colors.muted },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted, marginTop: 6 },
  option: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 6 },
  radio: { fontSize: 18, color: colors.muted, width: 20 },
  radioOn: { color: colors.saved },
  optName: { fontSize: 16, fontWeight: '600', color: colors.text },
  done: { fontSize: 15, fontWeight: '600', color: colors.saved, marginTop: 4 },
});
