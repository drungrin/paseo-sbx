import type { PluginHostProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, Switch, Text, View } from "react-native";

/**
 * Surfaces, figures, controls and motion the plugin's screens share, after the GSD observer's kit.
 * Every color comes from a theme token: tints are a token at a low opacity, the way Paseo tints its
 * own status colors, and motion stops when the system asks for reduced motion.
 */

export type Theme = PluginHostProps["theme"];
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
type ThemeProps = { theme: Theme };

/** Paseo theme colors are hex strings; "#abc" and "#aabbccdd" are read as "#aabbcc". */
function hex6(color: string): string | null {
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) return color.slice(0, 7);
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`;
  return null;
}
const channels = (color: string) => [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
function luminance(color: string): number {
  const value = hex6(color);
  if (!value) return 1;
  const [r, g, b] = channels(value);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
export const isDark = (theme: Theme) => luminance(theme.colors.surface0) < 0.4;

/** A token at a low opacity: 12% on light themes, a third more on dark ones, as Paseo's own status tints. */
export function tint(theme: Theme, color: string, strength = 0.12): string {
  const value = hex6(color);
  if (!value) return color;
  const alpha = Math.max(0, Math.min(1, isDark(theme) ? strength * 1.35 : strength));
  return `${value}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** A dark accent (Paseo's green) is made for fills; lifted toward white it also reads as text and lines on dark surfaces. */
function lifted(color: string): string {
  const value = hex6(color);
  if (!value) return color;
  return `#${channels(value)
    .map((channel) =>
      Math.round(channel + (255 - channel) * 0.42)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function toneColor(theme: Theme, tone: Tone): string {
  const { colors } = theme;
  if (tone === "neutral") return colors.foregroundMuted;
  if (tone === "accent") return isDark(theme) && luminance(colors.accent) < 0.45 ? lifted(colors.accent) : colors.accent;
  return tone === "success" ? colors.statusSuccess : tone === "warning" ? colors.statusWarning : colors.statusDanger;
}
export const surface = (theme: Theme, level: 1 | 2 = 1) => (level === 2 ? theme.colors.surface2 : theme.colors.surface1);

type Weight = "400" | "500" | "600" | "700";
export const text = (theme: Theme, size = 14, weight: Weight = "400", muted = false) => ({
  color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
  fontSize: size,
  lineHeight: Math.round(size * 1.45),
  fontWeight: weight,
  flexShrink: 1,
});
export const kicker = (theme: Theme) => ({
  ...text(theme, 11, "600", true),
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
});
export const mono = (theme: Theme, size = 12, muted = false) => ({
  ...text(theme, size, "400", muted),
  fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
});
export const figures = { fontVariant: ["tabular-nums" as const] };
/** Opacity and transform animate on the native thread where there is one; the web has none. */
const nativeDriver = () => Platform.OS !== "web";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (live) setReduced(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** The current time, every `intervalMs`, for relative times that keep up without a refresh. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** "just now", "12m ago", "3h 5m ago", "2d ago" for an epoch-milliseconds time. */
export function ago(time: number | null, now = Date.now()): string {
  if (time === null) return "never";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** A dot with a breathing ring: something is running right now. */
export function Pulse({ color, size = 8 }: { color: string; size?: number }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.timing(value, { toValue: 1, duration: 1_800, easing: Easing.out(Easing.quad), useNativeDriver: nativeDriver() }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, value]);
  const ring = size * 2.6;
  return (
    <View style={{ width: ring, height: ring, alignItems: "center", justifyContent: "center" }}>
      {reduced ? null : (
        <Animated.View
          style={{
            position: "absolute",
            width: ring,
            height: ring,
            borderRadius: ring / 2,
            backgroundColor: color,
            opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
            transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }],
          }}
        />
      )}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

/** A status dot: breathing while `moving`, still otherwise. */
export function Dot({ color, moving = false, size = 8 }: { color: string; moving?: boolean; size?: number }) {
  if (moving) return <Pulse color={color} size={size} />;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** Fades and lifts its children in when they first appear. */
export function FadeIn({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) {
      value.setValue(1);
      return;
    }
    Animated.timing(value, {
      toValue: 1,
      duration: 380,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver(),
    }).start();
  }, [delay, reduced, value]);
  return (
    <Animated.View
      style={{ opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}
    >
      {children}
    </Animated.View>
  );
}

export function Pill({
  label,
  tone = "neutral",
  theme,
  dot = false,
  moving = false,
}: ThemeProps & { label: string; tone?: Tone; dot?: boolean; moving?: boolean }) {
  const color = toneColor(theme, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: moving ? 0 : 6,
        alignSelf: "flex-start",
        minHeight: 24,
        paddingLeft: moving ? 0 : 9,
        paddingRight: 9,
        borderRadius: 999,
        backgroundColor: tone === "neutral" ? surface(theme, 2) : tint(theme, color, 0.14),
      }}
    >
      {dot ? <Dot color={color} moving={moving} size={moving ? 6 : 7} /> : null}
      <Text style={{ ...text(theme, 12, "500"), color: tone === "neutral" ? theme.colors.foregroundMuted : color }}>{label}</Text>
    </View>
  );
}

/** A borderless raised surface; a tone gives it a soft wash and a rule down its left edge. */
export function Section({
  title,
  overline,
  aside,
  children,
  theme,
  tone,
  padding = 20,
  gap = 14,
}: ThemeProps & {
  title?: string;
  overline?: string;
  aside?: ReactNode;
  children?: ReactNode;
  tone?: Tone;
  padding?: number;
  gap?: number;
}) {
  const color = tone ? toneColor(theme, tone) : null;
  return (
    <View
      style={{
        minWidth: 0,
        padding,
        gap,
        borderRadius: 16,
        backgroundColor: color ? tint(theme, color, 0.09) : surface(theme),
        overflow: "hidden",
      }}
    >
      {color ? <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: color }} /> : null}
      {title || overline || aside ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <View style={{ gap: 2, flex: 1, minWidth: 160 }}>
            {overline ? <Text style={kicker(theme)}>{overline}</Text> : null}
            {title ? (
              <Text role="heading" style={text(theme, 16, "600")}>
                {title}
              </Text>
            ) : null}
          </View>
          {aside}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** One headline figure with its label above and an optional detail below. */
export function Stat({
  label,
  value,
  detail,
  theme,
  tone,
  size = 24,
  children,
}: ThemeProps & { label: string; value: string; detail?: string | null; tone?: Tone; size?: number; children?: ReactNode }) {
  const toned = tone && tone !== "neutral";
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}${detail ? `, ${detail}` : ""}`}
      style={{
        flexBasis: 150,
        flexGrow: 1,
        minWidth: 0,
        paddingVertical: 14,
        paddingHorizontal: 16,
        gap: 2,
        borderRadius: 14,
        backgroundColor: toned ? tint(theme, toneColor(theme, tone), 0.1) : surface(theme),
      }}
    >
      <Text style={kicker(theme)}>{label}</Text>
      <Text style={{ ...text(theme, size, "700"), ...figures, color: toned ? toneColor(theme, tone) : theme.colors.foreground }}>
        {value}
      </Text>
      {detail ? <Text style={{ ...text(theme, 12, "400", true), ...figures }}>{detail}</Text> : null}
      {children}
    </View>
  );
}

