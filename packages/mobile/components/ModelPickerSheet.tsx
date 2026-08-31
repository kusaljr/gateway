import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  Dimensions,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import ProviderGlyph, { providerMeta } from "./ProviderGlyph";
import KeyboardResponsiveView from "./KeyboardResponsiveView";
import { backendOf, CLI_BACKENDS, type OCModel } from "../lib/api";

// Models arrive as one flat list spanning every backend (/api/models merges
// opencode's providers with agy's), which on a phone is a wall of near-identical
// names. Three things make it navigable, in order of how often they help:
//
//   1. the model you're already on, and the handful you keep coming back to,
//      are pinned at the top so the common case is a single tap with no
//      scrolling and no typing;
//   2. searching switches the list from provider sections to one relevance-
//      ranked "Results" section — grouping is only useful while browsing, and
//      is pure noise once a query has narrowed things to four rows;
//   3. models the current thread can't reach (see lockedBackend) are folded
//      into one collapsed section at the bottom instead of sitting greyed-out
//      between the ones you can actually pick.
const RECENTS_STORAGE = "kusal:modelRecents";
const RECENTS_MAX = 4;

// Travelled by the sheet on enter/exit. The sheet is at most 82% of the
// window, so a full window height is always enough to park it off-screen —
// measuring the real height first would mean rendering a frame at rest
// position, which shows up as a flash.
const TRAVEL = Dimensions.get("window").height;
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 900;

const ACCENT = "#f97316"; // orange-500, the app's one accent
const ACCENT_TINT = "#fff7ed";
const ACCENT_TEXT = "#c2410c";

type SectionKind = "current" | "recent" | "provider" | "custom" | "unavailable";
type Section = { kind: SectionKind; key: string; title: string; count?: number; data: OCModel[] };

export default function ModelPickerSheet(props: {
  visible: boolean;
  models: OCModel[];
  currentKey: string | null;
  // set once a thread has started: its backend can't change any more, so
  // models belonging to the other one are shown but not selectable
  lockedBackend?: string | null;
  onSelect: (m: OCModel) => void;
  onClose: () => void;
}) {
  // Kept mounted for the length of the exit animation, then dropped. Because
  // the body is a separate component, every open remounts it — which is also
  // what resets the search query and provider filter, so the sheet never
  // reopens still filtered by whatever was typed last time.
  const [mounted, setMounted] = useState(props.visible);
  useEffect(() => {
    if (props.visible) setMounted(true);
  }, [props.visible]);

  if (!mounted) return null;
  return <Sheet {...props} onClosed={() => setMounted(false)} />;
}

