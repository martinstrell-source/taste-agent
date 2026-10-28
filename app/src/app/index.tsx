import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import AddPlace from '@/components/AddPlace';
import HiddenList from '@/components/HiddenList';
import LogVisit from '@/components/LogVisit';
import PlaceCard from '@/components/PlaceCard';
import {
  categoryText,
  deltaForRadius,
  formatDistance,
  GROUP_LABEL,
  groupOf,
  kindOf,
  metersBetween,
  placeLabel,
  PRICE_STEPS,
  priceText,
  ratingText,
  type Group,
  type Kind,
} from '@/lib/format';
import { hidePlace, moveToList, undoHide, type HideReason } from '@/lib/hide';
import { areaName, runDiscover } from '@/lib/discover';
import { notInterested, saveFromPick, undoPick } from '@/lib/picks';
import { suggestPlaces, type Suggestion } from '@/lib/places-search';
import { isOpenNow } from '@/lib/hours';
import { fetchNearby, fetchPlaceDetails, supabase, type NearbyPlace, type PlaceDetails } from '@/lib/supabase';
import { colors, groupColor } from '@/lib/theme';

const RADII = [1000, 3000, 10000];
const GROUPS: Group[] = ['favorites', 'want_to_go', 'other', 'pick'];
const KINDS: { key: Kind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'food', label: 'Food' },
  { key: 'drink', label: 'Drinks & sweets' },
];
// used only if location is off: central San Francisco, so the map still works
const FALLBACK = { lat: 37.7749, lng: -122.4194 };

type Point = { lat: number; lng: number };

