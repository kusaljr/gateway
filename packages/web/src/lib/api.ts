// kusal web API — tunnel shell + device opencode (via /api/opencode proxy)
export type Device = { id: string; name: string; hostname: string; tunnel_id: string; status: string; last_seen: string };
export type Project = { id: string; name: string; path: string; device_id: string; created_at: string; updated_at: string };
// provider is the thread's backend id — "opencode" or one of CLI_BACKENDS. Left
// open rather than a closed union: it used to list four names, three of which
// were wrong (no cursor backend exists) and three of the real agents missing,
// so every new CLI agent silently fell outside the type.
export type Session = { id: string; title: string; provider: string; status: "working" | "done" | "failed" | "idle"; model: string; updatedAt: string; branch?: string; cwd: string; project_id?: string; archived?: boolean };

const OC = "/api/opencode";

/**
 * opencode scopes every call to a directory. Without it the server answers from
 * whatever cwd it booted in, which is why threads in other projects behaved as
 * if they were "not connected".
 */
function ocUrl(path: string, directory?: string, extra?: Record<string, string>) {
  const qs = new URLSearchParams(extra);
  if (directory) qs.set("directory", directory);
  const query = qs.toString();
  return `${OC}${path}${query ? `?${query}` : ""}`;
}

async function jsonOrThrow(r: Response) {
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.error ?? text; } catch {}
    throw new Error(msg || `${r.status} ${r.statusText}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function fetchDevices(): Promise<Device[]> {
  try {
    const r = await fetch("/api/devices");
    if (r.ok) {
      const raw = await r.json();
      if (!Array.isArray(raw)) return [];
      return raw.map((d: Record<string, unknown>) => ({
        id: (d.id ?? d.ID ?? "") as string,
        name: (d.name ?? d.Name ?? "") as string,
        hostname: (d.hostname ?? d.Hostname ?? "") as string,
        tunnel_id: (d.tunnel_id ?? d.TunnelID ?? "") as string,
        status: ((d.status ?? d.Status ?? "disconnected") as string).toLowerCase(),
        last_seen: (d.last_seen ?? d.LastSeen ?? d.lastSeen ?? "") as string,
      }));
    }
  } catch {}
  return [];
}

export async function fetchProjects(): Promise<Project[]> {
  try {
    const r = await fetch("/api/projects");
    if (r.ok) return await r.json();
  } catch {}
  return [];
}

export async function fetchSessions(): Promise<Session[]> {
  try {
    const r = await fetch("/api/sessions");
    if (r.ok) {
      const raw = await r.json();
      if (!Array.isArray(raw)) return [];
      // filter out any legacy Unknown project artefacts is done server-side now (sqlite only valid projects)
      return raw as Session[];
    }
  } catch {}
  return [];
}

/** Remove a thread: the sqlite row plus its opencode history. */
export async function deleteSession(id: string): Promise<void> {
  await jsonOrThrow(await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/** Archive (or restore) a thread — it leaves the sidebar tree but keeps its history. */
export async function archiveSession(id: string, archived: boolean): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived }),
    }),
  );
}

/** Rename a thread — sqlite title, and opencode's own title when it owns the id. */
export async function renameSession(id: string, title: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
}

/* ---------- opencode ---------- */

export type OCModel = { providerID: string; modelID: string; label: string };

type OCProvidersResponse = {
  providers?: Array<{
    id: string;
    name?: string;
    models?: Record<string, { id?: string; name?: string; providerID?: string } | undefined>;
  }>;
  default?: Record<string, string>;
};

/**
 * Every model this device can run, across every chat backend, plus the default
 * pick.
 *
 * The daemon's own /api/models is the source: it merges opencode's providers
 * with each installed CLI agent (Claude Code, Codex, Gemini CLI, Grok, Copilot,
 * Cline) under a synthetic providerID that also routes the thread. Asking
 * opencode's /config/providers directly — which is all this used to do — can
 * only ever return opencode, which is why the picker showed one backend on a
 * machine with six installed.
 *
 * opencode remains the fallback for a device still running an older daemon
 * with no /api/models handler.
 */
export async function fetchModels(directory?: string): Promise<{ models: OCModel[]; defaultModel: OCModel | null }> {
  try {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    const r = await fetch(`/api/models${qs}`);
    if (r.ok) {
      const j = (await r.json()) as { models?: OCModel[]; defaultKey?: string };
      const models = (Array.isArray(j?.models) ? j.models : []).filter((m) => m?.providerID && m?.modelID);
      if (models.length > 0) {
        const key = j?.defaultKey || "";
        const defaultModel = models.find((m) => `${m.providerID}/${m.modelID}` === key) ?? models[0] ?? null;
        return { models, defaultModel };
      }
    }
  } catch {
    /* fall through to opencode's own listing */
  }
  const d = (await jsonOrThrow(await fetch(ocUrl("/config/providers", directory)))) as OCProvidersResponse;
  const models: OCModel[] = [];
  for (const p of d.providers ?? []) {
    for (const [key, m] of Object.entries(p.models ?? {})) {
      const modelID = m?.id ?? key;
      models.push({ providerID: p.id, modelID, label: `${p.name || p.id} · ${m?.name || modelID}` });
    }
  }
  let defaultModel: OCModel | null = null;
  for (const [providerID, modelID] of Object.entries(d.default ?? {})) {
    const hit = models.find((m) => m.providerID === providerID && m.modelID === modelID);
    if (hit) { defaultModel = hit; break; }
  }
  return { models, defaultModel: defaultModel ?? models[0] ?? null };
}

// ── CLI agent backends ─────────────────────────────────────────────────────
// A thread routes to one of these purely by its model's providerID. None has a
// server of its own, so the daemon holds the transcript and these two calls
// stand in for opencode's prompt_async + /message + SSE. Kept in step with
// packages/mobile/lib/api.ts and internal/cliagent.

export const CLI_BACKENDS = ["agy", "cline", "codex", "claude", "grok", "copilot"] as const;

/**
 * Which chat backend a model belongs to. opencode fronts many model providers
 * (anthropic, openai, …) behind one server, so anything that isn't a known CLI
 * agent is opencode — the distinction that matters is the backend, not the
 * providerID.
 */
export function backendOf(providerID: string): string {
  return (CLI_BACKENDS as readonly string[]).includes(providerID) ? providerID : "opencode";
}

export function isCliBackend(backend: string | null | undefined): boolean {
  return !!backend && (CLI_BACKENDS as readonly string[]).includes(backend);
}

/**
 * One thread's sqlite row — the record that knows which backend it belongs to.
 *
 * There is no GET for a single session, and the list is nine rows on a busy
 * device, so this reads the list and picks. It exists because a CLI thread is
 * identifiable ONLY from this row (or from its stored transcript): opencode
 * has never heard of it, so asking opencode about it just answers "no such
 * session" indistinguishably from "a session with no messages".
 */
export async function fetchSessionRow(id: string): Promise<Session | null> {
  const all = await fetchSessions();
  return all.find((s) => s.id === id) ?? null;
}

/** Queue a turn on a CLI agent. Returns once accepted; output arrives by poll. */
export async function agentPrompt(
  backend: string,
  sessionId: string,
  model: string,
  text: string,
  directory: string,
): Promise<void> {
  const r = await fetch("/api/agent/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend, session_id: sessionId, model, text, directory }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => r.statusText)}`);
}

