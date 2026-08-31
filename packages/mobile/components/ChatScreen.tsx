import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  AppState,
  Text,
  View,
  Pressable,
  FlatList,
  TextInput,
  type AppStateStatus,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Markdown from "react-native-markdown-display";
import ModelPickerSheet, { Chevron as Caret, modelName } from "./ModelPickerSheet";
import ProviderGlyph from "./ProviderGlyph";
import { Chevron } from "./DeviceCard";
import { StepMark, TerminalGlyph } from "./Glyphs";
import Shimmer from "./Shimmer";
import KeyboardResponsiveView from "./KeyboardResponsiveView";
import { MONO_FONT } from "../lib/fonts";
import { notifyTurnFinished } from "../lib/notify";
import { openEventStream } from "../lib/sse";
import { applyStreamEvent } from "../lib/streamApply";
import {
  fetchModels,
  setSessionModel,
  promptAsync,
  fetchMessages,
  fetchSessionInfo,
  createSession,
  patchSession,
  authHeaders,
  agentPrompt,
  fetchAgentMessages,
  fetchSessionStatuses,
  backendOf,
  isCliBackend,
  type Project,
  type Auth,
  type OCModel,
  type OCMessage,
  type OCPart,
} from "../lib/api";

const MODEL_KEY_STORAGE = "kusal:modelKey";
// used only until the real fetchModels() call resolves — mirrors ChatView.tsx's own fallback exactly
const FALLBACK_MODELS: OCModel[] = [
  { providerID: "opencode", modelID: "claude-sonnet-4", label: "opencode · claude-sonnet-4" },
  { providerID: "opencode", modelID: "gpt-5", label: "opencode · gpt-5" },
];

