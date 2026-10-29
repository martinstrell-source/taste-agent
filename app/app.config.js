// Adds the Google map to real builds when app/.env has GOOGLE_MAPS_IOS_KEY (an iOS key restricted to
// the app's bundle id). Without it, builds use Apple Maps as before. Expo Go always uses Apple Maps.
// Everything else is in app.json.
const fs = require('fs');
const path = require('path');

function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = fs
      .readFileSync(path.join(__dirname, '.env'), 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith(`${name}=`));
    return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

module.exports = ({ config }) => {
  const key = envValue('GOOGLE_MAPS_IOS_KEY');
  if (!key) return { ...config, extra: { ...config.extra, googleMaps: false } };
  return {
    ...config,
    plugins: [...(config.plugins ?? []), ['react-native-maps', { iosGoogleMapsApiKey: key }]],
    extra: { ...config.extra, googleMaps: true },
  };
};