/**
 * A CLI agent's transcript plus whether its turn is still running. These agents
 * emit nothing on opencode's event bus, so this poll is the only live signal
 * there is for them.
 */
export async function fetchAgentMessages(sessionId: string): Promise<{ messages: OCMessage[]; running: boolean }> {
  const r = await fetch(`/api/agent/messages?session_id=${encodeURIComponent(sessionId)}`);
  const j = (await jsonOrThrow(r)) as { messages?: OCMessage[]; running?: boolean };
  return { messages: Array.isArray(j?.messages) ? j.messages : [], running: !!j?.running };
}

export async function createSession(title?: string, opts?: { cwd?: string; project_id?: string }): Promise<string> {
  // sqlite-backed project session (not opencode chat history) — keeps track per project
  const s = (await jsonOrThrow(
    await fetch(`/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: title || "New session",
        cwd: opts?.cwd,
        project_id: opts?.project_id,
      }),
    })
  )) as { id: string };
  return s.id;
}

export async function ensureProject(path?: string): Promise<Project | null> {
  try {
    const r = await fetch(`/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path || "" }),
    });
    if (r.ok) return asProject(await r.json());
  } catch {}
  return null;
}

/** A project is only usable if it carries an id and a path. */
export function asProject(value: unknown): Project | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Partial<Project>;
  if (typeof p.id !== "string" || !p.id || typeof p.path !== "string" || !p.path) return null;
  return { ...(p as Project), name: p.name || p.path.split("/").filter(Boolean).pop() || p.path };
}

