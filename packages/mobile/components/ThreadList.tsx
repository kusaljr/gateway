import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Text, View, Pressable, SectionList, TextInput, ActivityIndicator, Alert, type AppStateStatus } from "react-native";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { fetchSessions, fetchSessionStatuses, patchSession, deleteSession, authHeaders, type SessionSummary, type Project, type Auth } from "../lib/api";
import RenameSheet from "./RenameSheet";
import ProviderGlyph from "./ProviderGlyph";
import { Chevron } from "./DeviceCard";
import { openEventStream } from "../lib/sse";
import { MONO_FONT } from "../lib/fonts";
import { relativeTime } from "../lib/format";

// Threads grouped under their project — GET /api/sessions returns every
// thread on the device, filtered here to just this project's (there's no
// server-side project filter, matches how the web sidebar's own tree is
// built client-side from session cwds).

// ── recency buckets ─────────────────────────────────────────────────────────
// ChatGPT-style sections instead of one undifferentiated stream: the label
// carries the "when", so rows don't each need a full date. Boundaries roll
// from local midnight, not 24h ago — "Today" means today, not "the last day".
const DAY_MS = 24 * 60 * 60 * 1000;

type Bucket = { label: string; threads: SessionSummary[] };

function sameSessions(a: SessionSummary[], b: SessionSummary[]) {
  if (a.length !== b.length) return false;
  const byID = new Map(b.map((s) => [s.id, s]));
  return a.every((s) => {
    const n = byID.get(s.id);
    return n && s.id === n.id && s.title === n.title && s.status === n.status && s.model === n.model
      && s.updatedAt === n.updatedAt && s.branch === n.branch && s.archived === n.archived;
  });
}

