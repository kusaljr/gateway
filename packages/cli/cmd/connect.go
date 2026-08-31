package cmd

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"kusal/internal/auth"
	"kusal/internal/awake"
	"kusal/internal/cfapi"
	"kusal/internal/config"
	"kusal/internal/db"
	"kusal/internal/shell"
	"kusal/internal/tunnel"
)

// rememberedDomain resolves the base domain to auto-route under, from what this
// device has actually used before. There is deliberately no built-in default:
// a baked-in domain means every install that omits --domain reaches for one
// specific account's zone, which can only fail for anyone else — and fail
// confusingly, naming a domain they have never heard of. With nothing
// remembered, connect skips auto-routing and prints the manual steps.
//
// public_hostname is the second source because it predates the `domain` key:
// an install from before that key existed has only the full hostname stored,
// and dropping the default must not silently un-route it.
// deviceLabel reduces a device name to ONE DNS label and marks what it is:
// <name>-ssh-local. One label, because that is all the hostname can be —
// <label>.<domain> under Cloudflare's Universal SSL, which certifies *.domain
// and nothing deeper. A dotted name silently produces a two-label host that
// resolves, routes, connects, and then fails TLS with no certificate at all,
// which is a miserable thing to debug.
//
// Not an edge case: os.Hostname() on macOS is always "<name>.local", so simply
// accepting the prompt's default was enough to hit it. The mDNS suffix is
// dropped rather than hyphenated — "yarsakusal" is the name meant — and the
// -ssh-local suffix is then added back deliberately, so the public hostname
// says what it is rather than looking like a bare machine name.
//
// Idempotent by necessity: the resolved name is stored and re-labelled on every
// connect, so a name that already carries the suffix must come back unchanged
// rather than growing one per run.
func deviceLabel(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, suffix := range []string{".local", ".lan", ".home", ".localdomain"} {
		name = strings.TrimSuffix(name, suffix)
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	label := strings.Trim(b.String(), "-")
	for strings.Contains(label, "--") {
		label = strings.ReplaceAll(label, "--", "-")
	}
	if label == "" {
		return ""
	}
	if !strings.HasSuffix(label, deviceLabelSuffix) {
		label += deviceLabelSuffix
	}
	if len(label) > 63 {
		label = strings.Trim(label[:63-len(deviceLabelSuffix)], "-") + deviceLabelSuffix
	}
	return label
}

const deviceLabelSuffix = "-ssh-local"

func rememberedDomain(storedDomain, storedHost, name string) string {
	if storedDomain != "" {
		return storedDomain
	}
	if name != "" && strings.HasPrefix(storedHost, name+".") {
		return strings.TrimPrefix(storedHost, name+".")
	}
	return ""
}

var connectCmd = &cobra.Command{
	Use:   "connect",
	Short: "Authenticate via Cloudflare Tunnel and expose bash",
	Long: `kusal connect will:
  1. Authenticate with Cloudflare (opens browser via cloudflared tunnel login)
  2. Auto-create or reuse a tunnel for this device (no token paste needed)
  3. Start local PTY shell server and launch cloudflared tunnel (backgrounded)

Multiple devices can run 'kusal connect' with the same Cloudflare account — each gets its own tunnel/hostname.
Protected by Cloudflare Access — only your account can reach the shell.`,
	RunE: runConnect,
}

func init() {
	rootCmd.AddCommand(connectCmd)
	connectCmd.Flags().String("token", "", "Cloudflare Tunnel token. If provided, browser flow is skipped")
	connectCmd.Flags().String("name", "", "Device name (defaults to hostname)")
	connectCmd.Flags().String("addr", "127.0.0.1:8080", "Local shell server address (host:port, :0 = random). Fixed by default so the Cloudflare dashboard Public Hostname route and the mobile app's local-discovery fallback stay valid across restarts.")
	connectCmd.Flags().String("domain", "", "Base domain to auto-route this device under, e.g. kusal.yourdomain.com -> creates <device-name>.<domain> via 'cloudflared tunnel route dns' on every connect. Point a wildcard Access Application at *.<domain> once in the Cloudflare dashboard and every device becomes reachable with zero further manual steps. Leave empty to skip auto-routing (prints the manual command instead, as before).")
	connectCmd.Flags().Bool("foreground", false, "Run in foreground (block terminal). Default is background.")
	connectCmd.Flags().Bool("allow-sleep", false, "Let the machine sleep while connected. Off by default: sleeping suspends the tunnel and the device goes unreachable.")
	connectCmd.Flags().Bool("internal-daemon", false, "Internal: daemon mode (do not use directly)")
	_ = connectCmd.Flags().MarkHidden("internal-daemon")
}

func runConnect(cmd *cobra.Command, _ []string) error {
	token, _ := cmd.Flags().GetString("token")
	nameFlag, _ := cmd.Flags().GetString("name")
	addrFlag, _ := cmd.Flags().GetString("addr")
	domainFlag, _ := cmd.Flags().GetString("domain")
	foreground, _ := cmd.Flags().GetBool("foreground")
	allowSleep, _ := cmd.Flags().GetBool("allow-sleep")
	isDaemon, _ := cmd.Flags().GetBool("internal-daemon")

	// If not daemon and not foreground, spawn daemon and exit (background by default)
	if !isDaemon && !foreground {
		return runConnectBackground(cmd, token, nameFlag, addrFlag, domainFlag, allowSleep)
	}

	// --- daemon / foreground path: actually run the server ---
	store, err := db.Open()
	if err != nil {
		return err
	}
	defer store.DB.Close()

	hostname, _ := os.Hostname()
	if nameFlag == "" {
		// A device name already exists from a prior connect -> this is a
		// reconnect, not a first-time setup. Reuse it silently instead of
		// prompting: asking again (with the raw OS hostname as the shown
		// default) invites hitting Enter on the WRONG value and minting a
		// differently-named tunnel with no route to the hostname already
		// live in Cloudflare — exactly the "why did my app break" bug this
		// replaces. Only a genuine first run (nothing stored yet) prompts.
		if stored := store.GetKV("device_name"); stored != "" {
			nameFlag = stored
		} else {
			nameFlag = auth.Prompt("Device name", deviceLabel(hostname))
		}
	}
	nameFlag = deviceLabel(nameFlag)
	if domainFlag == "" {
		domainFlag = rememberedDomain(store.GetKV("domain"), store.GetKV("public_hostname"), nameFlag)
	}

	if token == "" {
		// try env for daemon spawn
		token = os.Getenv("KUSAL_TUNNEL_TOKEN")
	}
	if token == "" {
		fmt.Println("\n→ Starting Cloudflare authentication (browser flow)...")
		fmt.Println("  No token provided — will authenticate via browser and auto-create tunnel.")
		tok, err := auth.AuthViaBrowser(nameFlag)
		if err != nil {
			return err
		}
		token = tok
	} else if !isDaemon {
		fmt.Println("→ Using provided --token (skipping browser auth)")
	}

	if token == "" {
		return fmt.Errorf("tunnel token is required")
	}

	tunnelID, accountID, err := auth.ParseTunnelToken(token)
	if err != nil {
		fmt.Printf("warning: could not parse token: %v (continuing)\n", err)
	}
	if tunnelID == "" {
		tunnelID = "unknown"
	}
	if !isDaemon {
		fmt.Printf("  -> tunnel: %s  account: %s\n", tunnelID, accountID)
	}

	localAddr := addrFlag
	if localAddr == "127.0.0.1:0" {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		localAddr = ln.Addr().String()
		ln.Close()
	}

	deviceID := store.GetKV("device_id")
	if deviceID == "" {
		deviceID = uuid.NewString()
		_ = store.SetKV("device_id", deviceID)
	}
	_ = store.SetKV("tunnel_token", token)
	_ = store.SetKV("tunnel_id", tunnelID)
	_ = store.SetKV("account_id", accountID)
	_ = store.SetKV("local_addr", localAddr)
	_ = store.SetKV("device_name", nameFlag)

	if err := store.UpsertDevice(db.Device{
		ID: deviceID, Name: nameFlag, Hostname: hostname,
		TunnelID: tunnelID, AccountID: accountID, Status: "connected",
	}); err != nil {
		return err
	}
	_ = config.EnsureDir()
	_ = os.WriteFile(config.ConfigPath(), []byte(fmt.Sprintf(`{"device_id":%q,"name":%q,"tunnel_id":%q,"account_id":%q,"local_addr":%q}`, deviceID, nameFlag, tunnelID, accountID, localAddr)), 0600)

	srv := shell.New(localAddr)
	go func() {
		if err := srv.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "shell server error: %v\n", err)
			os.Exit(1)
		}
	}()

	if !isDaemon {
		fmt.Println("\nStarting shell server on", localAddr)
		fmt.Println("Starting cloudflared tunnel...")
	}
	if err := tunnel.EnsureCloudflared(); err != nil {
		return err
	}
	_ = tunnel.Stop()
	proc, err := tunnel.Run(token, localAddr)
	if err != nil {
		return err
	}
	// A laptop that suspends takes the tunnel with it, and the phone just sees
	// a device that went unreachable for no stated reason. Held for as long as
	// this process serves; --allow-sleep opts out.
	stopAwake := func() {}
	if !allowSleep {
		stopAwake = awake.Keep()
	}
	defer stopAwake()
	// daemon also writes its own pid
	_ = os.WriteFile(filepath.Join(config.Dir(), "daemon.pid"), []byte(fmt.Sprintf("%d", os.Getpid())), 0600)

	// Domain automation needs a browser for the (one-time, then cached) Cloudflare
	// OAuth login, so it only runs where a TTY/desktop is actually available:
	// the direct `--foreground` path, and separately in runConnectBackground
	// (which has already done its own equivalent for the daemon spawn below).
	// The spawned daemon itself (isDaemon) never attempts this — matches how
	// tunnel-token resolution already avoids the background process.
	publicHostname := ""
	if !isDaemon && foreground {
		publicHostname = ensureDomainAutomation(store, nameFlag, domainFlag, tunnelID, accountID, localAddr)
	}

	if !isDaemon {
		fmt.Println("✓ cloudflared running (pid", proc.Process.Pid, ")")
		fmt.Println("✓ device", nameFlag, "exposed via Cloudflare Tunnel")
		if publicHostname != "" {
			fmt.Println("\n✓ Live at: https://" + publicHostname)
		} else if domainFlag != "" {
			fmt.Println("\n⚠ Domain automation did not complete — see warnings above.")
		} else {
			fmt.Println("\nIMPORTANT: In Cloudflare dashboard, add Public Hostname -> Service http://" + localAddr)
			fmt.Println("  Hostname example: " + nameFlag + ".yourdomain.com  -> http://" + localAddr)
			fmt.Println("  Protect it with Access policy: Allow only your Cloudflare account/email.")
			fmt.Println("  Or re-run with --domain <base> to auto-route this and every future connect.")
		}
		fmt.Println("Local shell (no tunnel): http://" + localAddr)
	}

	// foreground / daemon blocks until signal
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	fmt.Println("\nShutting down...")
	_ = tunnel.Stop()
	_ = os.Remove(filepath.Join(config.Dir(), "daemon.pid"))
	_ = store.UpdateStatus(deviceID, "disconnected")
	if proc.Process != nil {
		_ = proc.Process.Kill()
	}
	fmt.Println("disconnected.")
	return nil
}

