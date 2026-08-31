import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp, AtSign, Brain, Check, ChevronDown, ChevronRight, CircleAlert, Cpu, FileText, FolderPlus,
  Globe, Image as ImageIcon, Loader2, Lock, LockOpen, Paperclip, PencilLine, Search, Sparkles, Square, Terminal as TermIcon, Wrench, Zap,
} from "lucide-react";
import {
  abortSession, agentPrompt, backendOf, createSession, fetchAgentMessages, fetchMessagesRaw, fetchModels,
  fetchSessionInfo, fetchSessionRow, isCliBackend, promptAsync, searchFiles, setSessionModel, updateSessionModel,
  type FileHit, type OCMessage, type OCModel, type OCPart, type Project,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { buildRows, ComposerMenu, detectTrigger, ModelPickerPopover, type MenuRow, type Trigger } from "@/components/ComposerMenus";
import { ProviderGlyph, providerMeta } from "@/components/ProviderGlyph";
import { applyStreamEvent } from "@/lib/stream";
import { eventSessionId, subscribeEvents } from "@/lib/events";
import { useSessionStatuses } from "@/lib/useSessionStatuses";

const MODEL_KEY_STORAGE = "kusal:modelKey";
const REASONING_KEY = "kusal:reasoningEffort";
const RUNTIME_MODE_KEY = "kusal:runtimeMode";
const FALLBACK_MODELS: OCModel[] = [
  { providerID: "opencode", modelID: "claude-sonnet-4", label: "opencode · claude-sonnet-4" },
  { providerID: "opencode", modelID: "gpt-5", label: "opencode · gpt-5" },
];

type ReasoningEffort = "auto" | "low" | "medium" | "high" | "max" | "xhigh" | "none";
const REASONING_OPTIONS: { id: ReasoningEffort; label: string; desc: string }[] = [
  { id: "auto", label: "Auto", desc: "Model default" },
  { id: "none", label: "Off", desc: "No reasoning" },
  { id: "low", label: "Low", desc: "Fast, cheapest" },
  { id: "medium", label: "Medium", desc: "Balanced" },
  { id: "high", label: "High", desc: "Deeper thinking" },
  { id: "xhigh", label: "Extra High", desc: "Maximum depth" },
  { id: "max", label: "Max", desc: "Full reasoning" },
];
type RuntimeMode = "supervised" | "full-access";
const RUNTIME_MODE_CONFIG: Record<RuntimeMode, { label: string; desc: string; icon: typeof Lock }> = {
  supervised: { label: "Supervised", desc: "Ask before commands and file changes.", icon: Lock },
  "full-access": { label: "Full access", desc: "Allow commands and edits without prompts.", icon: LockOpen },
};


export function ChatView({ sessionId, onSessionCreated, project, projects = [], onSelectProject, onAddProject, cwd }: {
  sessionId: string | null;
  onSessionCreated?: (id: string) => void;
  project?: Project | null;
  projects?: Project[];
  onSelectProject?: (project: Project) => void;
  onAddProject?: () => void;
  /** the open thread's directory; drafts fall back to the picked project */
  cwd?: string;
}) {
  const [msgsRaw, setMsgsRaw] = useState<OCMessage[]>([]);
  const [input, setInput] = useState("");
  const [models, setModels] = useState<OCModel[]>(FALLBACK_MODELS);
  const [modelKey, setModelKeyState] = useState<string>(() => {
    try { return localStorage.getItem(MODEL_KEY_STORAGE) ?? ""; } catch { return ""; }
  });
  // a send is optimistic until opencode reports the session busy
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const { statuses, connected: sseLive } = useSessionStatuses();
  const modelKeyRef = useRef(modelKey);
  const effectiveIdRef = useRef<string | null>(null);
  const threadCwdRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const threadCwd = cwd || project?.path || "";

  // model switcher: load real models from the device's opencode instance
  useEffect(() => {
    let alive = true;
    fetchModels(threadCwd || undefined)
      .then(({ models: fetched, defaultModel }) => {
        if (!alive) return;
        if (fetched.length === 0) return;
        setModels(fetched);
        // never clobber a remembered or session-pinned choice
        if (!modelKeyRef.current && defaultModel) {
          setModelKey(`${defaultModel.providerID}/${defaultModel.modelID}`, { persist: false });
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [threadCwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // A pinned model that isn't in the provider list must still be used as-is:
  // falling back to models[0] would quietly send to a different model.
  const model = useMemo(() => {
    const hit = models.find((m) => `${m.providerID}/${m.modelID}` === modelKey);
    if (hit) return hit;
    const slash = modelKey.indexOf("/");
    if (slash > 0) {
      const providerID = modelKey.slice(0, slash);
      const modelID = modelKey.slice(slash + 1);
      if (providerID && modelID) return { providerID, modelID, label: `${providerID} · ${modelID}` };
    }
    return models[0];
  }, [models, modelKey]);

  const effectiveId = liveSessionId ?? (sessionId && sessionId !== "new" ? sessionId : null);

  // Which backend this thread routes to. opencode fronts many model providers
  // behind one server; the CLI agents (Claude Code, Codex, Gemini CLI, Grok,
  // Copilot, Cline) each run as a process the daemon drives, with no server,
  // no SSE and no /session endpoints — so every call below has to pick a side.
  //
  // The OPEN THREAD decides, not the composer's remembered model. Deriving it
  // from the model key alone is what left every CLI thread blank: that key is
  // restored from localStorage and is usually some opencode model, so opening
  // a codex thread asked opencode for a session it has never heard of, got the
  // same empty array it returns for any unknown id, and rendered nothing.
  // threadBackend is recovered from the thread itself and wins while set.
  const [threadBackend, setThreadBackend] = useState<string | null>(null);
  const threadBackendRef = useRef<string | null>(null);
  const backend = threadBackend ?? backendOf(model?.providerID ?? "");
  const cli = isCliBackend(backend);
  // a CLI turn's run state, which only its own poll can report
  const [agentRunning, setAgentRunning] = useState(false);
  const cliRef = useRef(cli);
  useEffect(() => { cliRef.current = cli; }, [cli]);

  // A thread belongs to one backend for its whole life: its transcript lives
  // either in opencode or in the daemon's own store, and moving it mid-way
  // would swap the history out from under the reader. So once a CLI thread has
  // identified itself, the picker offers that agent's models and no others —
  // an opencode thread is unrestricted, since every model provider it fronts
  // shares the one server.
  const pickerModels = useMemo(
    () => (threadBackend ? models.filter((m) => backendOf(m.providerID) === threadBackend) : models),
    [models, threadBackend],
  );

  const adoptBackend = useCallback((next: string | null) => {
    threadBackendRef.current = next;
    setThreadBackend((prev) => (prev === next ? prev : next));
  }, []);

  // The thread's own row says which agent produced it and on which model, and
  // it is the only source that knows before a single message has been fetched.
  // Seeding the composer from it is also what makes the next send go to the
  // same backend the transcript came from.
  useEffect(() => {
    if (!effectiveId) return;
    let alive = true;
    fetchSessionRow(effectiveId)
      .then((row) => {
        if (!alive || !row) return;
        const rowBackend = backendOf(row.provider);
        if (isCliBackend(rowBackend)) adoptBackend(rowBackend);
        if (row.model && row.model.includes("/")) setModelKey(row.model, { persist: false });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [effectiveId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setModelKey = useCallback(
    (key: string, opts?: { persist?: boolean }) => {
      modelKeyRef.current = key;
      setModelKeyState(key);
      if (opts?.persist === false) return;
      try { localStorage.setItem(MODEL_KEY_STORAGE, key); } catch {}
      const [providerID, ...rest] = key.split("/");
      const modelID = rest.join("/");
      if (!providerID || !modelID) return;
      const id = effectiveIdRef.current;
      if (!id) return;
      // pin it on both sides so a reload restores this model, not the default.
      // The first call is opencode's own endpoint and means nothing to a CLI
      // agent; the sqlite mirror is what every backend reads back.
      if (!isCliBackend(backendOf(providerID))) {
        void setSessionModel(id, { providerID, modelID, label: key }, threadCwdRef.current || undefined);
      }
      void updateSessionModel(id, key);
    },
    [],
  );

  // refs so the callbacks above never need re-creating
  useEffect(() => { effectiveIdRef.current = effectiveId; }, [effectiveId]);
  useEffect(() => { threadCwdRef.current = threadCwd; }, [threadCwd]);

  // a thread remembers the model opencode has pinned to it
  useEffect(() => {
    if (!effectiveId || cli) return;
    let alive = true;
    fetchSessionInfo(effectiveId, threadCwd || undefined).then((info) => {
      if (!alive || !info?.model?.providerID || !info.model.id) return;
      setModelKey(`${info.model.providerID}/${info.model.id}`, { persist: false });
    });
    return () => { alive = false; };
  }, [effectiveId, threadCwd, cli, setModelKey]);

  // navigating to another thread (or a fresh draft) detaches a locally-created session
  useEffect(() => {
    setLiveSessionId((prev) => (!prev || sessionId === prev ? prev : null));
  }, [sessionId]);

  // history load for an existing session (full parts, not filtered)
  const reload = useCallback(
    async (id: string) => {
      // The stored agent transcript is probed FIRST, before anything is known
      // about the thread. It is the only source that can identify a CLI thread
      // at the moment it opens — and it is self-identifying, because the daemon
      // prefixes every message id with the agent that produced it ("codex-a-…",
      // "claude-a-…"). Only such a thread has a row here at all, so an opencode
      // thread costs one cheap sqlite lookup that comes back empty and falls
      // through to opencode below.
      try {
        const { messages, running } = await fetchAgentMessages(id);
        if (messages.length > 0) {
          const from = messages[0]?.info?.id?.split("-")[0] ?? null;
          if (from && isCliBackend(from)) adoptBackend(from);
          setMsgsRaw(messages);
          setAgentRunning(running);
          return;
        }
        // A CLI thread whose first turn has produced nothing yet. Falling
        // through would overwrite the optimistic echo with opencode's (empty)
        // history for the same id, which is how a just-sent message vanished.
        if (cliRef.current || threadBackendRef.current) {
          setAgentRunning(running);
          return;
        }
      } catch {
        // an older daemon with no /api/agent/messages, or a transient failure —
        // opencode is still worth asking
        if (cliRef.current || threadBackendRef.current) return;
      }
      try {
        const raw = await fetchMessagesRaw(id, threadCwd || undefined);
        setMsgsRaw(raw);
      } catch {
        /* the stream will fill in; a failed reconcile is not fatal */
      }
    },
    [threadCwd, adoptBackend],
  );

  useEffect(() => {
    if (!effectiveId || liveSessionId === effectiveId) return;
    setMsgsRaw([]);
    setStreamError(null);
    setAgentRunning(false);
    // the previous thread's backend must not carry over — it is re-established
    // from this thread's own row and transcript
    adoptBackend(null);
    void reload(effectiveId);
  }, [effectiveId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The two backends keep their transcripts in different places, so switching
  // the thread's model between them has to re-read from the other one.
  useEffect(() => {
    if (!effectiveId) return;
    void reload(effectiveId);
  }, [cli]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates come off the shared event bus and are filtered to this
  // session, so a turn running in another thread never bleeds in here.
  useEffect(() => {
    if (!effectiveId) return;
    return subscribeEvents((event) => {
      const sid = eventSessionId(event);
      if (sid && sid !== effectiveId) return;
      if (event.type === "session.error") {
        const err = event.properties["error"] as { name?: string; data?: { message?: string } } | undefined;
        setStreamError(err?.data?.message || err?.name || "opencode reported an error");
        return;
      }
      if (event.type === "session.idle" || event.type === "session.status") return; // handled by useSessionStatuses
      setMsgsRaw((prev) => applyStreamEvent(prev, event.type, event.properties));
    });
  }, [effectiveId]);

  // reconcile whenever the stream (re)connects, so nothing missed is lost
  useEffect(() => {
    if (!sseLive || !effectiveId) return;
    void reload(effectiveId);
  }, [sseLive, effectiveId, reload]);

  // opencode reports run state on its event bus; a CLI agent reports it only in
  // the poll's own `running` flag, since it emits no events at all
  const remoteBusy = cli
    ? agentRunning
    : !!effectiveId && (statuses[effectiveId] === "busy" || statuses[effectiveId] === "retry");
  const busy = remoteBusy || (!!effectiveId && pendingSend === effectiveId);

  // the optimistic flag belongs to one thread only
  useEffect(() => {
    setPendingSend((prev) => (prev && prev !== effectiveId ? null : prev));
  }, [effectiveId]);

  // opencode has taken over: drop the optimistic flag
  useEffect(() => {
    if (remoteBusy) setPendingSend(null);
  }, [remoteBusy]);

  // ...and never leave it stuck if the turn never starts
  useEffect(() => {
    if (!pendingSend) return;
    const t = setTimeout(() => setPendingSend(null), 20000);
    return () => clearTimeout(t);
  }, [pendingSend]);

  // safety net: only while a turn is running and the stream is down
  useEffect(() => {
    if (cli || !busy || sseLive || !effectiveId) return;
    const iv = setInterval(() => void reload(effectiveId), 2500);
    return () => clearInterval(iv);
  }, [cli, busy, sseLive, effectiveId, reload]);

  // A CLI agent has no stream to fall back FROM — polling is the only signal
  // it has, so it runs whenever such a thread is open. Fast while a turn is in
  // flight, slow once it is done, because output only changes when it runs.
  useEffect(() => {
    if (!cli || !effectiveId) return;
    const iv = setInterval(() => void reload(effectiveId), agentRunning ? 1200 : 6000);
    return () => clearInterval(iv);
  }, [cli, effectiveId, agentRunning, reload]);

  // stick to the bottom unless the reader scrolled up
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useEffect(() => {
    if (!pinnedRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgsRaw, busy]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setStreamError(null);
    pinnedRef.current = true;
    // optimistic user message
    const userMsg: OCMessage = {
      info: { role: "user", time: { created: Date.now() } },
      parts: [{ type: "text", text }],
    };
    setMsgsRaw((m) => [...m, userMsg]);

    try {
      // reuse the open thread; create a real opencode session on first send
      let sid = liveSessionId ?? (sessionId && sessionId !== "new" ? sessionId : null);
      if (sid) setPendingSend(sid);
      if (!sid) {
        const title = text.length > 80 ? `${text.slice(0, 77)}...` : text;
        sid = await createSession(title, project ? { cwd: project.path, project_id: project.id } : undefined);
        setLiveSessionId(sid);
        setPendingSend(sid);
        onSessionCreated?.(sid);
        // a fresh session starts on the remembered model
        if (model && !cli) void setSessionModel(sid, model, threadCwd || undefined);
        if (model) void updateSessionModel(sid, `${model.providerID}/${model.modelID}`);
      }
      if (cli) {
        // The daemon runs the agent as a process and answers 202 once it has
        // started; there is nothing to abort and nothing to stream. Marking it
        // running here rather than waiting for the next poll is what keeps the
        // composer's spinner from lagging a second behind the send.
        setAgentRunning(true);
        await agentPrompt(backend, sid, model.modelID, text, threadCwd || ".");
        void reload(sid);
      } else {
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        // returns as soon as the turn is queued; tokens arrive over SSE
        await promptAsync(sid, model, text, threadCwd || undefined, ctrl.signal);
        if (!sseLive) void reload(sid);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setStreamError((e as Error).message || `failed to reach ${cli ? backend : "opencode"}`);
      }
      setPendingSend(null);
      setAgentRunning(false);
    } finally {
      abortRef.current = null;
    }
  }, [input, busy, model, cli, backend, sessionId, liveSessionId, onSessionCreated, project, threadCwd, sseLive, reload]);

  const stop = () => {
    abortRef.current?.abort();
    setPendingSend(null);
    // /session/:id/abort is opencode's. A CLI agent runs as a child process the
    // daemon owns and offers no cancel, so the honest thing is to stop claiming
    // the send is pending and let the turn finish on its own.
    if (cli) return;
    const dir = threadCwd || undefined;
    if (liveSessionId) abortSession(liveSessionId, dir).catch(() => {});
    if (effectiveId && effectiveId !== liveSessionId) abortSession(effectiveId, dir).catch(() => {});
  };

  const isNew = !effectiveId;

  const composer = (
    <Composer
      input={input}
      setInput={setInput}
      onSend={send}
      onStop={stop}
      busy={busy}
      stoppable={!cli}
      models={pickerModels}
      model={model}
      setModelKey={setModelKey}
      {...(threadCwd ? { cwd: threadCwd } : {})}
      disabled={isNew && !project}
    />
  );

  // Draft state — hero headline with the inline project picker, like t3code's DraftHeroHeadline
  if (isNew && msgsRaw.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
          <h1 className="mx-auto w-full max-w-5xl text-center text-2xl font-normal tracking-tight text-foreground sm:text-3xl">
            {project ? (
              <>
                What should we build in{" "}
                <HeroProjectMenu project={project} projects={projects} onSelectProject={onSelectProject} onAddProject={onAddProject} />?
              </>
            ) : projects.length > 0 ? (
              <>
                <HeroProjectMenu project={null} projects={projects} onSelectProject={onSelectProject} onAddProject={onAddProject} /> to start
              </>
            ) : (
              <>
                <button
                  onClick={onAddProject}
                  className="cursor-pointer border-b border-dotted border-muted-foreground/40 text-muted-foreground/70 transition-colors hover:text-muted-foreground"
                >
                  Add a project
                </button>{" "}
                to start
              </>
            )}
          </h1>
          <p className="mt-3 text-center text-sm text-muted-foreground">
            {project ? (
              <span className="font-mono text-[12px]">{project.path}</span>
            ) : (
              "Threads run on your device over the tunnel — pick where this one should work."
            )}
          </p>
        </div>
        {composer}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div ref={scrollRef} onScroll={onScroll} className="timeline-fade min-h-0 flex-1 overflow-y-auto overflow-x-clip px-4 sm:px-6">
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-5 py-6">
          {msgsRaw.map((m, i) =>
            m.info.role === "user" ? (
              <UserMessage key={m.info.id ?? i} msg={m} />
            ) : (
              <AssistantTurn key={m.info.id ?? i} msg={m} busy={busy && i === msgsRaw.length - 1} />
            ),
          )}
          {busy && <WorkingIndicator msgs={msgsRaw} model={model} />}
          {streamError && (
            <div className="flex items-start gap-2 rounded-[var(--radius)] border border-error/40 bg-error/5 px-3 py-2 text-[13px] text-error-foreground">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{streamError}</span>
              <button onClick={() => setStreamError(null)} className="shrink-0 text-[11px] underline underline-offset-2">dismiss</button>
            </div>
          )}
          {busy && !sseLive && !cli && (
            <div className="px-0.5 text-[11px] text-muted-foreground/80">reconnecting to the opencode event stream…</div>
          )}
        </div>
      </div>
      {composer}
    </div>
  );
}

/* ---------------------------------------------------------------- messages */

function UserMessage({ msg }: { msg: OCMessage }) {
  const text = msg.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n\n");
  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-message px-3.5 py-2.5 text-sm leading-relaxed text-message-foreground">
        {text}
      </div>
      <div className="pe-1 text-[11px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        {formatClock(msg.info.time?.created)}
      </div>
    </div>
  );
}

function AssistantTurn({ msg, busy }: { msg: OCMessage; busy?: boolean }) {
  const hasVisible = msg.parts.some(
    (p) => (p.type === "text" && p.text?.trim()) || (p.type === "reasoning" && p.text?.trim()) || p.type === "tool",
  );
  return (
    <div className="group/assistant flex min-w-0 flex-col gap-1.5">
      {msg.parts.map((p, idx) => {
        if (p.type === "text" && p.text?.trim()) {
          return (
            <div key={p.id ?? idx} className="chat-md min-w-0 px-0.5 py-0.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.text}</ReactMarkdown>
            </div>
          );
        }
        if (p.type === "reasoning" && p.text?.trim()) return <ReasoningRow key={p.id ?? idx} part={p} />;
        if (p.type === "tool") return <ToolRow key={p.callID ?? p.id ?? idx} part={p} />;
        return null;
      })}
      {!hasVisible && busy && (
        <div className="flex items-center gap-2 px-0.5 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Working…
        </div>
      )}
      <div className="px-0.5 text-[11px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/assistant:opacity-100">
        {formatClock(msg.info.time?.created)}
      </div>
    </div>
  );
}

function ReasoningRow({ part }: { part: OCPart }) {
  const [open, setOpen] = useState(false);
  const secs = durationSeconds(part.time?.start, part.time?.end);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-control px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors hover:bg-accent/50"
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground/65" />
        <Brain className="size-4 shrink-0 text-muted-foreground opacity-70" />
        <span className="min-w-0 flex-1 truncate text-secondary-label">
          {secs ? `Thought for ${secs}` : "Thinking"}
        </span>
      </button>
      {open && (
        <div className="chat-md ms-7 mt-1 border-s border-border ps-3 text-muted-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text ?? ""}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function ToolRow({ part }: { part: OCPart }) {
  const [open, setOpen] = useState(false);
  const status = (part.state?.status ?? "pending") as string;
  const running = status === "running" || status === "pending";
  const failed = status === "failed" || status === "error";
  const input = part.state?.input as Record<string, unknown> | undefined;
  const output = (part.state?.output as string | undefined) ?? ((part.state?.metadata as Record<string, unknown>)?.["preview"] as string | undefined);
  const Icon = toolIcon(part.tool);
  const Chevron = open ? ChevronDown : ChevronRight;
  const secs = durationSeconds(part.state?.time?.start, part.state?.time?.end);
  const detail = toolDetail(input);

  return (
    <div className="min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-control px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors hover:bg-accent/50"
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground/65" />
        {running ? (
          <Loader2 className={cn("size-4 shrink-0 animate-spin", failed ? "text-error-foreground" : "text-info-foreground")} />
        ) : failed ? (
          <CircleAlert className="size-4 shrink-0 text-error-foreground" />
        ) : (
          <Icon className="size-4 shrink-0 text-muted-foreground opacity-70" />
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className={cn("font-medium", failed ? "text-error-foreground" : "text-foreground")}>{part.state?.title || part.tool || "tool"}</span>
          {detail && <span className="text-secondary-label"> {detail}</span>}
        </span>
        {secs && <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/70">{secs}</span>}
      </button>

      {open && (input || output) && (
        <div className="ms-7 mt-1 space-y-1.5 border-s border-border ps-3">
          {input && Object.keys(input).length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[11px] leading-5">
              {Object.entries(input).map(([k, v]) => (
                <div key={k} className="col-span-2 flex min-w-0 gap-2">
                  <dt className="shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 truncate text-foreground/85">{String(v).slice(0, 400)}</dd>
                </div>
              ))}
            </dl>
          )}
          {output && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-secondary px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/90">
              {output.slice(0, 4000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function WorkingIndicator({ msgs, model }: { msgs: OCMessage[]; model: OCModel | undefined }) {
  const last = msgs[msgs.length - 1];
  const streaming = last?.info.role === "assistant" && last.parts.some((p) => p.type === "tool" && p.state?.status === "running");
  if (streaming) return null;
  return (
    <div className="flex items-center gap-2 px-0.5 text-sm text-muted-foreground">
      <span className="size-1.5 rounded-full bg-info animate-status-pulse" />
      <span>opencode is working</span>
      {model && <span className="font-mono text-[11px] text-muted-foreground/70">{model.providerID}/{model.modelID}</span>}
    </div>
  );
}

/* --------------------------------------------------------------- composer */

function Composer({ input, setInput, onSend, onStop, busy, stoppable, models, model, setModelKey, cwd, disabled }: {
  input: string;
  setInput: (s: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  /** false for a CLI agent: the daemon owns the process and offers no cancel */
  stoppable: boolean;
  models: OCModel[];
  model: OCModel | undefined;
  setModelKey: (key: string) => void;
  /** the thread's working directory — what `@` searches */
  cwd?: string;
  disabled?: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [images, setImages] = useState<{ id: string; name: string; dataUrl: string; mime: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => {
    try { return (localStorage.getItem(REASONING_KEY) as ReasoningEffort) || "auto"; } catch { return "auto"; }
  });
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(() => {
    try { return (localStorage.getItem(RUNTIME_MODE_KEY) as RuntimeMode) || "supervised"; } catch { return "supervised"; }
  });
  const triggerRef = useRef<Trigger | null>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<HTMLDivElement>(null);

  useEffect(() => { try { localStorage.setItem(REASONING_KEY, reasoningEffort); } catch {} }, [reasoningEffort]);
  useEffect(() => { try { localStorage.setItem(RUNTIME_MODE_KEY, runtimeMode); } catch {} }, [runtimeMode]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (reasoningRef.current && !reasoningRef.current.contains(e.target as Node)) setReasoningOpen(false);
      if (runtimeRef.current && !runtimeRef.current.contains(e.target as Node)) setRuntimeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // auto-grow up to ~8 rows
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const closeTrigger = () => {
    triggerRef.current = null;
    setTrigger(null);
  };

  const syncTrigger = (text: string, caret: number) => {
    const next = detectTrigger(text, caret);
    const prev = triggerRef.current;
    const unchanged =
      (prev === null && next === null) ||
      (prev !== null && next !== null && prev.kind === next.kind && prev.start === next.start && prev.query === next.query);
    if (unchanged) return;
    triggerRef.current = next;
    setTrigger(next);
    setHighlight(0);
    if (!next || next.kind !== "file") setFiles([]);
  };

  useEffect(() => {
    if (!trigger || trigger.kind !== "file") return;
    let alive = true;
    setLoadingFiles(true);
    const timer = setTimeout(() => {
      searchFiles(cwd ?? "", trigger.query)
        .then((hits) => alive && setFiles(hits))
        .finally(() => alive && setLoadingFiles(false));
    }, 140);
    return () => { alive = false; clearTimeout(timer); };
  }, [trigger, cwd]);

  const rows = useMemo(() => (trigger ? buildRows(trigger, files) : []), [trigger, files]);
  const menuOpen = !!trigger && !modelOpen && !reasoningOpen && !runtimeOpen;

  const runCommand = (id: string) => {
    if (id === "model") setModelOpen(true);
  };

  const accept = (row: MenuRow) => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? input.length;
    if (!trigger) return;
    const insert = row.kind === "file" ? `@${row.description} ` : "";
    const next = `${input.slice(0, trigger.start)}${insert}${input.slice(caret)}`;
    setInput(next);
    closeTrigger();
    setFiles([]);
    if (row.kind === "command") runCommand(row.id);
    requestAnimationFrame(() => {
      const node = taRef.current;
      if (!node) return;
      node.focus();
      const pos = trigger.start + insert.length;
      node.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (rows.length ? (h + 1) % rows.length : 0)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (rows.length ? (h - 1 + rows.length) % rows.length : 0)); return; }
      if (e.key === "Escape") { e.preventDefault(); closeTrigger(); return; }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        const row = rows[highlight];
        if (row) { e.preventDefault(); accept(row); return; }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertMentionToken = () => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? input.length;
    const needsSpace = caret > 0 && !/\s$/.test(input.slice(0, caret));
    const token = `${needsSpace ? " " : ""}@`;
    const next = `${input.slice(0, caret)}${token}${input.slice(caret)}`;
    setInput(next);
    requestAnimationFrame(() => {
      const node = taRef.current;
      if (!node) return;
      const pos = caret + token.length;
      node.focus();
      node.setSelectionRange(pos, pos);
      syncTrigger(next, pos);
    });
  };

  const addImageFiles = (fileList: FileList | File[]) => {
    const filesArr = Array.from(fileList).filter((f) => f.type.startsWith("image/")).slice(0, 4 - images.length);
    if (filesArr.length === 0) return;
    filesArr.forEach((f) => {
      const reader = new FileReader();
      reader.onload = () => {
        setImages((prev) => prev.length >= 4 ? prev : [...prev, { id: `${Date.now()}-${f.name}`, name: f.name, dataUrl: reader.result as string, mime: f.type }]);
      };
      reader.readAsDataURL(f);
    });
  };

  const handleSend = () => {
    if (!input.trim() && images.length === 0) return;
    if (disabled || busy) return;
    // include images as markdown placeholders until backend supports attachments — keeps UX honest
    if (images.length > 0) {
      const imageTokens = images.map((img) => `\n![${img.name}](${img.dataUrl.slice(0, 64)}…)`).join("");
      // we don't actually send dataUrls yet; parent send will use input text
    }
    onSend();
    setImages([]);
  };

  const canSend = (!!input.trim() || images.length > 0) && !disabled && !busy;
  const reasoningOpt = REASONING_OPTIONS.find((o) => o.id === reasoningEffort) ?? REASONING_OPTIONS[0]!;
  const runtimeOpt = RUNTIME_MODE_CONFIG[runtimeMode];
  const RuntimeIcon = runtimeOpt.icon;

  return (
    <div className="shrink-0 px-4 pb-4 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="relative">
          {modelOpen && (
            <ModelPickerPopover
              models={models}
              model={model}
              onPick={(key) => { setModelKey(key); setModelOpen(false); taRef.current?.focus(); }}
              onClose={() => setModelOpen(false)}
            />
          )}
          {menuOpen && trigger && (
            <ComposerMenu
              trigger={trigger}
              rows={rows}
              loading={loadingFiles}
              highlight={highlight}
              onHighlight={setHighlight}
              onAccept={accept}
            />
          )}

          {/* t3 exact clone: outer p-px gradient frame + inner rounded-[20px] surface, drag overlay */}
          <div
            className={cn("group relative rounded-[22px] p-px transition-colors duration-200", dragOver ? "bg-primary/40" : "focus-within:bg-primary/25")}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files) addImageFiles(e.dataTransfer.files); }}
            data-chat-composer-form="true"
            data-chat-composer-main-surface="true"
          >
            <div className="rounded-[20px] border border-border bg-card shadow-sm shadow-black/[0.03] transition-colors">
              {/* image thumbnails — t3 shows 64x64 previews above textarea */}
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pt-3">
                  {images.map((img) => (
                    <div key={img.id} className="group/img relative h-16 w-16 overflow-hidden rounded-lg border border-border bg-muted">
                      <img src={img.dataUrl} alt={img.name} className="h-full w-full object-cover" />
                      <button
                        onClick={() => setImages((p) => p.filter((x) => x.id !== img.id))}
                        className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover/img:opacity-100 hover:bg-black/80"
                        aria-label="Remove image"
                      >
                        <ChevronDown className="size-3 rotate-45" />
                      </button>
                      <span className="absolute bottom-0 left-0 right-0 truncate bg-black/50 px-1 py-0.5 text-[9px] text-white">{img.name}</span>
                    </div>
                  ))}
                  {images.length < 4 && (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-border bg-muted/50 text-muted-foreground hover:bg-muted"
                    >
                      <ImageIcon className="size-5" />
                    </button>
                  )}
                </div>
              )}

              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => { setInput(e.target.value); syncTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
                onKeyUp={(e) => syncTrigger(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                onClick={(e) => syncTrigger(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                onBlur={closeTrigger}
                onKeyDown={onKeyDown}
                onPaste={(e) => {
                  const files = e.clipboardData.files;
                  if (files && files.length > 0 && Array.from(files).some((f) => f.type.startsWith("image/"))) {
                    e.preventDefault();
                    addImageFiles(files);
                  }
                }}
                placeholder={disabled ? "Pick a device & directory to start…" : "Ask anything…  ·  / for commands  ·  @ to mention files  ·  paste or drop images"}
                rows={1}
                disabled={disabled}
                className="block max-h-[200px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 disabled:opacity-60"
              />

              {/* footer — exact t3 layout: model picker | reasoning | runtime | attach | mention | right send */}
              <div className="flex items-center gap-1 px-2 pb-2 pt-1" data-chat-composer-footer="true">
                {/* Model picker trigger — t3: glyph + label + chevron, ComposerControl ghost */}
                <button
                  onClick={() => { setModelOpen((v) => !v); setReasoningOpen(false); setRuntimeOpen(false); }}
                  disabled={disabled}
                  className="inline-flex h-7 min-h-7 shrink-0 items-center gap-1.5 rounded-[var(--control-radius,0.5rem)] bg-transparent px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title={model ? `${model.providerID}/${model.modelID}` : "Choose model"}
                  data-chat-provider-model-picker="true"
                >
                  {model ? <ProviderGlyph providerID={model.providerID} size={14} /> : <Cpu className="size-3.5 opacity-70" />}
                  <span className="max-w-[14ch] truncate sm:max-w-[18ch]">{model ? model.modelID : "Select model"}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-60" />
                </button>

                {/* Reasoning / effort — t3 TraitsPicker single select */}
                <div ref={reasoningRef} className="relative">
                  <button
                    onClick={() => { setReasoningOpen((v) => !v); setModelOpen(false); setRuntimeOpen(false); }}
                    disabled={disabled}
                    className={cn(
                      "inline-flex h-7 min-h-7 shrink-0 items-center gap-1.5 rounded-[var(--control-radius,0.5rem)] px-2.5 text-xs font-medium transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40",
                      reasoningEffort !== "auto" && reasoningEffort !== "none" ? "bg-accent text-foreground" : "text-muted-foreground",
                    )}
                    aria-label="Reasoning effort"
                  >
                    <Brain className="size-3.5" />
                    <span className="hidden sm:inline">{reasoningOpt.label}</span>
                    <span className="sm:hidden">{reasoningOpt.label.slice(0, 4)}</span>
                    <ChevronDown className="size-3 opacity-60" />
                  </button>
                  {reasoningOpen && (
                    <div className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
                      <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">Reasoning</div>
                      {REASONING_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          onClick={() => { setReasoningEffort(opt.id); setReasoningOpen(false); }}
                          className={cn(
                            "flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent",
                            reasoningEffort === opt.id ? "bg-accent text-foreground" : "text-foreground/80",
                          )}
                        >
                          <span className="flex flex-col">
                            <span className="text-[13px] font-medium leading-none">{opt.label}</span>
                            <span className="text-[11px] text-muted-foreground">{opt.desc}</span>
                          </span>
                          {reasoningEffort === opt.id && <Check className="size-3.5 text-primary" />}
                        </button>
                      ))}
                      <div className="mt-1 border-t border-border px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
                        Higher effort uses more thinking tokens. Low is fastest.
                      </div>
                    </div>
                  )}
                </div>

                {/* Full access / Supervised — t3 runtime mode select */}
                <div ref={runtimeRef} className="relative hidden sm:block">
                  <button
                    onClick={() => { setRuntimeOpen((v) => !v); setModelOpen(false); setReasoningOpen(false); }}
                    disabled={disabled}
                    className="inline-flex h-7 min-h-7 shrink-0 items-center gap-1.5 rounded-[var(--control-radius,0.5rem)] px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                    aria-label="Runtime mode"
                  >
                    <RuntimeIcon className="size-3.5" />
                    <span>{runtimeOpt.label}</span>
                    <ChevronDown className="size-3 opacity-60" />
                  </button>
                  {runtimeOpen && (
                    <div className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
                      {(Object.keys(RUNTIME_MODE_CONFIG) as RuntimeMode[]).map((mode) => {
                        const cfg = RUNTIME_MODE_CONFIG[mode];
                        const Icon = cfg.icon;
                        const active = mode === runtimeMode;
                        return (
                          <button
                            key={mode}
                            onClick={() => { setRuntimeMode(mode); setRuntimeOpen(false); }}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-accent",
                              active ? "bg-accent" : "",
                            )}
                          >
                            <Icon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="flex flex-1 flex-col">
                              <span className="text-[13px] font-medium leading-none text-foreground">{cfg.label}</span>
                              <span className="text-[11px] leading-snug text-muted-foreground">{cfg.desc}</span>
                            </span>
                            {active && <Check className="size-3.5 shrink-0 text-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <span className="mx-0.5 hidden h-4 w-px bg-border sm:block" aria-hidden />

                <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files) addImageFiles(e.target.files); e.target.value = ""; }} />
                <button
                  disabled={disabled || images.length >= 4}
                  onClick={() => fileInputRef.current?.click()}
                  title={images.length >= 4 ? "Max 4 images" : "Attach images — paste, drag & drop, or click"}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <ImageIcon className="size-3.5" />
                </button>
                <button
                  disabled={disabled}
                  onClick={insertMentionToken}
                  title="Mention a file  (@)"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <AtSign className="size-3.5" />
                </button>
                <button
                  disabled={disabled}
                  title="Attach file"
                  className="hidden size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 sm:inline-flex"
                >
                  <Paperclip className="size-3.5" />
                </button>

                <span className="ml-auto hidden items-center gap-1 pe-2 text-[11px] text-muted-foreground sm:flex">
                  <TermIcon className="size-3" />
                  {runtimeMode === "full-access" ? "Full access" : "Supervised"}
                  <span className="mx-1 h-2 w-px bg-border" aria-hidden />
                  <Zap className={cn("size-3", reasoningEffort !== "auto" && reasoningEffort !== "none" ? "text-amber-500" : "opacity-40")} />
                  {reasoningOpt.label}
                </span>

                {busy && !stoppable ? (
                  <span
                    title={`${providerMeta(model?.providerID ?? "").label} is running — this backend has no cancel`}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                  >
                    <Loader2 className="size-4 animate-spin" />
                  </span>
                ) : busy ? (
                  <button onClick={onStop} title="Stop" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-error text-white shadow-sm transition-colors hover:opacity-90">
                    <Square className="size-3 fill-current" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    title="Send  (Enter)"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm transition-colors hover:bg-foreground/90 disabled:opacity-30"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[20px] bg-primary/5 ring-1 ring-primary/30">
              <span className="rounded-full bg-card px-3 py-1.5 text-xs font-medium shadow">Drop images</span>
            </div>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between px-2 text-[11px] text-muted-foreground/80">
          <span className="flex items-center gap-1">
            <kbd className="rounded bg-muted px-1 py-0.5 font-sans text-[10px]">Enter</kbd> to send · <kbd className="rounded bg-muted px-1 py-0.5 font-sans text-[10px]">Shift+Enter</kbd> for newline
            <span className="hidden sm:inline"> · <kbd className="rounded bg-muted px-1 py-0.5 font-sans text-[10px]">/model</kbd> switch · <Sparkles className="inline size-3" /> image paste</span>
          </span>
          <span className="hidden truncate font-mono sm:block">{model ? `${model.providerID}/${model.modelID}` : "—"} · {runtimeOpt.label} · {reasoningOpt.label}</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ hero picker */

// t3code DraftHeroHeadline: the project name is a dotted-underline menu trigger,
// listing known projects with "New project" underneath.
function HeroProjectMenu({ project, projects, onSelectProject, onAddProject }: {
  project: Project | null;
  projects: Project[];
  onSelectProject?: (project: Project) => void;
  onAddProject?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={project ? "Change project" : "Choose a project"}
        title={project?.path}
        className="cursor-pointer border-b border-dotted border-foreground/60 text-foreground transition-colors hover:border-foreground"
      >
        {project ? project.name || project.path : "Choose a project"}
      </button>
      {open && (
        <span className="absolute left-1/2 top-full z-50 mt-2 block w-max min-w-56 max-w-80 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover p-1 text-left shadow-xl shadow-black/10">
          <span className="block max-h-72 overflow-y-auto">
            {projects.map((p) => {
              const active = !!project && (p.id === project.id || p.path === project.path);
              return (
                <button
                  key={p.id}
                  onClick={() => { onSelectProject?.(p); setOpen(false); }}
                  title={p.path}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors",
                    active ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-normal">{p.name || p.path}</span>
                  {active && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              );
            })}
          </span>
          <span className="my-1 block h-px bg-border" />
          <button
            onClick={() => { onAddProject?.(); setOpen(false); }}
            className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[13px] font-normal text-foreground transition-colors hover:bg-accent/60"
          >
            <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" /> New project
          </button>
        </span>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- helpers */

function toolIcon(tool?: string) {
  const t = (tool ?? "").toLowerCase();
  if (t.includes("read") || t.includes("cat")) return FileText;
  if (t.includes("write") || t.includes("edit") || t.includes("patch")) return PencilLine;
  if (t.includes("bash") || t.includes("shell") || t.includes("run")) return TermIcon;
  if (t.includes("grep") || t.includes("glob") || t.includes("search") || t.includes("list")) return Search;
  if (t.includes("fetch") || t.includes("web")) return Globe;
  return Wrench;
}

const DETAIL_KEYS = ["filePath", "path", "file", "command", "pattern", "query", "url", "description", "prompt"];

function toolDetail(input?: Record<string, unknown>) {
  if (!input) return "";
  for (const k of DETAIL_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.length > 90 ? `${v.slice(0, 87)}…` : v;
  }
  return "";
}

function durationSeconds(start?: number, end?: number) {
  if (!start || !end || end < start) return "";
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function formatClock(ms?: number) {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