function Sheet({
  visible,
  models,
  currentKey,
  lockedBackend,
  onSelect,
  onClose,
  onClosed,
}: {
  visible: boolean;
  models: OCModel[];
  currentKey: string | null;
  lockedBackend?: string | null;
  onSelect: (m: OCModel) => void;
  onClose: () => void;
  onClosed: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const [recentKeys, setRecentKeys] = useState<string[]>([]);
  // read inside select(), which is deliberately identity-stable so the row
  // list isn't re-rendered by every parent render
  const recentsRef = useRef(recentKeys);
  recentsRef.current = recentKeys;
  const [showUnavailable, setShowUnavailable] = useState(false);

  // A single shared value drives enter, exit and drag alike, so the three can
  // never fight over the sheet's position — the backdrop's opacity is then
  // just a function of it, which is what makes a half-finished drag fade the
  // backdrop proportionally instead of only on release.
  const translateY = useSharedValue(TRAVEL);

  // ChatScreen passes onClose/onClosed as inline arrows, so they're a new
  // function on every one of its renders — and it re-renders constantly while
  // a reply streams in. Depending on them directly would restart the enter
  // animation mid-flight and rebuild the pan gesture each time, so everything
  // below goes through these two stable wrappers instead.
  const callbacks = useRef({ onClose, onClosed, onSelect });
  callbacks.current = { onClose, onClosed, onSelect };
  const requestClose = useCallback(() => callbacks.current.onClose(), []);
  const finishClose = useCallback(() => callbacks.current.onClosed(), []);

  useEffect(() => {
    if (visible) {
      translateY.value = withTiming(0, { duration: 280, easing: Easing.out(Easing.cubic) });
      return;
    }
    translateY.value = withTiming(
      TRAVEL,
      { duration: 200, easing: Easing.in(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(finishClose)();
      }
    );
  }, [visible, translateY, finishClose]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      requestClose();
      return true;
    });
    return () => subscription.remove();
  }, [requestClose]);

  useEffect(() => {
    AsyncStorage.getItem(RECENTS_STORAGE)
      .then((raw) => {
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed)) setRecentKeys(parsed.filter((k) => typeof k === "string"));
      })
      .catch(() => {});
  }, []);

  const select = useCallback(
    (m: OCModel) => {
      const key = `${m.providerID}/${m.modelID}`;
      // Written before onSelect so it still happens if the parent unmounts us
      // in the same tick (it does — picking closes the sheet).
      AsyncStorage.setItem(
        RECENTS_STORAGE,
        JSON.stringify([key, ...recentsRef.current.filter((k) => k !== key)].slice(0, RECENTS_MAX + 1))
      ).catch(() => {});
      callbacks.current.onSelect(m);
    },
    []
  );

  // Only the handle and title area drives the drag. Putting the gesture on the
  // whole sheet would make it compete with the list's own scroll, which reads
  // as the list refusing to scroll until you overshoot.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((e) => {
          translateY.value = Math.max(0, e.translationY);
        })
        .onEnd((e) => {
          if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
            // left where the finger dropped it — the exit animation the
            // parent's `visible` flip triggers carries it the rest of the way
            runOnJS(requestClose)();
            return;
          }
          translateY.value = withSpring(0, { damping: 22, stiffness: 220 });
        }),
    [translateY, requestClose]
  );

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, TRAVEL], [1, 0], "clamp"),
  }));

  const reachable = useCallback(
    (providerID: string) => !lockedBackend || backendOf(providerID) === lockedBackend,
    [lockedBackend]
  );

  // Providers the thread can still switch to come first: with a locked thread
  // the rest are dead weight in the filter rail, so they shouldn't be the
  // chips your thumb lands on.
  const providers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of models) counts.set(m.providerID, (counts.get(m.providerID) || 0) + 1);
    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, count, label: providerMeta(id).label, ok: reachable(id) }))
      .sort((a, b) => (a.ok === b.ok ? cmp(a.label, b.label) : a.ok ? -1 : 1));
  }, [models, reachable]);

  const recents = useMemo(() => {
    const byKey = new Map(models.map((m) => [`${m.providerID}/${m.modelID}`, m]));
    return recentKeys
      .filter((k) => k !== currentKey)
      .map((k) => byKey.get(k))
      .filter((m): m is OCModel => !!m && reachable(m.providerID))
      .slice(0, RECENTS_MAX);
  }, [recentKeys, models, currentKey, reachable]);

  const current = useMemo(
    () => models.find((m) => `${m.providerID}/${m.modelID}` === currentKey) || null,
    [models, currentKey]
  );

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();
    // Anything pinned above is left out of the sections below it — a model
    // listed twice makes the list look longer than it is and costs a tap
    // deciding which copy is the "real" one.
    const pinned = new Set<string>();
    if (current) pinned.add(`${current.providerID}/${current.modelID}`);
    for (const m of recents) pinned.add(`${m.providerID}/${m.modelID}`);

    const pool = models.filter((m) => !provider || m.providerID === provider);
    const out: Section[] = [];

    if (q) {
      const scored: Array<{ m: OCModel; score: number }> = [];
      for (const m of pool) {
        const score = rank(q, m);
        if (score >= 0) scored.push({ m, score });
      }
      scored.sort((a, b) => a.score - b.score || cmp(modelName(a.m), modelName(b.m)));
      const hits = scored.map((s) => s.m).filter((m) => reachable(m.providerID));
      if (hits.length) out.push({ kind: "provider", key: "results", title: "Results", count: hits.length, data: hits });
    } else {
      if (current && (!provider || provider === current.providerID)) {
        out.push({ kind: "current", key: "current", title: "Current", data: [current] });
      }
      if (recents.length && !provider) {
        out.push({ kind: "recent", key: "recent", title: "Recent", data: recents });
      }
      const byProvider = new Map<string, OCModel[]>();
      for (const m of pool) {
        if (pinned.has(`${m.providerID}/${m.modelID}`) || !reachable(m.providerID)) continue;
        const list = byProvider.get(m.providerID);
        if (list) list.push(m);
        else byProvider.set(m.providerID, [m]);
      }
      for (const [providerID, list] of Array.from(byProvider.entries()).sort(([a], [b]) =>
        cmp(providerMeta(a).label, providerMeta(b).label)
      )) {
        list.sort((a, b) => cmp(modelName(a), modelName(b)));
        out.push({
          kind: "provider",
          key: `p:${providerID}`,
          title: providerMeta(providerID).label,
          count: list.length,
          data: list,
        });
      }
    }

    // cline (and any CLI agent) accepts an arbitrary `-m <id>`, but has no
    // command that lists what's available — so anything not in the fetched
    // list can still be reached by typing its id. Offered only when the query
    // looks like a bare id and doesn't already match something exactly.
    const custom = customModels(query, models, provider, lockedBackend);
    if (custom.length) {
      // Ahead of the results when nothing matched (it's then the only way
      // forward), behind them when something did.
      const section: Section = { kind: "custom", key: "custom", title: "Use a custom model id", data: custom };
      if (out.length) out.push(section);
      else out.unshift(section);
    }

    const blocked = models.filter((m) => !reachable(m.providerID) && (!provider || m.providerID === provider));
    if (blocked.length) {
      blocked.sort((a, b) => cmp(providerMeta(a.providerID).label, providerMeta(b.providerID).label) || cmp(modelName(a), modelName(b)));
      out.push({
        kind: "unavailable",
        key: "unavailable",
        title: "Unavailable in this thread",
        count: blocked.length,
        data: showUnavailable ? blocked : [],
      });
    }

    return out;
  }, [models, query, provider, current, recents, reachable, lockedBackend, showUnavailable]);

  const selectableCount = useMemo(() => models.filter((m) => reachable(m.providerID)).length, [models, reachable]);

  const renderItem = useCallback(
    ({ item, section }: { item: OCModel; section: Section }) => {
      if (section.kind === "custom") {
        return (
          <Pressable
            onPress={() => select(item)}
            className="mb-1.5 flex-row items-center gap-2.5 rounded-xl border border-dashed border-zinc-300 px-3 py-3 active:bg-zinc-100"
          >
            <ProviderGlyph providerID={item.providerID} size={22} />
            <Text className="flex-1 text-[13px] text-zinc-900" numberOfLines={1}>
              Run <Text className="font-semibold">{item.modelID}</Text> on {providerMeta(item.providerID).label}
            </Text>
          </Pressable>
        );
      }
      const key = `${item.providerID}/${item.modelID}`;
      return (
        <ModelRow
          model={item}
          selected={key === currentKey}
          disabled={section.kind === "unavailable"}
          // The provider is already in the section heading when browsing; in
          // search results and the pinned sections it's the only thing telling
          // two same-named models apart, so it's spelled out there.
          showProvider={section.kind !== "provider" || section.key === "results"}
          onPress={() => select(item)}
        />
      );
    },
    [currentKey, select]
  );

  return (
    // Not a Modal: a Modal is a separate native window, so the keyboard inset
    // tracking KeyboardResponsiveView relies on never reaches inside it and the
    // search field ends up behind the keyboard. Same overlay approach as
    // RenameSheet.
    <View style={[StyleSheet.absoluteFill, { zIndex: 100, elevation: 100 }]}>
      <KeyboardResponsiveView androidBottomInset={0} iosVerticalOffset={0}>
        <View className="flex-1 justify-end">
          <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
            <Pressable style={StyleSheet.absoluteFill} className="bg-black/50" onPress={requestClose} />
          </Animated.View>

          <Animated.View
            style={[
              sheetStyle,
              {
                maxHeight: "84%",
                backgroundColor: "#ffffff",
                borderTopLeftRadius: 26,
                borderTopRightRadius: 26,
                paddingBottom: Math.max(insets.bottom, 10),
                shadowColor: "#000",
                shadowOpacity: 0.18,
                shadowRadius: 24,
                shadowOffset: { width: 0, height: -6 },
                elevation: 24,
              },
            ]}
          >
            <GestureDetector gesture={pan}>
              <View className="pt-2.5">
                <View className="mx-auto h-1 w-9 rounded-full bg-zinc-300" />
                <View className="flex-row items-baseline justify-center gap-1.5 px-4 pt-2.5">
                  <Text className="text-[15px] font-semibold text-zinc-900">Model</Text>
                  <Text className="text-[11px] text-zinc-400">{selectableCount} available</Text>
                </View>
                {lockedBackend ? (
                  <View className="mx-4 mt-2.5 flex-row items-center gap-2 rounded-lg bg-amber-50 px-2.5 py-2">
                    <ProviderGlyph providerID={lockedBackend} size={16} />
                    <Text className="flex-1 text-[11px] leading-4 text-amber-800">
                      This thread runs on {providerMeta(lockedBackend).label}. Its history can't move to another agent, so
                      only {providerMeta(lockedBackend).label} models can be picked.
                    </Text>
                  </View>
                ) : null}
              </View>
            </GestureDetector>

            <View className="flex-row items-center gap-2 rounded-xl bg-zinc-100 mx-4 mt-3 px-3">
              <SearchIcon />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search models"
                placeholderTextColor="#a1a1aa"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                className="flex-1 py-2.5 text-[14px] text-zinc-900"
              />
              {query ? (
                <Pressable onPress={() => setQuery("")} hitSlop={10} className="p-1 active:opacity-60">
                  <CrossIcon />
                </Pressable>
              ) : null}
            </View>

            {providers.length > 1 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                // A horizontal ScrollView is still a flex child of this column:
                // without flexGrow/flexShrink 0 it gets squeezed to whatever
                // height is left over and clips the chips inside it.
                style={{ flexGrow: 0, flexShrink: 0 }}
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, gap: 8, alignItems: "center" }}
              >
                <Chip label="All" count={models.length} active={provider === null} onPress={() => setProvider(null)} />
                {providers.map((p) => (
                  <Chip
                    key={p.id}
                    label={p.label}
                    count={p.count}
                    active={provider === p.id}
                    muted={!p.ok}
                    glyph={p.id}
                    onPress={() => setProvider(provider === p.id ? null : p.id)}
                  />
                ))}
              </ScrollView>
            ) : (
              <View className="h-3" />
            )}

            <SectionList
              sections={sections}
              keyExtractor={(item) => `${item.providerID}/${item.modelID}`}
              renderItem={renderItem as any}
              renderSectionHeader={({ section }: { section: Section }) => (
                <SectionHeader
                  section={section}
                  expanded={showUnavailable}
                  onToggle={section.kind === "unavailable" ? () => setShowUnavailable((v) => !v) : undefined}
                />
              )}
              stickySectionHeadersEnabled
              // Without this, a tap on a row while the keyboard is up is eaten
              // by the dismiss — the model only gets picked on the second tap.
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 12, flexGrow: 1 }}
              initialNumToRender={12}
              windowSize={7}
              removeClippedSubviews
              ListEmptyComponent={
                <View className="items-center py-10">
                  <Text className="text-[13px] text-zinc-400">
                    {query ? `Nothing matches “${query.trim()}”` : "No models"}
                  </Text>
                </View>
              }
            />
          </Animated.View>
        </View>
      </KeyboardResponsiveView>
    </View>
  );
}

