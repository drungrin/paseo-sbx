import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Fragment, useId, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Disclosure, Dot, Section, surface, text, tint, toneColor, type Theme, type Tone } from "./kit";

/** The header, tabs and "needs you" list every screen of the plugin shares. */

type ThemeProps = { theme: Theme };

/** A screen's status at a glance: a dot, breathing while something runs, and a few words. */
export function StatusChip({ label, tone, moving = false, theme }: ThemeProps & { label: string; tone: Tone; moving?: boolean }) {
  const color = toneColor(theme, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: moving ? 0 : 7,
        minHeight: 30,
        paddingLeft: moving ? 2 : 11,
        paddingRight: 12,
        borderRadius: 999,
        backgroundColor: tint(theme, color, 0.13),
      }}
    >
      <Dot color={color} moving={moving} size={7} />
      <Text style={{ ...text(theme, 12, "600"), color }}>{label}</Text>
    </View>
  );
}

/**
 * Header, status and actions above one tab's content. `alerts` qualify what the tab shows and stay
 * visible; `notes` explain how to read it and are folded under "How this works".
 */
export function Frame({
  title,
  description,
  status,
  actions,
  alerts = [],
  notes = [],
  compact,
  theme,
  children,
}: ThemeProps & {
  title: string;
  description?: string | null;
  status?: ReactNode;
  actions?: ReactNode;
  alerts?: readonly string[];
  notes?: readonly string[];
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <ScrollView
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{ padding: compact ? 16 : 28, gap: 18, paddingBottom: 40 }}
      nestedScrollEnabled
    >
      <View
        style={{
          flexDirection: compact ? "column" : "row",
          justifyContent: "space-between",
          alignItems: compact ? "flex-start" : "center",
          gap: 12,
        }}
      >
        <View style={{ gap: 2, flex: compact ? 0 : 1, minWidth: 0 }}>
          <Text role="heading" style={{ ...text(theme, 22, "700"), lineHeight: 28 }}>
            {title}
          </Text>
          {description ? <Text style={text(theme, 13, "400", true)}>{description}</Text> : null}
        </View>
        {status || actions ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {status}
            {actions}
          </View>
        ) : null}
      </View>
      {alerts.length > 0 ? (
        <View style={{ gap: 4 }}>
          {alerts.map((alert) => (
            <View key={alert} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <View
                style={{ width: 6, height: 6, marginTop: 7, borderRadius: 3, backgroundColor: toneColor(theme, "warning") }}
              />
              <Text role="alert" style={{ ...text(theme, 13), flex: 1 }}>
                {alert}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {children}
      <Disclosure title="How this works" notes={notes} theme={theme} />
    </ScrollView>
  );
}

export type Tab<Id extends string> = { id: Id; label: string; badge?: { label: string; tone?: Tone } | null };

type TabKeyEvent = { key?: string; nativeEvent?: { key?: string }; preventDefault(): void };
type Focusable = { focus(): void };

function tabForKey<Id extends string>(tabs: readonly Tab<Id>[], active: Id, key: string): Id | null {
  const index = tabs.findIndex((tab) => tab.id === active);
  if (key === "Home") return tabs[0].id;
  if (key === "End") return tabs[tabs.length - 1].id;
  if (key === "ArrowRight") return tabs[(index + 1) % tabs.length].id;
  if (key === "ArrowLeft") return tabs[(index + tabs.length - 1) % tabs.length].id;
  return null;
}

/**
 * A tab bar over panels that are built the first time they open and then kept, so a draft survives
 * switching tabs. `renderTab` draws one panel.
 */
export function Tabbed<Id extends string>({
  tabs,
  active,
  onSelect,
  renderTab,
  label,
  compact,
  theme,
}: ThemeProps & {
  tabs: readonly Tab<Id>[];
  active: Id;
  onSelect(id: Id): void;
  renderTab(id: Id): ReactNode;
  label: string;
  compact: boolean;
}) {
  const idPrefix = `sbx-${useId().replace(/:/g, "")}`;
  const [opened, setOpened] = useState<Id[]>([active]);
  const [focused, setFocused] = useState<Id | null>(null);
  const refs = useRef<Partial<Record<Id, Focusable | null>>>({});
  const built = new Set([...opened, active]);
  const select = (id: Id) => {
    setOpened((previous) => (previous.includes(id) ? previous : [...previous, id]));
    onSelect(id);
  };
  const muted = theme.colors.foregroundMuted;
  const accent = toneColor(theme, "accent");
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{ paddingHorizontal: compact ? 10 : 20, paddingTop: 8, borderBottomWidth: 1, borderColor: theme.colors.border }}
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, width: "100%" }}>
          <View
            role="tablist"
            accessibilityLabel={label}
            style={{ flexDirection: "row", alignSelf: "flex-start", gap: compact ? 0 : 4 }}
          >
            {tabs.map((tab) => {
              const selected = active === tab.id;
              const badgeColor = tab.badge?.tone && tab.badge.tone !== "neutral" ? toneColor(theme, tab.badge.tone) : muted;
              const webProps =
                Platform.OS === "web"
                  ? {
                      "aria-controls": `${idPrefix}-panel-${tab.id}`,
                      "aria-selected": selected,
                      onKeyDown: (event: TabKeyEvent) => {
                        const next = tabForKey(tabs, tab.id, event.key ?? event.nativeEvent?.key ?? "");
                        if (!next) return;
                        event.preventDefault();
                        select(next);
                        refs.current[next]?.focus();
                      },
                    }
                  : {};
              return (
                <Pressable
                  key={tab.id}
                  ref={(node) => {
                    refs.current[tab.id] = node;
                  }}
                  nativeID={`${idPrefix}-tab-${tab.id}`}
                  role="tab"
                  accessibilityLabel={tab.label}
                  accessibilityHint={tab.badge?.label}
                  accessibilityState={{ selected }}
                  tabIndex={selected ? 0 : -1}
                  onPress={() => select(tab.id)}
                  onFocus={() => setFocused(tab.id)}
                  onBlur={() => setFocused(null)}
                  {...webProps}
                  // The selected tab is underlined; the focused one is ringed, so keyboard focus shows on the selected tab too.
                  style={(state) => ({
                    minHeight: 44,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 7,
                    paddingHorizontal: compact ? 10 : 12,
                    marginBottom: -1,
                    borderWidth: 2,
                    borderRadius: 8,
                    borderBottomLeftRadius: 0,
                    borderBottomRightRadius: 0,
                    borderColor: focused === tab.id ? accent : "transparent",
                    borderBottomColor: selected || focused === tab.id ? accent : "transparent",
                    backgroundColor:
                      (state as { hovered?: boolean }).hovered && !selected ? tint(theme, muted, 0.08) : "transparent",
                  })}
                >
                  <Text
                    style={{
                      color: selected ? theme.colors.foreground : muted,
                      fontSize: 14,
                      fontWeight: selected ? "600" : "500",
                    }}
                  >
                    {tab.label}
                  </Text>
                  {tab.badge ? (
                    <Text
                      style={{
                        color: badgeColor,
                        fontSize: 11,
                        fontWeight: "600",
                        fontVariant: ["tabular-nums"],
                        paddingHorizontal: 6,
                        paddingVertical: 1,
                        borderRadius: 999,
                        overflow: "hidden",
                        backgroundColor: tint(theme, badgeColor, tab.badge.tone && tab.badge.tone !== "neutral" ? 0.16 : 0.12),
                      }}
                    >
                      {tab.badge.label}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>
      {tabs.map(({ id }) => (
        <View
          key={id}
          nativeID={`${idPrefix}-panel-${id}`}
          role="tabpanel"
          aria-labelledby={`${idPrefix}-tab-${id}`}
          aria-hidden={active !== id}
          importantForAccessibility={active === id ? "auto" : "no-hide-descendants"}
          style={{ flex: 1, minHeight: 0, display: active === id ? "flex" : "none" }}
        >
          {built.has(id) ? renderTab(id) : null}
        </View>
      ))}
    </View>
  );
}

/** One thing waiting on you: what it is, why, and where to fix it. */
export type Need = { tone: Tone; title: string; detail?: string | null; action?: { label: string; onPress(): void } | null };

/** What waits on you, each item with the way to fix it; a calm line when nothing does. */
export function Needs({ needs, calm, theme }: ThemeProps & { needs: readonly Need[]; calm: { title: string; detail: string } }) {
  const success = toneColor(theme, "success");
  if (!needs.length) {
    return (
      <View
        accessible
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 16,
          borderRadius: 14,
          backgroundColor: tint(theme, success, 0.1),
        }}
      >
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 15,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tint(theme, success, 0.25),
          }}
        >
          <Text style={{ ...text(theme, 15, "700"), color: success }}>✓</Text>
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={text(theme, 15, "600")}>{calm.title}</Text>
          <Text style={text(theme, 13, "400", true)}>{calm.detail}</Text>
        </View>
      </View>
    );
  }
  return (
    <Section
      theme={theme}
      tone={needs.some((need) => need.tone === "danger") ? "danger" : "warning"}
      overline={`Needs you · ${needs.length}`}
      gap={4}
      padding={16}
    >
      <View role="list" accessibilityLabel="What needs you">
        {needs.map((need, index) => (
          <View
            key={`${index}:${need.title}`}
            role="listitem"
            style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", paddingVertical: 8 }}
          >
            <View style={{ width: 8, height: 8, marginTop: 7, borderRadius: 4, backgroundColor: toneColor(theme, need.tone) }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={text(theme, 14, "600")}>{need.title}</Text>
              {need.detail ? <Text style={text(theme, 13, "400", true)}>{need.detail}</Text> : null}
            </View>
            {need.action ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${need.action.label}: ${need.title}`}
                onPress={need.action.onPress}
                style={{ minHeight: 28, justifyContent: "center", paddingHorizontal: 4 }}
              >
                <Text style={{ ...text(theme, 12, "600"), color: toneColor(theme, need.tone) }}>{need.action.label} →</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>
    </Section>
  );
}

/** A grid of figures that wraps on narrow layouts. */
export function Figures({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>{children}</View>;
}

/** Two columns side by side on wide layouts, one above the other on narrow ones. */
export function Columns({ compact, children }: { compact: boolean; children: ReactNode }) {
  return (
    <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "flex-start", gap: 16 }}>
      {children}
    </View>
  );
}

export function Column({ compact, children }: { compact: boolean; children: ReactNode }) {
  return (
    <View style={{ flexGrow: compact ? 0 : 1, flexShrink: 1, flexBasis: compact ? "auto" : 0, minWidth: 0, gap: 16 }}>
      {children}
    </View>
  );
}

/** Cards in two columns, filled in turn so neither runs much longer; one column on compact layouts. */
export function Grid<Item>({
  items,
  keyOf,
  render,
  compact,
}: {
  items: readonly Item[];
  keyOf(item: Item): string;
  render(item: Item): ReactNode;
  compact: boolean;
}) {
  const card = (item: Item) => <Fragment key={keyOf(item)}>{render(item)}</Fragment>;
  if (compact) return <View style={{ gap: 16 }}>{items.map(card)}</View>;
  return (
    <Columns compact={false}>
      {[0, 1].map((side) => (
        <Column key={side} compact={false}>
          {items.filter((_, index) => index % 2 === side).map(card)}
        </Column>
      ))}
    </Columns>
  );
}

/** An empty state: what is missing and how it fills. */
export function Empty({ title, detail, theme, children }: ThemeProps & { title: string; detail: string; children?: ReactNode }) {
  return (
    <View
      style={{
        alignItems: "flex-start",
        gap: 8,
        padding: 20,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: theme.colors.border,
        backgroundColor: surface(theme),
      }}
    >
      <Text style={text(theme, 15, "600")}>{title}</Text>
      <Text style={text(theme, 13, "400", true)}>{detail}</Text>
      {children}
    </View>
  );
}