// ensureDomainAutomation fully wires a device's public hostname: routes DNS,
// signs into the user's Cloudflare account via OAuth (cached in the local db
// after the first run, no browser needed on later connects), makes sure a
// wildcard Access Application exists, and points the tunnel's ingress at the
// local shell server. Only ever called where a browser can actually be opened
// for the one-time login — never from the background daemon itself. Returns
// "" on failures that leave nothing usable; callers fall back to printing
// manual instructions.
// cloudflareSession returns a Cloudflare dashboard token for this account,
// logging in through the browser once and remembering the result. Separate from
// its one former caller because choosing a domain needs the same token, and a
// second login prompt in one connect would be absurd.
func cloudflareSession(store *db.Store) (token, email string, err error) {
	if token, email, ok := storedCloudflareSession(store); ok {
		return token, email, nil
	}
	sess, err := auth.LoginToCloudflareAccount()
	if err != nil {
		return "", "", err
	}
	persistCloudflareSession(store, sess)
	return sess.AccessToken, sess.Email, nil
}

// storedCloudflareSession returns a WORKING token from the store, or reports
// that there is none. The stored token is checked rather than trusted: these
// dashboard tokens expire, and handing an expired one back made every API call
// fail identically forever — no re-run could recover, because the dead token
// was still sitting in the store. The refresh token kept at login is what
// avoids a browser trip; only when that fails too is a fresh sign-in needed.
//
// Never opens a browser itself, so teardown paths can use it without turning a
// delete into an interactive login.
func storedCloudflareSession(store *db.Store) (token, email string, ok bool) {
	token = store.GetKV("cf_access_token")
	if token == "" {
		return "", "", false
	}
	if email, err := auth.VerifyCloudflareToken(token); err == nil {
		return token, email, true
	}
	refresh := store.GetKV("cf_refresh_token")
	if refresh == "" {
		return "", "", false
	}
	sess, err := auth.RefreshCloudflareSession(refresh)
	if err != nil {
		fmt.Println("· Cloudflare session expired and could not be refreshed:", err)
		return "", "", false
	}
	persistCloudflareSession(store, sess)
	fmt.Println("· Cloudflare session refreshed")
	return sess.AccessToken, sess.Email, true
}

