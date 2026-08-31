import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { authHeaders, normalizeUrl } from "./net";
import { Storage, STORAGE_CF_ACCOUNT_REFRESH, STORAGE_CF_ACCOUNT_TOKEN, STORAGE_CF_JWT, STORAGE_EMAIL, STORAGE_SIGNED_OUT, STORAGE_TOKEN, STORAGE_TUNNEL, STORAGE_TUNNEL_CHOICES } from "./storage";
import { fetchDevices, fetchMe, probeTunnel, storedTunnelUrl, TunnelUnreachableError, verifyKusalBackend } from "./tunnel";
import { cloudflareAccountEmail, getTunnelRoutes, listCloudflareTunnels, loginToCloudflareAccount, loginViaCloudflareAccess, refreshCloudflareAccountSession, type CloudflareAccountSession } from "./cloudflare";
import type { Auth, AuthUser, Device } from "./api";

export type TunnelChoice = {
  name: string;
  // Cloudflare's id for the tunnel, so the device this choice refers to can be
  // picked out of the list the device itself reports (Device.tunnel_id).
  tunnelId: string;
  // true when this route points at a local port and the tunnel is named the way
  // `kusal connect` names one. It is a strong hint, not proof: the origin sits
  // behind Access and cannot be reached until a device is actually entered, so
  // the honest label is "looks like kusal", confirmed at sign-in.
  looksLikeKusal: boolean;
  // false disables the row. Cloudflare's own "healthy" only means cloudflared
  // is connected — a tunnel serving ssh reports exactly the same thing, which
  // is why two machines with no kusal on them looked ready to sign into.
  usable: boolean;
  // why it is disabled, shown in place of the hostname
  reason: string;
  // "" when the tunnel has no Public Hostname configured — shown, but not
  // signable-into, because there is no address to sign into
  url: string;
  // Cloudflare's own word for the tunnel: healthy, down, degraded, inactive
  status: string;
  accountName: string;

  // ── what the machine actually is ────────────────────────────────────────
  // All of it comes from Cloudflare's tunnel listing, which the app was
  // already fetching — none of it needs the device to be reachable, so it is
  // there for an offline machine too, describing its last known state.
  //
  // The device's public/egress address, as Cloudflare's edge sees cloudflared
  // connecting from — not the hostname's IP, which is Cloudflare's own.
  // IPv4-first: cloudflared prefers IPv6 wherever the machine has it, so
  // origin_ip is commonly a v6 address, and while that is the true egress
  // address it is not the one a person recognizes their own network by.
  originIp: string;
  // every distinct address the tunnel's connections dial out from, v4 and v6
  // — a multi-homed machine really does report more than one
  originIps: string[];
  // Cloudflare datacenters (IATA codes) the tunnel's connections land in; the
  // count of them is the number of live connections
  colos: string[];
  // cloudflared's version on that machine
  clientVersion: string;
  // when the current run of connections came up — "up since", not "last seen"
  activeSince: string;
  // when they last went down; shown in activeSince's place once a tunnel is no
  // longer healthy, because then "up since" is a lie
  inactiveSince: string;
  // when `kusal connect` created the tunnel
  createdAt: string;
  // the local address on the device this hostname is routed to, e.g.
  // http://localhost:7777 — the ingress rule behind this exact route
  service: string;
};

