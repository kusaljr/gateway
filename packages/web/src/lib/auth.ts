export type AuthUser = { email: string; provider: string; via?: string };

const SESSION_KEY = "kusal:cf_session_token";
const EMAIL_KEY = "kusal:cf_email";

export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const token = localStorage.getItem(SESSION_KEY);
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const r = await fetch("/api/auth/me", { credentials: "include", headers });
    if (!r.ok) return null;
    const j = (await r.json()) as { authenticated?: boolean; email?: string; provider?: string; via?: string };
    if (j.authenticated && j.email) return { email: j.email, provider: j.provider || "cloudflare", via: j.via };
    return null;
  } catch { return null; }
}

export async function loginWithCloudflare(email: string): Promise<AuthUser> {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, provider: "cloudflare" }),
  });
  if (!r.ok) throw new Error(await r.text());
  const j = (await r.json()) as { email: string; token: string; provider: string };
  try {
    localStorage.setItem(SESSION_KEY, j.token);
    localStorage.setItem(EMAIL_KEY, j.email);
  } catch {}
  return { email: j.email, provider: j.provider };
}

export async function logout(): Promise<void> {
  try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch {}
  try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(EMAIL_KEY); } catch {}
}

export function getStoredEmail(): string | null {
  try { return localStorage.getItem(EMAIL_KEY); } catch { return null; }
}