function sameStatuses(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

// Drawn from borders like DeviceCard's Chevron — the app ships no icon font
// and no SVG runtime, and border shapes stay crisp at every density.
function SearchGlyph({ color = "#a1a1aa", size = 11 }: { color?: string; size?: number }) {
  const lens = Math.round(size * 0.72);
  const handle = Math.round(size * 0.45);
  return (
    <View style={{ width: size, height: size, justifyContent: "flex-end" }}>
      <View
        style={{
          width: lens,
          height: lens,
          borderRadius: lens / 2,
          borderWidth: 1.6,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          bottom: 0,
          right: 0,
          width: 1.6,
          height: handle,
          backgroundColor: color,
          borderRadius: 1,
          transform: [{ rotate: "-45deg" }],
          transformOrigin: "top right",
        }}
      />
    </View>
  );
}

function groupByRecency(sessions: SessionSummary[]): Bucket[] {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const t0 = midnight.getTime();
  const time = (s: SessionSummary) => new Date(s.updatedAt ?? "").getTime() || 0;

  // sort newest-first once, then each bucket takes a prefix: threads stay
  // newest-first inside every section
  const sorted = sessions.slice().sort((a, b) => time(b) - time(a));
  const active = sorted.filter((s) => s.status === "working");
  // Active work should never be buried below an arbitrary date heading. It is
  // pulled into a dedicated first section, then omitted from the date buckets.
  // Search still runs before this function, so this section filters naturally.
  const dated = sorted.filter((s) => s.status !== "working");
  const defs: Array<{ label: string; min: number }> = [
    { label: "Today", min: t0 },
    { label: "Yesterday", min: t0 - DAY_MS },
    { label: "Previous 7 days", min: t0 - 7 * DAY_MS },
    { label: "Previous 30 days", min: t0 - 30 * DAY_MS },
    { label: "Older", min: -Infinity },
  ];

  const out: Bucket[] = active.length ? [{ label: "Running now", threads: active }] : [];
  let rest = dated;
  for (const { label, min } of defs) {
    if (rest.length === 0) break;
    // the list is sorted, so the bucket is a prefix — find where it ends
    const cut = rest.findIndex((s) => time(s) < min);
    const threads = cut === -1 ? rest : rest.slice(0, cut);
    if (threads.length > 0) out.push({ label, threads });
    rest = cut === -1 ? [] : rest.slice(cut);
  }
  return out;
}

export default function ThreadList({
  tunnelUrl,
  auth,
  project,
  onPick,
  onBack,
}: {
  tunnelUrl: string;
  auth: Auth;
  project: Project;
  onPick: (sessionId: string | null, model?: string) => void;
  onBack: () => void;
}) {
  const [rawSessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [renameText, setRenameText] = useState("");
  const [q, setQ] = useState("");
  // live run state from opencode, keyed by session id — overlaid onto the
  // list in the `sessions` memo below
  const [liveStatuses, setLiveStatuses] = useState<Record<string, string>>({});
  const [statusesReady, setStatusesReady] = useState(false);
  const insets = useSafeAreaInsets();

  const load = async () => {
    try {
      const all = await fetchSessions(tunnelUrl, auth);
      const next = all.filter((s) => s.project_id === project.id && !s.archived);
      // Polling should not rebuild every swipeable row when nothing changed.
      setSessions((prev) => (sameSessions(prev, next) ? prev : next));
      setErr(null);
    } catch (e: any) {
      setErr(e.message || "Could not load threads");
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelUrl, project.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // ── live run state ────────────────────────────────────────────────────────
  // The `status` on a session row is whatever was last recorded — for opencode
  // threads a turn only lands in sqlite when it finishes, so a thread mid-turn
  // still reads idle there. opencode's /session/status and its session.status
  // events carry the truth (same three sources the web sidebar layers on in
  // useSessionStatuses): a snapshot on mount, live events for instant updates,
  // and a poll as a backstop — RN's XHR-based SSE is flaky enough on Android
  // that ChatScreen keeps a poll alongside it too.
  useEffect(() => {
    let alive = true;
    setStatusesReady(false);
    fetchSessionStatuses(tunnelUrl, auth)
      .then((s) => {
        if (!alive) return;
        setLiveStatuses((prev) => (sameStatuses(prev, s) ? prev : s));
        setStatusesReady(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelUrl]);

  const tick = useCallback(() => {
    fetchSessionStatuses(tunnelUrl, auth)
      .then((s) => {
        setLiveStatuses((prev) => (sameStatuses(prev, s) ? prev : s));
        setStatusesReady(true);
      })
      .catch(() => {});
    // CLI-agent threads (claude/codex/…) have no opencode session status —
    // their running state is the DB row the server flips to "working" for
    // the length of a turn — so re-read the list itself as well.
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelUrl]);

  useEffect(() => {
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [tick]);

  // Coming back from the background, both live signals are stale: the OS
  // throttles the timer above and suspends the event stream without reporting
  // it, so this list kept showing whichever states were true when the phone
  // went to sleep. Re-read immediately and rebuild the stream.
  const streamEpochRef = useRef(0);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next !== "active" || prev === "active") return;
      tick();
      streamEpochRef.current += 1;
      setStreamEpoch(streamEpochRef.current);
    });
    return () => sub.remove();
  }, [tick]);

  useEffect(() => {
    // one stream, not directory-scoped — session.status spans every session on
    // the opencode instance, which is what this list wants anyway
    const close = openEventStream(
      `${tunnelUrl}/api/opencode/event`,
      authHeaders(auth),
      (e) => {
        const props: any = e.properties;
        const sid: string | undefined = props?.sessionID || props?.info?.sessionID;
        if (!sid) return;
        setStatusesReady(true);
        if (e.type === "session.status") {
          // opencode's event shape is { status: { type: "busy" } }. Older
          // builds briefly emitted `type` directly, so retain that fallback.
          const eventStatus = props?.status;
          const label = (typeof eventStatus === "string" ? eventStatus : eventStatus?.type) ?? props?.type;
          if (label === "busy" || label === "retry" || label === "idle") {
            setLiveStatuses((prev) => (prev[sid] === label ? prev : { ...prev, [sid]: label }));
          }
          return;
        }
        if (e.type === "session.idle" || e.type === "session.error") {
          setLiveStatuses((prev) => (prev[sid] === "idle" ? prev : { ...prev, [sid]: "idle" }));
        }
      }
    );
    return close;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelUrl, streamEpoch]);

  // the overlay: live status wins over the stored one, so the ping shows the
  // thread that is actually running and drops off the moment it goes idle
  const sessions = useMemo(
    () =>
      rawSessions.map((s) => {
        const state = liveStatuses[s.id];
        // CLI turns record "working" in sqlite. Their session id can also
        // belong to an idle backing opencode session, which must not erase the
        // CLI's authoritative run state.
        if (s.status === "working" && s.provider !== "opencode") return s;
        if (state === "busy" || state === "retry") return { ...s, status: "working" };
        // /session/status only guarantees entries for active opencode turns.
        // Once its first snapshot has arrived, an absent or idle entry means a
        // persisted optimistic "working" flag is stale.
        if (statusesReady && s.provider === "opencode" && s.status === "working") return { ...s, status: "idle" };
        return s;
      }),
    [rawSessions, liveStatuses, statusesReady],
  );

  const working = useMemo(() => sessions.filter((s) => s.status === "working").length, [sessions]);

  // search filters before grouping, so empty sections just disappear
  const needle = q.trim().toLowerCase();
  const visible = useMemo(
    () =>
      !needle
        ? sessions
        : sessions.filter((s) => `${s.title} ${s.model} ${s.branch ?? ""}`.toLowerCase().includes(needle)),
    [sessions, needle],
  );
  const buckets = useMemo(() => groupByRecency(visible), [visible]);
  const sections = useMemo(
    () => buckets.map((bucket) => ({ title: bucket.label, data: bucket.threads })),
    [buckets],
  );

  const startRename = (s: SessionSummary) => {
    setRenameText(s.title || "");
    setRenaming(s);
  };

  const saveRename = async () => {
    if (!renaming) return;
    const title = renameText.trim();
    const target = renaming;
    setRenaming(null);
    if (!title || title === target.title) return;
    setSessions((prev) => prev.map((s) => (s.id === target.id ? { ...s, title } : s)));
    try {
      await patchSession(tunnelUrl, auth, target.id, { title });
    } catch (e: any) {
      setErr(e.message || "Could not rename thread");
      load();
    }
  };

  const confirmDelete = (s: SessionSummary) => {
    Alert.alert("Delete thread?", s.title || "Untitled", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setSessions((prev) => prev.filter((x) => x.id !== s.id));
          try {
            await deleteSession(tunnelUrl, auth, s.id);
          } catch (e: any) {
            setErr(e.message || "Could not delete thread");
            load();
          }
        },
      },
    ]);
  };

  // iOS-style swipe actions — fixed-width Rename/Delete revealed as the row is
  // dragged left. `close` comes from Swipeable itself (third render arg), so
  // tapping either button dismisses the row before the alert/sheet opens.
  const renderRowActions = (s: SessionSummary, _progress: unknown, _translation: unknown, swipeable: { close: () => void }) => (
    <View style={{ flexDirection: "row", height: "100%" }}>
      <Pressable
        onPress={() => {
          swipeable.close();
          startRename(s);
        }}
        style={{ width: 76, height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "#e4e4e7" }}
      >
        <Text className="text-[11px] font-semibold text-zinc-700">Rename</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          swipeable.close();
          confirmDelete(s);
        }}
        style={{ width: 76, height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "#ef4444" }}
      >
        <Text className="text-[11px] font-semibold text-white">Delete</Text>
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-zinc-50">
      <View className="flex-row items-center px-4 pb-1 pt-1">
        <Pressable onPress={onBack} className="flex-row items-center gap-1.5 py-1 pr-2 active:opacity-60" hitSlop={8}>
          <Chevron direction="left" color="#52525b" size={7} />
          <Text className="text-sm text-zinc-600">Back</Text>
        </Pressable>
        <View className="flex-1" />
        <Pressable
          onPress={onRefresh}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel="Refresh threads"
          className="h-8 min-w-16 items-center justify-center rounded-full border border-zinc-200 bg-white px-3 active:bg-zinc-100 disabled:opacity-60"
        >
          {refreshing ? <ActivityIndicator size="small" color="#71717a" /> : <Text className="text-[11px] font-semibold text-zinc-600">Refresh</Text>}
        </Pressable>
      </View>

      {err ? (
        <View className="mx-5 mt-1 flex-row items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-3.5 py-3">
          <View className="mt-1 h-1.5 w-1.5 rounded-full bg-red-500" />
          <Text className="flex-1 text-xs leading-4 text-red-700">{err}</Text>
        </View>
      ) : null}

      <SectionList
        sections={loading ? [] : sections}
        keyExtractor={(item) => item.id}
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 108 }}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews
        ListHeaderComponent={
          <View className="mx-auto mb-5 w-full max-w-md">
            <Text className="text-[22px] font-bold text-zinc-900" numberOfLines={1}>{project.name}</Text>
            <Text
              style={{ fontFamily: MONO_FONT }}
              className="mt-0.5 text-[11px] text-zinc-400"
              numberOfLines={1}
              ellipsizeMode="head"
            >
              {project.path}
            </Text>
            <View className="mt-1 flex-row items-center gap-1.5">
              <Text className="text-xs text-zinc-500">
                {loading ? "Loading…" : `${sessions.length} ${sessions.length === 1 ? "thread" : "threads"}`}
              </Text>
              {working > 0 ? (
                <>
                  <View className="h-1 w-1 rounded-full bg-zinc-300" />
                  <View className="flex-row items-center gap-1">
                    <View className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <Text className="text-xs font-semibold text-emerald-700">{working} active</Text>
                  </View>
                </>
              ) : null}
            </View>

            {sessions.length > 0 ? (
              <View className="mt-4 flex-row items-center gap-2.5 rounded-xl bg-zinc-200/60 px-3.5 py-2.5">
                <SearchGlyph color="#71717a" size={13} />
                <TextInput
                  value={q}
                  onChangeText={setQ}
                  placeholder="Search threads"
                  placeholderTextColor="#a1a1aa"
                  returnKeyType="search"
                  selectionColor="#f97316"
                  accessibilityLabel="Search threads"
                  className="flex-1 py-0 text-[13px] text-zinc-900"
                />
                {q ? (
                  <Pressable onPress={() => setQ("")} accessibilityLabel="Clear search" hitSlop={8}>
                    <Text className="text-sm font-semibold text-zinc-400">×</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View className="mx-auto mb-2.5 mt-1 flex-row items-center gap-2 px-1 w-full max-w-md">
            {section.title === "Running now" ? <View className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : null}
            <Text className={`text-[10px] font-bold uppercase tracking-[1.5px] ${section.title === "Running now" ? "text-emerald-700" : "text-zinc-400"}`}>
              {section.title}
            </Text>
            <View className="h-px flex-1 bg-zinc-200" />
            <Text className="text-[10px] text-zinc-400">{section.data.length}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <View className="mx-auto mb-1 w-full max-w-md">
            <Swipeable
              renderRightActions={(progress, translation, swipeable) => renderRowActions(item, progress, translation, swipeable)}
              overshootRight={false}
              friction={1.5}
              containerStyle={{ borderRadius: 12, overflow: "hidden" }}
            >
              <ThreadRow s={item} onPick={onPick} onContext={confirmDelete} onRename={startRename} />
            </Swipeable>
          </View>
        )}
        ListEmptyComponent={
          <View className="mx-auto w-full max-w-md">
            {loading ? (
              <ThreadSkeleton />
            ) : sessions.length === 0 ? (
              <EmptyThreads onStart={() => onPick(null)} />
            ) : (
              <NoSearchResults query={q.trim()} onClear={() => setQ("")} />
            )}
          </View>
        }
        ListFooterComponent={
          sessions.length > 0 && sections.length > 0 ? (
            <Text className="mx-auto mt-2 w-full max-w-md text-center text-[10px] leading-4 text-zinc-400">
              Swipe left for actions · hold for options
            </Text>
          ) : null
        }
      />

      <Pressable
        onPress={() => onPick(null)}
        accessibilityRole="button"
        accessibilityLabel="Start a new thread"
        style={{
          position: "absolute",
          right: 20,
          bottom: insets.bottom + 18,
          shadowColor: "#c2410c",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.26,
          shadowRadius: 14,
          elevation: 7,
        }}
        className="flex-row items-center gap-2 rounded-full bg-orange-500 py-2.5 pl-2.5 pr-5 active:bg-orange-600"
      >
        <View className="h-8 w-8 items-center justify-center rounded-full bg-white/20">
          <Text className="-mt-0.5 text-[22px] font-light leading-6 text-white">+</Text>
        </View>
        <Text className="text-[13px] font-bold text-white">New thread</Text>
      </Pressable>

      {renaming ? (
        <RenameSheet
          title="Rename thread"
          placeholder="Thread title"
          value={renameText}
          onChangeText={setRenameText}
          onCancel={() => setRenaming(null)}
          onSave={saveRename}
        />
      ) : null}

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

// One standalone thread card. The Rename/Delete panel sits permanently
// behind every row (Swipeable renders it with absoluteFill), so the row stays
// fully OPAQUE — an explicit backgroundColor, and press feedback via colour
// rather than `active:opacity-*`, which would let those buttons show through
// on a plain tap. Long-press offers the same two actions for anyone who never
// discovers the swipe.
//
// The provider mark carries more identity than a generic thread dot, while a
// small overlaid state mark preserves the at-a-glance run status.
function ThreadRow({ s, onPick, onContext, onRename }: {
  s: SessionSummary;
  onPick: (sessionId: string | null, model?: string) => void;
  onContext: (s: SessionSummary) => void;
  onRename: (s: SessionSummary) => void;
}) {
  const model = s.model ? s.model.split("/").slice(1).join("/") || s.model : "";
  return (
    <Pressable
      onPress={() => onPick(s.id, s.model || undefined)}
      onLongPress={() =>
        Alert.alert(s.title || "Untitled", undefined, [
          { text: "Rename", onPress: () => onRename(s) },
          { text: "Delete", style: "destructive", onPress: () => onContext(s) },
          { text: "Cancel", style: "cancel" },
        ])
      }
      accessibilityRole="button"
      accessibilityLabel={`${s.title || "Untitled"}, ${s.status}`}
      className={`flex-row items-center gap-3 rounded-xl px-2.5 py-3.5 active:bg-zinc-100 ${s.status === "working" ? "bg-emerald-50" : "bg-zinc-50"}`}
    >
      <ThreadIdentity status={s.status} />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-[15px] font-semibold leading-5 text-zinc-900" numberOfLines={2}>
            {s.title || "Untitled"}
          </Text>
          <StatusPill status={s.status} />
        </View>
        <View className="mt-1.5 flex-row items-center gap-1.5">
          {s.model ? <ProviderGlyph providerID={s.model.split("/")[0]} size={12} /> : null}
          {model ? (
            <Text style={{ fontFamily: MONO_FONT }} className="max-w-[55%] shrink text-[10px] text-zinc-500" numberOfLines={1}>
              {model}
            </Text>
          ) : (
            <Text style={{ fontFamily: MONO_FONT }} className="shrink-0 text-[10px] text-zinc-300">no model</Text>
          )}
          {s.branch ? (
            <>
              <View className="h-0.5 w-0.5 rounded-full bg-zinc-300" />
              <Text style={{ fontFamily: MONO_FONT }} className="min-w-0 flex-1 text-[10px] text-zinc-400" numberOfLines={1}>
                {s.branch}
              </Text>
            </>
          ) : null}
          <Text className="ml-auto shrink-0 text-[10px] font-medium text-zinc-400">{relativeTime(s.updatedAt)}</Text>
        </View>
      </View>
      <Chevron color="#d4d4d8" size={7} />
    </Pressable>
  );
}

function ThreadIdentity({ status }: { status: string }) {
  return (
    <View className="h-8 w-8 items-center justify-center rounded-full border border-zinc-200 bg-white">
      <ConversationGlyph fill="#ffffff" />
      <View className="absolute -bottom-1 -right-1 h-4 w-4 items-center justify-center rounded-full bg-zinc-50">
        {status === "working" ? (
          <WorkingPing />
        ) : (
          <View className={`h-2.5 w-2.5 rounded-full ${status === "failed" ? "bg-red-500" : "bg-zinc-300"}`} />
        )}
      </View>
    </View>
  );
}

function ConversationGlyph({ fill = "#f4f4f5" }: { fill?: string }) {
  return (
    <View className="h-4 w-5 rounded-md border-[1.5px] border-zinc-400">
      <View
        style={{
          position: "absolute",
          left: 2,
          bottom: -3,
          width: 5,
          height: 5,
          borderLeftWidth: 1.5,
          borderBottomWidth: 1.5,
          borderColor: "#a1a1aa",
          transform: [{ skewY: "-28deg" }],
          backgroundColor: fill,
        }}
      />
    </View>
  );
}

// An expanding ring that fades out on repeat, over a solid centre dot. Sits
// inside a compact 14px box overlaid on the provider mark.
function WorkingPing() {
  const ping = useSharedValue(0);
  useEffect(() => {
    ping.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.out(Easing.quad) }), -1, false);
  }, [ping]);
  const ring = useAnimatedStyle(() => ({
    opacity: 1 - ping.value,
    transform: [{ scale: 0.45 + ping.value * 0.75 }],
  }));
  return (
    <View className="h-3.5 w-3.5 items-center justify-center">
      <Animated.View
        pointerEvents="none"
        style={[ring, { position: "absolute", width: 13, height: 13, borderRadius: 7, backgroundColor: "#10b981" }]}
      />
      <View className="h-2 w-2 rounded-full bg-emerald-500" />
    </View>
  );
}