// mirrors the assistant bubble's own text sizing (text-sm / zinc-900) since
// react-native-markdown-display can't read nativewind's className. Default
// library styles pack every block flush against the next with no breathing
// room — most of this is spacing (paragraph/heading/list margins), not color.
// bundled, so it renders identically on both platforms instead of falling
// back to whatever each OS calls "monospace"
const CODE_FONT = MONO_FONT;
const TOOL_DETAIL_KEYS = ["filePath", "path", "file", "command", "pattern", "query", "url", "description", "prompt"];
const markdownStyles = {
  body: { fontSize: 14, lineHeight: 21, color: "#18181b" },
  paragraph: { marginTop: 0, marginBottom: 8 },

  heading1: { fontSize: 19, lineHeight: 25, fontWeight: "700", marginTop: 10, marginBottom: 6 },
  heading2: { fontSize: 17, lineHeight: 23, fontWeight: "700", marginTop: 10, marginBottom: 6 },
  heading3: { fontSize: 15, lineHeight: 21, fontWeight: "700", marginTop: 8, marginBottom: 4 },
  heading4: { fontSize: 14, lineHeight: 20, fontWeight: "700", marginTop: 8, marginBottom: 4 },
  heading5: { fontSize: 14, lineHeight: 20, fontWeight: "700", marginTop: 6, marginBottom: 4 },
  heading6: { fontSize: 14, lineHeight: 20, fontWeight: "700", marginTop: 6, marginBottom: 4 },

  bullet_list: { marginTop: 2, marginBottom: 8 },
  ordered_list: { marginTop: 2, marginBottom: 8 },
  list_item: { marginBottom: 4, flexDirection: "row" },
  bullet_list_icon: { marginRight: 6 },
  bullet_list_content: { flex: 1 },
  ordered_list_icon: { marginRight: 6 },
  ordered_list_content: { flex: 1 },

  code_inline: {
    backgroundColor: "#f4f4f5",
    color: "#18181b",
    fontFamily: CODE_FONT,
    fontSize: 13,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  code_block: {
    backgroundColor: "#f4f4f5",
    color: "#18181b",
    fontFamily: CODE_FONT,
    fontSize: 12.5,
    lineHeight: 18,
    padding: 10,
    borderRadius: 8,
    marginTop: 4,
    marginBottom: 8,
  },
  fence: {
    backgroundColor: "#f4f4f5",
    color: "#18181b",
    fontFamily: CODE_FONT,
    fontSize: 12.5,
    lineHeight: 18,
    padding: 10,
    borderRadius: 8,
    marginTop: 4,
    marginBottom: 8,
  },

  blockquote: {
    backgroundColor: "#fafafa",
    borderLeftWidth: 3,
    borderLeftColor: "#e4e4e7",
    paddingLeft: 10,
    paddingVertical: 2,
    marginTop: 4,
    marginBottom: 8,
  },

  hr: { backgroundColor: "#e4e4e7", height: 1, marginVertical: 10 },

  link: { color: "#f97316" },

  table: { borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 6, marginTop: 4, marginBottom: 8 },
  th: { padding: 6, backgroundColor: "#f4f4f5" },
  td: { padding: 6, borderTopWidth: 1, borderColor: "#e4e4e7" },
} as const;

// Reconcile responses are freshly parsed JSON, so object identity alone would
// make every historical Markdown block render again on every poll. Compare the
// fields the timeline actually displays, then retain old objects for unchanged
// messages. String equality is much cheaper than reparsing Markdown and laying
// out the entire conversation.
function sameRenderedPart(a: OCPart, b: OCPart) {
  if (a.id !== b.id || a.type !== b.type || a.text !== b.text || a.tool !== b.tool || a.callID !== b.callID) return false;
  if (a.state?.status !== b.state?.status || a.state?.title !== b.state?.title || a.state?.output !== b.state?.output) return false;
  return TOOL_DETAIL_KEYS.every((key) => a.state?.input?.[key] === b.state?.input?.[key]);
}

function sameRenderedMessage(a: OCMessage, b: OCMessage) {
  if (a.info.id !== b.info.id || a.info.role !== b.info.role || a.info.time?.completed !== b.info.time?.completed) return false;
  return a.parts.length === b.parts.length && a.parts.every((part, i) => sameRenderedPart(part, b.parts[i]));
}

function stabilizeMessages(previous: OCMessage[], incoming: OCMessage[]) {
  if (previous.length === 0) return incoming;
  const byID = new Map(previous.flatMap((message) => message.info.id ? [[message.info.id, message] as const] : []));
  let unchanged = previous.length === incoming.length;
  const next = incoming.map((message, index) => {
    const old = (message.info.id && byID.get(message.info.id)) || previous[index];
    if (old && sameRenderedMessage(old, message)) {
      if (old !== previous[index]) unchanged = false;
      return old;
    }
    unchanged = false;
    return message;
  });
  return unchanged ? previous : next;
}

export default function ChatScreen({
  tunnelUrl,
  auth,
  project,
  initialSessionId,
  initialModelKey,
  onBack,
  onOpenTerminal,
}: {
  tunnelUrl: string;
  auth: Auth;
  project: Project;
  initialSessionId: string | null;
  // the model this thread actually ran on, from its own session row — a
  // reopened thread should show that, not whatever was last picked globally
  initialModelKey?: string | null;
  onBack: () => void;
  onOpenTerminal: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [messages, setMessages] = useState<OCMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [models, setModels] = useState<OCModel[]>(FALLBACK_MODELS);
  const [modelKey, setModelKey] = useState<string | null>(initialModelKey ?? null);
  const [showModelSheet, setShowModelSheet] = useState(false);
  const [busyState, setBusyState] = useState<"idle" | "busy" | "retry">("idle");
  const busyStateRef = useRef<"idle" | "busy" | "retry">("idle");
  busyStateRef.current = busyState;
  const [streamLive, setStreamLive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<FlatList<TimelineItem>>(null);
  const stickToBottomRef = useRef(true);
  const userIsScrollingRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  // Which CLI agent backend this thread belongs to ("agy" | "cline"), or null
  // for an opencode thread. The ref is what async callbacks read; the state is
  // what render reads.
  // Seeded from the thread's own model key ("claude/haiku" -> "claude") so a
  // reopened thread knows its backend immediately, rather than only once the
  // first transcript poll lands — that's what the picker's lock reads.
  const seededBackend = initialModelKey ? backendOf(initialModelKey.split("/")[0]) : null;
  const initialCliBackend = seededBackend && isCliBackend(seededBackend) ? seededBackend : null;
  const cliBackendRef = useRef<string | null>(initialCliBackend);
  const [cliBackend, setCliBackend] = useState<string | null>(initialCliBackend);
  const [agentRunning, setAgentRunning] = useState(false);
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(0);

  // model list + restore persisted (or session-default) choice
  useEffect(() => {
    (async () => {
      try {
        const { models: list, defaultKey } = await fetchModels(tunnelUrl, auth, project.path);
        if (list.length) setModels(list);
        const stored = await AsyncStorage.getItem(MODEL_KEY_STORAGE);
        // `prev` wins: for an existing thread it's already seeded from that
        // thread's own model, and the stored key is only a default for new ones
        setModelKey((prev) => prev || stored || defaultKey);
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelUrl, project.path]);

  const reconcile = useCallback(
    async (id: string) => {
      // agy has no server of its own, so kusal stores its transcript — and
      // only agy threads ever get such a row. That's what identifies the
      // backend here, rather than plumbing `provider` down into this screen:
      // an opencode thread simply comes back empty and falls through.
      try {
        const state = await fetchAgentMessages(tunnelUrl, auth, id);
        if (state.messages.length) {
          // the transcript's own message ids are prefixed with the backend
          // that produced them ("agy-a-…", "cline-a-…"), which is how a
          // reopened thread recovers its backend without extra plumbing
          const from = state.messages[0]?.info?.id?.split("-")[0] || null;
          if (from && isCliBackend(from)) {
            cliBackendRef.current = from;
            setCliBackend(from);
          }
          setMessages((prev) => stabilizeMessages(prev, state.messages));
          setAgentRunning((prev) => prev === state.running ? prev : state.running);
          if (!state.running && busyStateRef.current !== "idle") {
            busyStateRef.current = "idle";
            setBusyState("idle");
            patchSession(tunnelUrl, auth, id, { status: "idle" }).catch(() => {});
            // the transition is the event worth announcing, not the idle state:
            // this runs on a poll, so firing on `!running` alone would notify
            // once per tick for the rest of the thread's life
            notifyTurnFinished(project.name || project.path);
          }
          return;
        }
      } catch {}
      // a known agy thread whose first turn hasn't produced anything yet —
      // falling through would clobber the optimistic echo with opencode's
      // (empty) history for the same id
      if (cliBackendRef.current) return;
      try {
        const [info, msgs] = await Promise.all([
          fetchSessionInfo(tunnelUrl, auth, id, project.path),
          fetchMessages(tunnelUrl, auth, id, project.path),
        ]);
        if (info?.model) setModelKey(`${info.model.providerID}/${info.model.id}`);
        setMessages((prev) => stabilizeMessages(prev, msgs));
        const last = msgs[msgs.length - 1];
        if (last?.info.role === "assistant" && last.info.time?.completed && busyStateRef.current !== "idle") {
          busyStateRef.current = "idle";
          setBusyState("idle");
          patchSession(tunnelUrl, auth, id, { status: "idle" }).catch(() => {});
        }
      } catch {}
    },
    [tunnelUrl, auth, project.path]
  );

  useEffect(() => {
    if (sessionId) reconcile(sessionId);
  }, [sessionId, reconcile]);

  // Everything on this screen can be re-derived from the server — the
  // transcript, and whether a turn is still running — so nothing held in
  // memory is trusted after a suspend. This is the whole recovery: ask the
  // session, believe the answer.
  const resyncFromSession = useCallback(
    async (id: string) => {
      await reconcile(id);
      // reconcile already read `running` straight from the CLI agent's own row
      if (cliBackendRef.current) return;
      try {
        const statuses = await fetchSessionStatuses(tunnelUrl, auth);
        const live = statuses[id] === "busy" || statuses[id] === "retry";
        const next = live ? "busy" : "idle";
        if (busyStateRef.current !== next) {
          busyStateRef.current = next;
          setBusyState(next);
        }
      } catch {}
    },
    [reconcile, tunnelUrl, auth]
  );

  // A backgrounded app has no network. The OS suspends the SSE socket without
  // firing onerror, so `streamLive` stayed true while nothing was arriving —
  // and the backstop poll only runs when the stream is DOWN or a turn is
  // active, so it never started either. The thread simply froze mid-turn, and
  // nothing re-read it on the way back. Hence: say the stream is down the
  // moment we leave, and on return re-read the session and reconnect.
  const streamEpochRef = useRef(0);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === "active") {
        // ignore the inactive→active flicker of the app switcher or a pulled
        // -down notification shade, which never actually severed anything
        if (prev === "active") return;
        setStreamLive(false);
        streamEpochRef.current += 1;
        setStreamEpoch(streamEpochRef.current);
        if (sessionIdRef.current) void resyncFromSession(sessionIdRef.current);
        return;
      }
      if (next === "background") setStreamLive(false);
    });
    return () => sub.remove();
  }, [resyncFromSession]);

  // one shared event stream, not directory-scoped (matches the real web
  // client exactly — session.status/event/etc. span every session on the
  // opencode instance) — filtered here to just this screen's session id.
  useEffect(() => {
    const url = `${tunnelUrl}/api/opencode/event`;
    const close = openEventStream(
      url,
      authHeaders(auth),
      (e) => {
        const props: any = e.properties;
        const sid = props?.sessionID || props?.info?.sessionID || props?.part?.sessionID;
        if (e.type === "session.status" || e.type === "session.idle") {
          if (sid && sid === sessionIdRef.current) {
            const eventStatus = props?.status;
            const label = e.type === "session.idle"
              ? "idle"
              : (typeof eventStatus === "string" ? eventStatus : eventStatus?.type) || props?.type || "busy";
            busyStateRef.current = label;
            setBusyState(label);
            // Persist the completion too. If the user navigates back while a
            // turn is running, ThreadList can still render the correct state
            // from sqlite without depending on this screen's SSE connection.
            if (label === "idle") patchSession(tunnelUrl, auth, sid, { status: "idle" }).catch(() => {});
          }
          return;
        }
        if (e.type === "session.error") {
          if (sid === sessionIdRef.current) {
            busyStateRef.current = "idle";
            setBusyState("idle");
            setErr(String(props?.error || "session error"));
            patchSession(tunnelUrl, auth, sid, { status: "failed" }).catch(() => {});
          }
          return;
        }
        if (sid && sid !== sessionIdRef.current) return;
        setMessages((prev) => applyStreamEvent(prev, e.type, e.properties));
      },
      () => {
        setStreamLive(true);
        if (sessionIdRef.current) reconcile(sessionIdRef.current);
      },
      () => setStreamLive(false)
    );
    return close;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelUrl, streamEpoch]);

  // Poll only as a backstop while the stream is down or a turn is active. The
  // old unconditional two-second reload replaced the complete transcript even
  // on an idle screen, repeatedly reparsing every historical Markdown block.
  // `send` sets busyState optimistically, so this does not depend on SSE firing
  // before the safety-net poll starts.
  useEffect(() => {
    if (!sessionId || (streamLive && busyState === "idle" && !agentRunning)) return;
    const t = setInterval(() => reconcile(sessionId), 2500);
    return () => clearInterval(t);
  }, [sessionId, reconcile, streamLive, busyState, agentRunning]);

  const updateStickToBottom = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    stickToBottomRef.current = distanceFromBottom <= 80;
  }, []);

  const scrollToBottomIfNeeded = useCallback((animated = true) => {
    if (!stickToBottomRef.current) return;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated }));
  }, []);

  const currentModel = useMemo<OCModel | null>(() => {
    if (!modelKey) return null;
    // Split on the FIRST slash only — a modelID can itself contain slashes
    // (cline's are namespaced, e.g. "cline/z-ai/glm-5.3-flash"), so a plain
    // split("/") would truncate the id and run the wrong model.
    const slash = modelKey.indexOf("/");
    const providerID = slash < 0 ? modelKey : modelKey.slice(0, slash);
    const modelID = slash < 0 ? "" : modelKey.slice(slash + 1);
    return models.find((m) => m.providerID === providerID && m.modelID === modelID) || { providerID, modelID, label: modelKey };
  }, [modelKey, models]);

  // Derived from the actual message list, not busyState — busyState only
  // moves via SSE, which isn't reliable enough here to gate the spinner on.
  const waitingForReply = useMemo(() => {
    // agy reports this explicitly (it has no completion event to infer from
    // while a turn is between steps), so trust its flag when it's set.
    if (agentRunning) return true;
    const last = messages[messages.length - 1];
    if (!last) return false;
    if (last.info.role === "user") return true;
    return last.info.role === "assistant" && !last.info.time?.completed;
  }, [messages, agentRunning]);

  const timeline = useMemo(() => groupMessagesIntoTurns(messages), [messages]);
  const currentTurnHasActivity = useMemo(() => {
    const last = timeline[timeline.length - 1];
    return last?.role === "assistant" && last.messages.some((message) => message.parts.some(isActivityPart));
  }, [timeline]);

  // agy and opencode keep entirely separate transcripts (agy's lives in
  // kusal's own db, opencode's in its server), so switching backends mid-thread
  // would strand the history behind it. Once a thread has said anything, its
  // backend is fixed — models within that backend stay freely switchable.
  const lockedBackend = useMemo<string | null>(() => {
    if (!messages.length) return null;
    return cliBackend ?? "opencode";
  }, [messages.length, cliBackend]);

  const pickModel = async (m: OCModel) => {
    // the sheet already disables these, this is just the matching guard
    if (lockedBackend && backendOf(m.providerID) !== lockedBackend) return;
    const key = `${m.providerID}/${m.modelID}`;
    setModelKey(key);
    setShowModelSheet(false);
    await AsyncStorage.setItem(MODEL_KEY_STORAGE, key);
    if (sessionId) {
      if (!isCliBackend(m.providerID)) {
        setSessionModel(tunnelUrl, auth, sessionId, { providerID: m.providerID, id: m.modelID }, project.path).catch(() => {});
      }
      patchSession(tunnelUrl, auth, sessionId, { model: key }).catch(() => {});
    }
  };

  const openModelPicker = () => {
    setShowModelSheet(true);
    // A chat screen can stay mounted for a long time. Refresh on every open
    // so a newly available CLI catalog replaces any fallback response that
    // was cached in component state when the screen first loaded.
    fetchModels(tunnelUrl, auth, project.path)
      .then(({ models: list }) => {
        if (list.length) setModels(list);
      })
      .catch(() => {});
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    stickToBottomRef.current = true;
    setErr(null);
    setInput("");
    setSending(true);
    // optimistic local echo — instant feedback ahead of the session/SSE round-trip
    setMessages((prev) => [...prev, { info: { role: "user", id: `local-${Date.now()}` }, parts: [{ type: "text", text }] }]);
    let sid = sessionIdRef.current;
    try {
      if (!sid) {
        const title = text.length > 80 ? text.slice(0, 77) + "..." : text;
        const created = await createSession(tunnelUrl, auth, { title, cwd: project.path, project_id: project.id });
        sid = created.id;
        setSessionId(sid);
      }
      const model = currentModel
        ? { providerID: currentModel.providerID, modelID: currentModel.modelID }
        : { providerID: "opencode", modelID: "claude-sonnet-4" };
      // Same persistence pickModel() does — without it, a session created by
      // just typing and hitting send (the common path, no model picker ever
      // opened) never gets its model written to our own session row, so
      // ThreadList's "· model" line stays blank for it forever.
      if (currentModel) {
        patchSession(tunnelUrl, auth, sid, { model: `${currentModel.providerID}/${currentModel.modelID}` }).catch(() => {});
      }

      if (isCliBackend(model.providerID)) {
        cliBackendRef.current = model.providerID;
        setCliBackend(model.providerID);
        setAgentRunning(true);
        // no setSessionModel/promptAsync here — those are opencode's API, and
        // these agents take their model as a CLI flag on the turn itself.
        await agentPrompt(tunnelUrl, auth, model.providerID, sid, model.modelID, text, project.path);
        reconcile(sid);
      } else {
        // Make the working state durable before prompt_async returns. The
        // thread list may mount immediately after this screen unmounts, while
        // mobile SSE has not connected yet, so it needs more than an in-memory
        // event to know that this turn is active.
        await patchSession(tunnelUrl, auth, sid, { status: "working" }).catch(() => {});
        busyStateRef.current = "busy";
        setBusyState("busy");
        if (currentModel) {
          setSessionModel(tunnelUrl, auth, sid, { providerID: currentModel.providerID, id: currentModel.modelID }, project.path).catch(() => {});
        }
        await promptAsync(tunnelUrl, auth, sid, model, text, project.path);
        if (!streamLive) reconcile(sid);
      }
    } catch (e: any) {
      busyStateRef.current = "idle";
      setBusyState("idle");
      setErr(e.message || "Could not send message");
      if (sid) patchSession(tunnelUrl, auth, sid, { status: "failed" }).catch(() => {});
    }
    setSending(false);
  };

  const renderTimelineItem = useCallback(
    ({ item }: { item: TimelineItem }) => <TimelineRow item={item} />,
    [],
  );

  return (
    <SafeAreaView className="flex-1 bg-zinc-50">
      <View
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
        className="flex-row items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2.5"
      >
        <Pressable onPress={onBack} className="flex-row items-center gap-1.5 py-1 pr-1 active:opacity-60" hitSlop={8}>
          <Chevron direction="left" color="#52525b" size={7} />
        </Pressable>
        <View className="flex-1">
          <Text className="text-[13px] font-semibold text-zinc-900" numberOfLines={1}>{project.name}</Text>
          {/* the folder every command in this thread runs in — worth a line,
              since the same project name can exist on more than one device */}
          <Text
            style={{ fontFamily: MONO_FONT }}
            className="text-[10px] text-zinc-400"
            numberOfLines={1}
            ellipsizeMode="head"
          >
            {project.path}
          </Text>
        </View>
        <Pressable
          onPress={onOpenTerminal}
          accessibilityRole="button"
          accessibilityLabel="Terminal"
          hitSlop={6}
          className="h-9 w-9 items-center justify-center rounded-full border border-zinc-200 bg-white active:bg-zinc-100"
        >
          <TerminalGlyph />
        </Pressable>
      </View>

      {err ? (
        <Pressable onPress={() => setErr(null)} className="mx-4 mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
          <Text className="text-xs text-red-700">{err}</Text>
        </Pressable>
      ) : null}

      <KeyboardResponsiveView
        androidBottomInset={insets.bottom}
        iosVerticalOffset={insets.top + headerHeight}
      >
        <FlatList
          ref={scrollRef}
          data={timeline}
          renderItem={renderTimelineItem}
          keyExtractor={(item) => item.key}
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}
          ItemSeparatorComponent={TimelineGap}
          initialNumToRender={10}
          maxToRenderPerBatch={6}
          updateCellsBatchingPeriod={40}
          windowSize={7}
          scrollEventThrottle={32}
          onContentSizeChange={() => scrollToBottomIfNeeded(false)}
          onLayout={() => scrollToBottomIfNeeded(false)}
          onScrollBeginDrag={(event) => {
            userIsScrollingRef.current = true;
            updateStickToBottom(event);
          }}
          onScroll={(event) => {
            if (userIsScrollingRef.current) updateStickToBottom(event);
          }}
          onScrollEndDrag={(event) => {
            updateStickToBottom(event);
            userIsScrollingRef.current = false;
          }}
          onMomentumScrollBegin={() => {
            userIsScrollingRef.current = true;
          }}
          onMomentumScrollEnd={(event) => {
            updateStickToBottom(event);
            userIsScrollingRef.current = false;
          }}
          ListEmptyComponent={
            <View className="mt-12 items-center px-6">
              <Text className="text-center text-base font-semibold text-zinc-900">
                What are we building in {project.name}?
              </Text>
              <Text className="mt-2 text-center text-xs leading-5 text-zinc-400">
                Whatever you send runs an agent on that machine, in this folder. Pick the model
                below first if it matters.
              </Text>
            </View>
          }
          ListFooterComponent={
            (sending || waitingForReply) && !currentTurnHasActivity ? (
              <View className={timeline.length ? "mt-2.5" : undefined}>
                <WorkingShimmer />
              </View>
            ) : null
          }
        />

        <View className="border-t border-zinc-200 bg-white px-3 pb-2 pt-2.5">
          <Pressable
            onPress={openModelPicker}
            hitSlop={6}
            className="mb-2 max-w-full flex-row items-center gap-1.5 self-start rounded-full border border-zinc-200 bg-white pl-1.5 pr-2 py-1 active:bg-zinc-100"
          >
            {currentModel ? <ProviderGlyph providerID={currentModel.providerID} size={16} /> : null}
            <Text
              style={{ fontFamily: MONO_FONT, fontSize: 11, lineHeight: 16 }}
              className="shrink text-zinc-700"
              numberOfLines={1}
            >
              {currentModel ? modelName(currentModel) : "Choose model"}
            </Text>
            <Caret up={false} color="#a1a1aa" />
          </Pressable>
          <View className="flex-row items-end gap-2">
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={`Message ${currentModel ? modelName(currentModel) : "the agent"}…`}
              placeholderTextColor="#a1a1aa"
              multiline
              className="max-h-32 flex-1 rounded-2xl bg-zinc-100 px-3.5 py-2.5 text-sm leading-5 text-zinc-900"
            />
            {/* circular send: the arrow reads at a glance and the target stays
                square at 40px however tall the input grows */}
            <Pressable
              onPress={send}
              disabled={sending || !input.trim()}
              accessibilityRole="button"
              accessibilityLabel="Send"
              className={`h-10 w-10 items-center justify-center rounded-full bg-orange-500 ${sending || !input.trim() ? "opacity-40" : "active:opacity-90"}`}
            >
              <Chevron direction="up" color="#ffffff" size={9} width={2} />
            </Pressable>
          </View>
        </View>
      </KeyboardResponsiveView>

      <ModelPickerSheet
        visible={showModelSheet}
        models={models}
        currentKey={modelKey}
        lockedBackend={lockedBackend}
        onSelect={pickModel}
        onClose={() => setShowModelSheet(false)}
      />
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

