import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { categoryText, formatDistance, groupOf, mapsUrl, placeLabel } from '@/lib/format';
import type { NearbyPlace } from '@/lib/supabase';
import { colors, groupColor } from '@/lib/theme';

// Bottom card with the basics for one place
export default function PlaceCard({ place, onClose }: { place: NearbyPlace | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!place} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      {place && (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={{ gap: 8 }}>
            <View style={styles.row}>
              <Text style={[styles.badge, { backgroundColor: groupColor[groupOf(place)] }]}>
                {placeLabel(place)}
              </Text>
              <Text style={styles.muted}>{formatDistance(place.distance_m)}</Text>
            </View>
            <Text style={styles.name}>{place.name}</Text>
            {!!categoryText(place) && <Text style={styles.muted}>{categoryText(place, 5)}</Text>}
            {!!place.address && <Text style={styles.text}>{place.address}</Text>}
            {!!place.note && (
              <View style={styles.noteBox}>
                <Text style={styles.noteLabel}>{place.kind === 'pick' ? 'What the article said' : 'Your note'}</Text>
                <Text style={styles.text}>{place.note}</Text>
              </View>
            )}
          </ScrollView>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]}
            onPress={() => Linking.openURL(mapsUrl(place))}>
            <Text style={styles.buttonText}>Open in Maps</Text>
          </Pressable>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 8,
    maxHeight: '70%',
    gap: 12,
  },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: { color: '#fff', fontSize: 13, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' },
  name: { fontSize: 22, fontWeight: '700', color: colors.text },
  text: { fontSize: 16, color: colors.text, lineHeight: 22 },
  muted: { fontSize: 15, color: colors.muted },
  noteBox: { backgroundColor: colors.bg, borderRadius: 10, padding: 12, gap: 4, marginTop: 4 },
  noteLabel: { fontSize: 13, fontWeight: '600', color: colors.muted },
  button: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});