export type Segment = { value: number; color: string; label: string };

/** One bar split by value; a tiny segment keeps a sliver so it never disappears. */
export function SegmentBar({
  segments,
  height = 10,
  theme,
  label,
}: ThemeProps & { segments: readonly Segment[]; height?: number; label: string }) {
  const shown = segments.filter((segment) => segment.value > 0);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        height,
        gap: shown.length > 1 ? 2 : 0,
        borderRadius: height / 2,
        overflow: "hidden",
        backgroundColor: surface(theme, 2),
      }}
    >
      {shown.map((segment) => (
        <View
          key={segment.label}
          style={{ flexGrow: segment.value, flexBasis: 0, minWidth: 3, backgroundColor: segment.color }}
        />
      ))}
    </View>
  );
}

export function Legend({ items, theme }: ThemeProps & { items: readonly { color: string; label: string }[] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 }}>
      {items.map((item) => (
        <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: item.color }} />
          <Text style={{ ...text(theme, 12, "400", true), ...figures }}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** A thin bar filled to `value` of `max`. */
export function Meter({
  value,
  max,
  color,
  theme,
  height = 6,
}: ThemeProps & { value: number; max: number; color: string; height?: number }) {
  const percent = max > 0 ? Math.min(100, Math.max(value > 0 ? 1.5 : 0, (100 * value) / max)) : 0;
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: surface(theme, 2), overflow: "hidden" }}>
      <View style={{ width: `${percent}%`, height: "100%", borderRadius: height / 2, backgroundColor: color }} />
    </View>
  );
}