export type GitDiffResult = { cwd: string; isRepo: boolean; branch: string; diff: string; untracked: string };
export async function fetchGitDiff(cwd?: string): Promise<GitDiffResult> {
  try {
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const r = await fetch(`/api/git/diff${qs}`);
    if (r.ok) return (await r.json()) as GitDiffResult;
  } catch {}
  return { cwd: cwd || "", isRepo: false, branch: "", diff: "", untracked: "" };
}

export type PreviewPort = { port: number; open: boolean };
export async function fetchPreviewPorts(): Promise<PreviewPort[]> {
  try {
    const r = await fetch("/api/preview/ports");
    if (r.ok) return (await r.json()) as PreviewPort[];
  } catch {}
  return [];
}

export type FsEntry = { name: string; path: string; isDir: boolean };
export async function fetchFsList(path?: string): Promise<{ cwd: string; entries: FsEntry[] }> {
  try {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    const r = await fetch(`/api/fs/list${qs}`);
    if (r.ok) return (await r.json()) as { cwd: string; entries: FsEntry[] };
  } catch {}
  return { cwd: path || "", entries: [] };
}

export type FileHit = { name: string; path: string; rel: string; isDir: boolean };

/**
 * Files for `@` mentions. opencode's own indexer (`/find/file`) is both faster
 * and gitignore-aware, so it goes first; the shell's walker is the fallback for
 * when opencode isn't up yet.
 */
export async function searchFiles(cwd: string, q: string, limit = 30): Promise<FileHit[]> {
  // opencode answers an empty query too (recent/indexed files), so `@` on its
  // own lists something instead of sitting blank
  try {
    const r = await fetch(ocUrl("/find/file", cwd || undefined, { query: q, limit: String(limit) }));
    if (r.ok) {
      const rels = (await r.json()) as unknown;
      if (Array.isArray(rels)) {
        return (rels as string[]).slice(0, limit).map((rel) => toHit(rel, cwd));
      }
    }
  } catch {}
  // fallback: the shell's own walker (also covers opencode being down)
  try {
    const qs = new URLSearchParams({ path: cwd, q, limit: String(limit) });
    const r = await fetch(`/api/fs/search?${qs.toString()}`);
    if (!r.ok) return [];
    const data = (await r.json()) as { entries?: FileHit[] };
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function toHit(rel: string, cwd: string): FileHit {
  // opencode marks directories with a trailing slash
  const isDir = rel.endsWith("/");
  return {
    rel,
    name: rel.split("/").filter(Boolean).pop() ?? rel,
    path: cwd ? `${cwd.replace(/\/+$/, "")}/${rel}` : rel,
    isDir,
  };
}

export type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  at: string;
  pending?: boolean;
  error?: boolean;
};

// Full opencode message with all part types (tool, reasoning, step, etc.)
export type OCPart = {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  reason?: string;
  delta?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
};

export type OCMessage = {
  info: { role: "user" | "assistant"; id?: string; sessionID?: string; time?: { created?: number; completed?: number } };
  parts: OCPart[];
};

function partsToText(parts: OCPart[]): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

export async function fetchMessages(sessionId: string): Promise<ChatMsg[]> {
  const msgs = await fetchMessagesRaw(sessionId);
  return msgs
    .map((m) => ({
      role: m.info.role as "user" | "assistant",
      content: partsToText(m.parts),
      at: new Date(m.info.time?.created ?? Date.now()).toISOString(),
    }))
    .filter((m) => m.content.length > 0);
}

export async function fetchMessagesRaw(sessionId: string, directory?: string): Promise<OCMessage[]> {
  const msgs = (await jsonOrThrow(
    await fetch(ocUrl(`/session/${sessionId}/message`, directory, { limit: "100" }))
  )) as OCMessage[];
  return Array.isArray(msgs) ? msgs : [];
}

/**
 * Queue a prompt and return immediately — the reply arrives over the session's
 * SSE stream. The old blocking POST /message kept the UI waiting for the whole
 * turn, which is what made responses feel slow.
 */
export async function promptAsync(
  sessionId: string,
  model: OCModel,
  text: string,
  directory?: string,
  signal?: AbortSignal,
): Promise<void> {
  await jsonOrThrow(
    await fetch(ocUrl(`/session/${sessionId}/prompt_async`, directory), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        model: { providerID: model.providerID, modelID: model.modelID },
        agent: "build",
        parts: [{ type: "text", text }],
      }),
    }),
  );
}

export type SessionRunState = "idle" | "busy" | "retry";

