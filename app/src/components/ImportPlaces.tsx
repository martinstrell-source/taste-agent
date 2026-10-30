import { useEffect, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { runCapture, saveCapture, type Candidate, type Source } from '@/lib/capture';
import { getJob, latestTakeout, pickScreenshots, readListText, readScreenshot, startTakeoutImport, type ImportJob, type ShotResult } from '@/lib/onboard';
import { colors, radius } from '@/lib/theme';
import { Button, Segmented, SheetHeader } from '@/components/ui';

type Props = {
  visible: boolean;
  near: { lat: number; lng: number } | null;
  onClose: () => void;
  onSaved: () => void;
};

// source: where a row came from when it isn't the screenshot/list app (a link: the article's site)
type Row = { name: string; note: string; candidates: Candidate[]; pick: number | null; status?: string; source?: Source; via?: string };
type Tab = 'text' | 'shots' | 'link' | 'maps';
const TABS: { key: Tab; label: string }[] = [
  { key: 'text', label: 'Text' },
  { key: 'shots', label: 'Screenshot' },
  { key: 'link', label: 'Link' },
  { key: 'maps', label: 'Google Maps' },
];

export default function ImportPlaces({ visible, near, onClose, onSaved }: Props) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('text');
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Google Maps (Takeout)
  const [job, setJob] = useState<ImportJob | null>(null);
  const [uploading, setUploading] = useState(false);

  // screenshots
  const [progress, setProgress] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [app, setApp] = useState<string | null>(null);
  const [list, setList] = useState<'want_to_go' | 'favorites'>('want_to_go');
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [pasted, setPasted] = useState('');

  useEffect(() => {
    if (visible) latestTakeout().then(setJob).catch(() => {});
  }, [visible]);

  // while an import is queued or running, check on it every 10 seconds
  useEffect(() => {
    if (!visible || !job || (job.status !== 'queued' && job.status !== 'running')) return;
    const t = setInterval(() => {
      getJob(job.id)
        .then((j) => {
          if (!j) return;
          setJob(j);
          if (j.status === 'done') onSaved();
        })
        .catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [visible, job, onSaved]);

  async function upload() {
    setError(null);
    setUploading(true);
    try {
      const j = await startTakeoutImport();
      if (j) setJob(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  // add what Claude found to the list to review, skipping places already in it
  // (the same place on two overlapping screenshots, or in a list and a screenshot)
  function addFound(r: ShotResult, seen: Set<string>) {
    if (r.app) setApp(r.app);
    const added: Row[] = [];
    for (const p of r.places) {
      const key = p.candidates[0]?.google_place_id ?? p.name;
      if (seen.has(key)) continue;
      seen.add(key);
      added.push({ name: p.name, note: p.note, candidates: p.candidates, pick: p.candidates.length ? 0 : null });
    }
    setRows((old) => [...old, ...added]);
    if (r.message && !added.length) setError(r.message);
  }
  const seenNow = () => new Set(rows.map((r) => (r.candidates[0]?.google_place_id ?? r.name)));

  async function screenshots() {
    setError(null);
    setSavedCount(null);
    try {
      const shots = await pickScreenshots();
      if (!shots.length) return;
      const seen = seenNow();
      for (let i = 0; i < shots.length; i++) {
        setProgress(`Reading screenshot ${i + 1} of ${shots.length}…`);
        addFound(await readScreenshot(shots[i].base64, near), seen);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  async function fromText() {
    setError(null);
    setSavedCount(null);
    setProgress('Reading your list…');
    try {
      addFound(await readListText(pasted, near), seenNow());
      setPasted('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  // an article or a page of notes: every place on it, through the same reader as Add a place
  async function fromLink() {
    setError(null);
    setSavedCount(null);
    setProgress('Reading the page… this can take 10 to 20 seconds.');
    try {
      const r = await runCapture({ type: 'link', url: link.trim(), ...(near ?? {}) });
      const seen = seenNow();
      const added: Row[] = [];
      for (const p of r.places) {
        const key = p.candidates[0]?.google_place_id ?? p.name;
        if (seen.has(key)) continue;
        seen.add(key);
        added.push({ name: p.name, note: p.note, candidates: p.candidates, pick: p.candidates.length ? 0 : null, source: r.source, via: 'link' });
      }
      setRows((old) => [...old, ...added]);
      if (!added.length) setError(r.message ?? 'No places found on that page.');
      else setLink('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  async function saveAll() {
    setSaving(true);
    setError(null);
    let n = 0;
    const next = [...rows];
    for (let i = 0; i < next.length; i++) {
      const r = next[i];
      if (r.pick == null || r.status) continue;
      try {
        const c = r.candidates[r.pick];
        const res = r.source
          ? await saveCapture({ type: 'link', url: r.source.url ?? undefined }, { name: r.name, location_hint: '', note: r.note, dishes: [], candidates: [] }, c, r.source, list, 'import_link')
          : await saveCapture(
              { type: 'photo', text: app ? `(imported list from ${app})` : '(imported list)' },
              { name: r.name, location_hint: '', note: r.note ? `${app ?? 'Imported'}: ${r.note}` : '', dishes: [], candidates: [] },
              c,
              { type: 'app', name: app, url: null },
              list,
              tab === 'text' ? 'list_text' : 'screenshot',
            );
        next[i] = { ...r, status: res.saved ? 'Saved' : `Already on ${res.alreadyOn}` };
        if (res.saved) n += 1;
      } catch (e) {
        next[i] = { ...r, status: `Not saved: ${(e as Error).message}` };
      }
      setRows([...next]);
    }
    setSaving(false);
    setSavedCount(n);
    if (n) onSaved();
  }

  function close() {
    setRows([]);
    setApp(null);
    setSavedCount(null);
    setError(null);
    onClose();
  }

  const toSave = rows.filter((r) => r.pick != null && !r.status).length;
  const running = job && (job.status === 'queued' || job.status === 'running');

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={[styles.wrap, { paddingBottom: insets.bottom + 12 }]}>
        <SheetHeader title="Import places" action="Done" onAction={close} />
        <Segmented
          style={styles.tabs}
          options={TABS.map((t) => ({ value: t.key, label: t.label }))}
          value={tab}
          onChange={(k) => {
            setTab(k);
            setError(null);
          }}
        />
        {error && <Text style={styles.error}>{error}</Text>}

        {tab === 'maps' && (
          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.p}>Brings in your saved Google Maps lists (Want to go, Favorites and your own lists), with your notes.</Text>
            <Text style={styles.step}>1. Open Google Takeout and sign in.</Text>
            <Pressable onPress={() => Linking.openURL('https://takeout.google.com')} hitSlop={6}>
              <Text style={styles.link}>takeout.google.com</Text>
            </Pressable>
            <Text style={styles.step}>2. Tap "Deselect all", then check only "Saved".</Text>
            <Text style={styles.step}>3. Next step: export once, as a .zip. Create export.</Text>
            <Text style={styles.step}>4. Google emails you when it's ready (minutes to an hour). Download the .zip on this phone.</Text>
            <Text style={styles.step}>5. Come back here and choose the file.</Text>
            <Button title="Choose the Takeout file" icon="doc.zipper" onPress={upload} busy={uploading} disabled={(uploading || !!running)} />
            {job && (
              <View style={styles.job}>
                <Text style={styles.jobHead}>
                  {job.status === 'queued' ? 'Waiting to start…' : job.status === 'running' ? 'Importing… (a few minutes for big lists)' : job.status === 'done' ? 'Import done' : 'Import had a problem'}
                </Text>
                {!!job.message && <Text style={styles.p}>{job.message}</Text>}
                {running && <Text style={styles.muted}>You can close this; the import keeps going.</Text>}
              </View>
            )}
          </ScrollView>
        )}

        {tab !== 'maps' && (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {tab === 'link' ? (
              <>
                <Text style={styles.p}>An article or a page of notes that names several places, like a "best of" list. Every place on it shows up below for you to check.</Text>
                <TextInput
                  style={styles.linkInput}
                  value={link}
                  onChangeText={setLink}
                  placeholder="Paste a link"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <Button title="Find the places" icon="magnifyingglass" onPress={fromLink} busy={!!progress} disabled={(!!progress || !/^https?:\/\//i.test(link.trim()))} />
              </>
            ) : tab === 'shots' ? (
              <>
                <Text style={styles.p}>For lists in apps without an export, like Beli or Yelp collections: take screenshots of the list, then choose them here (up to 10 at a time).</Text>
                <Button title={rows.length ? 'Add more screenshots' : 'Choose screenshots'} icon="photo.on.rectangle" onPress={screenshots} busy={!!progress} disabled={!!progress} />
              </>
            ) : (
              <>
                <Text style={styles.p}>Paste a list of places: from a notes app, a message, a spreadsheet. One per line or any format.</Text>
                <TextInput
                  style={styles.input}
                  value={pasted}
                  onChangeText={setPasted}
                  multiline
                  placeholder={'Nopa\nDelfina (Mission)\nTacos el Gordo, Las Vegas'}
                  placeholderTextColor={colors.muted}
                />
                <Button title="Find these places" icon="magnifyingglass" onPress={fromText} busy={!!progress} disabled={(!!progress || !pasted.trim())} />
              </>
            )}
            {!!progress && <Text style={styles.muted}>{progress}</Text>}
            {rows.length > 0 && (
              <>
                <Text style={styles.p}>
                  {rows.length} places{app ? ` from ${app}` : ''}. Tap the right match, or Skip.
                </Text>
                <Segmented
                  options={[
                    { value: 'want_to_go' as const, label: 'Save to Want to go' },
                    { value: 'favorites' as const, label: 'Save to Favorites' },
                  ]}
                  value={list}
                  onChange={setList}
                />
                {rows.map((r, i) => (
                  <View key={`${r.name}-${i}`} style={styles.place}>
                    <Text style={styles.placeName}>
                      {r.name}
                      {r.note ? <Text style={styles.muted}>  {r.note}</Text> : null}
                    </Text>
                    {r.status ? (
                      <Text style={styles.muted}>{r.status}</Text>
                    ) : (
                      <>
                        {r.candidates.length === 0 && <Text style={styles.muted}>Not found on Google.</Text>}
                        {r.candidates.slice(0, 2).map((c, j) => (
                          <Pressable key={c.google_place_id} onPress={() => setRows((x) => x.map((y, k) => (k === i ? { ...y, pick: j } : y)))} style={[styles.cand, r.pick === j && styles.candOn]}>
                            <Text style={styles.candName}>{c.name}</Text>
                            {!!c.address && <Text style={styles.muted} numberOfLines={1}>{c.address}</Text>}
                          </Pressable>
                        ))}
                        {r.candidates.length > 0 && (
                          <Pressable onPress={() => setRows((x) => x.map((y, k) => (k === i ? { ...y, pick: null } : y)))} hitSlop={6}>
                            <Text style={[styles.skip, r.pick == null && { color: colors.text, fontWeight: '700' }]}>Skip</Text>
                          </Pressable>
                        )}
                      </>
                    )}
                  </View>
                ))}
              </>
            )}
          </ScrollView>
        )}

        {tab !== 'maps' && (toSave > 0 || savedCount != null) && (
          <View style={styles.footer}>
            {savedCount != null && <Text style={styles.muted}>Saved {savedCount}.</Text>}
            {toSave > 0 && (
              <Button title={`Save ${toSave} places`} icon="bookmark.fill" kind="tinted" color={colors.saved} onPress={saveAll} busy={saving} disabled={saving} />
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  tabs: { marginHorizontal: 16, marginVertical: 12 },
  linkInput: {
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.m, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16,
    color: colors.text, backgroundColor: colors.card,
  },
  body: { paddingHorizontal: 16, gap: 10, paddingBottom: 24 },
  p: { fontSize: 15, lineHeight: 21, color: colors.text },
  step: { fontSize: 15, lineHeight: 21, color: colors.text },
  link: { fontSize: 15, fontWeight: '700', color: colors.accent },
  muted: { fontSize: 14, color: colors.muted, fontWeight: '400' },
  error: { color: colors.danger, fontSize: 15, paddingHorizontal: 16 },
  input: {
    minHeight: 140, maxHeight: 260, borderWidth: 1, borderColor: colors.line, borderRadius: radius.m, padding: 12, fontSize: 16,
    color: colors.text, backgroundColor: colors.card, textAlignVertical: 'top',
  },
  job: { gap: 4, padding: 12, borderRadius: radius.m, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  jobHead: { fontSize: 15, fontWeight: '700', color: colors.text },
  place: { gap: 6, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  placeName: { fontSize: 16, fontWeight: '700', color: colors.text },
  cand: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.m, padding: 10, backgroundColor: colors.card },
  candOn: { borderColor: colors.saved, borderWidth: 2 },
  candName: { fontSize: 15, fontWeight: '600', color: colors.text },
  skip: { fontSize: 14, color: colors.muted, paddingVertical: 2 },
  footer: { paddingHorizontal: 16, paddingTop: 8, gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
});