/** The notes behind a screen's figures, folded until asked for. */
export function Disclosure({ title, notes, theme }: ThemeProps & { title: string; notes: readonly string[] }) {
  const [open, setOpen] = useState(false);
  if (!notes.length) return null;
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ alignSelf: "flex-start", minHeight: 32, justifyContent: "center" }}
      >
        <Text style={text(theme, 12, "600", true)}>
          {open ? "▾" : "▸"} {title}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 6, paddingLeft: 14, borderLeftWidth: 2, borderColor: theme.colors.border }}>
          {notes.map((note) => (
            <Text key={note} style={text(theme, 12, "400", true)}>
              {note}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A segmented choice between a few options. */
export function Toggle<V extends string>({
  label,
  options,
  value,
  onChange,
  theme,
}: ThemeProps & { label: string; options: readonly { value: V; label: string }[]; value: V; onChange(value: V): void }) {
  return (
    <View
      role="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        padding: 3,
        gap: 2,
        borderRadius: 10,
        backgroundColor: surface(theme, 2),
        alignSelf: "flex-start",
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected, checked: selected }}
            onPress={() => onChange(option.value)}
            style={{
              minHeight: 30,
              justifyContent: "center",
              paddingHorizontal: 12,
              borderRadius: 8,
              backgroundColor: selected ? theme.colors.surface0 : "transparent",
            }}
          >
            <Text style={text(theme, 12, selected ? "600" : "400", !selected)}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export type ButtonKind = "primary" | "secondary" | "danger" | "quiet";

/** A rounded action; `primary` is the one thing a surface is for, `danger` a destructive one. */
export function Button({
  label,
  onPress,
  theme,
  kind = "secondary",
  disabled = false,
  busy = false,
  small = false,
}: ThemeProps & { label: string; onPress(): void; kind?: ButtonKind; disabled?: boolean; busy?: boolean; small?: boolean }) {
  const danger = toneColor(theme, "danger");
  const background =
    kind === "primary"
      ? theme.colors.accent
      : kind === "danger"
        ? tint(theme, danger, 0.16)
        : kind === "quiet"
          ? "transparent"
          : // Translucent, so it reads on tinted sections as well as on plain surfaces.
            tint(theme, theme.colors.foregroundMuted, 0.16);
  const color = kind === "primary" ? theme.colors.accentForeground : kind === "danger" ? danger : theme.colors.foreground;
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={(state) => ({
        minHeight: small ? 30 : 36,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: small ? 11 : 14,
        borderRadius: 999,
        backgroundColor: background,
        opacity: disabled ? 0.45 : (state as { hovered?: boolean }).hovered ? 0.85 : 1,
      })}
    >
      <Text style={{ ...text(theme, small ? 12 : 13, "600"), color }}>{busy ? `${label}…` : label}</Text>
    </Pressable>
  );
}

/** A destructive action that asks for a second press instead of a modal, and disarms after a while. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  theme,
  disabled,
  busy,
  small,
}: ThemeProps & { label: string; confirmLabel: string; onConfirm(): void; disabled?: boolean; busy?: boolean; small?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5_000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      theme={theme}
      label={armed ? confirmLabel : label}
      kind={armed ? "danger" : "secondary"}
      disabled={disabled}
      busy={busy}
      small={small}
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

export function Actions({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>{children}</View>;
}

/** A labelled text field with its hint below, and an error in its place when there is one. Lay it out in a row: it grows along it. */
export function Field({
  label,
  hint,
  error,
  value,
  onChangeText,
  placeholder,
  theme,
  monospace = false,
  width,
  onSubmit,
}: ThemeProps & {
  label: string;
  hint?: string | null;
  error?: string | null;
  value: string;
  onChangeText(value: string): void;
  placeholder?: string;
  monospace?: boolean;
  width?: number;
  onSubmit?(): void;
}) {
  const [focused, setFocused] = useState(false);
  const danger = toneColor(theme, "danger");
  return (
    <View style={{ gap: 6, flexGrow: width ? 0 : 1, flexBasis: width ?? 200, minWidth: 0 }}>
      <Text style={text(theme, 12, "600", true)}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        placeholder={placeholder}
        placeholderTextColor={tint(theme, theme.colors.foregroundMuted, 0.55)}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onSubmit}
        style={{
          ...(monospace ? mono(theme, 13) : text(theme, 14)),
          minHeight: 38,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: error ? danger : focused ? toneColor(theme, "accent") : theme.colors.border,
          backgroundColor: theme.colors.surface0,
        }}
      />
      {error ? (
        <Text role="alert" style={{ ...text(theme, 12), color: danger }}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={text(theme, 12, "400", true)}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** A setting that is on or off, its label beside the switch. */
export function SwitchRow({
  label,
  hint,
  value,
  onValueChange,
  theme,
  disabled,
}: ThemeProps & { label: string; hint?: string; value: boolean; onValueChange(value: boolean): void; disabled?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={text(theme, 14, "500")}>{label}</Text>
        {hint ? <Text style={text(theme, 12, "400", true)}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ true: theme.colors.accent, false: surface(theme, 2) }}
        thumbColor={value ? "#ffffff" : theme.colors.foregroundMuted}
        {...(Platform.OS === "web" ? { activeThumbColor: "#ffffff" } : {})}
      />
    </View>
  );
}

/**
 * One choice of a list, ringed in the accent when selected. `action` sits at its right edge but
 * outside the choice itself, so it presses on its own and is not read as part of the radio.
 */
export function Choice({
  title,
  detail,
  action,
  selected,
  onPress,
  theme,
}: ThemeProps & { title: string; detail?: string | null; action?: ReactNode; selected: boolean; onPress(): void }) {
  const accent = toneColor(theme, "accent");
  const tile = (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={title}
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        paddingLeft: 14,
        // Room for the action, armed included ("Confirm remove").
        paddingRight: action ? 136 : 14,
        borderRadius: 12,
        borderWidth: 1.5,
        borderColor: selected ? accent : "transparent",
        backgroundColor: selected
          ? tint(theme, accent, 0.1)
          : (state as { hovered?: boolean }).hovered
            ? tint(theme, theme.colors.foregroundMuted, 0.1)
            : surface(theme, 2),
      })}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          borderWidth: 2,
          borderColor: selected ? accent : tint(theme, theme.colors.foregroundMuted, 0.6),
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: accent }} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={text(theme, 14, selected ? "600" : "500")}>
          {title}
        </Text>
        {detail ? <Text style={text(theme, 12, "400", true)}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
  if (!action) return tile;
  return (
    <View>
      {tile}
      <View style={{ position: "absolute", top: 0, bottom: 0, right: 12, justifyContent: "center" }}>{action}</View>
    </View>
  );
}

/** A row of a list inside a section: a lead mark, a title over a detail, and what it offers at the end. */
export function ListRow({
  title,
  detail,
  lead,
  aside,
  theme,
  first = false,
  monospace = false,
  stacked = false,
}: ThemeProps & {
  title: string;
  detail?: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
  first?: boolean;
  monospace?: boolean;
  /** Puts `aside` below the text, for narrow layouts. */
  stacked?: boolean;
}) {
  const body = (
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text selectable style={monospace ? mono(theme, 13) : text(theme, 14, "500")}>
        {title}
      </Text>
      {typeof detail === "string" ? <Text style={text(theme, 12, "400", true)}>{detail}</Text> : detail}
    </View>
  );
  return (
    <View
      role="listitem"
      style={{
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "stretch" : "center",
        gap: stacked ? 8 : 12,
        paddingVertical: 11,
        borderTopWidth: first ? 0 : 1,
        borderColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: stacked ? 0 : 1, minWidth: 0 }}>
        {lead ? <View style={{ width: 22, alignItems: "center" }}>{lead}</View> : null}
        {body}
      </View>
      {aside ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>{aside}</View> : null}
    </View>
  );
}

/** A quiet line under a group: how it behaves, or what an action does. */
export function Note({ children, theme, tone }: ThemeProps & { children: ReactNode; tone?: Tone }) {
  return (
    <Text
      role={tone === "danger" ? "alert" : undefined}
      style={{ ...text(theme, 12, "400", !tone), ...(tone ? { color: toneColor(theme, tone) } : {}) }}
    >
      {children}
    </Text>
  );
}

/** A command to copy, in a code well. */
export function Code({ value, theme }: ThemeProps & { value: string }) {
  return (
    <View style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: surface(theme, 2) }}>
      <Text selectable style={mono(theme, 12)}>
        {value}
      </Text>
    </View>
  );
}
