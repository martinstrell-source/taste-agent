import * as DocumentPicker from 'expo-document-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { Candidate } from './capture';
import { supabase } from './supabase';

// Onboarding and imports, through the capture function (Claude and Google stay on the server).

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('capture', { body });
  if (error) {
    let detail = '';
    try {
      detail = (await (error as { context?: Response }).context?.json())?.error ?? '';
    } catch {
      /* no body */
    }
    if (/type must be/.test(detail)) throw new Error('This needs the updated capture function in Supabase (run deploy.sh).');
    throw new Error(detail || error.message);
  }
  return data as T;
}

export type ImportJob = { id: number; kind: string; status: string; message: string | null; created_at: string; finished_at: string | null };
export type Me = { handle: string; places: number; has_profile: boolean; last_job: ImportJob | null };

// at launch: makes the account row if new; onboarding shows when there are no places and no profile
export const me = () => call<Me>({ type: 'me' });

export type TastePlace = { name: string; area: string; cuisine: string; candidates: Candidate[] };
export type TasteRead = { places: TastePlace[]; dishes: string[]; cuisines: string[]; dislikes: string[]; message?: string };

export const readTaste = (text: string, near: { lat: number; lng: number } | null) =>
  call<TasteRead>({ type: 'taste_read', text, ...(near ?? {}) });

// well-known places near a new user, to rate in onboarding
export type StarterPlace = Candidate & { rating: number | null; reviews: number | null; kind: string };
export const starterPlaces = (near: { lat: number; lng: number }, exclude: string[]) =>
  call<{ places: StarterPlace[] }>({ type: 'starter_places', ...near, exclude });

export const saveTaste = (s: {
  places: { name: string; cuisine?: string; candidate: Candidate; list?: 'favorites' | 'want_to_go' }[];
  noes?: { google_place_id: string; name: string }[];
  dishes: string[];
  cuisines: string[];
  dislikes: string[];
  text: string;
}) => call<{ saved: number; handle: string }>({ type: 'taste_save', ...s });

// ---------- screenshots of lists from other apps ----------

export type ShotPlace = { name: string; location_hint: string; note: string; candidates: Candidate[] };
export type ShotResult = { app: string | null; places: ShotPlace[]; message?: string };

// several screenshots from the photo library, shrunk so text stays readable but uploads stay small
export async function pickScreenshots(): Promise<{ uri: string; base64: string }[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Photo access is off. Turn it on in Settings to pick screenshots.');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 10, quality: 1 });
  if (r.canceled) return [];
  const out: { uri: string; base64: string }[] = [];
  for (const a of r.assets) {
    const ctx = ImageManipulator.ImageManipulator.manipulate(a.uri);
    if ((a.height ?? 0) > 2400) ctx.resize({ height: 2400 }); // tall screenshots keep their width
    const img = await ctx.renderAsync();
    const saved = await img.saveAsync({ base64: true, compress: 0.7, format: ImageManipulator.SaveFormat.JPEG });
    if (saved.base64) out.push({ uri: saved.uri, base64: saved.base64 });
  }
  return out;
}

export const readScreenshot = (base64: string, near: { lat: number; lng: number } | null) =>
  call<ShotResult>({ type: 'screenshot_list', image_base64: base64, ...(near ?? {}) });

// a pasted list (notes app, a message, a spreadsheet column): same result as a screenshot
export const readListText = (text: string, near: { lat: number; lng: number } | null) =>
  call<ShotResult>({ type: 'screenshot_list', text, ...(near ?? {}) });

// ---------- Google Maps Takeout ----------

// pick the Takeout zip (or a CSV), upload it to the private imports bucket, and queue it for the import worker
export async function startTakeoutImport(): Promise<ImportJob | null> {
  const r = await DocumentPicker.getDocumentAsync({
    type: ['application/zip', 'application/x-zip-compressed', 'text/csv', 'text/comma-separated-values', '*/*'],
    copyToCacheDirectory: true,
  });
  if (r.canceled || !r.assets?.length) return null;
  const a = r.assets[0];
  const isZip = /\.zip$/i.test(a.name) || /zip/.test(a.mimeType ?? '');
  const isCsv = /\.csv$/i.test(a.name);
  if (!isZip && !isCsv) throw new Error('Pick the Takeout .zip file (or a .csv list from it).');
  if ((a.size ?? 0) > 50 * 1024 * 1024) throw new Error('That file is over 50 MB. In Takeout, choose only "Saved" under Maps (your places).');

  const { data: u } = await supabase.auth.getUser();
  if (!u.user) throw new Error('Not signed in');
  const path = `${u.user.id}/${Date.now()}.${isZip ? 'zip' : 'csv'}`;
  const bytes = await (await fetch(a.uri)).arrayBuffer();
  const up = await supabase.storage.from('imports').upload(path, bytes, { contentType: isZip ? 'application/zip' : 'text/csv' });
  if (up.error) throw new Error(`Upload failed: ${up.error.message}`);
  const { data, error } = await supabase
    .from('import_jobs')
    .insert({ user_id: u.user.id, kind: 'takeout', storage_path: path })
    .select('id, kind, status, message, created_at, finished_at')
    .single();
  if (error) throw new Error(error.message);
  return data as ImportJob;
}

export async function getJob(id: number): Promise<ImportJob | null> {
  const { data } = await supabase.from('import_jobs').select('id, kind, status, message, created_at, finished_at').eq('id', id).maybeSingle();
  return (data as ImportJob | null) ?? null;
}

export async function latestTakeout(): Promise<ImportJob | null> {
  const { data } = await supabase
    .from('import_jobs')
    .select('id, kind, status, message, created_at, finished_at')
    .eq('kind', 'takeout')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as ImportJob | null) ?? null;
}