type TimelineItem =
  | { role: "user"; key: string; message: OCMessage }
  | { role: "assistant"; key: string; messages: OCMessage[] };

const TimelineRow = memo(
  function TimelineRow({ item }: { item: TimelineItem }) {
    return item.role === "user"
      ? <UserMessageBubble msg={item.message} />
      : <AssistantTurn messages={item.messages} />;
  },
  (previous, next) => {
    const a = previous.item;
    const b = next.item;
    if (a.role !== b.role || a.key !== b.key) return false;
    if (a.role === "user" && b.role === "user") return a.message === b.message;
    if (a.role === "assistant" && b.role === "assistant") {
      return a.messages.length === b.messages.length && a.messages.every((message, i) => message === b.messages[i]);
    }
    return false;
  },
);

function TimelineGap() {
  return <View className="h-2.5" />;
}

function groupMessagesIntoTurns(messages: OCMessage[]): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  messages.forEach((message, index) => {
    const key = message.info.id || `${message.info.role}-${index}`;
    if (message.info.role === "user") {
      timeline.push({ role: "user", key, message });
      return;
    }

    const previous = timeline[timeline.length - 1];
    if (previous?.role === "assistant") {
      previous.messages.push(message);
    } else {
      timeline.push({ role: "assistant", key, messages: [message] });
    }
  });
  return timeline;
}

