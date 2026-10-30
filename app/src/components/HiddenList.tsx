import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { listHidden, restorePlace, type HiddenPlace } from '@/lib/hide';
import { colors } from '@/lib/theme';
import { Button } from '@/components/ui';

const REASON = { closed: 'Permanently closed', didnt_like: "Didn't like it" } as const;

// Saved places the user hid, with a way to bring them back
export default function HiddenList({ visible, onClose, onChanged }: { visible: boolean; onClose: () => void; onChanged: () => void }) {
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<HiddenPlace[] | null>(null);

  useEffect(() => {
    if (!visible) return;
    setRows(null);
    listHidden().then(setRows);
  }, [visible]);

  async function restore(id: number, googleId: string | null) {
    await restorePlace(id, googleId);
    setRows((r) => (r ?? []).filter((x) => x.id !== id));
    onChanged();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Hidden places</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.link}>Done</Text>
          </Pressable>
        </View>
        <Text style={styles.muted}>
          These stay on your Google Maps lists. Restore one to show it in Nearby again.
        </Text>
        {rows === null ? (
          <ActivityIndicator style={{ margin: 24 }} />
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(r) => String(r.id)}
            ListEmptyComponent={<Text style={styles.muted}>Nothing hidden.</Text>}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.muted}>{REASON[item.reason] ?? item.reason}</Text>
                </View>
                <Button title="Restore" icon="arrow.uturn.backward" kind="secondary" small onPress={() => restore(item.id, item.googleId)} />
              </View>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '70%', gap: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.text },
  link: { color: colors.text, fontSize: 17, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  name: { fontSize: 16, fontWeight: '600', color: colors.text },
});
