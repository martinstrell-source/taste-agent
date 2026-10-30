import { getShareExtensionKey } from 'expo-share-intent';

// Something shared to the app ("Share > Taste Agent") opens it with a special link. Send that to the main
// screen, which opens Add a place with what was shared; every other link goes where it says.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return '/';
    return path;
  } catch {
    return '/';
  }
}
