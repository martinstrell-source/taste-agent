export const colors = {
  bg: '#FAF7F2',
  card: '#FFFFFF',
  text: '#1F1B16',
  muted: '#6E665C',
  line: '#E6E0D6',
  accent: '#B5532A', // buttons, selected chips
  saved: '#2F6F4E', // the user's own saves (Want to go)
  favorite: '#A63446', // Favorites
  otherList: '#4F6D8F', // other saved lists and places added in the app
  pick: '#C9822B', // new picks
  danger: '#B3261E',
};

export const groupColor = {
  favorites: colors.favorite,
  want_to_go: colors.saved,
  other: colors.otherList,
  pick: colors.pick,
} as const;
