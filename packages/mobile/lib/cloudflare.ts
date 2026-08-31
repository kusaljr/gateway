import * as Crypto from "expo-crypto";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { fetchWithTimeout, normalizeUrl } from "./net";

// Real Cloudflare Access login: opens the tunnel's own hostname in a system browser
// tab (ASWebAuthenticationSession / Chrome Custom Tabs via expo-web-browser). Since
// the whole origin sits behind Access, an unauthenticated hit is intercepted by
// Cloudflare's edge and shows its real login page (Google/GitHub/OTP/whatever the
// Access policy allows) — this app never sees credentials. Once Access approves the
// user, it forwards through to /api/auth/cloudflare/callback with
// Cf-Access-Authenticated-User-Email attached, and the backend redirects back to
// redirectUri with a bearer token AND Access's own JWT (see handleCloudflareCallback
// in shell.go). The bearer token is only meaningful to our own backend; the JWT is
// what actually gets a plain fetch() past Access's edge on every later request —
// without it, Access redirects every request to its login page since it has no
// idea our bearer scheme exists (verified directly against this deployment).
export async function loginViaCloudflareAccess(tunnelUrl: string): Promise<{ token: string; email: string; cfJwt: string }> {
  const redirectUri = Linking.createURL("auth");
  // Access is asked to come back to an https page on the device's own origin,
  // which then jumps to the app. Handing Access the exp:// or kusal:// link
  // directly is what produced "page isn't working": an in-app browser will not
  // navigate to an unknown scheme, and the login died on its last hop with the
  // session already issued.
  const appReturn = `${tunnelUrl}/api/auth/app-return?to=${encodeURIComponent(redirectUri)}`;
  const authUrl = `${tunnelUrl}/api/auth/cloudflare/callback?redirect_uri=${encodeURIComponent(appReturn)}`;
  const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
  if (result.type === "cancel" || result.type === "dismiss") {
    throw new Error("Login cancelled");
  }
  if (result.type !== "success" || !result.url) {
    throw new Error("Cloudflare Access login failed");
  }
  const { queryParams } = Linking.parse(result.url);
  const token = (queryParams?.token as string) || "";
  const email = (queryParams?.email as string) || "";
  const cfJwt = (queryParams?.cf_jwt as string) || "";
  if (!token || !email) throw new Error("Cloudflare did not return a session — check the tunnel is behind Access");
  return { token, email, cfJwt };
}

// ── Cloudflare account OAuth (setup/discovery only) ────────────────────────
// Separate from loginViaCloudflareAccess above: that one authenticates INTO a
// known device's Access-protected hostname for daily use. This one signs into
// the user's actual Cloudflare ACCOUNT (self-managed OAuth, PKCE) so we can call
// Cloudflare's own control-plane API and discover which tunnels/hostnames exist
// — no hostname needs to be known in advance. Registered once in the Cloudflare
// dashboard (Manage account → OAuth clients); client_id is a public client
// identifier, safe to ship — PKCE means there's no secret to leak.
const CF_OAUTH_CLIENT_ID = "82de03435724c4f303d8c095ec008e4b";
const CF_OAUTH_AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
const CF_OAUTH_TOKEN = "https://dash.cloudflare.com/oauth2/token";
// must exactly match what's registered with the OAuth client — a static https
// relay page (can't register a custom scheme with Cloudflare) that immediately
// bounces to CF_OAUTH_APP_REDIRECT with the same query string.
const CF_OAUTH_HTTPS_REDIRECT = "https://kusallamsal.com.np/auth/kusal-callback";
// what the relay page above redirects to, and what this app listens for.
// app/auth.tsx exists purely so expo-router doesn't render its unmatched-route
// screen when this link also reaches the router's own linking handler.
const CF_OAUTH_APP_REDIRECT = "kusal://auth";
// Exact scopes registered on the client (Cloudflare dashboard → OAuth clients →
// kusal) — account read, tunnel read/write, zone read/write, Access apps/policies
// write.
//
// offline_access is deliberately absent. Asking for it does not merely fail to
// return a refresh token, it breaks sign-in outright: Cloudflare answers the
// authorize request with "OAuth 2.0 client is not allowed to request scope
// offline_access" and renders that as a dead-end page, so the browser tab never
// redirects back and the app sits on "Continue with Cloudflare" forever. The
// scope has to be granted on the client itself in the dashboard before it can
// be requested here. Until then the account token is short-lived with nothing
// to renew it from, and refreshCloudflareAccountSession below never gets a
// token to use. Keep this in sync with cfOAuthScopes in
// packages/cli/internal/auth/oauth.go.
const CF_OAUTH_SCOPES = "account-settings.read argotunnel.read argotunnel.write zone.read zone.write zone-access.write user-details.read";
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

