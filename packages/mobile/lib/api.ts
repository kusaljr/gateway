// Thin client for the shell backend + its /api/opencode proxy — mirrors
// packages/web/src/lib/api.ts's actual call shapes exactly (verified against
// the Go handlers and opencode's real request/response bodies, not guessed).
// Every call needs BOTH headers: Authorization is only meaningful once past
// Cloudflare Access, and Cf-Access-Jwt-Assertion is what gets it past Access
// at all (see lib/net.ts's authHeaders — reused here via the `auth` param).

export type Device = { id: string; name: string; hostname: string; tunnel_id: string; status: string; last_seen: string };
export type AuthUser = { email: string; provider: string };

export type Project = { id: string; name: string; path: string; device_id: string; created_at: string; updated_at: string };

export type SessionSummary = {
  id: string;
  title: string;
  provider: string;
  status: string;
  model: string;
  updatedAt: string;
  branch?: string;
  cwd: string;
  project_id?: string;
  archived?: boolean;
};

export type FsEntry = { name: string; path: string; isDir: boolean };

export type OCModel = { providerID: string; modelID: string; label: string };

export type OCPartState = {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
};

export type OCPart = {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: OCPartState;
  delta?: string;
  time?: { start?: number; end?: number };
};

export type OCMessage = {
  info: { role: "user" | "assistant"; id?: string; sessionID?: string; time?: { created?: number; completed?: number } };
  parts: OCPart[];
};

export type OCSessionInfo = {
  id: string;
  title?: string;
  directory?: string;
  model?: { providerID: string; id: string; variant?: string };
};

export type Auth = { token: string; cfJwt: string };

function authHeaders(auth: Auth, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (auth.token) h["Authorization"] = `Bearer ${auth.token}`;
  if (auth.cfJwt) h["Cf-Access-Jwt-Assertion"] = auth.cfJwt;
  return h;
}

async function jsonOrThrow(r: Response): Promise<any> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => r.statusText)}`);
  const text = await r.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, got: ${text.slice(0, 200)}`);
  }
}

// ── projects / sessions / fs (sqlite-backed, direct on the shell server) ──

export async function fetchProjects(base: string, auth: Auth): Promise<Project[]> {
  const r = await fetch(`${base}/api/projects`, { headers: authHeaders(auth) });
  const j = await jsonOrThrow(r);
  return Array.isArray(j) ? j : [];
}

export async function createProject(base: string, auth: Auth, path: string, name?: string): Promise<Project> {
  const r = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: authHeaders(auth, { "content-type": "application/json" }),
    body: JSON.stringify({ path, name }),
  });
  return jsonOrThrow(r);
}

export async function renameProject(base: string, auth: Auth, id: string, name: string): Promise<void> {
  await fetch(`${base}/api/projects/${id}`, {
    method: "PATCH",
    headers: authHeaders(auth, { "content-type": "application/json" }),
    body: JSON.stringify({ name }),
  });
}

export async function deleteProject(base: string, auth: Auth, id: string): Promise<void> {
  await fetch(`${base}/api/projects/${id}`, {
    method: "DELETE",
    headers: authHeaders(auth),
  });
}

export async function fetchFsList(base: string, auth: Auth, path?: string): Promise<{ cwd: string; entries: FsEntry[] }> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  const r = await fetch(`${base}/api/fs/list${qs}`, { headers: authHeaders(auth) });
  const j = await jsonOrThrow(r);
  return { cwd: j?.cwd || "", entries: Array.isArray(j?.entries) ? j.entries : [] };
}

export async function fetchSessions(base: string, auth: Auth): Promise<SessionSummary[]> {
  const r = await fetch(`${base}/api/sessions`, { headers: authHeaders(auth) });
  const j = await jsonOrThrow(r);
  return Array.isArray(j) ? j : [];
}

export async function createSession(base: string, auth: Auth, opts: { title: string; cwd: string; project_id: string }): Promise<{ id: string }> {
  const r = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: authHeaders(auth, { "content-type": "application/json" }),
    body: JSON.stringify(opts),
  });
  return jsonOrThrow(r);
}

export async function patchSession(base: string, auth: Auth, id: string, patch: { archived?: boolean; status?: string; title?: string; model?: string }): Promise<void> {
  await fetch(`${base}/api/sessions/${id}`, {
    method: "PATCH",
    headers: authHeaders(auth, { "content-type": "application/json" }),
    body: JSON.stringify(patch),
  });
}