func persistCloudflareSession(store *db.Store, sess *auth.CloudflareSession) {
	_ = store.SetKV("cf_access_token", sess.AccessToken)
	_ = store.SetKV("cf_refresh_token", sess.RefreshToken)
	_ = store.SetKV("cf_email", sess.Email)
}

// promptForDomain asks which of the account's own domains to route this device
// under. It lists what Cloudflare actually reports rather than taking a typed
// string on faith: a domain that isn't a zone on this account cannot be routed,
// and finding that out here beats a DNS failure three steps later.
//
// An empty return means "no auto-routing" and is a normal outcome — the caller
// prints the manual dashboard steps. Returning early on an unreadable zone list
// keeps a broken token from looking like an empty account.
func promptForDomain(store *db.Store, accountID, name string) string {
	token, _, err := cloudflareSession(store)
	if err != nil {
		fmt.Println("⚠ Cloudflare login failed:", err)
		return ""
	}
	zones, err := cfapi.ListZones(token, accountID)
	if err != nil {
		fmt.Println("⚠ Could not list the domains on your Cloudflare account:", err)
		return ""
	}
	if len(zones) == 0 {
		fmt.Println()
		fmt.Println("This Cloudflare account has no domain, so there is no hostname to route to.")
		fmt.Println("  Add one (Cloudflare dashboard -> Add a domain) and re-run kusal connect.")
		fmt.Println("  A domain is what makes Cloudflare Access possible, and Access is what keeps")
		fmt.Println("  this shell private — kusal deliberately has no un-gated public mode.")
		return ""
	}

	fmt.Println()
	fmt.Println("Which domain should this device be reachable under?")
	for i, z := range zones {
		fmt.Printf("  %d) %s.%s\n", i+1, name, z.Name)
	}
	fmt.Println("  (Enter to skip and set the hostname up manually)")
	answer := auth.Prompt("Choice", "")
	if answer == "" {
		return ""
	}
	if n, err := strconv.Atoi(answer); err == nil {
		if n < 1 || n > len(zones) {
			fmt.Println("⚠ No such choice — skipping auto-routing.")
			return ""
		}
		return zones[n-1].Name
	}
	// a typed name is accepted, but only if the account really holds it
	for _, z := range zones {
		if strings.EqualFold(answer, z.Name) {
			return z.Name
		}
	}
	fmt.Printf("⚠ %q is not a domain on this Cloudflare account — skipping auto-routing.\n", answer)
	return ""
}