const PKCE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
async function randomPkceString(length: number): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(length);
  let out = "";
  for (let i = 0; i < length; i++) out += PKCE_CHARSET[bytes[i] % PKCE_CHARSET.length];
  return out;
}

function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type CloudflareAccountSession = { accessToken: string; refreshToken: string | null; email: string };

// Full PKCE Authorization Code flow against Cloudflare's self-managed OAuth.
//
// Without offline_access (see CF_OAUTH_SCOPES) Cloudflare returns no refresh
// token, so this session simply dies when its access token expires. The device
// list is cached rather than re-fetched on every launch — signing into a device
// uses the separate Access flow, so even a dead account token must never stand
// between the user and a machine they already know about.
export async function loginToCloudflareAccount(): Promise<CloudflareAccountSession> {
  const verifier = await randomPkceString(64);
  const challengeB64 = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const challenge = base64ToBase64Url(challengeB64);
  const state = await randomPkceString(24);

  // Must match the client's registered scopes exactly (verified against the
  // client's own config via GET .../oauth_clients/{id} — omitting `scope`
  // entirely does NOT default to the registered set, it grants zero).
  const authUrl = `${CF_OAUTH_AUTHORIZE}?${new URLSearchParams({
    response_type: "code",
    client_id: CF_OAUTH_CLIENT_ID,
    redirect_uri: CF_OAUTH_HTTPS_REDIRECT,
    scope: CF_OAUTH_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()}`;

  const result = await WebBrowser.openAuthSessionAsync(authUrl, CF_OAUTH_APP_REDIRECT);
  if (result.type === "cancel" || result.type === "dismiss") throw new Error("Login cancelled");
  if (result.type !== "success" || !result.url) throw new Error("Cloudflare login failed");

  const { queryParams } = Linking.parse(result.url);
  const code = (queryParams?.code as string) || "";
  const returnedState = (queryParams?.state as string) || "";
  const oauthError = (queryParams?.error as string) || "";
  if (oauthError) {
    const desc = (queryParams?.error_description as string) || "";
    throw new Error(`Cloudflare rejected the login: ${oauthError}${desc ? ` — ${desc}` : ""}`);
  }
  if (!code) throw new Error(`Cloudflare did not return an authorization code. Got: ${result.url.slice(0, 200)}`);
  if (returnedState !== state) throw new Error("State mismatch on Cloudflare login — aborting");

  const tokenRes = await fetchWithTimeout(CF_OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CF_OAUTH_HTTPS_REDIRECT,
      client_id: CF_OAUTH_CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  }, 10000);
  if (!tokenRes.ok) throw new Error(`Cloudflare token exchange failed: ${(await tokenRes.text()).slice(0, 200)}`);
  const tok = await tokenRes.json();
  if (!tok.access_token) throw new Error("Cloudflare token exchange did not return an access_token");

  // no openid scope, so no id_token — ask Cloudflare's own API who this is
  let email = "";
  try {
    const meRes = await fetchWithTimeout(`${CF_API_BASE}/user`, { headers: { Authorization: `Bearer ${tok.access_token}` } }, 8000);
    if (meRes.ok) {
      const meJson = await meRes.json();
      email = meJson?.result?.email || "";
    }
  } catch {}

  return { accessToken: tok.access_token, refreshToken: tok.refresh_token || null, email };
}

// One cloudflared connection to Cloudflare's edge. A healthy tunnel keeps
// several of these open at once (usually four, spread over two datacenters),
// so these arrive as a list and the list length IS the connection count.
export type TunnelConnection = {
  // The address Cloudflare's edge sees cloudflared dialling out FROM: the
  // machine's public/egress IP. It is deliberately not the hostname's IP —
  // that resolves to Cloudflare, not to the device — and on a NATed network it
  // is the router's address rather than the machine's own LAN one.
  originIp: string;
  // Cloudflare datacenter the connection lands in, as an IATA airport code
  colo: string;
  // cloudflared's version on that machine — the one number that says whether a
  // device is running something ancient
  clientVersion: string;
  openedAt: string;
  pendingReconnect: boolean;
};

