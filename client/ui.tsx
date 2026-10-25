import type { PluginHostProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

type Theme = PluginHostProps["theme"];

export function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: 20 },
      section: { gap: 8 },
      heading: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      firstRow: { borderTopWidth: 0 },
      label: { color: theme.colors.foreground, fontSize: 13 },
      value: { color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1, textAlign: "right" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      mono: { color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      primaryButton: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      primaryButtonText: { color: theme.colors.accentForeground },
      disabled: { opacity: 0.5 },
    }),
    [theme, compact],
  );
}

export type Styles = ReturnType<typeof useStyles>;

export function Screen({ styles, children }: { styles: Styles; children: ReactNode }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {children}
    </ScrollView>
  );
}

export function Section({ styles, title, children }: { styles: Styles; title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{title}</Text>
      {children}
    </View>
  );
}

export function Card({ styles, children }: { styles: Styles; children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Row({
  styles,
  label,
  first,
  children,
}: {
  styles: Styles;
  label: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[styles.row, first ? styles.firstRow : null]}>
      <Text style={styles.label}>{label}</Text>
      {typeof children === "string" ? <Text style={styles.value}>{children}</Text> : children}
    </View>
  );
}

export function Button({
  styles,
  label,
  onPress,
  primary,
  disabled,
}: {
  styles: Styles;
  label: string;
  onPress(): void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, primary ? styles.primaryButton : null, disabled ? styles.disabled : null]}
    >
      <Text style={[styles.buttonText, primary ? styles.primaryButtonText : null]}>{label}</Text>
    </Pressable>
  );
}

/** Destructive actions ask for a second press instead of a modal. */
export function ConfirmButton({
  styles,
  label,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  styles: Styles;
  label: string;
  confirmLabel: string;
  onConfirm(): void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      styles={styles}
      label={armed ? confirmLabel : label}
      primary={armed}
      disabled={disabled}
      onPress={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    />
  );
}

export function formatMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GiB` : `${mib} MiB`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
