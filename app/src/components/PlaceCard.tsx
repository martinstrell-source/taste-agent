import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  categoryText,
  formatDistance,
  groupOf,
  mapsUrl,
  placeLabel,
  priceText,
  ratingText,
  sourceLine,
} from '@/lib/format';
import type { HideReason } from '@/lib/hide';
import { pickMentions, type Mention } from '@/lib/picks';
import { isOpenNow, todaysHours } from '@/lib/hours';
import { fetchPlaceDetails, type NearbyPlace, type PlaceDetails } from '@/lib/supabase';
import { colors, groupColor } from '@/lib/theme';

type Props = {
  place: NearbyPlace | null;
  onClose: () => void;
  onHide: (p: NearbyPlace, reason: HideReason) => void;
  onMove: (p: NearbyPlace, list: 'favorites' | 'want_to_go') => void;
  onPick: (p: NearbyPlace, action: 'want' | 'not_interested') => void;
  onDetails: (googleId: string, d: PlaceDetails) => void; // so the list and filters see it too
};

function shortDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Bottom card with the basics for one place
export default function PlaceCard({ place, onClose, onHide, onMove, onPick, onDetails }: Props) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [mentions, setMentions] = useState<Mention[]>([]);

  // for picks: which outlet mentioned it, with a link to the article
  useEffect(() => {
    setMentions([]);
    const gid = place?.kind === 'pick' ? (place.google_place_id ?? place.ref) : null;
    if (!gid) return;
    let cancelled = false;
    pickMentions(gid).then((m) => !cancelled && setMentions(m));
    return () => {
      cancelled = true;
    };
  }, [place?.kind, place?.ref, place?.google_place_id]);

  // rating, price and hours from Google the first time a card opens (cached on the server)
  useEffect(() => {
    const gid = place?.google_place_id;
    if (!gid || place?.opening_hours) return;
    let cancelled = false;
    setLoading(true);
    fetchPlaceDetails([gid], true)
      .then((d) => !cancelled && d[gid] && onDetails(gid, d[gid]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place?.google_place_id]);

  const open = place ? isOpenNow(place.opening_hours) : null;
  const hoursToday = place ? todaysHours(place.opening_hours) : null;
  const facts = place
    ? [ratingText(place.rating, place.review_count), priceText(place.price_level)].filter(Boolean).join(' · ')
    : '';
  const source = place ? sourceLine(place) : null;

  return (
    <Modal visible={!!place} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      {place && (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={{ gap: 8 }}>
            <View style={styles.row}>
              <Text style={[styles.badge, { backgroundColor: groupColor[groupOf(place)] }]}>{placeLabel(place)}</Text>
              <Text style={styles.muted}>{formatDistance(place.distance_m)}</Text>
            </View>
            <Text style={styles.name}>{place.name}</Text>

            {(facts || open !== null || loading) && (
              <View style={styles.factsRow}>
                {!!facts && <Text style={styles.facts}>{facts}</Text>}
                {open !== null && (
                  <Text style={[styles.facts, { color: open ? colors.saved : colors.danger }]}>
                    {open ? 'Open now' : 'Closed now'}
                    {hoursToday ? <Text style={styles.muted}>{`  ${hoursToday}`}</Text> : null}
                  </Text>
                )}
                {loading && <ActivityIndicator size="small" />}
              </View>
            )}

            {!!categoryText(place) && <Text style={styles.muted}>{categoryText(place, 5)}</Text>}
            {!!place.address && <Text style={styles.text}>{place.address}</Text>}
            {!!place.note && (
              <View style={styles.noteBox}>
                <Text style={styles.noteLabel}>{place.kind === 'pick' ? 'What the article said' : 'Your note'}</Text>
                <Text style={styles.text}>{place.note}</Text>
              </View>
            )}
            {mentions.map((m, i) => (
              <View key={i} style={styles.mention}>
                <Text style={styles.mentionSource}>
                  {m.source === 'Google Maps search' ? 'Found by a Google search for new places' : m.source}
                  {m.published && m.source !== 'Google Maps search' ? ` · ${shortDate(m.published)}` : ''}
                </Text>
                {!!m.title && m.source !== 'Google Maps search' && <Text style={styles.muted}>{m.title}</Text>}
                {!!m.link && m.link.startsWith('http') && m.source !== 'Google Maps search' && (
                  <Pressable onPress={() => Linking.openURL(m.link as string)} hitSlop={6}>
                    <Text style={styles.link}>Read the article</Text>
                  </Pressable>
                )}
              </View>
            ))}
            {!!source && <Text style={styles.source}>{source}</Text>}
          </ScrollView>

          <Pressable
            style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]}
            onPress={() => Linking.openURL(mapsUrl(place))}>
            <Text style={styles.buttonText}>Open in Maps</Text>
          </Pressable>
          {place.kind === 'pick' && (
            <View style={styles.hideRow}>
              <Pressable style={[styles.hideBtn, styles.wantBtn]} onPress={() => onPick(place, 'want')}>
                <Text style={[styles.hideText, { color: '#fff' }]}>Want to go</Text>
              </Pressable>
              <Pressable style={styles.hideBtn} onPress={() => onPick(place, 'not_interested')}>
                <Text style={styles.hideText}>Not interested</Text>
              </Pressable>
            </View>
          )}
          {place.kind === 'saved' && (
            <Pressable
              style={styles.moveBtn}
              onPress={() => onMove(place, place.list_name === 'favorites' ? 'want_to_go' : 'favorites')}>
              <Text style={styles.hideText}>
                {place.list_name === 'favorites' ? 'Move to Want to go' : 'Move to Favorites'}
              </Text>
            </Pressable>
          )}
          {place.kind === 'saved' && (
            <View style={styles.hideRow}>
              <Pressable style={styles.hideBtn} onPress={() => onHide(place, 'closed')}>
                <Text style={styles.hideText}>Permanently closed</Text>
              </Pressable>
              <Pressable style={styles.hideBtn} onPress={() => onHide(place, 'didnt_like')}>
                <Text style={styles.hideText}>Tried it, didn't like it</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 8,
    maxHeight: '75%',
    gap: 12,
  },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: { color: '#fff', fontSize: 13, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' },
  name: { fontSize: 22, fontWeight: '700', color: colors.text },
  factsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  facts: { fontSize: 16, fontWeight: '600', color: colors.text },
  text: { fontSize: 16, color: colors.text, lineHeight: 22 },
  muted: { fontSize: 15, color: colors.muted, fontWeight: '400' },
  source: { fontSize: 14, color: colors.muted, fontStyle: 'italic' },
  noteBox: { backgroundColor: colors.bg, borderRadius: 10, padding: 12, gap: 4, marginTop: 4 },
  noteLabel: { fontSize: 13, fontWeight: '600', color: colors.muted },
  button: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  hideRow: { flexDirection: 'row', gap: 10 },
  // secondary buttons: filled and bold so they read as buttons, but quieter than Open in Maps
  hideBtn: {
    flex: 1,
    backgroundColor: '#EFE8DD',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hideText: { color: colors.text, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  wantBtn: { backgroundColor: colors.saved },
  mention: { gap: 2, paddingTop: 2 },
  mentionSource: { fontSize: 15, fontWeight: '600', color: colors.text },
  link: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  // full width on its own line; no flex:1 here (in a column that squeezes the button and hides its label)
  moveBtn: {
    backgroundColor: '#EFE8DD',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
});