function ModelRow({
  model,
  selected,
  disabled,
  showProvider,
  onPress,
}: {
  model: OCModel;
  selected: boolean;
  disabled: boolean;
  showProvider: boolean;
  onPress: () => void;
}) {
  const name = modelName(model);
  // The id is the only thing separating a "Sonnet 4" served by two providers,
  // or a preview build from its stable release — but repeating it when it's
  // just the name in kebab-case is noise, so it's shown only when it adds
  // something the name doesn't already say.
  const showId = normalize(model.modelID) !== normalize(name);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        backgroundColor: selected ? ACCENT_TINT : "#ffffff",
        borderColor: selected ? "#fdba74" : "#e4e4e7",
        opacity: disabled ? 0.45 : 1,
      }}
      className={`mb-1.5 flex-row items-center gap-2.5 rounded-xl border px-3 py-2.5 ${disabled ? "" : "active:bg-zinc-100"}`}
    >
      <ProviderGlyph providerID={model.providerID} size={22} />
      <View className="flex-1">
        <Text
          style={{ color: selected ? ACCENT_TEXT : "#18181b" }}
          className={`text-[14px] ${selected ? "font-semibold" : "font-medium"}`}
          numberOfLines={1}
        >
          {name}
        </Text>
        {showId || showProvider ? (
          <Text className="mt-0.5 text-[11px] text-zinc-400" numberOfLines={1}>
            {[showProvider ? providerMeta(model.providerID).label : null, showId ? model.modelID : null]
              .filter(Boolean)
              .join("  ·  ")}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <View style={{ backgroundColor: ACCENT }} className="h-5 w-5 items-center justify-center rounded-full">
          <CheckIcon />
        </View>
      ) : null}
    </Pressable>
  );
}