export default function Nearby() {
  const mapRef = useRef<MapView>(null);
  const [center, setCenter] = useState<Point | null>(null); // where the last search was centered
  const [mapCenter, setMapCenter] = useState<Point | null>(null); // where the map is now
  const [radius, setRadius] = useState(1000);
  const [hiddenGroups, setHiddenGroups] = useState<Set<Group>>(new Set());
  const [places, setPlaces] = useState<NearbyPlace[]>([]);
  const [details, setDetails] = useState<Record<string, PlaceDetails>>({}); // Google data fetched in the app
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locationOff, setLocationOff] = useState(false);
  const [selected, setSelected] = useState<NearbyPlace | null>(null);
  const [reload, setReload] = useState(0);

  // search a city or neighborhood by name
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [placeName, setPlaceName] = useState<string | null>(null); // shown while away from current location
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [focused, setFocused] = useState(false);

  // filters
  const [showFilters, setShowFilters] = useState(false);

  // map can be collapsed for more list on small phones; remembered between launches
  const [mapOpen, setMapOpen] = useState(true);
  // Nearest, or Best match (picks by taste score first); also remembered
  const [sort, setSort] = useState<'near' | 'match'>('near');
  useEffect(() => {
    AsyncStorage.multiGet(['mapOpen', 'sort'])
      .then((kv) => {
        if (kv[0][1] === 'false') setMapOpen(false);
        if (kv[1][1] === 'match') setSort('match');
      })
      .catch(() => {});
  }, []);
  function chooseSort(s: 'near' | 'match') {
    setSort(s);
    AsyncStorage.setItem('sort', s).catch(() => {});
  }
  function toggleMap() {
    setMapOpen((o) => {
      AsyncStorage.setItem('mapOpen', String(!o)).catch(() => {});
      return !o;
    });
  }
  const [kind, setKind] = useState<Kind>('all');
  const [prices, setPrices] = useState<Set<string>>(new Set());
  const [openNow, setOpenNow] = useState(false);
  const [checking, setChecking] = useState(false);

  // hide with undo
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<void> } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [discovering, setDiscovering] = useState<string | null>(null); // status line while Discover runs
  const [visitFor, setVisitFor] = useState<NearbyPlace | null>(null);
  const [visitsKey, setVisitsKey] = useState(0);

  // where am I?
  const locate = useCallback(async () => {
    setError(null);
    setPlaceName(null);
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
  }, [center, radius, reload]);

  // suggestions while typing (2+ letters), nearest first, after a short pause
  useEffect(() => {
    const q = query.trim();
    if (!focused || q.length < 2) {
      setSuggestions([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      suggestPlaces(q, center ?? undefined, ctl.signal)
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, focused]);

  function choose(sg: Suggestion) {
    Keyboard.dismiss();
    setQuery(sg.label);
    setSuggestions([]);
    setPlaceName(sg.label);
    setRadius((r) => Math.max(r, 3000));
    setCenter({ lat: sg.lat, lng: sg.lng });
  }

  async function goTo() {
    const q = query.trim();
    if (!q) return;
    Keyboard.dismiss();
    setSearching(true);
    setError(null);
    try {
      const hits = await Location.geocodeAsync(q);
      if (!hits.length) {
        setError(`Couldn't find "${q}". Try adding the city or state.`);
        return;
      }
      setPlaceName(q);
      setRadius((r) => Math.max(r, 3000)); // a city view, not a block
      setCenter({ lat: hits[0].latitude, lng: hits[0].longitude });
    } catch (e) {
      setError(`Couldn't look up "${q}": ${(e as Error).message}`);
    } finally {
      setSearching(false);
    }
  }

  // places with Google details merged in (from nearby() or fetched here)
  const merged = useMemo(
    () =>
      places.map((p) => {
        const d = p.google_place_id ? details[p.google_place_id] : undefined;
        return d ? { ...p, ...d } : p;
      }),
    [places, details],
  );

  const needDetails = prices.size > 0 || openNow;
  // price and open now need Google data; fetch it for places on screen that don't have it yet
  useEffect(() => {
    if (!needDetails) return;
    const missing = merged
      .filter((p) => p.google_place_id && (openNow ? !p.opening_hours : !p.price_level && !p.rating))
      .map((p) => p.google_place_id as string)
      .slice(0, 120);
    if (!missing.length) return;
    let cancelled = false;
    setChecking(true);
    fetchPlaceDetails(missing, openNow)
      .then((d) => !cancelled && setDetails((old) => ({ ...old, ...d })))
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needDetails, openNow, places]);

  const byGroup = useMemo(() => {
    const c: Record<Group, number> = { favorites: 0, want_to_go: 0, other: 0, pick: 0 };
    for (const p of merged) c[groupOf(p)] += 1;
    return c;
  }, [merged]);

  const { shown, unknown } = useMemo(() => {
    let unknownCount = 0;
    const list = merged.filter((p) => {
      if (hiddenGroups.has(groupOf(p))) return false;
      if (kind !== 'all' && kindOf(p) !== kind) return false;
      if (prices.size) {
        const pr = priceText(p.price_level);
        if (!pr) {
          unknownCount += 1;
          return false;
        }
        if (!prices.has(pr)) return false;
      }
      if (openNow) {
        const o = isOpenNow(p.opening_hours);
        if (o === null) {
          unknownCount += 1;
          return false;
        }
        if (!o) return false;
      }
      return true;
    });
    if (sort === 'match') {
      // strongest picks first (unscored new picks after them), then your saves: Favorites, Want to go, others
      const rank = (p: NearbyPlace) =>
        p.kind === 'pick' ? (p.score == null ? 1 : 0) : p.list_name === 'favorites' ? 2 : p.list_name === 'want_to_go' ? 3 : 4;
      list.sort((a, b) => rank(a) - rank(b) || (b.score ?? 0) - (a.score ?? 0) || a.distance_m - b.distance_m);
    }
    return { shown: list, unknown: unknownCount };
  }, [merged, hiddenGroups, kind, prices, openNow, sort]);

  const activeFilters = (kind !== 'all' ? 1 : 0) + (prices.size ? 1 : 0) + (openNow ? 1 : 0) + (sort === 'match' ? 1 : 0);

  function toggleGroup(g: Group) {
    setHiddenGroups((h) => {
      const next = new Set(h);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }
  function togglePrice(p: string) {
    setPrices((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function hide(p: NearbyPlace, reason: HideReason) {
    setSelected(null);
    try {
      const receipt = await hidePlace(p, reason);
      setPlaces((ps) => ps.filter((x) => !(x.kind === 'saved' && x.ref === p.ref)));
      offerUndo(`Hid ${p.name}`, () => undoHide(receipt));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function move(p: NearbyPlace, list: 'favorites' | 'want_to_go') {
    try {
      await moveToList(p, list);
      setPlaces((ps) => ps.map((x) => (x.kind === 'saved' && x.ref === p.ref ? { ...x, list_name: list } : x)));
      setSelected((s) => (s && s.ref === p.ref ? { ...s, list_name: list } : s));
    } catch (e) {
      setSelected(null);
      setError((e as Error).message);
    }
  }
  function offerUndo(label: string, run: () => Promise<void>) {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ label, run });
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  }
  async function doUndo() {
    if (!undo) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    const u = undo;
    setUndo(null);
    await u.run();
    setReload((n) => n + 1);
  }
  async function pickAction(p: NearbyPlace, action: 'want' | 'not_interested') {
    setSelected(null);
    try {
      const receipt = action === 'want' ? await saveFromPick(p) : await notInterested(p);
      if (action === 'want') setReload((n) => n + 1); // comes back as one of your saves
      else setPlaces((ps) => ps.filter((x) => !(x.kind === 'pick' && x.ref === p.ref)));
      offerUndo(action === 'want' ? `Added ${p.name} to Want to go` : `Won't show ${p.name} again`, () => undoPick(receipt));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Discover: places you'd like around the map's center. Quick Google results first, then the web.
  async function discover() {
    const at = mapCenter ?? center;
    if (!at || discovering) return;
    const name = (await areaName(at.lat, at.lng)) ?? placeName ?? undefined;
    const label = name ?? 'here';
    setError(null);
    setDiscovering(`Finding places you'd like near ${label}…`);
    try {
      const quick = await runDiscover('google', at.lat, at.lng, 6000, name);
      // show what was found: wider radius, best matches first
      setRadius(10000);
      chooseSort('match');
      setCenter({ ...at });
      setDiscovering(`Found ${quick.places} nearby. Searching the local food press…`);
      const web = await runDiscover('web', at.lat, at.lng, 8000, name);
      setReload((n) => n + 1);
      setDiscovering(
        web.message ??
          (web.places
            ? `Added ${web.places} from the local food press${web.cached ? ' (searched recently)' : ''}.`
            : 'No more from the web this time.'),
      );
      setTimeout(() => setDiscovering(null), 5000);
    } catch (e) {
      setDiscovering(null);
      setError((e as Error).message);
    }
  }

  // offer "search this area" once the map has moved away from the last search
  const moved = !!(center && mapCenter && metersBetween(center, mapCenter) > radius * 0.3);

  function onRegionChangeComplete(r: Region) {
    setMapCenter({ lat: r.latitude, lng: r.longitude });
  }

  return (
    <SafeAreaView style={styles.wrap} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {placeName ? placeName : 'Nearby'}
        </Text>
        <Pressable
          style={[styles.addBtn, styles.discoverBtn, !!discovering && { opacity: 0.6 }]}
          onPress={discover}
          disabled={!!discovering}
          accessibilityLabel="Discover places here">
          <Text style={styles.addText}>Discover</Text>
        </Pressable>
        <Pressable style={styles.addBtn} onPress={() => setShowAdd(true)} accessibilityLabel="Add a place">
          <Text style={styles.addText}>+ Add</Text>
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Go to a city or neighborhood"
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          onSubmitEditing={() => (suggestions[0] ? choose(suggestions[0]) : goTo())}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 250)} // let a tap on a suggestion land first
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {searching && <ActivityIndicator style={{ marginLeft: 8 }} />}
      </View>
      {/* suggestions hang over whatever is below (map or list), so they work with the map hidden too */}
      <View style={styles.suggestAnchor}>
      {suggestions.length > 0 && (
        <View style={styles.suggestBox}>
          {suggestions.map((sg) => (
            <Pressable
              key={sg.key}
              onPress={() => choose(sg)}
              style={({ pressed }) => [styles.suggestRow, pressed && { backgroundColor: colors.line }]}>
              <Text style={styles.suggestName}>{sg.label}</Text>
              {!!sg.detail && <Text style={styles.suggestDetail}>{sg.detail}</Text>}
            </Pressable>
          ))}
          <Text style={styles.osm}>Suggestions © OpenStreetMap contributors</Text>
        </View>
      )}
      </View>

      {mapOpen && (
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
          <Pressable
            style={styles.searchHere}
            onPress={() => {
              if (!mapCenter) return;
              setPlaceName('This area');
              setCenter(mapCenter);
            }}>
            <Text style={styles.searchHereText}>Search this area</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.locateBtn}
          onPress={() => {
            setQuery('');
            locate();
          }}
          hitSlop={8}
          accessibilityLabel="My location">
          <Text style={styles.locateText}>◎</Text>
        </Pressable>
      </View>
      )}

      {/* radius, groups, and a Filters button; wraps on narrow phones */}
      <View style={styles.controls}>
        <Pressable onPress={toggleMap} style={styles.toggle} hitSlop={4}>
          <Text style={styles.toggleText}>{mapOpen ? 'Hide map' : 'Map'}</Text>
        </Pressable>
        {!mapOpen && (
          <Pressable
            onPress={() => {
              setQuery('');
              locate();
            }}
            style={styles.toggle}
            accessibilityLabel="My location">
            <Text style={[styles.toggleText, { color: colors.accent }]}>◎</Text>
          </Pressable>
        )}
        <View style={styles.segment}>
          {RADII.map((r) => (
            <Pressable key={r} onPress={() => setRadius(r)} style={[styles.segItem, radius === r && styles.segOn]}>
              <Text style={[styles.segText, radius === r && styles.segTextOn]}>{formatDistance(r)}</Text>
            </Pressable>
          ))}
        </View>
        {GROUPS.filter((g) => g !== 'other' || byGroup.other > 0).map((g) => {
          const on = !hiddenGroups.has(g);
          return (
            <Pressable
              key={g}
              onPress={() => toggleGroup(g)}
              style={[styles.toggle, on ? { backgroundColor: groupColor[g], borderColor: groupColor[g] } : null]}>
              <Text style={[styles.toggleText, on && styles.toggleTextOn]}>
                {GROUP_LABEL[g]} {byGroup[g]}
              </Text>
            </Pressable>
          );
        })}
        <Pressable onPress={() => setShowFilters((s) => !s)} style={[styles.toggle, activeFilters > 0 && styles.filterOn]}>
          <Text style={[styles.toggleText, activeFilters > 0 && styles.toggleTextOn]}>
            Filters{activeFilters ? ` ${activeFilters}` : ''} {showFilters ? '▴' : '▾'}
          </Text>
        </Pressable>
      </View>

      {showFilters && (
        <View style={styles.filters}>
          <View style={styles.filterRow}>
            <Text style={styles.filterLabel}>Sort</Text>
            <View style={styles.segment}>
              {(['near', 'match'] as const).map((s) => (
                <Pressable key={s} onPress={() => chooseSort(s)} style={[styles.segItem, sort === s && styles.segOn]}>
                  <Text style={[styles.segText, sort === s && styles.segTextOn]}>{s === 'near' ? 'Nearest' : 'Best match'}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          {sort === 'match' && !merged.some((p) => p.score != null) && (
            <Text style={styles.hint}>
              No taste scores here yet, so Best match only puts picks first. Scores come from match.py (run weekly).
            </Text>
          )}
          <View style={styles.filterRow}>
            {KINDS.map((k) => (
              <Pressable key={k.key} onPress={() => setKind(k.key)} style={[styles.toggle, kind === k.key && styles.filterOn]}>
                <Text style={[styles.toggleText, kind === k.key && styles.toggleTextOn]}>{k.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.filterRow}>
            {PRICE_STEPS.map((p) => (
              <Pressable key={p} onPress={() => togglePrice(p)} style={[styles.toggle, prices.has(p) && styles.filterOn]}>
                <Text style={[styles.toggleText, prices.has(p) && styles.toggleTextOn]}>{p}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => setOpenNow((o) => !o)} style={[styles.toggle, openNow && styles.filterOn]}>
              <Text style={[styles.toggleText, openNow && styles.toggleTextOn]}>Open now</Text>
            </Pressable>
            {checking && <ActivityIndicator size="small" />}
          </View>
          {needDetails && unknown > 0 && !checking && (
            <Text style={styles.hint}>
              {unknown} {unknown === 1 ? 'place has' : 'places have'} no {openNow ? 'hours' : 'price'} from Google and{' '}
              {unknown === 1 ? 'is' : 'are'} left out.
            </Text>
          )}
        </View>
      )}

      {locationOff && (
        <Pressable style={styles.notice} onPress={() => Linking.openSettings()}>
          <Text style={styles.noticeText}>
            Location is off, so this shows San Francisco. Tap to turn it on in Settings, or type a city above.
          </Text>
        </Pressable>
      )}
      {discovering && (
        <View style={styles.discovering}>
          <ActivityIndicator size="small" color={colors.pick} />
          <Text style={styles.discoveringText}>{discovering}</Text>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}

      {loading && places.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(p) => `${p.kind}:${p.ref}`}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 32 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {loading
                ? ''
                : places.length > 0
                  ? 'Nothing matches the groups and filters you have on.'
                  : radius < 10000
                    ? `Nothing within ${formatDistance(radius)}. Try a wider radius.`
                    : 'Nothing here yet.'}
            </Text>
          }
          ListFooterComponent={
            <View style={styles.footer}>
              <Pressable onPress={() => setShowHidden(true)} hitSlop={8}>
                <Text style={styles.footerText}>Hidden places</Text>
              </Pressable>
              <Pressable onPress={() => supabase.auth.signOut()} hitSlop={8}>
                <Text style={styles.footerText}>Sign out</Text>
              </Pressable>
            </View>
          }
          renderItem={({ item }) => <Row place={item} onPress={() => setSelected(item)} />}
        />
      )}

      {undo && (
        <View style={styles.undo}>
          <Text style={styles.undoText} numberOfLines={1}>
            {undo.label}
          </Text>
          <Pressable onPress={doUndo} hitSlop={10}>
            <Text style={styles.undoBtn}>Undo</Text>
          </Pressable>
        </View>
      )}

      <PlaceCard
        place={selected ? (merged.find((p) => p.kind === selected.kind && p.ref === selected.ref) ?? selected) : null}
        onClose={() => setSelected(null)}
        onHide={hide}
        onMove={move}
        onPick={pickAction}
        onLogVisit={(p) => {
          setSelected(null); // iOS can't stack two sheets: close the card, then open the visit form
          setTimeout(() => setVisitFor(p), 400);
        }}
        visitsKey={visitsKey}
        onDetails={(gid, d) => setDetails((old) => ({ ...old, [gid]: d }))}
      />
      <LogVisit
        place={visitFor}
        onClose={() => setVisitFor(null)}
        onSaved={() => {
          setVisitsKey((n) => n + 1);
          setReload((n) => n + 1);
        }}
      />
      <AddPlace
        visible={showAdd}
        near={mapCenter ?? center}
        onClose={() => setShowAdd(false)}
        onSaved={() => setReload((n) => n + 1)}
      />
      <HiddenList visible={showHidden} onClose={() => setShowHidden(false)} onChanged={() => setReload((n) => n + 1)} />
    </SafeAreaView>
  );
}

function Row({ place, onPress }: { place: NearbyPlace; onPress: () => void }) {
  const cats = categoryText(place);
  const facts = [ratingText(place.rating, place.review_count), priceText(place.price_level)].filter(Boolean).join(' · ');
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
          {[placeLabel(place), cats, facts].filter(Boolean).join(' · ')}
        </Text>
        {place.kind === 'pick' && !!place.why && (
          <Text style={styles.why} numberOfLines={1}>
            {place.why}
          </Text>
        )}
        {!!place.note && (
          <Text style={styles.note} numberOfLines={2}>
            {place.note}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const shadow = {
  shadowColor: '#000',
  shadowOpacity: 0.15,
  shadowRadius: 6,
  shadowOffset: { width: 0, height: 2 },
};

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, fontSize: 28, fontWeight: '700', color: colors.text },
  addBtn: { backgroundColor: colors.accent, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7 },
  addText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  discoverBtn: { backgroundColor: colors.pick },
  discovering: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#FFF4E3' },
  discoveringText: { flex: 1, fontSize: 14, color: colors.text },
  searchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 8 },
  search: {
    flex: 1,
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 16,
    color: colors.text,
  },
  mapWrap: { height: '33%', backgroundColor: colors.line },
  suggestAnchor: { zIndex: 20, elevation: 20 },
  suggestBox: {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    zIndex: 10,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  suggestRow: { paddingHorizontal: 12, paddingVertical: 9 },
  suggestName: { fontSize: 16, color: colors.text, fontWeight: '600' },
  suggestDetail: { fontSize: 13, color: colors.muted },
  osm: { fontSize: 11, color: colors.muted, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6 },
  searchHere: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    ...shadow,
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
    ...shadow,
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
  filterOn: { backgroundColor: colors.text, borderColor: colors.text },
  filters: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  hint: { fontSize: 13, color: colors.muted },
  filterLabel: { fontSize: 13, fontWeight: '600', color: colors.muted, marginRight: 2 },
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
  why: { fontSize: 14, color: colors.pick, fontWeight: '600' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 38 },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 24, paddingHorizontal: 24 },
  footer: { flexDirection: 'row', justifyContent: 'center', gap: 32, marginTop: 24, padding: 8 },
  footerText: { color: colors.muted, fontSize: 14 },
  undo: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: colors.text,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    ...shadow,
  },
  undoText: { color: '#fff', fontSize: 15, flex: 1 },
  undoBtn: { color: '#FFD9A8', fontSize: 15, fontWeight: '700' },
});
