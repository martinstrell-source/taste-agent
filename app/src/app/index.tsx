import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import PlaceCard from '@/components/PlaceCard';
import {
  categoryText,
  deltaForRadius,
  formatDistance,
  GROUP_LABEL,
  groupOf,
  metersBetween,
  placeLabel,
  type Group,
} from '@/lib/format';
import { fetchNearby, supabase, type NearbyPlace } from '@/lib/supabase';
import { colors, groupColor } from '@/lib/theme';

const RADII = [1000, 3000, 10000];
const GROUPS: Group[] = ['favorites', 'want_to_go', 'other', 'pick'];
// used only if location is off: central San Francisco, so the map still works
const FALLBACK = { lat: 37.7749, lng: -122.4194 };

type Point = { lat: number; lng: number };

export default function Nearby() {
  const mapRef = useRef<MapView>(null);
  const [center, setCenter] = useState<Point | null>(null); // where the last search was centered
  const [mapCenter, setMapCenter] = useState<Point | null>(null); // where the map is now
  const [radius, setRadius] = useState(1000);
  const [hidden, setHidden] = useState<Set<Group>>(new Set()); // groups switched off
  const [places, setPlaces] = useState<NearbyPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locationOff, setLocationOff] = useState(false);
  const [selected, setSelected] = useState<NearbyPlace | null>(null);

  // where am I?
  const locate = useCallback(async () => {
    setError(null);
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) {
      setLocationOff(true);
      setCenter((c) => c ?? FALLBACK);
      return;
    }
    setLocationOff(false);
    const last = await Location.getLastKnownPositionAsync();
    if (last) setCenter({ lat: last.coords.latitude, lng: last.coords.longitude });
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
  }, []);

  useEffect(() => {
    locate().catch((e) => {
      setError(`Could not get your location: ${e.message}`);
      setCenter((c) => c ?? FALLBACK);
    });
  }, [locate]);

  // search whenever the center or radius changes
  useEffect(() => {
    if (!center) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchNearby(center.lat, center.lng, radius)
      .then((rows) => !cancelled && setPlaces(rows))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    mapRef.current?.animateToRegion(
      {
        latitude: center.lat,
        longitude: center.lng,
        latitudeDelta: deltaForRadius(radius),
        longitudeDelta: deltaForRadius(radius),
      },
      300,
    );
    return () => {
      cancelled = true;
    };
  }, [center, radius]);

  const counts = useMemo(() => {
    const c: Record<Group, number> = { favorites: 0, want_to_go: 0, other: 0, pick: 0 };
    for (const p of places) c[groupOf(p)] += 1;
    return c;
  }, [places]);
  const shown = useMemo(() => places.filter((p) => !hidden.has(groupOf(p))), [places, hidden]);

  function toggle(g: Group) {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }

  // offer "search this area" once the map has moved away from the last search
  const moved = !!(center && mapCenter && metersBetween(center, mapCenter) > radius * 0.3);

  function onRegionChangeComplete(r: Region) {
    setMapCenter({ lat: r.latitude, lng: r.longitude });
  }

  return (
    <SafeAreaView style={styles.wrap} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Nearby</Text>
      </View>

      <View style={styles.mapWrap}>
        {center && (
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            initialRegion={{
              latitude: center.lat,
              longitude: center.lng,
              latitudeDelta: deltaForRadius(radius),
              longitudeDelta: deltaForRadius(radius),
            }}
            showsUserLocation={!locationOff}
            onRegionChangeComplete={onRegionChangeComplete}>
            {shown.map((p) => (
              <Marker
                key={`${p.kind}:${p.ref}`}
                coordinate={{ latitude: p.place_lat, longitude: p.place_lng }}
                pinColor={groupColor[groupOf(p)]}
                tracksViewChanges={false}
                onPress={() => setSelected(p)}
              />
            ))}
          </MapView>
        )}
        {moved && (
          <Pressable style={styles.searchHere} onPress={() => mapCenter && setCenter(mapCenter)}>
            <Text style={styles.searchHereText}>Search this area</Text>
          </Pressable>
        )}
        <Pressable style={styles.locateBtn} onPress={() => locate()} hitSlop={8} accessibilityLabel="My location">
          <Text style={styles.locateText}>◎</Text>
        </Pressable>
      </View>

      {/* radius, then which groups to show; wraps to a second line on narrow phones */}
      <View style={styles.controls}>
        <View style={styles.segment}>
          {RADII.map((r) => (
            <Pressable key={r} onPress={() => setRadius(r)} style={[styles.segItem, radius === r && styles.segOn]}>
              <Text style={[styles.segText, radius === r && styles.segTextOn]}>{formatDistance(r)}</Text>
            </Pressable>
          ))}
        </View>
        {GROUPS.filter((g) => g !== 'other' || counts.other > 0).map((g) => {
          const on = !hidden.has(g);
          return (
            <Pressable
              key={g}
              onPress={() => toggle(g)}
              style={[styles.toggle, on ? { backgroundColor: groupColor[g], borderColor: groupColor[g] } : null]}>
              <Text style={[styles.toggleText, on && styles.toggleTextOn]}>
                {GROUP_LABEL[g]} {counts[g]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {locationOff && (
        <Pressable style={styles.notice} onPress={() => Linking.openSettings()}>
          <Text style={styles.noticeText}>
            Location is off, so this shows San Francisco. Tap to turn it on in Settings, or move the map and tap
            "Search this area".
          </Text>
        </Pressable>
      )}
      {error && <Text style={styles.error}>{error}</Text>}

      {loading && places.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(p) => `${p.kind}:${p.ref}`}
          contentContainerStyle={{ paddingBottom: 32 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {loading
                ? ''
                : places.length > 0
                  ? 'Everything here is switched off. Tap a group above to show it.'
                  : radius < 10000
                    ? `Nothing within ${formatDistance(radius)}. Try a wider radius.`
                    : 'Nothing here yet.'}
            </Text>
          }
          ListFooterComponent={
            <Pressable onPress={() => supabase.auth.signOut()} style={styles.signOut} hitSlop={8}>
              <Text style={styles.signOutText}>Sign out</Text>
            </Pressable>
          }
          renderItem={({ item }) => <Row place={item} onPress={() => setSelected(item)} />}
        />
      )}

      <PlaceCard place={selected} onClose={() => setSelected(null)} />
    </SafeAreaView>
  );
}

function Row({ place, onPress }: { place: NearbyPlace; onPress: () => void }) {
  const cats = categoryText(place);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.line }]}>
      <View style={[styles.dot, { backgroundColor: groupColor[groupOf(place)] }]} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>
            {place.name}
          </Text>
          <Text style={styles.dist}>{formatDistance(place.distance_m)}</Text>
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {[placeLabel(place), cats].filter(Boolean).join(' · ')}
        </Text>
        {!!place.note && (
          <Text style={styles.note} numberOfLines={2}>
            {place.note}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  title: { fontSize: 28, fontWeight: '700', color: colors.text },
  mapWrap: { height: '36%', backgroundColor: colors.line },
  searchHere: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  searchHereText: { color: colors.accent, fontWeight: '600', fontSize: 15 },
  locateBtn: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  locateText: { fontSize: 22, color: colors.accent, lineHeight: 26 },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  segment: {
    flexDirection: 'row',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  segItem: { paddingHorizontal: 10, paddingVertical: 6 },
  segOn: { backgroundColor: colors.text },
  segText: { fontSize: 14, color: colors.text },
  segTextOn: { color: '#fff', fontWeight: '600' },
  toggle: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  toggleText: { fontSize: 14, color: colors.muted },
  toggleTextOn: { color: '#fff', fontWeight: '600' },
  notice: { margin: 16, marginBottom: 0, padding: 12, borderRadius: 10, backgroundColor: '#FFF1E0' },
  noticeText: { color: colors.text, fontSize: 14 },
  error: { color: colors.danger, paddingHorizontal: 16, paddingTop: 8 },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'flex-start' },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  name: { flex: 1, fontSize: 17, fontWeight: '600', color: colors.text },
  dist: { fontSize: 14, color: colors.muted },
  meta: { fontSize: 14, color: colors.muted },
  note: { fontSize: 14, color: colors.text },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 38 },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 24, paddingHorizontal: 24 },
  signOut: { alignSelf: 'center', marginTop: 24, padding: 8 },
  signOutText: { color: colors.muted, fontSize: 14 },
});