// Only states worth naming appear. Kept typographic rather than pill-shaped so
// a thread reads like conversation history, not a product with merchandising
// badges.
function StatusPill({ status }: { status: string }) {
  if (status === "working") {
    return (
      <Text className="text-[10px] font-semibold text-emerald-700">Working</Text>
    );
  }
  if (status === "failed") {
    return (
      <Text className="text-[10px] font-semibold text-red-600">Failed</Text>
    );
  }
  return null;
}

function EmptyThreads({ onStart }: { onStart: () => void }) {
  return (
    <View
      style={{ shadowColor: "#18181b", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.045, shadowRadius: 20, elevation: 2 }}
      className="items-center rounded-3xl border border-zinc-200/80 bg-white px-7 py-10"
    >
      <View className="mb-4 h-14 w-14 items-center justify-center rounded-2xl bg-orange-50">
        <ConversationGlyph fill="#fff7ed" />
      </View>
      <Text className="text-base font-bold text-zinc-900">Start the conversation</Text>
      <Text className="mt-2 text-center text-xs leading-5 text-zinc-500">
        Threads keep each task and its agent context together inside this project.
      </Text>
      <Pressable onPress={onStart} className="mt-5 rounded-full bg-zinc-900 px-5 py-3 active:bg-zinc-700">
        <Text className="text-xs font-bold text-white">Create first thread</Text>
      </Pressable>
    </View>
  );
}