function UserMessageBubble({ msg }: { msg: OCMessage }) {
  const text = msg.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return (
    <View className="ml-12 items-end">
      <View className="rounded-2xl rounded-br-md bg-zinc-900 px-3.5 py-2.5">
        <Text className="text-sm leading-5 text-white">{text}</Text>
      </View>
    </View>
  );
}

function isActivityPart(part: OCPart) {
  return part.type === "reasoning" || part.type === "tool";
}

function AssistantTurn({ messages }: { messages: OCMessage[] }) {
  const activity = messages.flatMap((message) => message.parts.filter(isActivityPart));
  const texts = messages.flatMap((message) => message.parts.filter((part) => part.type === "text" && part.text?.trim()));
  const live = !messages[messages.length - 1]?.info.time?.completed;
  return (
    <View className="mr-8 gap-2">
      {activity.length ? <ActivityGroup parts={activity} live={live} /> : null}
      {texts.map((p, i) => (
        <PartView key={p.id || `t${i}`} part={p} />
      ))}
    </View>
  );
}

const RUNNING_STATUSES = ["running", "pending"];

// While a turn is running there is nothing worth reporting yet — the tool
// titles arrive after the fact — so the line says only that work is happening,
// in a word that changes as it goes. Same idea as Claude Code's own ticker.
const WHIMSY = [
  "Tinkering",
  "Flibbergeting",
  "Pondering",
  "Noodling",
  "Percolating",
  "Rummaging",
  "Wrangling",
  "Finagling",
  "Whittling",
  "Marinating",
  "Cogitating",
  "Puttering",
  "Simmering",
  "Spelunking",
  "Untangling",
  "Mulling",
];