function SectionHeader({
  section,
  expanded,
  onToggle,
}: {
  section: Section;
  expanded: boolean;
  onToggle?: () => void;
}) {
  const body = (
    <View className="flex-row items-center gap-1.5 bg-white pb-1.5 pt-2.5">
      <Text className="text-[10.5px] font-semibold uppercase tracking-widest text-zinc-400">{section.title}</Text>
      {section.count ? <Text className="text-[10.5px] text-zinc-300">{section.count}</Text> : null}
      {onToggle ? (
        <>
          <View className="ml-1 h-px flex-1 bg-zinc-100" />
          <Chevron up={expanded} />
        </>
      ) : null}
    </View>
  );
  if (!onToggle) return body;
  return (
    <Pressable onPress={onToggle} className="active:opacity-60">
      {body}
    </Pressable>
  );
}

function Chip({
  label,
  count,
  active,
  muted,
  glyph,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  muted?: boolean;
  glyph?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{ backgroundColor: active ? "#18181b" : "#f4f4f5", opacity: muted && !active ? 0.5 : 1 }}
      className="flex-row items-center gap-1.5 rounded-full px-2.5 py-1.5 active:opacity-70"
    >
      {glyph ? <ProviderGlyph providerID={glyph} size={15} /> : null}
      <Text
        style={{ fontSize: 12, lineHeight: 16, color: active ? "#ffffff" : "#52525b" }}
        className="font-medium"
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text style={{ fontSize: 10.5, lineHeight: 16, color: active ? "#a1a1aa" : "#a1a1aa" }}>{count}</Text>
    </Pressable>
  );
}