// verifyPublicHostname actually fetches what connect is about to print. Routing
// DNS and ingress says the configuration was accepted, not that anything can
// reach it — and a "✓ Live at" line for a hostname that fails TLS sends people
// hunting through the app, the tunnel and the daemon for a problem that a single
// request would have named.
//
// Behind Cloudflare Access an unauthenticated request is redirected to the
// Access login rather than reaching the origin, so any HTTP response at all is
// success here. What this catches is the layer below: no certificate, no DNS,
// nothing listening — and Cloudflare's own 1033 for a hostname whose tunnel has
// no connector.
func verifyPublicHostname(hostname string) error {
	client := &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	// the tunnel and its DNS record are seconds old; give propagation a moment
	// rather than reporting a failure that fixes itself
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		resp, err := client.Get("https://" + hostname + "/health")
		if err == nil {
			defer resp.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			if bytes.Contains(body, []byte("Error 1033")) || bytes.Contains(body, []byte("Argo Tunnel error")) {
				return fmt.Errorf("Cloudflare returned 1033 — the hostname is routed to a tunnel with no connector")
			}
			return nil
		}
		lastErr = err
		time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
	}
	return lastErr
}

func ensureDomainAutomation(store *db.Store, nameFlag, domainFlag, tunnelID, accountID, localAddr string) string {
	if domainFlag == "" {
		domainFlag = promptForDomain(store, accountID, nameFlag)
	}
	if domainFlag == "" {
		return ""
	}
	hostname := nameFlag + "." + domainFlag
	wildcard := "*." + domainFlag

	// Persisted up front, not after the last remote call: with no built-in
	// default, a --domain that is only remembered on full success means every
	// failed run forgets it and the next bare connect silently skips routing.
	_ = store.SetKV("domain", domainFlag)

	// idempotent (--overwrite-dns) — safe to run on every connect.
	if err := tunnel.RouteDNS(tunnelID, hostname); err != nil {
		fmt.Println("⚠ DNS route failed:", err)
		return ""
	}

	cfToken, cfEmail, err := cloudflareSession(store)
	if err != nil {
		fmt.Println("⚠ Cloudflare login failed:", err)
		fmt.Println("  DNS is routed, but the Access Application + tunnel routing still need manual setup:")
		fmt.Println("  Cloudflare dashboard -> Zero Trust -> Access -> Applications -> Add ->", wildcard)
		return ""
	}
	if cfEmail == "" {
		fmt.Println("⚠ Could not determine your Cloudflare account email — skipping Access Application setup.")
		return ""
	}

	zoneID, err := cfapi.GetZoneID(cfToken, accountID, hostname)
	if err != nil {
		fmt.Println("⚠ Could not find the Cloudflare zone for", hostname+":", err)
		fmt.Println("  Set up the Access Application manually: Cloudflare dashboard -> Zero Trust -> Access -> Applications -> Add ->", wildcard)
	} else {
		appID, created, err := cfapi.EnsureWildcardAccessApp(cfToken, zoneID, wildcard, "kusal", cfEmail)
		if err != nil {
			fmt.Println("⚠ Access Application setup failed:", err)
			fmt.Println("  Set one up manually: Cloudflare dashboard -> Zero Trust -> Access -> Applications -> Add ->", wildcard)
		} else if created {
			fmt.Printf("✓ Created Access Application for %s (policy: email is %s)\n", wildcard, cfEmail)
		} else {
			fmt.Printf("✓ Access Application already covers %s (id %s)\n", wildcard, appID)
			// An app created by an older kusal carries a 24h session, which is
			// a sign-in every single day on every device. Raising it is only
			// possible here, on a run that already holds a working token.
			if changed, err := cfapi.EnsureAccessSessionDuration(cfToken, zoneID, appID); err != nil {
				// Reported, never fatal: the app exists and protects the
				// hostname, which is what connect actually needs. Staying quiet
				// about it is what made a failed bump indistinguishable from a
				// successful one.
				fmt.Println("⚠ Could not extend the Access session duration:", err)
				fmt.Println("  Sessions stay as they were — set it by hand at Zero Trust -> Access -> Applications ->", wildcard)
			} else if changed {
				fmt.Println("✓ Access sessions extended to 1 month (was shorter — you were signing in far more often than needed)")
			}
		}
	}

	if err := cfapi.SetTunnelIngress(cfToken, accountID, tunnelID, hostname, "http://"+localAddr); err != nil {
		fmt.Println("⚠ Tunnel ingress setup failed:", err)
		return ""
	}
	fmt.Println("✓ Tunnel routed:", hostname, "->", localAddr)

	if err := verifyPublicHostname(hostname); err != nil {
		fmt.Println("⚠ Routed, but the hostname does not answer yet:", err)
		if strings.Count(strings.TrimSuffix(hostname, "."+domainFlag), ".") > 0 {
			fmt.Println("  That name is more than one label under " + domainFlag + ", and Cloudflare's")
			fmt.Println("  Universal SSL covers only *." + domainFlag + " — one label. A multi-level host")
			fmt.Println("  gets no certificate at all, so TLS fails before HTTP. Use a single-label")
			fmt.Println("  device name (hyphens are fine), or add Advanced Certificate Manager.")
		}
		fmt.Println("  Everything above is configured; only reaching it failed.")
		return ""
	}

	_ = store.SetKV("public_hostname", hostname)
	return hostname
}

