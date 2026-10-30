import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useShareIntentContext } from 'expo-share-intent';
import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE, type Region } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import AddPlace, { type Shared } from '@/components/AddPlace';
import { Button, Chip, Icon, IconButton, Segmented } from '@/components/ui';
import HiddenList from '@/components/HiddenList';
import ImportPlaces from '@/components/ImportPlaces';
import Onboarding from '@/components/Onboarding';
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
import { areaName, isTimeout, runDiscover, waitForWebRun } from '@/lib/discover';
import { photoFromUri } from '@/lib/capture';
import { me } from '@/lib/onboard';
import { fetchStarred, isStarred, NO_STARS, setStar, type Starred } from '@/lib/star';
import { notInterested, saveFromPick, undoPick } from '@/lib/picks';
import { suggestPlaces, type Suggestion } from '@/lib/places-search';
import { googlePlace, newSession, searchGoogle, searchSaves, type GoogleHit } from '@/lib/search';
import { isOpenNow } from '@/lib/hours';
import { fetchNearby, fetchPlaceDetails, supabase, type NearbyPlace, type PlaceDetails } from '@/lib/supabase';
import { colors, groupColor, radius as corner } from '@/lib/theme';

const RADII = [1000, 3000, 10000];
const GROUPS: Group[] = ['favorites', 'want_to_go', 'other', 'pick'];
const KINDS: { key: Kind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'food', label: 'Food' },
  { key: 'drink', label: 'Drinks & sweets' },
];
// Google's map in real builds that have the key (app.config.js); Expo Go always uses Apple Maps
const GOOGLE_MAP =
  !!Constants.expoConfig?.extra?.googleMaps && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

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
  const [savedHits, setSavedHits] = useState<NearbyPlace[]>([]); // your places whose name matches
  const [googleHits, setGoogleHits] = useState<GoogleHit[]>([]); // restaurants from Google
  const session = useRef(newSession());
  // open this place's card once the list around it has loaded (after = the load count when it was chosen)
  const [pendingSelect, setPendingSelectState] = useState<{ key: string; after: number } | null>(null);
  const [loads, setLoads] = useState(0); // finished list loads
  const loadsRef = useRef(0);
  const setPendingSelect = (key: string) => setPendingSelectState({ key, after: loadsRef.current });

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
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [runDiscoverSoon, setRunDiscoverSoon] = useState(false);

  // Share > Taste Agent from another app: open Add a place with what was shared
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const [shared, setShared] = useState<Shared | null>(null);
  useEffect(() => {
    if (!hasShareIntent) return;
    const img = shareIntent.files?.find((f) => f.mimeType?.startsWith('image/'));
    (async () => {
      try {
        if (img) {
          const p = await photoFromUri(img.path, img.width ?? undefined, img.height ?? undefined);
          setShared({ type: 'photo', photo: { base64: p.base64, uri: p.uri } });
        } else if (shareIntent.webUrl) {
          setShared({ type: 'link', url: shareIntent.webUrl });
        } else if (shareIntent.text?.trim()) {
          setShared({ type: 'text', text: shareIntent.text.trim() });
        } else {
          return;
        }
        setSelected(null);
        setShowAdd(true);
      } catch (e) {
        setError(`Couldn't open what was shared: ${(e as Error).message}`);
      } finally {
        resetShareIntent();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent]);
  const [starred, setStarred] = useState<Starred>(NO_STARS);

  // which saves are starred: reloaded with the list
  useEffect(() => {
    fetchStarred().then(setStarred).catch(() => {});
  }, [reload]);

  async function star(p: NearbyPlace, on: boolean) {
    // show it at once; put it back if saving fails
    const prev = starred;
    const next = { ids: new Set(prev.ids), gids: new Set(prev.gids) };
    if (on) {
      next.ids.add(p.ref);
      if (p.google_place_id) next.gids.add(p.google_place_id);
    } else {
      next.ids.delete(p.ref);
      if (p.google_place_id) next.gids.delete(p.google_place_id);
    }
    setStarred(next);
    try {
      await setStar(p, on);
    } catch (e) {
      setStarred(prev);
      setError((e as Error).message);
    }
  }

  // first launch for a new account: onboarding (no places and no taste profile yet)
  useEffect(() => {
    me()
      .then((m) => {
        if (m.places === 0 && !m.has_profile) setShowOnboarding(true);
      })
      .catch(() => {}); // function not updated yet: carry on without onboarding
  }, []);

  // how many places they've saved anywhere: under a few, Nearby suggests adding more
  const [savedTotal, setSavedTotal] = useState<number | null>(null);
  useEffect(() => {
    supabase
      .from('places')
      .select('id', { count: 'exact', head: true })
      .is('hidden_at', null)
      .then(({ count }) => setSavedTotal(count ?? null));
  }, [reload]);

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
      .then((rows) => {
        if (cancelled) return;
        setPlaces(rows);
        loadsRef.current += 1;
        setLoads(loadsRef.current);
      })
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

  // suggestions while typing (2+ letters), after a short pause: your places, restaurants from Google
  // (3+ letters), and cities and neighborhoods
  useEffect(() => {
    const q = query.trim();
    if (!focused || q.length < 2) {
      setSuggestions([]);
      setSavedHits([]);
      setGoogleHits([]);
      return;
    }
    const near = mapCenter ?? center;
    const ctl = new AbortController();
    let live = true;
    const t = setTimeout(() => {
      suggestPlaces(q, near ?? undefined, ctl.signal)
        .then((s) => live && setSuggestions(s))
        .catch(() => live && setSuggestions([]));
      searchSaves(q, near).then((s) => live && setSavedHits(s));
    }, 250);
    const tg = setTimeout(() => {
      if (q.length >= 3) searchGoogle(q, near, session.current).then((g) => live && setGoogleHits(g));
      else setGoogleHits([]);
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
      clearTimeout(tg);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, focused]);

  function clearSearch() {
    Keyboard.dismiss();
    setSuggestions([]);
    setSavedHits([]);
    setGoogleHits([]);
    session.current = newSession(); // the next search is a new Google session
  }

  // one of your places: go there and open its card when the list has loaded
  function chooseSaved(p: NearbyPlace) {
    setQuery(p.name);
    clearSearch();
    setPlaceName(null);
    setRadius(1000);
    setPendingSelect(p.ref);
    setCenter({ lat: p.place_lat, lng: p.place_lng });
  }

  // a restaurant from Google: go there and open its card (save it from there)
  async function chooseGoogle(h: GoogleHit) {
    const token = session.current;
    setQuery(h.name);
    clearSearch();
    setSearching(true);
    try {
      const p = await googlePlace(h.google_place_id, token, mapCenter ?? center);
      if (!p) {
        setError(`Couldn't load ${h.name}.`);
        return;
      }
      setPlaceName(null);
      setRadius(1000);
      setCenter({ lat: p.place_lat, lng: p.place_lng });
      // if it's already one of yours or a pick, the card for that shows up instead (once loaded)
      setPendingSelect(`gid:${p.google_place_id}`);
      setSearchResult(p);
    } finally {
      setSearching(false);
    }
  }
  const [searchResult, setSearchResult] = useState<NearbyPlace | null>(null);

  // open the card for a place chosen in the search bar once the list around it has loaded
  useEffect(() => {
    if (!pendingSelect || loads <= pendingSelect.after) return;
    const key = pendingSelect.key;
    const gid = key.startsWith('gid:') ? key.slice(4) : null;
    const found = places.find((p) => (gid ? p.google_place_id === gid || (p.kind === 'pick' && p.ref === gid) : p.kind === 'saved' && p.ref === key));
    setPendingSelectState(null);
    if (found) setSelected(found);
    else if (gid && searchResult) setSelected(searchResult);
    setSearchResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads, pendingSelect]);

  function choose(sg: Suggestion) {
    setQuery(sg.label);
    clearSearch();
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
      // starred places first, then the strongest picks (unscored new picks after them), then your saves:
      // Favorites, Want to go, others
      const rank = (p: NearbyPlace) =>
        isStarred(p, starred) ? -1 : p.kind === 'pick' ? (p.score == null ? 1 : 0) : p.list_name === 'favorites' ? 2 : p.list_name === 'want_to_go' ? 3 : 4;
      list.sort((a, b) => rank(a) - rank(b) || (b.score ?? 0) - (a.score ?? 0) || a.distance_m - b.distance_m);
    }
    return { shown: list, unknown: unknownCount };
  }, [merged, hiddenGroups, kind, prices, openNow, sort, starred]);

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
  // "Not interested" comes with the reason the card asked for, if any
  async function pickAction(p: NearbyPlace, action: 'want' | 'not_interested', note?: string | null) {
    setSelected(null);
    try {
      const receipt = action === 'want' ? await saveFromPick(p) : await notInterested(p, note);
      if (action === 'want') setReload((n) => n + 1); // comes back as one of your saves
      else setPlaces((ps) => ps.filter((x) => !(x.kind === 'pick' && x.ref === p.ref)));
      offerUndo(action === 'want' ? `Added ${p.name} to Want to go` : `Won't show ${p.name} again`, () => undoPick(receipt));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Discover: places you'd like around the map's center. Quick Google results first, then the web.
  async function discover(here?: Point) {
    const at = here ?? mapCenter ?? center;
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
      const startedAt = Date.now();
      let web: { places: number; cached?: boolean; message?: string };
      try {
        web = await runDiscover('web', at.lat, at.lng, 8000, name);
      } catch (e) {
        if (!isTimeout(e)) throw e;
        // the phone stopped waiting; the server keeps going and saves the picks, so watch for it to finish
        setDiscovering('Still searching the local food press…');
        web = (await waitForWebRun(at.lat, at.lng, startedAt)) ?? {
          places: 0,
          message: 'The web search is taking longer than usual. New picks will show the next time the list reloads.',
        };
      }
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

  // after onboarding: find places around them once the map has a center
  useEffect(() => {
    if (!runDiscoverSoon || !center) return;
    setRunDiscoverSoon(false);
    discover(center); // where they are now, not wherever the map was before location was allowed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runDiscoverSoon, center]);

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
        <Button title="Discover" icon="sparkles" kind="tinted" color={colors.pick} small onPress={() => discover()} disabled={!!discovering} />
        <IconButton name="plus" label="Add a place" onPress={() => setShowAdd(true)} />
      </View>

      <View style={styles.searchRow}>
        <Icon name="magnifyingglass" color={colors.muted} size={16} />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search a restaurant, your places or a city"
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          onSubmitEditing={() =>
            savedHits[0] ? chooseSaved(savedHits[0]) : googleHits[0] ? chooseGoogle(googleHits[0]) : suggestions[0] ? choose(suggestions[0]) : goTo()
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 250)} // let a tap on a suggestion land first
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {searching && <ActivityIndicator style={{ marginLeft: 8 }} />}
      </View>
      {/* suggestions hang over whatever is below (map or list), so they work with the map hidden too */}
      <View style={styles.suggestAnchor}>
      {(suggestions.length > 0 || savedHits.length > 0 || googleHits.length > 0) && (
        <ScrollView style={styles.suggestBox} keyboardShouldPersistTaps="handled">
          {savedHits.length > 0 && <Text style={styles.suggestHead}>Your places</Text>}
          {savedHits.map((p) => (
            <Pressable
              key={`s:${p.ref}`}
              onPress={() => chooseSaved(p)}
              style={({ pressed }) => [styles.suggestRow, pressed && { backgroundColor: colors.line }]}>
              <Text style={styles.suggestName}>
                <Text style={{ color: groupColor[groupOf(p)] }}>● </Text>
                {p.name}
              </Text>
              <Text style={styles.suggestDetail}>{[placeLabel(p), p.distance_m ? formatDistance(p.distance_m) : ''].filter(Boolean).join(' · ')}</Text>
            </Pressable>
          ))}
          {googleHits.filter((g) => !savedHits.some((s) => s.google_place_id === g.google_place_id)).length > 0 && (
            <Text style={styles.suggestHead}>Restaurants</Text>
          )}
          {googleHits
            .filter((g) => !savedHits.some((s) => s.google_place_id === g.google_place_id))
            .map((g) => (
              <Pressable
                key={`g:${g.google_place_id}`}
                onPress={() => chooseGoogle(g)}
                style={({ pressed }) => [styles.suggestRow, pressed && { backgroundColor: colors.line }]}>
                <Text style={styles.suggestName}>{g.name}</Text>
                {!!g.detail && <Text style={styles.suggestDetail}>{g.detail}</Text>}
              </Pressable>
            ))}
          {suggestions.length > 0 && (savedHits.length > 0 || googleHits.length > 0) && <Text style={styles.suggestHead}>Places</Text>}
          {suggestions.map((sg) => (
            <Pressable
              key={sg.key}
              onPress={() => choose(sg)}
              style={({ pressed }) => [styles.suggestRow, pressed && { backgroundColor: colors.line }]}>
              <Text style={styles.suggestName}>{sg.label}</Text>
              {!!sg.detail && <Text style={styles.suggestDetail}>{sg.detail}</Text>}
            </Pressable>
          ))}
          {suggestions.length > 0 && <Text style={styles.osm}>Places © OpenStreetMap contributors</Text>}
        </ScrollView>
      )}
      </View>

      {mapOpen && (
      <View style={styles.mapWrap}>
        {center && (
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            provider={GOOGLE_MAP ? PROVIDER_GOOGLE : undefined}
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
            <Icon name="arrow.clockwise" color="#fff" size={13} />
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
          <Icon name="location.fill" color={colors.text} size={17} />
        </Pressable>
      </View>
      )}

      {/* lists to show, then map, location, radius and filters */}
      <View style={styles.controls}>
        <View style={styles.chipRow}>
          {GROUPS.filter((g) => g !== 'other' || byGroup.other > 0).map((g) => (
            <Chip key={g} label={`${GROUP_LABEL[g]} ${byGroup[g]}`} color={groupColor[g]} on={!hiddenGroups.has(g)} onPress={() => toggleGroup(g)} />
          ))}
        </View>
        <View style={styles.toolRow}>
          <Pressable onPress={toggleMap} style={[styles.tool, mapOpen && styles.toolOn]} accessibilityLabel={mapOpen ? 'Hide map' : 'Show map'} hitSlop={4}>
            <Icon name={mapOpen ? 'map.fill' : 'map'} color={mapOpen ? '#fff' : colors.text} size={16} />
          </Pressable>
          {!mapOpen && (
            <Pressable
              onPress={() => {
                setQuery('');
                locate();
              }}
              style={styles.tool}
              accessibilityLabel="My location"
              hitSlop={4}>
              <Icon name="location.fill" color={colors.text} size={15} />
            </Pressable>
          )}
          <Segmented
            style={{ flex: 1 }}
            options={RADII.map((r) => ({ value: r, label: formatDistance(r) }))}
            value={radius}
            onChange={setRadius}
          />
          <Pressable
            onPress={() => setShowFilters((x) => !x)}
            style={[styles.tool, styles.filterTool, (showFilters || activeFilters > 0) && styles.toolOn]}
            accessibilityLabel="Filters">
            <Icon name="line.3.horizontal.decrease" color={showFilters || activeFilters > 0 ? '#fff' : colors.text} size={15} />
            {activeFilters > 0 && <Text style={styles.filterCount}>{activeFilters}</Text>}
          </Pressable>
        </View>
      </View>

      {showFilters && (
        <View style={styles.filters}>
          <View style={styles.filterRow}>
            <Text style={styles.filterLabel}>Sort</Text>
            <Segmented
              style={{ flex: 1 }}
              options={[
                { value: 'near' as const, label: 'Nearest' },
                { value: 'match' as const, label: 'Best match' },
              ]}
              value={sort}
              onChange={chooseSort}
            />
          </View>
          <View style={styles.filterRow}>
            <Text style={styles.filterLabel}>Show</Text>
            <Segmented style={{ flex: 1 }} options={KINDS.map((k) => ({ value: k.key, label: k.label }))} value={kind} onChange={setKind} />
          </View>
          <View style={styles.filterRow}>
            {PRICE_STEPS.map((p) => (
              <Chip key={p} label={p} on={prices.has(p)} onPress={() => togglePrice(p)} />
            ))}
            <Chip label="Open now" icon="clock" on={openNow} onPress={() => setOpenNow((o) => !o)} />
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
          ListHeaderComponent={
            savedTotal !== null && savedTotal < 10 && !discovering ? (
              <View style={styles.starter}>
                <Text style={styles.starterTitle}>Picks get better with more of your places</Text>
                <Text style={styles.starterText}>
                  Bring in a list from Google Maps or Beli, or add places as you hear about them: a link, a screenshot, a friend's text.
                </Text>
                <View style={styles.starterRow}>
                  <Button title="Import a list" icon="square.and.arrow.down" small style={{ flex: 1 }} onPress={() => setShowImport(true)} />
                  <Button title="Add a place" icon="plus" kind="secondary" small style={{ flex: 1 }} onPress={() => setShowAdd(true)} />
                </View>
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {discovering
                ? 'Finding places near you…'
                : loading
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
              <Button title="Import places" icon="square.and.arrow.down" kind="secondary" small onPress={() => setShowImport(true)} />
              <Button title="Hidden places" icon="eye.slash" kind="secondary" small onPress={() => setShowHidden(true)} />
              <Button title="Sign out" kind="secondary" small onPress={() => supabase.auth.signOut()} />
            </View>
          }
          renderItem={({ item }) => <Row place={item} starred={isStarred(item, starred)} onPress={() => setSelected(item)} />}
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
        starred={!!selected && isStarred(selected, starred)}
        onStar={star}
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
        shared={shared}
        near={mapCenter ?? center}
        onClose={() => {
          setShowAdd(false);
          setShared(null);
        }}
        onSaved={() => setReload((n) => n + 1)}
      />
      <ImportPlaces
        visible={showImport}
        near={mapCenter ?? center}
        onClose={() => setShowImport(false)}
        onSaved={() => setReload((n) => n + 1)}
      />
      <Onboarding
        visible={showOnboarding}
        onDone={({ importNext }) => {
          setShowOnboarding(false);
          setReload((n) => n + 1);
          // find them first (location may have just been allowed in onboarding), then Discover there
          locate()
            .catch(() => {})
            .finally(() => setRunDiscoverSoon(true));
          if (importNext) setTimeout(() => setShowImport(true), 600); // after the onboarding sheet has closed
        }}
      />
      <HiddenList visible={showHidden} onClose={() => setShowHidden(false)} onChanged={() => setReload((n) => n + 1)} />
    </SafeAreaView>
  );
}

function Row({ place, starred, onPress }: { place: NearbyPlace; starred: boolean; onPress: () => void }) {
  const cats = categoryText(place);
  const facts = [ratingText(place.rating, place.review_count), priceText(place.price_level)].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, starred && { backgroundColor: colors.starBg }, pressed && { backgroundColor: colors.line }]}>
      <View style={[styles.dot, { backgroundColor: groupColor[groupOf(place)] }]} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>
            {starred ? <Text style={{ color: colors.star }}>★ </Text> : null}
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
  header: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { flex: 1, fontSize: 30, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  discovering: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.starBg },
  discoveringText: { flex: 1, fontSize: 14, color: colors.text },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingLeft: 12,
    paddingRight: 6,
    backgroundColor: colors.card,
    borderRadius: corner.m,
    borderWidth: 1,
    borderColor: colors.line,
  },
  search: { flex: 1, paddingVertical: 11, fontSize: 16, color: colors.text },
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
    maxHeight: 440,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  suggestRow: { paddingHorizontal: 12, paddingVertical: 9 },
  suggestHead: { fontSize: 12, fontWeight: '700', color: colors.muted, paddingHorizontal: 12, paddingTop: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  suggestName: { fontSize: 16, color: colors.text, fontWeight: '600' },
  suggestDetail: { fontSize: 13, color: colors.muted },
  osm: { fontSize: 11, color: colors.muted, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6 },
  searchHere: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: corner.pill,
    ...shadow,
  },
  searchHereText: { color: '#fff', fontWeight: '700', fontSize: 14 },
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
  controls: {
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tool: {
    height: 34,
    minWidth: 34,
    borderRadius: corner.s + 2,
    backgroundColor: colors.soft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolOn: { backgroundColor: colors.accent },
  filterTool: { flexDirection: 'row', gap: 5, paddingHorizontal: 10 },
  filterCount: { color: '#fff', fontSize: 13, fontWeight: '700' },
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
  filterLabel: { width: 40, fontSize: 13, fontWeight: '600', color: colors.muted },
  starter: { margin: 16, marginBottom: 8, padding: 14, gap: 8, borderRadius: corner.m, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  starterTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  starterText: { fontSize: 14, lineHeight: 20, color: colors.muted },
  starterRow: { flexDirection: 'row', gap: 8, marginTop: 2 },
  notice: { margin: 16, marginBottom: 0, padding: 12, borderRadius: corner.m, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  noticeText: { color: colors.text, fontSize: 14 },
  error: { color: colors.danger, paddingHorizontal: 16, paddingTop: 8 },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'flex-start' },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  name: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.text },
  dist: { fontSize: 14, color: colors.muted },
  meta: { fontSize: 14, color: colors.muted },
  note: { fontSize: 14, color: colors.text },
  why: { fontSize: 14, color: colors.pick, fontWeight: '600' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 38 },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 24, paddingHorizontal: 24 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 28, padding: 8 },
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
  undoBtn: { color: colors.star, fontSize: 15, fontWeight: '700' },
});