export type CloudflareTunnel = {
  accountId: string;
  accountName: string;
  id: string;
  name: string;
  status: string;
  // when `kusal connect` first created this tunnel
  createdAt: string;
  // when the current run of connections came up, and when they last went down.
  // Cloudflare's own bookkeeping, which is why "active since" survives both the
  // app restarting and the device being out of reach.
  connsActiveAt: string;
  connsInactiveAt: string;
  connections: TunnelConnection[];
};

// Read-only: list every Cloudflare Tunnel across every account this OAuth
// token can see. This is what makes discovery real — no domain typed in,
// no local network probing, straight from Cloudflare's own API.
export async function listCloudflareTunnels(accessToken: string): Promise<CloudflareTunnel[]> {
  const authHeaders = { Authorization: `Bearer ${accessToken}` };
  const accRes = await fetchWithTimeout(`${CF_API_BASE}/accounts`, { headers: authHeaders }, 10000);
  if (!accRes.ok) throw new Error(`Could not list Cloudflare accounts: ${(await accRes.text()).slice(0, 200)}`);
  const accJson = await accRes.json();
  const accounts: Array<{ id: string; name: string }> = accJson.result || [];

  const out: CloudflareTunnel[] = [];
  for (const acc of accounts) {
    const tRes = await fetchWithTimeout(`${CF_API_BASE}/accounts/${acc.id}/cfd_tunnel?is_deleted=false`, { headers: authHeaders }, 10000);
    if (!tRes.ok) continue;
    const tJson = await tRes.json();
    for (const t of tJson.result || []) {
      out.push({
        accountId: acc.id,
        accountName: acc.name,
        id: t.id,
        name: t.name,
        status: t.status,
        createdAt: t.created_at || "",
        connsActiveAt: t.conns_active_at || "",
        connsInactiveAt: t.conns_inactive_at || "",
        // already in the same response — listing tunnels has always carried the
        // per-connection detail, it was just being dropped on the floor here
        connections: ((t.connections || []) as any[]).map((c) => ({
          originIp: c.origin_ip || "",
          colo: c.colo_name || "",
          clientVersion: c.client_version || "",
          openedAt: c.opened_at || "",
          pendingReconnect: !!c.is_pending_reconnect,
        })),
      });
    }
  }
  return out;
}

// A tunnel existing doesn't mean it's reachable — Cloudflare only routes a
// hostname to it once ingress config (Public Hostname) is set. Read-only check;
// returns null if nothing's configured yet rather than guessing one.
// Every hostname a tunnel serves, with the local service behind it. The old
// version returned only the FIRST ingress rule, which is why a tunnel routing
// several hostnames showed up as one — and why the list looked like it had
// searched a single domain.
export type TunnelRoute = { hostname: string; service: string };

export async function getTunnelRoutes(accessToken: string, accountId: string, tunnelId: string): Promise<TunnelRoute[]> {
  const r = await fetchWithTimeout(`${CF_API_BASE}/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 10000);
  if (!r.ok) return [];
  const j = await r.json();
  const ingress: Array<{ hostname?: string; service?: string }> = j?.result?.config?.ingress || [];
  const out: TunnelRoute[] = [];
  for (const rule of ingress) {
    // the catch-all rule (http_status:404) carries no hostname
    if (rule.hostname) out.push({ hostname: rule.hostname, service: rule.service || "" });
  }
  return out;
}

// Renews the account session without a browser. Cloudflare hands back a refresh
// token at login and it was simply dropped, so every reload started the whole
// PKCE dance again.
export async function refreshCloudflareAccountSession(refreshToken: string): Promise<CloudflareAccountSession> {
  const r = await fetchWithTimeout(CF_OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CF_OAUTH_CLIENT_ID,
    }).toString(),
  }, 10000);
  if (!r.ok) throw new Error(`Cloudflare refresh failed: ${(await r.text()).slice(0, 160)}`);
  const tok = await r.json();
  if (!tok.access_token) throw new Error("Cloudflare refresh returned no access_token");
  return {
    accessToken: tok.access_token,
    // Cloudflare may not rotate it; keep the one that still works
    refreshToken: tok.refresh_token || refreshToken,
    email: await cloudflareAccountEmail(tok.access_token),
  };
}

// Whether the account token still works, and who it belongs to. Returns "" when
// the token is dead — the caller refreshes rather than showing an error.
export async function cloudflareAccountEmail(accessToken: string): Promise<string> {
  try {
    const r = await fetchWithTimeout(`${CF_API_BASE}/user`, { headers: { Authorization: `Bearer ${accessToken}` } }, 8000);
    if (!r.ok) return "";
    const j = await r.json();
    return j?.result?.email || "";
  } catch {
    return "";
  }
}