function NoSearchResults({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <View className="items-center rounded-3xl bg-white px-6 py-9">
      <View className="h-10 w-10 items-center justify-center rounded-full bg-zinc-100">
        <SearchGlyph color="#71717a" size={15} />
      </View>
      <Text className="mt-3 text-sm font-bold text-zinc-900">No matching threads</Text>
      <Text className="mt-1 max-w-xs text-center text-xs leading-5 text-zinc-500" numberOfLines={2}>
        Nothing matched “{query}”. Try a title, model, or branch name.
      </Text>
      <Pressable onPress={onClear} className="mt-4 rounded-full bg-zinc-100 px-4 py-2.5 active:bg-zinc-200">
        <Text className="text-xs font-bold text-zinc-700">Clear search</Text>
      </Pressable>
    </View>
  );
}

// Sized like the real conversation rows so the list does not jump when data lands.
function ThreadSkeleton() {
  return (
    <View>
      <View className="mb-2.5 flex-row items-center gap-2 px-1">
        <View className="h-2.5 w-20 rounded-full bg-zinc-200" />
        <View className="h-px flex-1 bg-zinc-200" />
      </View>
      <View className="gap-1">
        {[0, 1, 2].map((i) => (
          <View key={i} className="flex-row items-center gap-3 rounded-xl px-2.5 py-3.5">
            <View className="h-8 w-8 rounded-full bg-zinc-200/70" />
            <View className="min-w-0 flex-1 gap-1.5">
              <View className="h-3.5 w-2/3 rounded-full bg-zinc-100" />
              <View className="h-2.5 w-32 rounded-full bg-zinc-100" />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