/** Live per-session run state, keyed by opencode session id. */
export async function fetchSessionStatuses(): Promise<Record<string, SessionRunState>> {
  try {
    const r = await fetch(ocUrl("/session/status"));
    if (!r.ok) return {};
    const raw = (await r.json()) as Record<string, { type?: string } | undefined>;
    const out: Record<string, SessionRunState> = {};
    for (const [id, status] of Object.entries(raw ?? {})) {
      const t = status?.type;
      if (t === "busy" || t === "retry" || t === "idle") out[id] = t;
    }
    return out;
  } catch {
    return {};
  }
}

export type OCSessionInfo = {
  id: string;
  title?: string;
  directory?: string;
  model?: { providerID: string; id: string; variant?: string };
};

/** One opencode session — carries the model it is pinned to. */
export async function fetchSessionInfo(sessionId: string, directory?: string): Promise<OCSessionInfo | null> {
  try {
    const r = await fetch(ocUrl(`/session/${sessionId}`, directory));
    if (!r.ok) return null;
    return (await r.json()) as OCSessionInfo;
  } catch {
    return null;
  }
}

/**
 * Pin a model to a session so it survives reloads. Note the doubled prefix:
 * this route only exists under opencode's own `/api`, and kusal proxies
 * `/api/opencode/*` to the server root.
 */
export async function setSessionModel(sessionId: string, model: OCModel, directory?: string): Promise<void> {
  await fetch(ocUrl(`/api/session/${sessionId}/model`, directory), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: model.providerID, id: model.modelID } }),
  });
}

/** Mirror the model onto the sqlite row so the sidebar chip agrees. */
export async function updateSessionModel(sessionId: string, model: string): Promise<void> {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
  } catch {}
}

/**
 * SSE URL for opencode's event bus. One stream carries every session (the
 * per-session route lives behind opencode's own `/api` prefix), so callers
 * filter on `properties.sessionID`.
 */
export function eventStreamUrl(directory?: string) {
  return ocUrl("/event", directory);
}

/** Send a prompt and wait for opencode's full response (blocking). Used as fallback; streaming is via SSE/polling. */
export async function sendMessage(sessionId: string, model: OCModel, text: string, signal?: AbortSignal, directory?: string): Promise<OCMessage> {
  const res = (await jsonOrThrow(
    await fetch(ocUrl(`/session/${sessionId}/message`, directory), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        model: { providerID: model.providerID, modelID: model.modelID },
        agent: "build",
        parts: [{ type: "text", text }],
      }),
    })
  )) as OCMessage;
  return res;
}

export function ocMessageToChatMsg(m: OCMessage): ChatMsg {
  return {
    role: m.info.role as "user" | "assistant",
    content: partsToText(m.parts) || "(no response)",
    at: new Date(m.info.time?.created ?? Date.now()).toISOString(),
  };
}

export async function abortSession(sessionId: string, directory?: string): Promise<void> {
  await fetch(ocUrl(`/session/${sessionId}/abort`, directory), { method: "POST" });
}

// ── usage telemetry ────────────────────────────────────────────────────────
// Device-wide token and cost metrics collected across opencode and all CLI
// agents (Claude Code, Codex, Copilot CLI, Gemini CLI/Antigravity).

export type UsageTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  total: number;
};

export type UsageDay = {
  date: string;
  tokens: UsageTokens;
  cost: number;
  messages: number;
  unpriced_messages: number;
};

export type UsageProvider = {
  provider: string;
  tokens: UsageTokens;
  cost: number;
  messages: number;
  models: number;
  priced?: boolean;
};

export type UsageUnmetered = { provider: string; reason: string };

export type UsageModel = {
  key: string;
  provider: string;
  model: string;
  tokens: UsageTokens;
  cost: number;
  messages: number;
};

export type Usage = {
  hostname: string;
  from: string;
  to: string;
  days: UsageDay[];
  providers: UsageProvider[];
  models: UsageModel[];
  tokens: UsageTokens;
  cost: number;
  messages: number;
  unpriced_messages: number;
  sessions_scanned: number;
  unmetered?: UsageUnmetered[];
  opencode_error?: string;
  source?: string;
};

export async function fetchUsage(days = 14): Promise<Usage> {
  const r = await fetch(`/api/usage?days=${days}`);
  if (!r.ok) {
    if (r.status === 404) {
      throw new Error("This device runs an older kusal build with no /api/usage. Update it there (npm run install:cli) and restart kusal connect.");
    }
    const text = await r.text().catch(() => "");
    throw new Error(text || `${r.status} ${r.statusText}`);
  }
  return jsonOrThrow(r);
}