export async function deleteSession(base: string, auth: Auth, id: string): Promise<void> {
  await fetch(`${base}/api/sessions/${id}`, {
    method: "DELETE",
    headers: authHeaders(auth),
  });
}

// ── opencode proxy — every call (except /session/status and /event) MUST
// carry ?directory= or opencode answers from whatever cwd it booted in ──

function ocUrl(path: string, directory?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  if (directory) params.set("directory", directory);
  const qs = params.toString();
  return `/api/opencode${path}${qs ? `?${qs}` : ""}`;
}

// Every chat backend's models in one list. The flattening that used to live
// here now happens server-side (/api/models), which is also where agy's
// models get merged in — see handleModels in shell.go.
// ── provider inventory ─────────────────────────────────────────────────────
// Which agent CLIs exist on the device answering the request, and whether each
// looks signed in. Per-device by nature: the call goes through one device's own
// tunnel, so `hostname` says which machine the answer describes. `auth` is
// three-valued — an agent that stores its login somewhere kusal can't inspect
// reports "unknown" rather than a wrong "signed_out" (see cliagent/auth.go).

export type ProviderAuth = "signed_in" | "signed_out" | "unknown";

export type ProviderStatus = {
  name: string;
  label: string;
  bin: string;
  installed: boolean;
  path?: string;
  auth?: ProviderAuth;
  // where the login was found — a location, never a credential
  source?: string;
};

export async function fetchProviders(base: string, auth: Auth): Promise<{ hostname: string; providers: ProviderStatus[] }> {
  const r = await fetch(`${base}/api/providers`, { headers: authHeaders(auth) });
  // This route is newer than the first shipped daemons: an older `kusal
  // connect` has no handler for it and falls through to the mux's default
  // "404 page not found", which says nothing about what to actually do.
  if (r.status === 404) {
    throw new Error("This device runs an older kusal build with no /api/providers. Update it there (npm run install:cli) and restart kusal connect.");
  }
  const j = await jsonOrThrow(r);
  return { hostname: j?.hostname || "", providers: Array.isArray(j?.providers) ? j.providers : [] };
}

// ── usage ──────────────────────────────────────────────────────────────────
// Device-wide, not kusal-wide: opencode is asked over its own API, and the agent
// CLIs are read from the history each one keeps on disk, so a turn typed into a
// terminal counts like one sent from the phone. All measured numbers — nothing
// estimated from text length.
//
// Two caveats travel with them. `cost` only exists where a provider prices its
// own turns (opencode); the CLIs run on the user's own subscription and write no
// price, which is what `priced: false` and `unpriced_messages` say. And a CLI
// that records no counts at all appears in `unmetered` with the reason, rather
// than as a misleading zero.

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
  // false when this provider reports no price of its own. Optional: a device
  // running an older kusal build omits it entirely.
  priced?: boolean;
};

// an installed CLI whose history carries no counts to read
export type UsageUnmetered = { provider: string; reason: string };
export type UsageModel = { key: string; provider: string; model: string; tokens: UsageTokens; cost: number; messages: number };

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
  // omitted by older kusal builds, so every reader must tolerate its absence
  unmetered?: UsageUnmetered[];
  // set when opencode itself could not be reached; the CLI numbers still stand
  opencode_error?: string;
  source: string;
};

export async function fetchUsage(base: string, auth: Auth, days = 14): Promise<Usage> {
  const r = await fetch(`${base}/api/usage?days=${days}`, { headers: authHeaders(auth) });
  // same trap as /api/providers: an older daemon has no handler and falls
  // through to the mux's default 404
  if (r.status === 404) {
    throw new Error("This device runs an older kusal build with no /api/usage. Update it there (npm run install:cli) and restart kusal connect.");
  }
  return jsonOrThrow(r);
}

export async function fetchModels(base: string, auth: Auth, directory: string): Promise<{ models: OCModel[]; defaultKey: string | null }> {
  const r = await fetch(`${base}/api/models?directory=${encodeURIComponent(directory)}`, { headers: authHeaders(auth) });
  const j = await jsonOrThrow(r);
  const models: OCModel[] = Array.isArray(j?.models) ? j.models : [];
  return { models, defaultKey: j?.defaultKey || (models[0] ? `${models[0].providerID}/${models[0].modelID}` : null) };
}

// ── CLI agents (claude = Claude Code, codex, agy = Gemini CLI, copilot =
// GitHub Copilot CLI, grok, cline) — a thread routes to one of these purely by
// its model's providerID. None has a server of its own, so kusal holds the
// transcript and these two calls stand in for opencode's prompt_async +
// /message + SSE.

