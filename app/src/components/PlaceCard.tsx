import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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
  wazeUrl,
  yelpUrl,
} from '@/lib/format';
import type { HideReason } from '@/lib/hide';
import { pickMentions, type Mention } from '@/lib/picks';
import { isOpenNow, todaysHours } from '@/lib/hours';
import { fetchPlaceDetails, type NearbyPlace, type PlaceDetails } from '@/lib/supabase';
import { listVisits, REACTION_LABEL, type Visit } from '@/lib/visits';
import { colors, groupColor, radius } from '@/lib/theme';
import { Button, Icon } from '@/components/ui';
import WhyNot from '@/components/WhyNot';

type Props = {
  place: NearbyPlace | null;
  onClose: () => void;
  onHide: (p: NearbyPlace, reason: HideReason) => void;
  onMove: (p: NearbyPlace, list: 'favorites' | 'want_to_go') => void;
  onPick: (p: NearbyPlace, action: 'want' | 'not_interested', note?: string | null) => void;
  onLogVisit: (p: NearbyPlace) => void;
  visitsKey: number; // changes after a visit is saved, to reload the list
  onDetails: (googleId: string, d: PlaceDetails) => void; // so the list and filters see it too
  starred: boolean;
  onStar: (p: NearbyPlace, on: boolean) => void;
};

function shortDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Bottom card with the basics for one place
export default function PlaceCard({ place, onClose, onHide, onMove, onPick, onLogVisit, visitsKey, onDetails, starred, onStar }: Props) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [loading, setLoading] = useState(false);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [asking, setAsking] = useState(false); // after Not interested: why?
  useEffect(() => setAsking(false), [place]);

  // your past visits here: date, reaction, what you ordered, photos
  useEffect(() => {
    setVisits([]);
    if (!place) return;
    let cancelled = false;
    listVisits(place).then((v) => !cancelled && setVisits(v));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place?.ref, place?.kind, visitsKey]);

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
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: height * 0.75 }]}>
          <View style={styles.handle} />
          {asking ? (
            <WhyNot name={place.name} onDone={(note) => onPick(place, 'not_interested', note)} />
          ) : (
          <>
          <ScrollView contentContainerStyle={{ gap: 8 }}>
            <View style={styles.row}>
              <Text style={[styles.badge, { backgroundColor: groupColor[groupOf(place)] }]}>{placeLabel(place)}</Text>
              <Text style={styles.muted}>{formatDistance(place.distance_m)}</Text>
            </View>
            <View style={styles.nameRow}>
              <Text style={[styles.name, { flex: 1 }]}>{place.name}</Text>
              {/* star a Want to go place (a starred place that moved to Favorites can still be unstarred) */}
              {place.kind === 'saved' && (place.list_name === 'want_to_go' || starred) && (
                <Pressable
                  onPress={() => onStar(place, !starred)}
                  hitSlop={10}
                  style={[styles.starBtn, starred && styles.starBtnOn]}
                  accessibilityLabel={starred ? 'Remove star' : 'Star: show at the top of Best match'}>
                  <Icon name={starred ? 'star.fill' : 'star'} color={starred ? '#fff' : colors.star} size={14} />
                  <Text style={[styles.starText, starred && { color: '#fff' }]}>{starred ? 'Starred' : 'Star'}</Text>
                </Pressable>
              )}
            </View>

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

            {place.kind === 'pick' && !!place.why && <Text style={styles.why}>Why you: {place.why}</Text>}
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
            {visits.length > 0 && <Text style={styles.noteLabel}>Your visits</Text>}
            {visits.map((v) => (
              <View key={v.id} style={styles.visit}>
                <Text style={styles.visitHead}>
                  {shortDate(v.visited_on)}
                  {v.reaction ? ` · ${REACTION_LABEL[v.reaction]}` : ''}
                  {v.bill_total !== null ? ` · $${Number(v.bill_total).toFixed(2)}` : ''}
                </Text>
                {!!v.thoughts && <Text style={styles.text}>{v.thoughts}</Text>}
                {v.items.length > 0 && (
                  <Text style={styles.muted}>
                    {v.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ')}
                  </Text>
                )}
                {(v.photos.length > 0 || v.bill) && (
                  <ScrollView horizontal contentContainerStyle={{ gap: 6 }}>
                    {v.photos.map((u) => (
                      <Pressable key={u} onPress={() => Linking.openURL(u)}>
                        <Image source={{ uri: u }} style={styles.thumb} />
                      </Pressable>
                    ))}
                    {v.bill && (
                      <Pressable onPress={() => Linking.openURL(v.bill as string)}>
                        <Image source={{ uri: v.bill }} style={styles.thumb} />
                      </Pressable>
                    )}
                  </ScrollView>
                )}
              </View>
            ))}
          </ScrollView>

          <View style={styles.hideRow}>
            <Button title="Google Maps" style={{ flex: 1 }} onPress={() => Linking.openURL(mapsUrl(place))} />
            <Button title="Waze" kind="secondary" style={styles.side} onPress={() => Linking.openURL(wazeUrl(place))} />
            <Button title="Yelp" kind="secondary" style={styles.side} onPress={() => Linking.openURL(yelpUrl(place))} />
          </View>
          {place.kind === 'pick' && (
            <View style={styles.hideRow}>
              <Button title="Want to go" kind="tinted" color={colors.saved} style={{ flex: 1 }} onPress={() => onPick(place, 'want')} />
              <Button title="Not interested" kind="secondary" style={{ flex: 1 }} onPress={() => setAsking(true)} />
            </View>
          )}
          <View style={styles.hideRow}>
            <Button title="Log a visit" icon="checkmark.circle" kind="outline" style={{ flex: 1 }} onPress={() => onLogVisit(place)} />
            {place.kind === 'saved' && (
              <Button
                title={place.list_name === 'favorites' ? 'To Want to go' : 'To Favorites'}
                icon={place.list_name === 'favorites' ? 'bookmark' : 'heart'}
                kind="outline"
                style={{ flex: 1 }}
                onPress={() => onMove(place, place.list_name === 'favorites' ? 'want_to_go' : 'favorites')}
              />
            )}
          </View>
          {place.kind === 'saved' && (
            <View style={styles.hideRow}>
              <Button title="Closed for good" kind="secondary" small style={{ flex: 1 }} onPress={() => onHide(place, 'closed')} />
              <Button title="Didn't like it" kind="secondary" small style={{ flex: 1 }} onPress={() => onHide(place, 'didnt_like')} />
            </View>
          )}
          </>
          )}
        </View>
        </KeyboardAvoidingView>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 8,
    gap: 12,
  },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: { color: '#fff', fontSize: 13, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden' },
  name: { fontSize: 24, fontWeight: '800', color: colors.text, letterSpacing: -0.3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  starBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1.5, borderColor: colors.star, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  starBtnOn: { backgroundColor: colors.star },
  starText: { fontSize: 15, fontWeight: '700', color: colors.star },
  factsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  facts: { fontSize: 16, fontWeight: '600', color: colors.text },
  text: { fontSize: 16, color: colors.text, lineHeight: 22 },
  muted: { fontSize: 15, color: colors.muted, fontWeight: '400' },
  source: { fontSize: 14, color: colors.muted, fontStyle: 'italic' },
  noteBox: { backgroundColor: colors.bg, borderRadius: radius.m, padding: 12, gap: 4, marginTop: 4 },
  noteLabel: { fontSize: 13, fontWeight: '600', color: colors.muted },
  hideRow: { flexDirection: 'row', gap: 8 },
  side: { paddingHorizontal: 14 },
  why: { fontSize: 15, fontWeight: '600', color: colors.pick },
  visit: { gap: 3, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  visitHead: { fontSize: 15, fontWeight: '600', color: colors.text },
  thumb: { width: 72, height: 72, borderRadius: 8, backgroundColor: colors.line },
  mention: { gap: 2, paddingTop: 2 },
  mentionSource: { fontSize: 15, fontWeight: '600', color: colors.text },
  link: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