function useWhimsyWord(active: boolean): string {
  // starts somewhere random so two turns in a row don't open on the same word
  const [i, setI] = useState(() => Math.floor(Math.random() * WHIMSY.length));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((n) => n + 1), 2400);
    return () => clearInterval(t);
  }, [active]);
  return WHIMSY[i % WHIMSY.length];
}

// Bare text, no card. Running: one shimmering word. Finished: a quiet step
// count that expands into the actual steps.
function ActivityGroup({ parts, live }: { parts: OCPart[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const busy = live || parts.some((p) => p.type === "tool" && RUNNING_STATUSES.includes(p.state?.status || ""));
  const failedCount = parts.filter((p) => p.type === "tool" && ["failed", "error"].includes(p.state?.status || "")).length;
  const steps = parts.length;
  const word = useWhimsyWord(busy);

  return (
    <View className="gap-1.5">
      <Pressable onPress={() => setOpen(!open)} hitSlop={8} className="flex-row items-center gap-1.5 self-start py-0.5">
        {busy ? (
          <Shimmer>
            <Text className="text-[13px] text-zinc-500">{word}…</Text>
          </Shimmer>
        ) : (
          <Text className={`text-[12px] ${failedCount ? "text-red-500" : "text-zinc-400"}`} numberOfLines={1}>
            {failedCount ? `${steps} ${steps === 1 ? "step" : "steps"} · ${failedCount} failed` : `${steps} ${steps === 1 ? "step" : "steps"}`}
          </Text>
        )}
        <Chevron direction={open ? "up" : "down"} color="#d4d4d8" size={5} />
      </Pressable>

      {open ? (
        <View className="gap-1.5">
          {parts.map((p, i) => (
            <PartView key={p.id || i} part={p} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// Before the first part of a turn arrives there is nothing to collapse yet —
// same bare line, no count.
function WorkingShimmer() {
  const word = useWhimsyWord(true);
  return (
    <View className="self-start py-0.5">
      <Shimmer>
        <Text className="text-[13px] text-zinc-500">{word}…</Text>
      </Shimmer>
    </View>
  );
}

// text/reasoning/tool only — anything else opencode sends is silently
// skipped here too, matching the web renderer exactly (not an omission).
function PartView({ part }: { part: OCPart }) {
  const [open, setOpen] = useState(false);

  if (part.type === "text") {
    if (!part.text?.trim()) return null;
    return (
      <View className="rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-3.5 py-2.5">
        <Markdown style={markdownStyles}>{part.text}</Markdown>
      </View>
    );
  }

  if (part.type === "reasoning") {
    return (
      <View>
        <Pressable onPress={() => setOpen(!open)} hitSlop={6} className="flex-row items-center gap-1.5 self-start">
          <Text className="text-[11px] uppercase text-zinc-400">{open ? "Thinking" : "Thought"}</Text>
          <Chevron direction={open ? "up" : "down"} color="#d4d4d8" size={5} />
        </Pressable>
        {/* a rule instead of a filled block: reading the text matters, framing
            it does not */}
        {open && part.text ? (
          <Text className="mt-1 border-l border-zinc-200 pl-2.5 text-xs leading-5 text-zinc-500">{part.text}</Text>
        ) : null}
      </View>
    );
  }

  if (part.type === "tool") {
    const status = part.state?.status;
    let detail = "";
    for (const k of TOOL_DETAIL_KEYS) {
      const v = part.state?.input?.[k];
      if (typeof v === "string") {
        detail = v.slice(0, 90);
        break;
      }
    }
    const mark = RUNNING_STATUSES.includes(status || "")
      ? "running"
      : ["failed", "error"].includes(status || "")
        ? "failed"
        : "done";
    const failed = mark === "failed";
    const hasOutput = Boolean(part.state?.output);
    return (
      <View>
        <Pressable
          onPress={() => (hasOutput ? setOpen(!open) : undefined)}
          hitSlop={6}
          className="flex-row items-center gap-2 self-start"
        >
          <StepMark status={mark} />
          <Text className={`text-xs ${failed ? "text-red-500" : "text-zinc-600"}`} numberOfLines={1}>
            {part.state?.title || part.tool}
          </Text>
          {hasOutput ? <Chevron direction={open ? "up" : "down"} color="#d4d4d8" size={5} /> : null}
        </Pressable>
        {/* the argument that says WHICH file/command this step touched — a path
            or a shell line, so it reads in mono */}
        {detail ? (
          <Text
            style={{ fontFamily: MONO_FONT }}
            className="mt-0.5 pl-[22px] text-[10px] text-zinc-400"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {detail}
          </Text>
        ) : null}
        {open && part.state?.output ? (
          <Text
            style={{ fontFamily: MONO_FONT }}
            className="ml-[22px] mt-1 border-l border-zinc-200 pl-2.5 text-[10px] leading-4 text-zinc-400"
            numberOfLines={20}
          >
            {part.state.output.slice(0, 4000)}
          </Text>
        ) : null}
      </View>
    );
  }

  return null;
}