export const AGY_PROVIDER = "agy";
export const CLINE_PROVIDER = "cline";
export const CODEX_PROVIDER = "codex";
export const CLAUDE_PROVIDER = "claude";
export const GROK_PROVIDER = "grok";
export const COPILOT_PROVIDER = "copilot";
export const CLI_BACKENDS = [AGY_PROVIDER, CLINE_PROVIDER, CODEX_PROVIDER, CLAUDE_PROVIDER, GROK_PROVIDER, COPILOT_PROVIDER];

// Which chat backend a model belongs to. opencode fronts many model providers
// (anthropic, openai, …) behind one server, so anything that isn't a known CLI
// agent is opencode — the distinction that matters is the backend, not the
// providerID.
export function backendOf(providerID: string): string {
  return CLI_BACKENDS.includes(providerID) ? providerID : "opencode";
}

export function isCliBackend(backend: string | null | undefined): boolean {
  return !!backend && CLI_BACKENDS.includes(backend);
}

export async function agentPrompt(
  base: string,
  auth: Auth,
  backend: string,
  sessionId: string,
  model: string,
  text: string,
  directory: string
): Promise<void> {
  const r = await fetch(`${base}/api/agent/prompt`, {
    method: "POST",
    headers: authHeaders(auth, { "content-type": "application/json" }),
    body: JSON.stringify({ backend, session_id: sessionId, model, text, directory }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => r.statusText)}`);
}

export async function fetchAgentMessages(base: string, auth: Auth, sessionId: string): Promise<{ messages: OCMessage[]; running: boolean }> {
  const r = await fetch(`${base}/api/agent/messages?session_id=${encodeURIComponent(sessionId)}`, { headers: authHeaders(auth) });
  const j = await jsonOrThrow(r);
  return { messages: Array.isArray(j?.messages) ? j.messages : [], running: !!j?.running };
}

// NOTE: body key is "id", not "modelID" — matches the real (inconsistent)
// web app behavior exactly, confirmed against api.ts:369 vs api.ts:315/401.
export async function setSessionModel(base: string, auth: Auth, id: string, model: { providerID: string; id: string }, directory: string): Promise<void> {
  await fetch(`${base}${ocUrl(`/api/session/${id}/model`, directory)}`, {
    method: "POST",
    headers: authHeaders(auth, { "content-type": "application/json" }),
    body: JSON.stringify({ model }),
  });
}

export async function promptAsync(
  base: string,
  auth: Auth,
  id: string,
  model: { providerID: string; modelID: string },
  text: string,
  directory: string,
  signal?: AbortSignal
): Promise<void> {
  const r = await fetch(`${base}${ocUrl(`/session/${id}/prompt_async`, directory)}`, {
    method: "POST",
    headers: authHeaders(auth, { "content-type": "application/json" }),
    body: JSON.stringify({ model, agent: "build", parts: [{ type: "text", text }] }),
    signal,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => r.statusText)}`);
}

export async function fetchMessages(base: string, auth: Auth, id: string, directory: string): Promise<OCMessage[]> {
  const r = await fetch(`${base}${ocUrl(`/session/${id}/message`, directory, { limit: "100" })}`, { headers: authHeaders(auth) });
  const j = await jsonOrThrow(r);
  return Array.isArray(j) ? j : [];
}

export async function fetchSessionInfo(base: string, auth: Auth, id: string, directory: string): Promise<OCSessionInfo | null> {
  try {
    const r = await fetch(`${base}${ocUrl(`/session/${id}`, directory)}`, { headers: authHeaders(auth) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function abortSession(base: string, auth: Auth, id: string, directory: string): Promise<void> {
  await fetch(`${base}${ocUrl(`/session/${id}/abort`, directory)}`, {
    method: "POST",
    headers: authHeaders(auth),
  });
}

// not directory-scoped in the real web client either — intentional, see research
export async function fetchSessionStatuses(base: string, auth: Auth): Promise<Record<string, string>> {
  try {
    const r = await fetch(`${base}${ocUrl("/session/status")}`, { headers: authHeaders(auth) });
    const j = await jsonOrThrow(r);
    const out: Record<string, string> = {};
    for (const [id, v] of Object.entries<any>(j || {})) {
      if (v?.type) out[id] = v.type;
    }
    return out;
  } catch {
    return {};
  }
}

export { authHeaders, ocUrl };