// Drawn from Views rather than typed as ✓ / ▾ / ✕: those glyphs aren't in
// Inter's own coverage, so each platform substitutes a different fallback font
// and they land at different sizes and baselines.
function CheckIcon({ size = 11, color = "#ffffff" }: { size?: number; color?: string }) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: size * 0.5,
          height: size * 0.85,
          borderRightWidth: 1.8,
          borderBottomWidth: 1.8,
          borderColor: color,
          transform: [{ rotate: "45deg" }],
          marginTop: -size * 0.18,
        }}
      />
    </View>
  );
}

export function Chevron({ up, color = "#a1a1aa" }: { up: boolean; color?: string }) {
  return (
    <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: 6,
          height: 6,
          borderRightWidth: 1.5,
          borderBottomWidth: 1.5,
          borderColor: color,
          transform: [{ rotate: up ? "225deg" : "45deg" }],
          marginTop: up ? 2 : -2,
        }}
      />
    </View>
  );
}

function SearchIcon() {
  return (
    <View style={{ width: 14, height: 14 }}>
      <View
        style={{
          position: "absolute",
          width: 10,
          height: 10,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: "#a1a1aa",
        }}
      />
      <View
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 5,
          height: 1.5,
          backgroundColor: "#a1a1aa",
          transform: [{ rotate: "45deg" }],
        }}
      />
    </View>
  );
}

