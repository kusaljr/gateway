import { fetchWithTimeout, normalizeUrl, authHeaders } from "./net";
import { Storage, STORAGE_TUNNEL } from "./storage";
import type { AuthUser, Device } from "./api";

// The ONLY remembered hostname is the one a verified login stored. There is no
// build-time fallback: a hostname baked into the app is someone's specific
// device, it goes stale the moment that device is removed, and it made the app
// sign into an address the account no longer owns. Which devices exist is a
// question only Cloudflare can answer, and signing in is what asks it.

// Every kusal hostname sits behind a Cloudflare Access wildcard app, and
// Access intercepts a request BEFORE it ever reaches the tunnel/origin — an
// unauthenticated hit never sees the real backend, it gets redirected to
// Access's own login flow at <team>.cloudflareaccess.com/cdn-cgi/access/login/…
// every single time, whether the tunnel behind it is alive or not. So neither
// "the request came back 200" (true for that login page too — false positive
// on a dead tunnel) nor "the body says ok" (never true unauthenticated — false
// negative on a live one, since we have no session yet at probe time) can
// tell alive from dead on their own. What DOES distinguish "a real, currently
// configured kusal Access app" from "nothing here at all" is landing on that
// exact Access login redirect — a truly dead/never-set-up host fails outright
// (DNS error, connection refused, or some other Cloudflare error page, none
// of which land on cloudflareaccess.com). Real origin liveness (as opposed to
// "Access is configured for this host") is instead checked via the Cloudflare
// Tunnel API's own status field — see the `status` filter in useSession's login.
export async function probeTunnel(url: string): Promise<boolean> {
  try {
    const r = await fetchWithTimeout(`${normalizeUrl(url)}/health`, { method: "GET" }, 4000);
    if (r.url.includes(".cloudflareaccess.com/cdn-cgi/access/login/")) return true;
    if (!r.ok) return false;
    const body = (await r.text()).trim();
    return body === "ok";
  } catch {
    return false;
  }
}

// The hostname a previous verified login stored. Used to restore a session on
// launch — never to discover a device, which is what the Cloudflare account
// listing is for. null means "nothing paired yet, ask Cloudflare".
//
// Deliberately NOT probed here any more. Gating the stored hostname on a live
// 4-second probe meant a phone on a slow connection — or one that had just
// woken up, or was mid-handover between wifi and cellular — reported "no device
// paired" and dropped the user back to the chooser, where the only way forward
// was signing in again. A network blip is not the same fact as a removed
// device, and the calls that follow (fetchMe, then verifyKusalBackend) can tell
// the difference properly because they authenticate rather than guess.
export async function storedTunnelUrl(): Promise<string | null> {
  const stored = await Storage.getItem(STORAGE_TUNNEL);
  if (!stored) return null;
  return normalizeUrl(stored);
}

// Thrown when a hostname is reachable but nothing kusal is behind it. Its own
// class because the login flow reacts to it rather than showing it: a stored
// hostname that fails this way is stale, and the answer is to forget it and
// rediscover, not to hand the user an error about a device they already removed.
export class TunnelUnreachableError extends Error {}

// The proof probeTunnel cannot give. Access answers from Cloudflare's edge, so
// landing on its login page says only that Access is configured for the
// hostname — the DNS record and the Access app both outlive the tunnel they
// were created for, and a deleted device keeps "probing alive" indefinitely.
// Once Access has issued a JWT the origin is finally reachable, and only then
// can anyone tell a live kusal backend from a dead hostname.
//
// /health is the check because it is unauthenticated at the origin and answers
// a literal "ok": anything else — Cloudflare's own 1033 page for a tunnel with
// no connector, an unrelated service behind the same wildcard Access app, an
// HTML error — is not a kusal device.
export async function verifyKusalBackend(url: string, token: string, cfJwt: string): Promise<void> {
  let r: Response;
  try {
    r = await fetchWithTimeout(`${normalizeUrl(url)}/health`, { headers: authHeaders(token, cfJwt) }, 8000);
  } catch (e: any) {
    throw new TunnelUnreachableError(`${url} did not respond (${e?.message || "network error"}).`);
  }
  const body = (await r.text()).trim();
  if (r.status === 530 || body.includes("Error 1033") || body.includes("Argo Tunnel error")) {
    throw new TunnelUnreachableError(
      `${url} has no tunnel behind it (Cloudflare error 1033). The DNS record outlived the device — run \`kusal connect\` on that machine.`
    );
  }
  if (!r.ok || body !== "ok") {
    throw new TunnelUnreachableError(`${url} answered, but not as a kusal device.`);
  }
}

export async function fetchMe(tunnelUrl: string, token: string, cfJwt: string): Promise<AuthUser | null> {
  try {
    const r = await fetchWithTimeout(`${tunnelUrl}/api/auth/me`, {
      headers: authHeaders(token, cfJwt),
    }, 6000);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.authenticated && j.email) return { email: j.email, provider: j.provider || "cloudflare" };
    return null;
  } catch {
    return null;
  }
}

export async function fetchDevices(tunnelUrl: string, token: string, cfJwt: string): Promise<Device[]> {
  const r = await fetchWithTimeout(`${tunnelUrl}/api/devices`, {
    headers: authHeaders(token, cfJwt),
  }, 6000);
  if (!r.ok) return [];
  const raw = await r.json();
  if (!Array.isArray(raw)) return [];
  return raw.map((d: any) => ({
    id: (d.id ?? d.ID ?? "") as string,
    name: (d.name ?? d.Name ?? "") as string,
    hostname: (d.hostname ?? d.Hostname ?? "") as string,
    tunnel_id: (d.tunnel_id ?? d.TunnelID ?? "") as string,
    status: ((d.status ?? d.Status ?? "disconnected") as string).toLowerCase(),
    last_seen: (d.last_seen ?? d.LastSeen ?? d.lastSeen ?? "") as string,
  }));
}