func runConnectBackground(cmd *cobra.Command, token, nameFlag, addrFlag, domainFlag string, allowSleep bool) error {
	// Same reconnect-continuity fallback as the foreground path: prefer the
	// device name and domain persisted from the last successful connect over
	// prompting fresh / silently skipping domain automation, so a bare
	// `kusal connect` after `kusal disconnect` lands on the same hostname
	// instead of quietly standing up a new, unrouted device identity.
	var storedName, storedDomain, storedHost string
	if st, err := db.Open(); err == nil {
		storedName = st.GetKV("device_name")
		storedDomain = st.GetKV("domain")
		storedHost = st.GetKV("public_hostname")
		st.DB.Close()
	}

	hostname, _ := os.Hostname()
	if nameFlag == "" {
		// see matching comment in runConnect — reuse silently on reconnect,
		// only prompt on a genuine first-time setup.
		if storedName != "" {
			nameFlag = storedName
		} else {
			nameFlag = auth.Prompt("Device name", deviceLabel(hostname))
		}
	}
	nameFlag = deviceLabel(nameFlag)
	if domainFlag == "" {
		domainFlag = rememberedDomain(storedDomain, storedHost, nameFlag)
	}
	// Resolve token now so daemon doesn't need interactive browser in background
	// (daemon would hang without tty). Do auth in foreground, then hand off.
	if token == "" {
		token = os.Getenv("KUSAL_TUNNEL_TOKEN")
	}
	if token == "" {
		fmt.Println("\n→ Starting Cloudflare authentication (browser flow)...")
		tok, err := auth.AuthViaBrowser(nameFlag)
		if err != nil {
			return err
		}
		token = tok
	}
	if token == "" {
		return fmt.Errorf("tunnel token is required")
	}
	tunnelID, accountID, _ := auth.ParseTunnelToken(token)
	if tunnelID == "" {
		tunnelID = "unknown"
	}
	fmt.Printf("  -> tunnel: %s  account: %s\n", tunnelID, accountID)

	localAddr := addrFlag
	if localAddr == "127.0.0.1:0" {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		localAddr = ln.Addr().String()
		ln.Close()
	}

	// Persist before daemon so status is correct (daemon will re-persist)
	store, err := db.Open()
	if err != nil {
		return err
	}
	deviceID := store.GetKV("device_id")
	if deviceID == "" {
		deviceID = uuid.NewString()
		_ = store.SetKV("device_id", deviceID)
	}
	store.DB.Close()

	// Spawn daemon
	_ = config.EnsureDir()
	logFile := filepath.Join(config.Dir(), "daemon.log")
	lf, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer lf.Close()

	args := []string{"connect", "--internal-daemon", "--name", nameFlag, "--addr", localAddr}
	if domainFlag != "" {
		args = append(args, "--domain", domainFlag)
	}
	if allowSleep {
		args = append(args, "--allow-sleep")
	}
	daemon := exec.Command(os.Args[0], args...)
	daemon.Env = append(os.Environ(), "KUSAL_TUNNEL_TOKEN="+token)
	daemon.Stdout = lf
	daemon.Stderr = lf
	daemon.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := daemon.Start(); err != nil {
		return fmt.Errorf("failed to start background daemon: %w", err)
	}
	_ = os.WriteFile(filepath.Join(config.Dir(), "daemon.pid"), []byte(fmt.Sprintf("%d", daemon.Process.Pid)), 0600)

	// Wait briefly and check health + frontend
	fmt.Println("\nStarting shell server on", localAddr, " (background)")
	fmt.Println("Starting cloudflared tunnel in background...")

	// Poll for readiness (up to 5s)
	for i := 0; i < 25; i++ {
		if daemon.ProcessState != nil && daemon.ProcessState.Exited() {
			fmt.Println("✗ daemon exited early — check", logFile)
			b, _ := os.ReadFile(logFile)
			if len(b) > 0 {
				tail := string(b)
				if len(tail) > 1200 {
					tail = tail[len(tail)-1200:]
				}
				fmt.Println(tail)
			}
			return fmt.Errorf("daemon failed")
		}
		// check http health
		if _, err := net.Dial("tcp", localAddr); err == nil {
			break
		}
		// tiny sleep
		syscall.Select(0, nil, nil, nil, &syscall.Timeval{Sec: 0, Usec: 200000})
	}

	fmt.Println()
	fmt.Println("✓ Connection successful — running in background")
	fmt.Printf("  daemon pid %d, log %s\n", daemon.Process.Pid, logFile)
	fmt.Printf("  shell: http://%s  (frontend if built)\n", localAddr)
	fmt.Printf("  tunnel: cloudflared pid via %s/tunnel.pid\n", config.Dir())
	fmt.Println()
	publicHostname := ""
	{
		// runs here (has a TTY for the one-time Cloudflare login and the domain
		// choice), not in the daemon — same reasoning as the tunnel-token
		// resolution above.
		if st, err := db.Open(); err == nil {
			publicHostname = ensureDomainAutomation(st, nameFlag, domainFlag, tunnelID, accountID, localAddr)
			st.DB.Close()
		}
	}
	if publicHostname != "" {
		fmt.Println("  Access your shell at: https://" + publicHostname)
	} else {
		fmt.Println("  Access your shell at: https://" + nameFlag + ".yourdomain.com  (after adding Public Hostname in Cloudflare dashboard)")
		fmt.Println("  Dashboard: add Public Hostname -> Service http://" + localAddr + " -> Protect with Access policy")
		fmt.Println("  Or re-run with --domain <base> to auto-route this and every future connect.")
	}
	fmt.Println()
	fmt.Println("  Useful:")
	fmt.Println("    kusal status        # tunnel + log tail")
	fmt.Println("    kusal disconnect    # stop background tunnel + shell")
	fmt.Println("    cat", logFile, "    # daemon log")
	fmt.Println("    cat ~/.kusal/cloudflared.log  # tunnel log")
	fmt.Println()
	fmt.Println("  Terminal is free — daemon keeps running.")
	return nil
}