function CrossIcon() {
  const bar = { position: "absolute" as const, width: 12, height: 1.5, backgroundColor: "#71717a", top: 5.25 };
  return (
    <View style={{ width: 12, height: 12 }}>
      <View style={[bar, { transform: [{ rotate: "45deg" }] }]} />
      <View style={[bar, { transform: [{ rotate: "-45deg" }] }]} />
    </View>
  );
}

// The label already carries the provider ("opencode · GPT-5", "agy · Gemini
// 3.7 Flash"), which is redundant once a row shows the provider's own glyph.
export function modelName(m: OCModel): string {
  const idx = m.label.indexOf(" · ");
  return idx >= 0 ? m.label.slice(idx + 3) : m.label;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cmp(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Search score for one model, lower being a better match, -1 for no match.
 *
 * A plain substring test isn't enough here because model ids are punctuated in
 * ways nobody types: "sonnet4" and "g3pro" should find "claude-sonnet-4" and
 * "Gemini 3 Pro". So a substring hit scores by how early it lands, and
 * everything else falls through to a subsequence match, which is ranked behind
 * every substring hit.
 */
function rank(q: string, m: OCModel): number {
  const name = modelName(m).toLowerCase();
  const hay = `${name} ${m.modelID.toLowerCase()} ${providerMeta(m.providerID).label.toLowerCase()}`;
  const direct = hay.indexOf(q);
  if (direct >= 0) return direct;
  const squashed = normalize(`${name}${m.modelID}`);
  const subsequence = subsequenceScore(normalize(q), squashed);
  return subsequence < 0 ? -1 : 1000 + subsequence;
}

function subsequenceScore(needle: string, hay: string): number {
  if (!needle) return 0;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of needle) {
    const at = hay.indexOf(ch, from);
    if (at < 0) return -1;
    // consecutive characters are free; a gap costs what it skipped
    if (at !== previous + 1) score += at - from + 1;
    previous = at;
    from = at + 1;
  }
  return score;
}

function customModels(
  query: string,
  models: OCModel[],
  provider: string | null,
  lockedBackend: string | null | undefined
): OCModel[] {
  const q = query.trim();
  // ids are bare tokens — a query with a space in it is someone searching by
  // name, not naming a model
  if (!q || !/^[\w.:@/-]+$/.test(q)) return [];
  if (models.some((m) => m.modelID === q)) return [];
  return Array.from(new Set(models.map((m) => m.providerID)))
    .filter((p) => CLI_BACKENDS.includes(p))
    .filter((p) => !provider || provider === p)
    .filter((p) => !lockedBackend || backendOf(p) === lockedBackend)
    .sort(cmp)
    .map((p) => ({ providerID: p, modelID: q, label: `${p} · ${q}` }) as OCModel);
}
