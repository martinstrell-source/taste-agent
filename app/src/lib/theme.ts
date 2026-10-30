// Colors carry meaning: each list has its own color (dots, chips, map pins), Discover and new picks share
// tangerine, stars are saffron. Everything else is ink on a pale sage page with white surfaces.
export const colors = {
  bg: '#F1F3EE', // page: pale sage grey
  card: '#FFFFFF', // surfaces: sheets, rows' pressed state, inputs
  text: '#1A1F1C', // ink: text and the main buttons
  muted: '#646B66',
  line: '#DCE0D9',
  soft: '#E7EAE4', // quiet fills: secondary buttons, off chips, pressed rows
  accent: '#1A1F1C', // main action color (ink)
  saved: '#2E7D4F', // basil: Want to go
  favorite: '#C8323C', // chili: Favorites
  otherList: '#4E6A8C', // slate: other saved lists and places added in the app
  pick: '#E2711D', // tangerine: new picks and Discover
  danger: '#B42318',
  star: '#E5A400', // saffron: starred Want to go places
  starBg: '#FFF4D1', // their row in the list
};

export const groupColor = {
  favorites: colors.favorite,
  want_to_go: colors.saved,
  other: colors.otherList,
  pick: colors.pick,
} as const;

// spacing and corner sizes used across screens
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 };
export const radius = { s: 8, m: 12, pill: 999 };