type SessionValue = {
  // bootstrap (restore stored session / discover a tunnel) has finished
  ready: boolean;
  tunnelUrl: string;
  user: AuthUser | null;
  token: string | null;
  cfJwt: string;
  // stable object so screens can put it in effect deps without refetching
  auth: Auth;
  devices: Device[];
  // false until the first device fetch settles — an empty list means "none
  // connected" only after that, so the list can show a skeleton before it
  devicesLoaded: boolean;
  deviceById: (id: string) => Device | undefined;
  refreshDevices: () => Promise<void>;
  busy: boolean;
  magicStep: string | null;
  // the Cloudflare ACCOUNT the app is signed into, before any device is entered
  accountEmail: string;
  // set by pickTunnel: the tunnel just entered, cleared once acted on
  pickedTunnelId: string | null;
  clearPicked: () => void;
  err: string | null;
  // set when a Cloudflare account holds more than one live kusal tunnel —
  // the login screen asks which device to sign into
  tunnelChoices: TunnelChoice[] | null;
  // a tunnel lookup (cached or live) has completed at least once
  choicesLoaded: boolean;
  // discover: true forces the account listing (the device chooser). Without it,
  // signing in takes the fast path into the machine already paired.
  login: (opts?: { silent?: boolean; discover?: boolean }) => Promise<void>;
  pickTunnel: (url: string, tunnelId?: string) => Promise<void>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

export function SessionProvider({ children }: PropsWithChildren) {
  const [tunnelUrl, setTunnelUrl] = useState<string>("");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [cfJwt, setCfJwt] = useState<string>("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [magicStep, setMagicStep] = useState<string | null>(null);
  const [accountEmail, setAccountEmail] = useState("");
  const [pickedTunnelId, setPickedTunnelId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tunnelChoices, setTunnelChoices] = useState<TunnelChoice[] | null>(null);
  // whether anything has finished looking for tunnels yet — separate from
  // `devicesLoaded`, which only ever describes the backend of the one device
  // already signed into. Without it there is no way to tell "found nothing"
  // from "still looking", and the main screen guessed wrong in both directions.
  const [choicesLoaded, setChoicesLoaded] = useState(false);

  const auth = useMemo<Auth>(() => ({ token: token || "", cfJwt }), [token, cfJwt]);

  const refreshDevices = useCallback(async () => {
    if (!tunnelUrl || !token) return;
    try {
      const list = await fetchDevices(tunnelUrl, token, cfJwt);
      setDevices(list);
    } catch {
      // The device list is fetched THROUGH this same device's own tunnel —
      // once it's disconnected there's no separate always-on service left to
      // ask "are you online", so a failed fetch here IS the offline signal.
      // Previously this branch did nothing, so a disconnected device kept
      // showing its last-known "connected" dot forever.
      setDevices((prev) => prev.map((d) => (d.status === "connected" ? { ...d, status: "disconnected" } : d)));
    } finally {
      setDevicesLoaded(true);
    }
  }, [tunnelUrl, token, cfJwt]);

  // Real Cloudflare Access login against a known hostname, then load devices.
  const performAccessLogin = useCallback(async (url: string) => {
    setMagicStep("Sign in with Cloudflare…");
    const res = await loginViaCloudflareAccess(url);
    if (!res.cfJwt) throw new Error("Cloudflare Access login succeeded but returned no JWT — check the backend build is up to date.");

    // Access issues a JWT for any hostname its app covers, tunnel or no tunnel.
    // Verifying here — before anything is stored or the user is marked signed
    // in — is what stops a deleted device from producing a perfectly happy
    // session whose every request answers 1033. fetchDevices can't stand in for
    // it: that swallows failures and returns [], so a dead tunnel looked
    // exactly like a machine with no devices.
    setMagicStep("Checking the device is reachable…");
    await verifyKusalBackend(url, res.token, res.cfJwt);

    await Storage.setItem(STORAGE_TOKEN, res.token);
    await Storage.setItem(STORAGE_EMAIL, res.email);
    await Storage.setItem(STORAGE_CF_JWT, res.cfJwt);
    await Storage.setItem(STORAGE_TUNNEL, url);
    setTunnelUrl(url);
    setToken(res.token);
    setCfJwt(res.cfJwt);
    setUser({ email: res.email, provider: "cloudflare" });

    setMagicStep("Fetching devices…");
    const list = await fetchDevices(url, res.token, res.cfJwt);
    setDevices(list);
    setDevicesLoaded(true);
  }, []);

  // The account session is remembered and renewed, in that order: a stored
  // token that still answers is used as-is, a dead one is refreshed with the
  // refresh token Cloudflare handed over at login, and only a failure of both
  // opens a browser. Storing neither is what made every single app reload
  // demand a full PKCE sign-in.
  // allowBrowser=false is for the launch path: renewing silently is welcome
  // there, but a browser opening by itself when an app merely starts is not.
  const cloudflareAccount = useCallback(async (allowBrowser: boolean): Promise<CloudflareAccountSession | null> => {
    const [stored, refresh] = await Promise.all([
      Storage.getItem(STORAGE_CF_ACCOUNT_TOKEN),
      Storage.getItem(STORAGE_CF_ACCOUNT_REFRESH),
    ]);
    if (stored) {
      const email = await cloudflareAccountEmail(stored);
      if (email) {
        setAccountEmail(email);
        await Storage.setItem(STORAGE_EMAIL, email);
        return { accessToken: stored, refreshToken: refresh, email };
      }
    }
    if (refresh) {
      try {
        setMagicStep("Renewing your Cloudflare session…");
        const renewed = await refreshCloudflareAccountSession(refresh);
        await Storage.setItem(STORAGE_CF_ACCOUNT_TOKEN, renewed.accessToken);
        if (renewed.refreshToken) await Storage.setItem(STORAGE_CF_ACCOUNT_REFRESH, renewed.refreshToken);
        setAccountEmail(renewed.email);
        if (renewed.email) await Storage.setItem(STORAGE_EMAIL, renewed.email);
        return renewed;
      } catch {
        // fall through to a real sign-in
      }
    }
    if (!allowBrowser) return null;
    setMagicStep("Sign in with your Cloudflare account…");
    const fresh = await loginToCloudflareAccount();
    await Storage.setItem(STORAGE_CF_ACCOUNT_TOKEN, fresh.accessToken);
    if (fresh.refreshToken) await Storage.setItem(STORAGE_CF_ACCOUNT_REFRESH, fresh.refreshToken);
    setAccountEmail(fresh.email);
    if (fresh.email) await Storage.setItem(STORAGE_EMAIL, fresh.email);
    return fresh;
  }, []);

  // The last list Cloudflare gave us, read straight off disk. EVERY path into
  // the app needs it, not only the one with no remembered device: restoring a
  // session returned early without ever loading it, so a relaunch — and every
  // back gesture out of a device — landed on "No devices yet" until a full
  // rediscovery had run, which is the slow part the user was waiting on.
  const restoreCachedChoices = useCallback(async () => {
    const cached = await Storage.getItem(STORAGE_TUNNEL_CHOICES);
    if (!cached) return;
    try {
      const parsed = JSON.parse(cached) as TunnelChoice[];
      if (Array.isArray(parsed) && parsed.length > 0) setTunnelChoices(parsed);
    } catch {
      await Storage.removeItem(STORAGE_TUNNEL_CHOICES);
    }
  }, []);

  // Signing in has two shapes, and conflating them is what made the app ask for
  // TWO logins every time.
  //
  // Discovery — "which machines does this account have?" — can only be answered
  // by Cloudflare's own account API, which means a dashboard OAuth sign-in. It
  // is needed exactly once, to learn a hostname.
  //
  // Entry — "let me into this machine" — is Cloudflare Access on that hostname,
  // and it is the only one that produces the JWT every later request carries.
  //
  // Once a device is paired the first is pure overhead: its account token is
  // short-lived and (with no offline_access scope) unrenewable, so it expired
  // constantly and dragged the user through a dashboard login purely to
  // re-learn a hostname already on disk — and then through Access again. The
  // fast path below skips straight to Access, and discovery is reached only
  // when there is genuinely nothing paired, or the caller asks for the list.
  const login = useCallback(async (opts?: { silent?: boolean; discover?: boolean }) => {
    // Silent runs are background refreshes nobody asked for, so they leave
    // `busy` alone: it disables every row in the list and swaps the login
    // button for a progress line, and a list going untappable on its own —
    // while a perfectly good cached copy is on screen — is not something the
    // user did.
    const silent = !!opts?.silent;
    if (!silent) setBusy(true);
    setErr(null);
    const wantsList = !!opts?.discover;
    // the previous list is deliberately left on screen: this doubles as the
    // chooser's refresh, and blanking it mid-run would bounce that screen back
    // to login on its "nothing to choose from" guard
    // asking to sign in is the opposite of having signed out
    await Storage.removeItem(STORAGE_SIGNED_OUT);
    try {
      // ── fast path: a machine is already paired ──────────────────────────
      // Access alone, no dashboard round-trip. Usually not even a visible
      // login: Access keeps its own session in the system browser, so when it
      // is still valid this completes as a redirect the user never interacts
      // with. Skipped for a silent run, which must never open a browser.
      if (!silent && !wantsList) {
        const remembered = await Storage.getItem(STORAGE_TUNNEL);
        if (remembered) {
          try {
            await performAccessLogin(normalizeUrl(remembered));
            return;
          } catch (e) {
            if (!(e instanceof TunnelUnreachableError)) throw e;
            // The machine really is gone — the DNS record outlived it, or
            // kusal no longer runs there. THIS is the case the old code was
            // guarding against by re-listing every single time; it costs a
            // rediscovery when it happens, instead of taxing every launch.
            await Storage.removeItem(STORAGE_TUNNEL);
          }
        }
      }

      const session = await cloudflareAccount(!silent);
      // silent launch-time listing with no usable account session: nothing to
      // show and nothing to complain about — the login screen is already right
      if (!session) return;
      setMagicStep("Looking up your Cloudflare Tunnels…");
      const tunnels = await listCloudflareTunnels(session.accessToken);
      if (tunnels.length === 0) {
        throw new Error("No Cloudflare Tunnels found on your account. Run `kusal connect` on the device you want to access, then try again.");
      }
      setMagicStep(`Resolving ${tunnels.length} tunnel${tunnels.length === 1 ? "" : "s"}…`);
      // Every tunnel, and every hostname each one serves — a tunnel can route
      // more than one, and taking only the first made the list look like it had
      // searched a single domain. Nothing is filtered out: a tunnel that is
      // merely down is still the device the user wants, and whether a pick is
      // really kusal is settled at sign-in by verifyKusalBackend, which is the
      // only thing that can see past Access to the origin.
      const perTunnel = await Promise.all(
        tunnels.map(async (t) => {
          const routes = await getTunnelRoutes(session.accessToken, t.accountId, t.id).catch(() => []);
          const kusalName = t.name.startsWith("kusal-");
          // A connection that is mid-reconnect still reports the address it
          // dialled from, so the first non-empty value is the right one to
          // show rather than the first entry outright.
          const conns = t.connections || [];
          // Distinct because a healthy tunnel holds four connections and they
          // normally all dial out from the same address — listing that address
          // four times says nothing.
          const originIps = Array.from(new Set(conns.map((c) => c.originIp).filter(Boolean)));
          const base = {
            name: t.name,
            tunnelId: t.id,
            status: t.status || "unknown",
            accountName: t.accountName,
            originIp: originIps.find((ip) => !ip.includes(":")) || originIps[0] || "",
            originIps,
            colos: Array.from(new Set(conns.map((c) => c.colo).filter(Boolean))),
            clientVersion: conns.find((c) => c.clientVersion)?.clientVersion || "",
            activeSince: t.connsActiveAt,
            inactiveSince: t.connsInactiveAt,
            createdAt: t.createdAt,
          };
          if (routes.length === 0) {
            return [{ ...base, url: "", service: "", looksLikeKusal: kusalName, usable: false, reason: "no public hostname" }];
          }
          return Promise.all(
            routes.map(async (r) => {
              // The name is the reliable signal, not the service: `kusal
              // connect` always creates its tunnel as kusal-<device> (see
              // sanitizeTunnelName in internal/auth), so a tunnel without that
              // prefix was never made by kusal. Judging by "points at an HTTP
              // loopback port" instead let any local web service through — an
              // ssh box also forwarding http://localhost looked identical to a
              // real device, which is exactly what showed two machines as
              // ready to sign into when neither had kusal on it.
              const looksLikeKusal = kusalName;
              const url = normalizeUrl(r.hostname);
              let usable = true;
              let reason = "";
              // Cloudflare reports four tunnel states, and only two of them
              // mean "you cannot reach this machine".
              //
              // cloudflared opens FOUR HA connections to the edge. All four up
              // is `healthy`; any smaller number is `degraded`. A degraded
              // tunnel routes traffic perfectly well — it is carrying less
              // redundancy, not less service — and one connection failing to
              // hold is ordinary on a phone-tethered, VPN'd or CGNAT'd link.
              // Requiring `healthy` therefore disabled working machines and
              // told the user they were "not up", which was simply false.
              //
              // `down` (no connections) and `inactive` (never run) are the
              // states that genuinely have nothing behind them.
              const dead = t.status === "down" || t.status === "inactive" || !t.status;
              if (dead) {
                usable = false;
                reason = `tunnel not up (${t.status || "not connected"})`;
              } else if (!looksLikeKusal) {
                usable = false;
                reason = "kusal CLI not installed or not running";
              } else if (!(await probeTunnel(url))) {
                // DNS gone, or Cloudflare's 1033 for a hostname whose tunnel
                // died — either way there is nothing to sign into
                usable = false;
                reason = "hostname does not answer";
              }
              return { ...base, url, service: r.service, looksLikeKusal, usable, reason };
            })
          );
        })
      );
      const choices: TunnelChoice[] = perTunnel.flat();
      // kusal-looking and routable first; a tunnel with no hostname can be seen
      // but not entered, so it sinks to the bottom
      choices.sort(
        (a, b) =>
          (b.usable ? 1 : 0) - (a.usable ? 1 : 0) ||
          (b.looksLikeKusal ? 1 : 0) - (a.looksLikeKusal ? 1 : 0) ||
          a.name.localeCompare(b.name)
      );
      // Never auto-enter, not even with one result: signing in redirects
      // through Cloudflare Access for that specific hostname, and doing that
      // without being asked is how a stray tunnel swallowed the whole flow.
      setTunnelChoices(choices);
      // cached so the next launch has something to show without a live account
      // token — see the bootstrap branch that reads it back
      await Storage.setItem(STORAGE_TUNNEL_CHOICES, JSON.stringify(choices));
    } catch (e: any) {
      // a silent attempt that fails leaves the login screen as it was; only a
      // sign-in the user actually asked for gets to show an error
      if (!silent) setErr(e.message ? String(e.message).slice(0, 300) : "Could not sign in.");
    } finally {
      setChoicesLoaded(true);
      setMagicStep(null);
      if (!silent) setBusy(false);
    }
  }, [cloudflareAccount, performAccessLogin, restoreCachedChoices]);

  const pickTunnel = useCallback(async (url: string, tunnelId?: string) => {
    setBusy(true);
    setErr(null);
    // The list deliberately stays up. Clearing it here left the main screen
    // with neither a user nor anything to choose from, which is exactly the
    // state its guard reads as "not signed in" — so entering a device bounced
    // through the login screen and back before landing, and returning from
    // that device found an empty list. busy already disables the rows.
    await Storage.removeItem(STORAGE_SIGNED_OUT);
    try {
      await performAccessLogin(url);
      // signing in was a means to an end: the caller opens this machine rather
      // than dropping the user back on the list they just chose from
      if (tunnelId) setPickedTunnelId(tunnelId);
    } catch (e: any) {
      setErr(e.message ? String(e.message).slice(0, 300) : "Could not sign in.");
    } finally {
      setMagicStep(null);
      setBusy(false);
    }
  }, [performAccessLogin]);

  const logout = useCallback(async () => {
    try {
      if (tunnelUrl && token) await fetch(`${tunnelUrl}/api/auth/logout`, { method: "POST", headers: authHeaders(token, cfJwt) });
    } catch {}
    await Storage.removeItem(STORAGE_TOKEN);
    await Storage.removeItem(STORAGE_CF_JWT);
    await Storage.removeItem(STORAGE_EMAIL);
    // remembered across restarts: the next launch must land on the login
    // screen and wait to be asked, not re-authenticate on its own
    await Storage.setItem(STORAGE_SIGNED_OUT, "1");
    // the Cloudflare ACCOUNT session goes too: it is what lists every tunnel on
    // the account, so leaving it behind would mean a signed-out app could still
    // enumerate the user's infrastructure
    await Storage.removeItem(STORAGE_CF_ACCOUNT_TOKEN);
    await Storage.removeItem(STORAGE_CF_ACCOUNT_REFRESH);
    await Storage.removeItem(STORAGE_TUNNEL_CHOICES);
    // The paired hostname goes too. Signing in now takes a fast path straight
    // back into the remembered machine, which is exactly right for a session
    // that merely expired and exactly wrong after a deliberate sign-out —
    // "sign out" would have walked back into the same device it just left,
    // with no way to reach the chooser and pick a different one.
    await Storage.removeItem(STORAGE_TUNNEL);
    setTunnelChoices(null);
    setUser(null);
    setToken(null);
    setCfJwt("");
    setDevices([]);
    setDevicesLoaded(false);
  }, [tunnelUrl, token, cfJwt]);

  // bootstrap: try to silently restore the session using the stored Cloudflare
  // Access JWT — Access only recognizes its own JWT/cookie, not our app's
  // bearer token alone (verified directly: curl with just Authorization:
  // Bearer <token> against /api/auth/me comes back as a 302 to
  // *.cloudflareaccess.com, not JSON). The JWT is good until it expires
  // (bounded by the Access Application's session_duration, currently 24h);
  // once it does, fall through to an automatic (not silent, but not an extra
  // tap either) re-login using the hostname we already know.
  useEffect(() => {
    (async () => {
      try {
        const [storedToken, storedJwt, signedOut] = await Promise.all([
          Storage.getItem(STORAGE_TOKEN),
          Storage.getItem(STORAGE_CF_JWT),
          Storage.getItem(STORAGE_SIGNED_OUT),
        ]);
        const url = await storedTunnelUrl();
        if (!url) {
          // No device remembered — but the Cloudflare ACCOUNT session may still
          // be good, and that is what knows which devices exist. Listing them
          // here is what makes a reload land back on the chooser instead of on
          // a login button that would only ask the same question again. login()
          // reuses the stored account token, so this opens no browser; with no
          // account session it does nothing and the login screen stands.
          if (signedOut) return;
          // Show the last known list straight away — no token, no network, no
          // login screen. This is the fix for "why am I asked to sign in on
          // every start": the account token is short-lived and, with no
          // offline_access scope, comes with nothing to refresh it — but the
          // list it produced is still the right answer, and entering a device
          // from it goes through Access, not through that token.
          const storedEmail = await Storage.getItem(STORAGE_EMAIL);
          if (storedEmail) setAccountEmail(storedEmail);
          await restoreCachedChoices();
          setReady(true);
          // then quietly bring it up to date if the account session happens to
          // still be alive; silent means it never opens a browser by itself
          if (await Storage.getItem(STORAGE_CF_ACCOUNT_TOKEN)) await login({ silent: true, discover: true });
          return;
        }
        setTunnelUrl(url);
        // NOT stored here: discovery only proves Access is configured for the
        // hostname, and writing it back on every launch is what kept resurrecting
        // a removed device's address. Only a verified login stores it.
        // A stored session that no longer works is the ONLY case worth a silent
        // re-login: the hostname is known and Access will renew without a
        // prompt. With no stored session there is nothing to renew — this used
        // to fall through to login() anyway, which is why a fresh launch after
        // signing out walked straight back in (Access still holds its own
        // browser session, so that login needed no interaction).
        let staleSession = false;
        if (storedToken && storedJwt) {
          const me = await fetchMe(url, storedToken, storedJwt);
          if (me) {
            setUser(me);
            setToken(storedToken);
            setCfJwt(storedJwt);
            // A live session says which device is entered, not which devices
            // exist — that answer only ever came from Cloudflare, and this
            // path used to return without it.
            await restoreCachedChoices();
            setReady(true);
            // brought up to date in the background: silent, so no browser
            // opens by itself and the cached list stays tappable meanwhile
            if (await Storage.getItem(STORAGE_CF_ACCOUNT_TOKEN)) await login({ silent: true, discover: true });
            return;
          }
          await Storage.removeItem(STORAGE_TOKEN);
          await Storage.removeItem(STORAGE_CF_JWT);
          staleSession = true;
        }
        setReady(true);
        // and never renew a session the user ended themselves
        if (staleSession && !signedOut) await login();
        return;
      } finally {
        setReady(true);
        setChoicesLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First device load once a session exists; per-screen polling lives in the
  // device list route, which is the only screen that shows the dots.
  useEffect(() => {
    if (user && token && tunnelUrl) refreshDevices();
  }, [user, token, tunnelUrl, refreshDevices]);

  const clearPicked = useCallback(() => setPickedTunnelId(null), []);

  const deviceById = useCallback((id: string) => devices.find((d) => d.id === id), [devices]);

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      tunnelUrl,
      user,
      token,
      cfJwt,
      auth,
      devices,
      devicesLoaded,
      choicesLoaded,
      deviceById,
      refreshDevices,
      busy,
      magicStep,
      accountEmail,
      pickedTunnelId,
      clearPicked,
      err,
      tunnelChoices,
      login,
      pickTunnel,
      logout,
    }),
    [ready, tunnelUrl, user, token, cfJwt, auth, devices, devicesLoaded, deviceById, refreshDevices, busy, magicStep, accountEmail, pickedTunnelId, clearPicked, err, tunnelChoices, choicesLoaded, login, pickTunnel, logout]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
