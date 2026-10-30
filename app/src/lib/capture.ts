import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from './supabase';

export type CaptureType = 'link' | 'text' | 'photo' | 'friend';
export type CaptureInput = {
  type: CaptureType;
  url?: string;
  text?: string;
  friend?: string;
  image_base64?: string;
  lat?: number;
  lng?: number;
};
export type Candidate = {
  google_place_id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  categories: string[];
  is_food: boolean;
  open: boolean;
};
export type Found = { name: string; location_hint: string; note: string; dishes: string[]; candidates: Candidate[] };
export type Source = { type: string; name: string | null; url: string | null };
export type CaptureResult = { source: Source; places: Found[]; message?: string };

const NOT_SET_UP = 'Add a place needs the "capture" function in Supabase (and the ANTHROPIC_API_KEY secret).';

// Ask the capture function to find the places (Claude reads, Google matches). Nothing is saved yet.
export async function runCapture(input: CaptureInput): Promise<CaptureResult> {
  const { data, error } = await supabase.functions.invoke('capture', { body: input });
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 404) throw new Error(NOT_SET_UP);
    let detail = '';
    try {
      detail = (await (error as { context?: Response }).context?.json())?.error ?? '';
    } catch {
      /* no body */
    }
    throw new Error(detail || error.message);
  }
  return data as CaptureResult;
}

// Save the chosen match to Want to go (or Favorites), with where it came from. Returns the list it's on if already saved.
export async function saveCapture(
  input: CaptureInput,
  found: Found,
  c: Candidate,
  source: Source,
  list: 'want_to_go' | 'favorites' = 'want_to_go',
  inputType?: string, // recorded in captures; defaults to the input's type
): Promise<{ saved: boolean; alreadyOn?: string }> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) throw new Error('Not signed in');
  const existing = await supabase
    .from('places')
    .select('id, list_name, hidden_at')
    .eq('google_place_id', c.google_place_id)
    .is('removed_at', null)
    .limit(1);
  const row = existing.data?.[0];
  if (row && !row.hidden_at) return { saved: false, alreadyOn: row.list_name ?? 'your list' };

  const note = [found.note, found.dishes.length ? `Dishes: ${found.dishes.join(', ')}` : '']
    .filter(Boolean)
    .join(' ');
  const { data, error } = await supabase
    .from('places')
    .upsert(
      {
        user_id: u.user.id,
        place_key: `capture:${c.google_place_id}`,
        list_name: list,
        added_via: 'capture',
        list_set_in_app: true,
        title: found.name,
        note: note || null,
        google_place_id: c.google_place_id,
        google_name: c.name,
        address: c.address,
        location: c.lat !== null && c.lng !== null ? `SRID=4326;POINT(${c.lng} ${c.lat})` : null,
        categories: c.categories,
        is_food: c.is_food,
        match_confidence: 'good',
        source_type: source.type,
        source_name: source.name,
        source_url: source.url,
        hidden_at: null,
        hidden_reason: null,
      },
      { onConflict: 'user_id,place_key' },
    )
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  await supabase.from('captures').insert({
    user_id: u.user.id,
    input_type: inputType ?? input.type,
    raw_input: input.type === 'link' ? input.url : input.type === 'photo' ? input.text || '(photo)' : input.text,
    source_type: source.type,
    source_name: source.name,
    source_url: source.url,
    place_id: data?.id ?? null,
  });
  return { saved: true };
}

function gps(exif: Record<string, unknown> | null | undefined): { lat: number; lng: number } | null {
  if (!exif) return null;
  const lat = Number(exif.GPSLatitude);
  const lng = Number(exif.GPSLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return {
    lat: exif.GPSLatitudeRef === 'S' ? -Math.abs(lat) : lat,
    lng: exif.GPSLongitudeRef === 'W' ? -Math.abs(lng) : lng,
  };
}

// A photo shared to the app (Share > Taste Agent): same resizing as a chosen photo, no location
export async function photoFromUri(uri: string, width?: number, height?: number): Promise<{ base64: string; uri: string; where: null }> {
  const ctx = ImageManipulator.ImageManipulator.manipulate(uri);
  if ((width ?? 0) >= (height ?? 1)) ctx.resize({ width: Math.min(width || 1568, 1568) });
  else ctx.resize({ height: Math.min(height || 1568, 1568) });
  const img = await ctx.renderAsync();
  const out = await img.saveAsync({ compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
  return { base64: out.base64 ?? '', uri: out.uri, where: null };
}

// Take or choose a photo; returns a resized JPEG (base64), a preview uri and where it was taken (if known)
export async function getPhoto(fromCamera: boolean): Promise<{ base64: string; uri: string; where: { lat: number; lng: number } | null } | null> {
  if (fromCamera) {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('Camera access is off. Turn it on in Settings for Expo Go.');
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: true };
  const r = fromCamera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (r.canceled || !r.assets?.length) return null;
  const a = r.assets[0];
  // about 1,500 px on the long side is plenty for reading a sign or a screenshot, and keeps uploads small
  const ctx = ImageManipulator.ImageManipulator.manipulate(a.uri);
  if ((a.width ?? 0) >= (a.height ?? 0)) ctx.resize({ width: Math.min(a.width ?? 1568, 1568) });
  else ctx.resize({ height: Math.min(a.height ?? 1568, 1568) });
  const img = await ctx.renderAsync();
  const out = await img.saveAsync({ compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
  return { base64: out.base64 ?? '', uri: out.uri, where: gps(a.exif) };
}
