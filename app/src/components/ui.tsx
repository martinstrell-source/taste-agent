// The app's few building blocks, so every screen's buttons and chips look and behave the same.
//   Button     primary (ink), secondary (quiet fill), outline, tinted (a list color), danger; optional icon
//   IconButton round icon-only button for headers
//   Chip       a toggle with a colored dot (lists, filters); filled in its color when on
//   Segmented  one bar of mutually exclusive options (tabs, radius, sort)
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius } from '@/lib/theme';

type Symbol = SymbolViewProps['name'];

export function Icon({ name, color = colors.text, size = 18 }: { name: Symbol; color?: string; size?: number }) {
  return <SymbolView name={name} tintColor={color} size={size} weight="semibold" resizeMode="scaleAspectFit" style={{ width: size, height: size }} />;
}

type Kind = 'primary' | 'secondary' | 'outline' | 'tinted' | 'danger';

export function Button({
  title,
  onPress,
  kind = 'primary',
  color,
  icon,
  busy,
  disabled,
  small,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: Kind;
  color?: string; // for kind "tinted"
  icon?: Symbol;
  busy?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const bg =
    kind === 'primary' ? colors.accent : kind === 'tinted' ? (color ?? colors.saved) : kind === 'danger' ? colors.danger : kind === 'secondary' ? colors.soft : 'transparent';
  const fg = kind === 'secondary' || kind === 'outline' ? colors.text : '#fff';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        { backgroundColor: bg },
        kind === 'outline' && styles.outline,
        (disabled || busy) && { opacity: 0.45 },
        pressed && { opacity: 0.8 },
        style,
      ]}>
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.btnInner}>
          {icon && <Icon name={icon} color={fg} size={small ? 14 : 16} />}
          <Text style={[styles.btnText, small && styles.btnTextSmall, { color: fg }]} numberOfLines={1}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export function IconButton({
  name,
  onPress,
  label,
  bg = colors.accent,
  fg = '#fff',
  disabled,
}: {
  name: Symbol;
  onPress: () => void;
  label: string;
  bg?: string;
  fg?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={6}
      style={({ pressed }) => [styles.iconBtn, { backgroundColor: bg }, (pressed || disabled) && { opacity: 0.7 }]}>
      <Icon name={name} color={fg} size={18} />
    </Pressable>
  );
}

export function Chip({
  label,
  on,
  onPress,
  color,
  icon,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  color?: string; // a list color: a dot when off, the fill when on
  icon?: Symbol;
}) {
  const fill = color ?? colors.accent;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [styles.chip, on ? { backgroundColor: fill, borderColor: fill } : null, pressed && { opacity: 0.8 }]}>
      {icon ? <Icon name={icon} color={on ? '#fff' : colors.text} size={13} /> : color ? <View style={[styles.dot, { backgroundColor: on ? '#fff' : color }]} /> : null}
      <Text style={[styles.chipText, on && { color: '#fff' }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  style,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.seg, style]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={[styles.segBtn, on && styles.segOn]}>
            <Text style={[styles.segText, on && styles.segTextOn]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// a sheet's title row: title on the left, one text action on the right
export function SheetHeader({ title, action, onAction }: { title: string; action: string; onAction: () => void }): ReactNode {
  return (
    <View style={styles.sheetHead}>
      <Text style={styles.sheetTitle}>{title}</Text>
      <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button">
        <Text style={styles.sheetAction}>{action}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { borderRadius: radius.m, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  btnSmall: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: radius.s },
  btnInner: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  btnText: { fontSize: 16, fontWeight: '700' },
  btnTextSmall: { fontSize: 14, fontWeight: '600' },
  outline: { borderWidth: 1.5, borderColor: colors.text },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: radius.pill,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontSize: 14, fontWeight: '600', color: colors.text },
  seg: { flexDirection: 'row', backgroundColor: colors.soft, borderRadius: radius.s + 2, padding: 3 },
  segBtn: { flex: 1, paddingVertical: 7, paddingHorizontal: 4, borderRadius: radius.s, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.card, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  segText: { fontSize: 14, fontWeight: '600', color: colors.muted },
  segTextOn: { color: colors.text },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  sheetTitle: { fontSize: 24, fontWeight: '800', color: colors.text },
  sheetAction: { fontSize: 17, fontWeight: '600', color: colors.text },
});
