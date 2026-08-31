export async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeUrl(v: string) {
  let s = v.trim();
  if (!s) return s;
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

// Cf-Access-Jwt-Assertion is what actually gets a plain fetch() past Cloudflare
// Access's edge — our own bearer token only means something once a request has
// already cleared Access and reached the Go backend. Without the JWT header,
// Access redirects every one of these to its login page instead of forwarding
// the request at all (verified directly against a live deployment).
export function authHeaders(token: string, cfJwt: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (cfJwt) h["Cf-Access-Jwt-Assertion"] = cfJwt;
  return h;
}
