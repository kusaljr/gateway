package shell

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"kusal/internal/agentusage"
	"kusal/internal/auth"
	"kusal/internal/cfapi"
	"kusal/internal/cliagent"
	"kusal/internal/db"
	"kusal/internal/opencode"
)

// commonDevPorts are probed for the preview panel — typical local dev-server ports.
var commonDevPorts = []int{3000, 3001, 5173, 5174, 4200, 8080, 8000, 4000, 5000, 9000}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Server struct {
	Addr  string
	Shell string
}

func New(addr string) *Server {
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/bash"
	}
	return &Server{Addr: addr, Shell: sh}
}

func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/api/auth/me", s.handleAuthMe)
	mux.HandleFunc("/api/auth/login", s.handleAuthLogin)
	mux.HandleFunc("/api/auth/logout", s.handleAuthLogout)
	mux.HandleFunc("/api/auth/cloudflare/callback", s.handleCloudflareCallback)
	mux.HandleFunc("/api/auth/app-return", s.handleAppReturn)
	mux.HandleFunc("/api/devices", s.handleDevices)
	mux.HandleFunc("/api/sessions", s.handleSessions)
	mux.HandleFunc("/api/sessions/", s.handleSession)
	mux.HandleFunc("/api/projects", s.handleProjects)
	mux.HandleFunc("/api/projects/", s.handleProject)
	mux.HandleFunc("/api/models", s.handleModels)
	mux.HandleFunc("/api/providers", s.handleProviders)
	mux.HandleFunc("/api/usage", s.handleUsage)
	mux.HandleFunc("/api/agent/prompt", s.handleAgentPrompt)
	mux.HandleFunc("/api/agent/messages", s.handleAgentMessages)
	mux.HandleFunc("/api/fs/list", s.handleFsList)
	mux.HandleFunc("/api/fs/search", s.handleFsSearch)
	mux.HandleFunc("/api/opencode/", s.handleOpencodeProxy)
	mux.HandleFunc("/api/git/diff", s.handleGitDiff)
	mux.HandleFunc("/api/preview/ports", s.handlePreviewPorts)

	// Serve frontend dist if exists (packages/web/dist)
	// Try multiple locations: ./packages/web/dist, ../web/dist, ./dist
	candidates := []string{
		filepath.Join("packages", "web", "dist"),
		filepath.Join("..", "web", "dist"),
		filepath.Join(".", "dist"),
		filepath.Join(filepath.Dir(os.Args[0]), "..", "packages", "web", "dist"),
	}
	var frontendDir string
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			frontendDir = c
			break
		}
	}
	if frontendDir != "" {
		log.Printf("serving frontend from %s", frontendDir)
		fs := http.FileServer(http.Dir(frontendDir))
		mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// API/ws already handled; fallthrough to static
			if r.URL.Path == "/ws" || len(r.URL.Path) >= 4 && r.URL.Path[:4] == "/api" {
				http.NotFound(w, r)
				return
			}
			// vite content-hashes filenames under /assets/, so those are safe to
			// cache forever; index.html (and any other non-hashed route) must always
			// revalidate or browsers can get stuck serving a stale SPA build.
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			// SPA fallback: serve index.html for non-file routes
			path := filepath.Join(frontendDir, filepath.Clean(r.URL.Path))
			if _, err := os.Stat(path); os.IsNotExist(err) {
				http.ServeFile(w, r, filepath.Join(frontendDir, "index.html"))
				return
			}
			fs.ServeHTTP(w, r)
		}))
	} else {
		mux.HandleFunc("/", s.handleIndex)
	}

	log.Printf("shell server listening on %s (shell=%s) frontend=%q", s.Addr, s.Shell, frontendDir)
	return http.ListenAndServe(s.Addr, mux)
}

// ── Cloudflare Tunnel + Access Auth ────────────────────────────────────────

// handleAuthMe returns the current user if a valid Cloudflare Access JWT header
// or a prior kusal_session cookie is present. When behind a real Cloudflare
// Tunnel + Access, Cloudflare injects Cf-Access-Jwt-Assertion and
// Cf-Access-Authenticated-User-Email — we honour those first so remote access
// "just works" without an extra login step. Locally we fall back to the cookie.
func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	} else {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	// 1) Real Cloudflare Access headers (when behind Zero Trust)
	if email := r.Header.Get("Cf-Access-Authenticated-User-Email"); email != "" {
		_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "email": email, "provider": "cloudflare", "via": "cf-header"})
		return
	}
	if email := r.Header.Get("CF-Access-Authenticated-User-Email"); email != "" {
		_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "email": email, "provider": "cloudflare", "via": "cf-header"})
		return
	}
	if jwt := r.Header.Get("Cf-Access-Jwt-Assertion"); jwt != "" {
		// In production validate JWT against Cloudflare certs; here we decode email from payload for demo
		if email := emailFromCFJWT(jwt); email != "" {
			_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "email": email, "provider": "cloudflare", "via": "cf-jwt"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "email": "cloudflare-user@access", "provider": "cloudflare", "via": "cf-jwt"})
		return
	}
	// 2) Cookie session (local mock or post-login)
	if c, err := r.Cookie("kusal_session"); err == nil && c.Value != "" {
		store, _ := db.Open()
		if store != nil {
			defer store.DB.Close()
			if email := store.GetKV("auth_session:" + c.Value); email != "" {
				_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "email": email, "provider": "cloudflare", "via": "cookie"})
				return
			}
		}
		// also allow bare token that IS the email (dev fallback)
		if isEmail(c.Value) || len(c.Value) > 10 {
			_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "email": c.Value, "provider": "cloudflare", "via": "cookie-raw"})
			return
		}
	}
	// 3) Authorization: Bearer <token> (mobile)
	if auth := r.Header.Get("Authorization"); len(auth) > 7 && auth[:7] == "Bearer " {
		tok := auth[7:]
		store, _ := db.Open()
		if store != nil {
			defer store.DB.Close()
			if email := store.GetKV("auth_session:" + tok); email != "" {
				_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "email": email, "provider": "cloudflare", "via": "bearer"})
				return
			}
		}
	}
	w.WriteHeader(401)
	_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": false})
}

// isLocalRequest reports whether r originated from this same machine (loopback).
// Used to gate the unverified-email fallback paths below: convenient for same-box
// dev use, but must never accept an arbitrary client-submitted email from the LAN
// or the internet — those callers must go through real Cloudflare Access instead.
func isLocalRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func accessVerifiedEmail(r *http.Request) string {
	if e := r.Header.Get("Cf-Access-Authenticated-User-Email"); e != "" {
		return e
	}
	return r.Header.Get("CF-Access-Authenticated-User-Email")
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	} else {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type, authorization")
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	// Access already verified this request before it reached us — trust that
	// over anything the client body claims.
	email := accessVerifiedEmail(r)
	if email == "" {
		// No Access header means this request didn't come through the tunnel's
		// Access policy. Only same-machine dev use is allowed to self-assert an
		// email here — anyone on the LAN or internet must go through Access.
		if !isLocalRequest(r) {
			http.Error(w, "authentication required", 401)
			return
		}
		var req struct {
			Email    string `json:"email"`
			Token    string `json:"token"`
			Provider string `json:"provider"`
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &req)
		email = strings.TrimSpace(req.Email)
		// Allow Cloudflare Access JWT token as login: decode email from it
		if email == "" && req.Token != "" {
			email = emailFromCFJWT(req.Token)
			if email == "" {
				// token might be plain email in dev
				if isEmail(req.Token) {
					email = req.Token
				}
			}
		}
	}
	if !isEmail(email) {
		http.Error(w, "valid email required", 400)
		return
	}
	// create session
	sid := uuid.NewString()
	store, err := db.Open()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer store.DB.Close()
	_ = store.SetKV("auth_session:"+sid, email)
	_ = store.SetKV("auth_user_email", email)
	http.SetCookie(w, &http.Cookie{Name: "kusal_session", Value: sid, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 86400 * 30})
	_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "email": email, "token": sid, "provider": "cloudflare"})
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	} else {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	if c, err := r.Cookie("kusal_session"); err == nil && c.Value != "" {
		if store, err := db.Open(); err == nil {
			_, _ = store.DB.Exec(`DELETE FROM kv WHERE key=?`, "auth_session:"+c.Value)
			store.DB.Close()
		}
	}
	http.SetCookie(w, &http.Cookie{Name: "kusal_session", Value: "", Path: "/", MaxAge: -1})
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// handleCloudflareCallback is where the app lands after a Cloudflare Access login.
// The whole origin sits behind Access, so by the time this request reaches Go at
// all, Cloudflare's edge has already authenticated the user and attached the
// Cf-Access-Authenticated-User-Email header — this handler never talks to
// Cloudflare itself, it only reads what the edge already verified.
//
// Mobile passes ?redirect_uri=<app-scheme>://... (e.g. via expo-web-browser's
// openAuthSessionAsync): we hand the session token back as a query param on that
// URI, since a mobile fetch() client can't pick up the HttpOnly web cookie. Web
// callers omit redirect_uri and get the classic cookie + redirect to "/".
// handleAppReturn is an https landing page whose only job is to jump to the
// app's own URL scheme.
//
// Redirecting straight from the Access callback to exp:// or kusal:// looks
// correct and fails in practice: an in-app browser treats a 302 to an unknown
// scheme as a navigation it cannot perform and renders its own "page isn't
// working" error, so the login appears to break at the very last hop. Coming
// from a real page on the same https origin, the scheme jump is a link the
// browser will follow, and the manual link below covers the case where even
// that is blocked.
func (s *Server) handleAppReturn(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	to := q.Get("to")
	if to == "" {
		http.Error(w, "missing to", 400)
		return
	}
	u, err := url.Parse(to)
	if err != nil {
		http.Error(w, "invalid to", 400)
		return
	}
	// carry everything the callback attached (token, email, cf_jwt) onto the
	// app link, minus the routing parameter itself
	target := u.Query()
	for k, vals := range q {
		if k == "to" {
			continue
		}
		for _, v := range vals {
			target.Set(k, v)
		}
	}
	u.RawQuery = target.Encode()

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = fmt.Fprintf(w, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing in…</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;color:#3f3f46}a{color:#ea580c}</style>
<p>Returning to kusal… <a id="go" href="%s">open the app</a></p>
<script>location.replace(%s)</script>`, htmlEscape(u.String()), jsString(u.String()))
}

func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}

func jsString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

func (s *Server) handleCloudflareCallback(w http.ResponseWriter, r *http.Request) {
	// Access-verified header wins over anything the caller claims in the query
	// string — a ?email= param alone proves nothing and must not be trusted
	// from the LAN or internet. Query fallback only for same-machine dev use.
	email := accessVerifiedEmail(r)
	if email == "" && isLocalRequest(r) {
		email = r.URL.Query().Get("email")
		tok := r.URL.Query().Get("token")
		if tok != "" && email == "" {
			email = emailFromCFJWT(tok)
		}
	}
	if email == "" {
		http.Error(w, "missing email — this endpoint expects to be reached behind Cloudflare Access", 400)
		return
	}
	sid := uuid.NewString()
	if store, err := db.Open(); err == nil {
		_ = store.SetKV("auth_session:"+sid, email)
		store.DB.Close()
	}
	// The bearer session token above is only meaningful to OUR backend — Access
	// itself has never heard of it, so it re-challenges every plain fetch() that
	// carries only that header. Access DOES recognize its own JWT (this is the
	// same token Access just used to authenticate this very request), so hand it
	// back too: the client attaches it as Cf-Access-Jwt-Assertion on future
	// requests and Access lets them straight through instead of redirecting to
	// login again — good until the JWT expires (bounded by the Access
	// Application's session_duration).
	accessJWT := r.Header.Get("Cf-Access-Jwt-Assertion")

	if redirectURI := r.URL.Query().Get("redirect_uri"); redirectURI != "" {
		u, err := url.Parse(redirectURI)
		if err != nil {
			http.Error(w, "invalid redirect_uri", 400)
			return
		}
		q := u.Query()
		q.Set("token", sid)
		q.Set("email", email)
		if accessJWT != "" {
			q.Set("cf_jwt", accessJWT)
		}
		u.RawQuery = q.Encode()
		http.Redirect(w, r, u.String(), 302)
		return
	}

	http.SetCookie(w, &http.Cookie{Name: "kusal_session", Value: sid, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 86400 * 30})
	http.Redirect(w, r, "/", 302)
}

func isEmail(s string) bool {
	return len(s) > 3 && len(s) < 254 && bytes.Contains([]byte(s), []byte("@"))
}

func emailFromCFJWT(jwt string) string {
	parts := bytes.Split([]byte(jwt), []byte("."))
	if len(parts) != 3 {
		// plain base64 maybe
		if dec, err := base64.RawURLEncoding.DecodeString(jwt); err == nil {
			var m map[string]any
			if json.Unmarshal(dec, &m) == nil {
				if e, _ := m["email"].(string); e != "" {
					return e
				}
			}
		}
		return ""
	}
	payload := parts[1]
	// pad
	if m := len(payload) % 4; m != 0 {
		payload = append(payload, bytes.Repeat([]byte("="), 4-m)...)
	}
	dec, err := base64.URLEncoding.DecodeString(string(payload))
	if err != nil {
		dec, err = base64.RawURLEncoding.DecodeString(string(parts[1]))
		if err != nil {
			return ""
		}
	}
	var data map[string]any
	if json.Unmarshal(dec, &data) != nil {
		return ""
	}
	if e, _ := data["email"].(string); e != "" {
		return e
	}
	if e, _ := data["sub"].(string); e != "" && isEmail(e) {
		return e
	}
	return ""
}

var (
	devicesCacheMu      sync.Mutex
	devicesCacheAt      time.Time
	devicesCachePayload []byte
)

func (s *Server) handleDevices(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	devicesCacheMu.Lock()
	if devicesCachePayload != nil && time.Since(devicesCacheAt) < 8*time.Second {
		payload := devicesCachePayload
		devicesCacheMu.Unlock()
		_, _ = w.Write(payload)
		return
	}
	devicesCacheMu.Unlock()

	store, err := db.Open()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer store.DB.Close()

	devs, _ := store.ListDevices()
	if devs == nil {
		devs = []db.Device{}
	}

	// Retrieve or refresh Cloudflare session token from local store
	cfToken := store.GetKV("cf_access_token")
	if cfToken != "" {
		if _, err := auth.VerifyCloudflareToken(cfToken); err != nil {
			if refresh := store.GetKV("cf_refresh_token"); refresh != "" {
				if sess, err := auth.RefreshCloudflareSession(refresh); err == nil {
					cfToken = sess.AccessToken
					_ = store.SetKV("cf_access_token", sess.AccessToken)
					if sess.RefreshToken != "" {
						_ = store.SetKV("cf_refresh_token", sess.RefreshToken)
					}
					if sess.Email != "" {
						_ = store.SetKV("cf_email", sess.Email)
					}
				}
			}
		}
	}

	if cfToken != "" {
		accountID := store.GetKV("account_id")
		if accountID == "" {
			accounts, err := cfapi.ListAccounts(cfToken)
			if err == nil && len(accounts) > 0 {
				accountID = accounts[0].ID
				_ = store.SetKV("account_id", accountID)
			}
		}

		if accountID != "" {
			tunnels, err := cfapi.ListTunnels(cfToken, accountID)
			if err == nil {
				byTunnelID := make(map[string]int)
				byName := make(map[string]int)
				for i, d := range devs {
					if d.TunnelID != "" {
						byTunnelID[d.TunnelID] = i
					}
					if d.Name != "" {
						byName[strings.ToLower(d.Name)] = i
					}
				}

				for _, t := range tunnels {
					status := "disconnected"
					if t.Status == "healthy" || len(t.Connections) > 0 {
						status = "connected"
					}
					cleanName := strings.TrimPrefix(t.Name, "kusal-")
					cleanNameLower := strings.ToLower(cleanName)

					matchIdx := -1
					if idx, ok := byTunnelID[t.ID]; ok {
						matchIdx = idx
					} else if idx, ok := byName[cleanNameLower]; ok {
						matchIdx = idx
					}

					if matchIdx >= 0 {
						devs[matchIdx].Status = status
						if devs[matchIdx].TunnelID == "" {
							devs[matchIdx].TunnelID = t.ID
						}
						if devs[matchIdx].Hostname == "" {
							if hostnames, err := cfapi.GetTunnelHostnames(cfToken, accountID, t.ID); err == nil && len(hostnames) > 0 {
								devs[matchIdx].Hostname = hostnames[0]
							}
						}
						if t.ConnsActiveAt != "" {
							if ts, err := time.Parse(time.RFC3339, t.ConnsActiveAt); err == nil {
								devs[matchIdx].LastSeen = ts
							}
						}
						_ = store.UpsertDevice(devs[matchIdx])
					} else {
						hostname := t.Name
						if hostnames, err := cfapi.GetTunnelHostnames(cfToken, accountID, t.ID); err == nil && len(hostnames) > 0 {
							hostname = hostnames[0]
						}
						lastSeen := time.Now()
						if t.ConnsActiveAt != "" {
							if ts, err := time.Parse(time.RFC3339, t.ConnsActiveAt); err == nil {
								lastSeen = ts
							}
						}
						createdAt := time.Now()
						if t.CreatedAt != "" {
							if ts, err := time.Parse(time.RFC3339, t.CreatedAt); err == nil {
								createdAt = ts
							}
						}
						newDev := db.Device{
							ID:        t.ID,
							Name:      cleanName,
							Hostname:  hostname,
							TunnelID:  t.ID,
							AccountID: accountID,
							Status:    status,
							CreatedAt: createdAt,
							LastSeen:  lastSeen,
						}
						_ = store.UpsertDevice(newDev)
						devs = append(devs, newDev)
						byTunnelID[t.ID] = len(devs) - 1
						byName[cleanNameLower] = len(devs) - 1
					}
				}
			}
		}
	}

	sort.Slice(devs, func(i, j int) bool {
		if (devs[i].Status == "connected") != (devs[j].Status == "connected") {
			return devs[i].Status == "connected"
		}
		return devs[i].LastSeen.After(devs[j].LastSeen)
	})

	encoded, err := json.Marshal(devs)
	if err == nil {
		devicesCacheMu.Lock()
		devicesCachePayload = encoded
		devicesCacheAt = time.Now()
		devicesCacheMu.Unlock()
		_, _ = w.Write(encoded)
		return
	}

	_ = json.NewEncoder(w).Encode(devs)
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	store, err := db.Open()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer store.DB.Close()

	if r.Method == "POST" {
		var req struct {
			Title     string `json:"title"`
			Cwd       string `json:"cwd"`
			Path      string `json:"path"`
			ProjectID string `json:"project_id"`
			Branch    string `json:"branch"`
			Model     string `json:"model"`
			Provider  string `json:"provider"`
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &req)
		if req.Title == "" {
			req.Title = "New session"
		}
		projectID := req.ProjectID
		cwd := req.Cwd
		if cwd == "" {
			cwd = req.Path
		}
		if cwd == "" {
			if wd, err := os.Getwd(); err == nil {
				cwd = wd
			} else {
				cwd = "."
			}
		}
		cwd = filepath.Clean(expandHome(cwd))
		if projectID == "" {
			deviceID := store.GetKV("device_id")
			proj, err := store.EnsureProject(cwd, deviceID)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			projectID = proj.ID
		}
		provider := req.Provider
		if provider == "" {
			provider = "opencode"
		}
		// try to create backing opencode session so chat has real agent history
		sessionID := uuid.NewString()
		if err := opencode.EnsureRunning(cwd); err == nil {
			// attempt opencode session create; reuse its id if success
			if ocID := tryCreateOpencodeSession(req.Title, cwd); ocID != "" {
				sessionID = ocID
			}
		}
		sess := db.Session{
			ID:        sessionID,
			ProjectID: projectID,
			Title:     req.Title,
			Provider:  provider,
			Status:    "idle",
			Model:     req.Model,
			Cwd:       cwd,
			Branch:    req.Branch,
		}
		if err := store.CreateSession(sess); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		_, _ = store.DB.Exec(`UPDATE projects SET updated_at=CURRENT_TIMESTAMP WHERE id=?`, projectID)
		_ = store.TouchSession(sess.ID)
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": sess.ID})
		return
	}

	// GET — sqlite-backed sessions, not agent/chat history
	sessions, _ := store.ListSessions()
	if sessions == nil {
		sessions = []db.Session{}
	}
	type outSess struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		Provider  string `json:"provider"`
		Status    string `json:"status"`
		Model     string `json:"model"`
		Cwd       string `json:"cwd"`
		Branch    string `json:"branch"`
		UpdatedAt string `json:"updatedAt"`
		ProjectID string `json:"project_id"`
		Archived  bool   `json:"archived"`
	}
	var out []outSess
	for _, se := range sessions {
		updated := se.UpdatedAt
		if updated.IsZero() {
			updated = se.CreatedAt
		}
		if updated.IsZero() {
			updated = time.Now()
		}
		out = append(out, outSess{
			ID:        se.ID,
			Title:     se.Title,
			Provider:  se.Provider,
			Status:    se.Status,
			Model:     se.Model,
			Cwd:       se.Cwd,
			Branch:    se.Branch,
			UpdatedAt: updated.Format(time.RFC3339),
			ProjectID: se.ProjectID,
			Archived:  se.ArchivedAt != nil,
		})
	}
	if out == nil {
		out = []outSess{}
	}
	_ = json.NewEncoder(w).Encode(out)
}

// handleSession serves /api/sessions/{id}: DELETE removes a thread (and its
// opencode history when the ids line up), PATCH archives or restores it.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "DELETE, PATCH, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}

	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/sessions/"), "/")
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "session id required", 400)
		return
	}

	store, err := db.Open()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer store.DB.Close()

	switch r.Method {
	case http.MethodDelete:
		if err := store.DeleteSession(id); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		// the sqlite row reuses the opencode session id when opencode created
		// it, so drop the agent history too — best effort, the row is gone
		// either way.
		deleteOpencodeSession(id)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "deleted": true})
	case http.MethodPatch:
		var req struct {
			Archived *bool   `json:"archived"`
			Status   *string `json:"status"`
			Title    *string `json:"title"`
			Model    *string `json:"model"`
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &req)
		if req.Archived != nil {
			if err := store.SetSessionArchived(id, *req.Archived); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}
		if req.Status != nil {
			if err := store.UpdateSessionStatus(id, *req.Status); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}
		if req.Model != nil {
			if err := store.UpdateSessionModel(id, strings.TrimSpace(*req.Model)); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}
		if req.Title != nil {
			title := strings.TrimSpace(*req.Title)
			if title == "" {
				http.Error(w, "title cannot be empty", 400)
				return
			}
			if err := store.UpdateSessionTitle(id, title); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			// keep the agent history's title in step when opencode owns the id
			renameOpencodeSession(id, title)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "ok": true})
	default:
		http.Error(w, "method not allowed", 405)
	}
}

func renameOpencodeSession(id, title string) {
	body, _ := json.Marshal(map[string]string{"title": title})
	req, err := http.NewRequest(http.MethodPatch, "http://127.0.0.1:4096/session/"+id, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}

func deleteOpencodeSession(id string) {
	req, err := http.NewRequest(http.MethodDelete, "http://127.0.0.1:4096/session/"+id, nil)
	if err != nil {
		return
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}

func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	store, err := db.Open()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer store.DB.Close()

	if r.Method == "POST" {
		var req struct {
			Path string `json:"path"`
			Name string `json:"name"`
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &req)
		if req.Path == "" {
			if wd, err := os.Getwd(); err == nil {
				req.Path = wd
			} else {
				req.Path = "."
			}
		}
		req.Path = filepath.Clean(expandHome(req.Path))
		deviceID := store.GetKV("device_id")
		proj, err := store.EnsureProject(req.Path, deviceID)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if req.Name != "" && req.Name != proj.Name {
			_, _ = store.DB.Exec(`UPDATE projects SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, req.Name, proj.ID)
			proj.Name = req.Name
		}
		_ = json.NewEncoder(w).Encode(proj)
		return
	}

	projects, _ := store.ListProjects()
	if projects == nil {
		projects = []db.Project{}
	}
	// ensure at least one project exists for empty fresh DB — auto-create from cwd
	if len(projects) == 0 {
		if wd, err := os.Getwd(); err == nil {
			deviceID := store.GetKV("device_id")
			if proj, err := store.EnsureProject(wd, deviceID); err == nil {
				projects = []db.Project{*proj}
			}
		}
	}
	_ = json.NewEncoder(w).Encode(projects)
}

// handleModels serves /api/models: one flattened list spanning every chat
// backend, so the clients' model picker doesn't need to know how many there
// are. opencode's own providers come from its /config/providers (the shape
// the clients used to flatten themselves); agy's models are appended under a
// synthetic "agy" providerID, which is also what routes a thread to it.
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	type outModel struct {
		ProviderID string `json:"providerID"`
		ModelID    string `json:"modelID"`
		Label      string `json:"label"`
	}
	out := struct {
		Models     []outModel `json:"models"`
		DefaultKey string     `json:"defaultKey"`
	}{Models: []outModel{}}

	directory := r.URL.Query().Get("directory")
	if directory == "" {
		directory = "."
	}
	if err := opencode.EnsureRunning(directory); err == nil {
		if raw, err := fetchOpencodeProviders(directory); err == nil {
			for _, p := range raw.Providers {
				for id, m := range p.Models {
					label := m.Name
					if label == "" {
						label = id
					}
					out.Models = append(out.Models, outModel{ProviderID: p.ID, ModelID: id, Label: p.Name + " · " + label})
				}
			}
			for provider, model := range raw.Default {
				out.DefaultKey = provider + "/" + model
				break
			}
		}
	}
	// stable ordering — opencode returns models as an unordered JSON object,
	// so without this the picker reshuffles on every fetch
	sort.Slice(out.Models, func(i, j int) bool {
		if out.Models[i].ProviderID != out.Models[j].ProviderID {
			return out.Models[i].ProviderID < out.Models[j].ProviderID
		}
		return out.Models[i].ModelID < out.Models[j].ModelID
	})

	for _, b := range cliagent.Installed() {
		for _, m := range b.Models() {
			out.Models = append(out.Models, outModel{ProviderID: b.Name(), ModelID: m.ID, Label: b.Name() + " · " + m.Label})
		}
	}
	if out.DefaultKey == "" && len(out.Models) > 0 {
		out.DefaultKey = out.Models[0].ProviderID + "/" + out.Models[0].ModelID
	}
	_ = json.NewEncoder(w).Encode(out)
}

// handleProviders serves /api/providers: which coding-agent CLIs are installed
// on THIS device and whether each looks signed in. Necessarily per-device — the
// request arrives through this machine's own tunnel, so the answer can only
// ever describe the machine answering it, which is why the hostname ships with
// it rather than being inferred client-side.
//
// Nothing here runs an agent or reads a credential's contents out to the
// client: cliagent.Probe reports only a location (see cliagent/auth.go).
func (s *Server) handleProviders(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	host, _ := os.Hostname()
	out := struct {
		Hostname  string            `json:"hostname"`
		Providers []cliagent.Status `json:"providers"`
	}{Hostname: host, Providers: cliagent.Statuses()}
	// opencode is the built-in backend rather than one of the CLI agents, but
	// it's a provider like any other from the client's point of view.
	out.Providers = append(out.Providers, opencodeStatus())
	_ = json.NewEncoder(w).Encode(out)
}

// opencodeStatus mirrors cliagent.Statuses() for opencode itself. Its auth
// probe is deliberately inconclusive: older builds kept credentials in
// auth.json under the data dir, current ones keep them in opencode.db, and a
// database we don't own is not something to guess about — "unknown" beats
// telling someone to log in again.
func shellLookPath(bin string) (string, error) {
	if p, err := exec.LookPath(bin); err == nil {
		return p, nil
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, dir := range []string{
			filepath.Join(home, ".opencode", "bin"),
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "bin"),
			filepath.Join(home, ".npm-global", "bin"),
		} {
			cand := filepath.Join(dir, bin)
			if st, err := os.Stat(cand); err == nil && !st.IsDir() && st.Mode().Perm()&0111 != 0 {
				return cand, nil
			}
		}
	}
	return "", exec.ErrNotFound
}

func opencodeStatus() cliagent.Status {
	st := cliagent.Status{Name: "opencode", Label: "opencode", Bin: "opencode"}
	path, err := shellLookPath(st.Bin)
	if err != nil {
		return st
	}
	st.Installed, st.Path = true, path
	st.Auth, st.Source = cliagent.Probe{
		Files: []cliagent.CredFile{
			{Path: ".local/share/opencode/auth.json"},
			{Path: ".config/opencode/auth.json"},
		},
		Envs: []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"},
	}.Check()
	return st
}

// ── usage ──────────────────────────────────────────────────────────────────

// usageCache keeps the last answer briefly: collecting means one request per
// recent thread against opencode, and a client that re-reads on every focus (or
// a pull-to-refresh held down) shouldn't turn that into a stampede.
var usageCache struct {
	mu      sync.Mutex
	at      time.Time
	days    int
	payload []byte
}

const usageCacheTTL = 45 * time.Second

// handleUsage serves /api/usage?days=N: per-day, per-provider and per-model
// token totals for this DEVICE — not only for threads kusal drove.
//
// Two sources, merged. opencode is asked over its own API (see
// opencode/usage.go). The agent CLIs are read from the history each one already
// keeps on disk (see agentusage), which is what makes this device-wide: a turn
// typed straight into a terminal counts exactly like one sent from the phone. A
// CLI that records no counts at all is named with its reason rather than
// reported as a zero.
//
// Necessarily per-device, exactly like /api/providers: the numbers describe the
// machine that answered, which is why its hostname ships with them.
func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	days := 14
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			days = n
		}
	}

	usageCache.mu.Lock()
	if usageCache.payload != nil && usageCache.days == days && time.Since(usageCache.at) < usageCacheTTL {
		payload := usageCache.payload
		usageCache.mu.Unlock()
		_, _ = w.Write(payload)
		return
	}
	usageCache.mu.Unlock()

	// opencode's own accounting. A machine can legitimately have no opencode
	// running, so a failure here degrades to "no opencode rows" instead of a
	// 502 — the agent CLIs below are counted either way.
	var oc *opencode.Usage
	ocErr := ""
	if err := opencode.EnsureRunning("."); err != nil {
		ocErr = err.Error()
	} else if u, err := opencode.Collect(days); err != nil {
		ocErr = err.Error()
	} else {
		oc = u
	}

	var cache agentusage.FileCache
	if store, err := db.Open(); err == nil {
		defer store.DB.Close()
		cache = &usageFileCache{store: store}
	}
	agentRows, unmetered := agentusage.Collect(days, cache)

	out := buildUsage(days, oc, agentRows, unmetered)
	out.Hostname, _ = os.Hostname()
	if ocErr != "" {
		out.OpencodeError = truncate(ocErr, 200)
	}

	payload, err := json.Marshal(out)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	usageCache.mu.Lock()
	usageCache.at, usageCache.days, usageCache.payload = time.Now(), days, payload
	usageCache.mu.Unlock()
	_, _ = w.Write(payload)
}

// usageFileCache adapts the DB-backed cache to what agentusage wants, keeping
// the JSON encoding of the rows on this side of the boundary.
type usageFileCache struct{ store *db.Store }

func (c *usageFileCache) Get(path string, size, mtime int64) ([]agentusage.Row, bool) {
	raw, ok := c.store.GetUsageFile(path, size, mtime)
	if !ok {
		return nil, false
	}
	var rows []agentusage.Row
	if json.Unmarshal([]byte(raw), &rows) != nil {
		return nil, false
	}
	return rows, true
}

func (c *usageFileCache) Put(path string, size, mtime int64, rows []agentusage.Row) {
	blob, err := json.Marshal(rows)
	if err != nil {
		return
	}
	c.store.PutUsageFile(path, size, mtime, string(blob))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ── usage response assembly ────────────────────────────────────────────────

type usageTokens struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	Reasoning  int64 `json:"reasoning"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
	Total      int64 `json:"total"`
}

func (t *usageTokens) addOC(o opencode.Tokens) {
	t.Input += o.Input
	t.Output += o.Output
	t.Reasoning += o.Reasoning
	t.CacheRead += o.CacheRead
	t.CacheWrite += o.CacheWrite
	t.Total += o.Total
}

func (t *usageTokens) addAgent(o agentusage.Tokens) {
	t.Input += o.Input
	t.Output += o.Output
	t.Reasoning += o.Reasoning
	t.CacheRead += o.CacheRead
	t.CacheWrite += o.CacheWrite
	t.Total += o.Total
}

type usageDay struct {
	Date   string      `json:"date"`
	Tokens usageTokens `json:"tokens"`
	Cost   float64     `json:"cost"`
	// opencode turns plus one per accounted CLI entry
	Messages         int `json:"messages"`
	UnpricedMessages int `json:"unpriced_messages"`
}

type usageProvider struct {
	Provider string      `json:"provider"`
	Tokens   usageTokens `json:"tokens"`
	Cost     float64     `json:"cost"`
	Messages int         `json:"messages"`
	Models   int         `json:"models"`
	// false when the provider reports no price of its own — a CLI on the user's
	// own subscription, where any dollar figure would be invented
	Priced bool `json:"priced"`
}

type usageModel struct {
	Key      string      `json:"key"`
	Provider string      `json:"provider"`
	Model    string      `json:"model"`
	Tokens   usageTokens `json:"tokens"`
	Cost     float64     `json:"cost"`
	Messages int         `json:"messages"`
}

type usageResponse struct {
	Hostname  string          `json:"hostname"`
	From      string          `json:"from"`
	To        string          `json:"to"`
	Days      []usageDay      `json:"days"`
	Providers []usageProvider `json:"providers"`
	Models    []usageModel    `json:"models"`
	Tokens    usageTokens     `json:"tokens"`
	Cost      float64         `json:"cost"`
	Messages  int             `json:"messages"`
	// counted turns that carried no price — subscription and free models
	UnpricedMessages int `json:"unpriced_messages"`
	SessionsScanned  int `json:"sessions_scanned"`
	// installed CLIs that keep no counts to read, with the reason
	Unmetered     []agentusage.Unmetered `json:"unmetered"`
	OpencodeError string                 `json:"opencode_error,omitempty"`
	Source        string                 `json:"source"`
}

// buildUsage folds both sources onto one day axis. Every date in the window
// gets a row even when nothing ran, so a chart can plot a continuous axis
// without inventing the gaps itself.
func buildUsage(days int, oc *opencode.Usage, agentRows []agentusage.Row, unmetered []agentusage.Unmetered) *usageResponse {
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(days - 1))

	out := &usageResponse{
		From:      start.Format("2006-01-02"),
		To:        now.Format("2006-01-02"),
		Unmetered: unmetered,
		Source:    "opencode + agent CLI history",
	}
	if out.Unmetered == nil {
		out.Unmetered = []agentusage.Unmetered{}
	}

	byDay := map[string]*usageDay{}
	byProvider := map[string]*usageProvider{}
	byModel := map[string]*usageModel{}
	modelsPer := map[string]map[string]bool{}

	day := func(date string) *usageDay {
		d := byDay[date]
		if d == nil {
			d = &usageDay{Date: date}
			byDay[date] = d
		}
		return d
	}
	provider := func(name string, priced bool) *usageProvider {
		p := byProvider[name]
		if p == nil {
			p = &usageProvider{Provider: name, Priced: priced}
			byProvider[name] = p
		}
		return p
	}
	model := func(providerID, modelID string) *usageModel {
		key := providerID + "/" + modelID
		m := byModel[key]
		if m == nil {
			m = &usageModel{Key: key, Provider: providerID, Model: modelID}
			byModel[key] = m
		}
		if modelsPer[providerID] == nil {
			modelsPer[providerID] = map[string]bool{}
		}
		modelsPer[providerID][modelID] = true
		return m
	}

	if oc != nil {
		out.SessionsScanned = oc.SessionsScanned
		for _, d := range oc.Days {
			if d.Messages == 0 {
				continue
			}
			t := day(d.Date)
			t.Tokens.addOC(d.Tokens)
			t.Cost += d.Cost
			t.Messages += d.Messages
			t.UnpricedMessages += d.UnpricedMessage
		}
		for _, p := range oc.Providers {
			pr := provider(p.Provider, true)
			pr.Tokens.addOC(p.Tokens)
			pr.Cost += p.Cost
			pr.Messages += p.Messages
		}
		for _, m := range oc.Models {
			mm := model(m.Provider, m.Model)
			mm.Tokens.addOC(m.Tokens)
			cost := m.Cost
			if cost == 0 && m.Tokens.Total > 0 {
				cost = agentusage.EstimateCost(m.Provider, m.Model, agentusage.Tokens{
					Input:      m.Tokens.Input,
					Output:     m.Tokens.Output,
					Reasoning:  m.Tokens.Reasoning,
					CacheRead:  m.Tokens.CacheRead,
					CacheWrite: m.Tokens.CacheWrite,
					Total:      m.Tokens.Total,
				})
			}
			mm.Cost += cost
			mm.Messages += m.Messages
		}
	}

	for _, r := range agentRows {
		t := day(r.Date)
		t.Tokens.addAgent(r.Tokens)
		t.Messages += r.Turns
		t.UnpricedMessages += r.Turns

		estCost := agentusage.EstimateCost(r.Provider, r.Model, r.Tokens)
		t.Cost += estCost

		pr := provider(r.Provider, true)
		pr.Tokens.addAgent(r.Tokens)
		pr.Cost += estCost
		pr.Messages += r.Turns

		mm := model(r.Provider, r.Model)
		mm.Tokens.addAgent(r.Tokens)
		mm.Cost += estCost
		mm.Messages += r.Turns
	}

	for d := start; !d.After(now); d = d.AddDate(0, 0, 1) {
		date := d.Format("2006-01-02")
		t := byDay[date]
		if t == nil {
			out.Days = append(out.Days, usageDay{Date: date})
			continue
		}
		out.Days = append(out.Days, *t)
		out.Tokens.Input += t.Tokens.Input
		out.Tokens.Output += t.Tokens.Output
		out.Tokens.Reasoning += t.Tokens.Reasoning
		out.Tokens.CacheRead += t.Tokens.CacheRead
		out.Tokens.CacheWrite += t.Tokens.CacheWrite
		out.Tokens.Total += t.Tokens.Total
		out.Cost += t.Cost
		out.Messages += t.Messages
		out.UnpricedMessages += t.UnpricedMessages
	}

	out.Providers = make([]usageProvider, 0, len(byProvider))
	for _, p := range byProvider {
		p.Models = len(modelsPer[p.Provider])
		out.Providers = append(out.Providers, *p)
	}
	sort.Slice(out.Providers, func(i, j int) bool {
		if out.Providers[i].Tokens.Total != out.Providers[j].Tokens.Total {
			return out.Providers[i].Tokens.Total > out.Providers[j].Tokens.Total
		}
		return out.Providers[i].Provider < out.Providers[j].Provider
	})

	out.Models = make([]usageModel, 0, len(byModel))
	for _, m := range byModel {
		out.Models = append(out.Models, *m)
	}
	sort.Slice(out.Models, func(i, j int) bool {
		if out.Models[i].Tokens.Total != out.Models[j].Tokens.Total {
			return out.Models[i].Tokens.Total > out.Models[j].Tokens.Total
		}
		return out.Models[i].Key < out.Models[j].Key
	})
	return out
}

type opencodeProviders struct {
	Providers []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Models map[string]struct {
			Name string `json:"name"`
		} `json:"models"`
	} `json:"providers"`
	Default map[string]string `json:"default"`
}

func fetchOpencodeProviders(directory string) (*opencodeProviders, error) {
	u := "http://127.0.0.1:4096/config/providers?directory=" + url.QueryEscape(directory)
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("providers: %d", resp.StatusCode)
	}
	var raw opencodeProviders
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return &raw, nil
}

// agyRuns guards against a second turn being started while one is still
// streaming for the same session — these agents are a process per turn, and
// two concurrent ones would interleave into the same transcript row.
var agentRuns sync.Map // sessionID -> struct{}

// handleAgentPrompt starts one turn of a CLI agent (agy, cline) in the
// background and returns immediately. There's no streaming endpoint because
// none of them offers an SSE equivalent — clients poll /api/agent/messages,
// which they already do for opencode threads anyway.
func (s *Server) handleAgentPrompt(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	var req struct {
		Backend   string `json:"backend"`
		SessionID string `json:"session_id"`
		Model     string `json:"model"`
		Text      string `json:"text"`
		Directory string `json:"directory"`
	}
	body, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(body, &req)
	if req.SessionID == "" || strings.TrimSpace(req.Text) == "" {
		http.Error(w, "session_id and text are required", 400)
		return
	}
	backend := cliagent.Get(req.Backend)
	if backend == nil {
		http.Error(w, "unknown agent backend: "+req.Backend, 400)
		return
	}
	if !cliagent.IsInstalled(backend) {
		http.Error(w, backend.Bin()+" is not installed on this device", 503)
		return
	}
	if _, busy := agentRuns.LoadOrStore(req.SessionID, struct{}{}); busy {
		http.Error(w, "this thread is already running a turn", 409)
		return
	}

	store, err := db.Open()
	if err != nil {
		agentRuns.Delete(req.SessionID)
		http.Error(w, err.Error(), 500)
		return
	}
	st := store.AgyState(req.SessionID)
	var prior []cliagent.Message
	if st.Messages != "" {
		_ = json.Unmarshal([]byte(st.Messages), &prior)
	}
	// mark it running for pollers before the goroutine has produced anything
	_ = store.SaveAgyState(req.SessionID, st.ConversationID, st.Messages, true)
	_ = store.UpdateSessionProvider(req.SessionID, backend.Name())
	_ = store.UpdateSessionStatus(req.SessionID, "working")
	store.DB.Close()

	go func() {
		defer agentRuns.Delete(req.SessionID)
		persist := func(conversationID string, messages []cliagent.Message, running bool) {
			blob, err := json.Marshal(messages)
			if err != nil {
				return
			}
			// a short-lived handle per write: this goroutine outlives the
			// request, and every other handler opens its own store too
			if st, err := db.Open(); err == nil {
				_ = st.SaveAgyState(req.SessionID, conversationID, string(blob), running)
				st.DB.Close()
			}
		}
		convID, runErr := cliagent.Run(backend, req.SessionID, req.Directory, req.Model, st.ConversationID, req.Text, prior,
			func(conversationID string, messages []cliagent.Message) {
				persist(conversationID, messages, true)
			})
		// final write flips running off so the client stops showing a spinner
		if final, err := db.Open(); err == nil {
			cur := final.AgyState(req.SessionID)
			_ = final.SaveAgyState(req.SessionID, convID, cur.Messages, false)
			status := "idle"
			if runErr != nil {
				status = "failed"
				log.Printf("%s run failed for session %s: %v", backend.Name(), req.SessionID, runErr)
			}
			_ = final.UpdateSessionStatus(req.SessionID, status)
			final.DB.Close()
		}
	}()

	w.WriteHeader(202)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// handleAgentMessages serves GET /api/agent/messages?session_id= — the stored
// transcript in the same shape opencode's /session/{id}/message returns, plus
// a `running` flag standing in for opencode's session.status events.
func (s *Server) handleAgentMessages(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		http.Error(w, "session_id required", 400)
		return
	}
	store, err := db.Open()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer store.DB.Close()
	st := store.AgyState(sessionID)
	messages := json.RawMessage("[]")
	if st.Messages != "" {
		messages = json.RawMessage(st.Messages)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"messages": messages, "running": st.Running})
}

// handleProject serves /api/projects/{id}: PATCH renames it, DELETE removes
// it (its sessions are kept, just detached — see db.DeleteProject).
func (s *Server) handleProject(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "DELETE, PATCH, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}

	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "project id required", 400)
		return
	}

	store, err := db.Open()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer store.DB.Close()

	switch r.Method {
	case http.MethodDelete:
		if err := store.DeleteProject(id); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "deleted": true})
	case http.MethodPatch:
		var req struct {
			Name *string `json:"name"`
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &req)
		if req.Name == nil || strings.TrimSpace(*req.Name) == "" {
			http.Error(w, "name cannot be empty", 400)
			return
		}
		if _, err := store.DB.Exec(`UPDATE projects SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, strings.TrimSpace(*req.Name), id); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "ok": true})
	default:
		http.Error(w, "method not allowed", 405)
	}
}

// expandHome turns a leading ~ into the user's home directory, so a path typed
// in the web project picker (~/projects/my-app) lands on the same absolute path
// the rest of the app stores.
func expandHome(p string) string {
	if p == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
		return p
	}
	if len(p) >= 2 && p[0] == '~' && (p[1] == '/' || p[1] == '\\') {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

// directories that never hold anything worth mentioning in a prompt
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "build": true, "out": true,
	".next": true, ".turbo": true, ".venv": true, "venv": true, "__pycache__": true,
	"target": true, "vendor": true, ".cache": true, "coverage": true, ".idea": true,
}

// handleFsSearch backs the composer's `@` file mentions: a bounded walk of the
// thread's cwd, ranked so path-prefix and basename matches surface first.
func (s *Server) handleFsSearch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	root := expandHome(r.URL.Query().Get("path"))
	if root == "" {
		if wd, err := os.Getwd(); err == nil {
			root = wd
		} else {
			root = "."
		}
	}
	root = filepath.Clean(root)
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		http.Error(w, "not a directory: "+root, 404)
		return
	}

	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	limit := 40
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}

	type hit struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		Rel   string `json:"rel"`
		IsDir bool   `json:"isDir"`
		score int    `json:"-"`
	}
	var hits []hit
	// hard ceilings so a huge tree can't stall the request
	const maxVisit = 20000
	visited := 0

	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		visited++
		if visited > maxVisit {
			return filepath.SkipAll
		}
		name := d.Name()
		if path != root && strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if path != root && skipDirs[name] {
				return filepath.SkipDir
			}
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		lowerRel, lowerName := strings.ToLower(rel), strings.ToLower(name)
		score := 0
		switch {
		case query == "":
			score = 3
		case lowerName == query:
			score = 0
		case strings.HasPrefix(lowerName, query):
			score = 1
		case strings.HasPrefix(lowerRel, query):
			score = 2
		case strings.Contains(lowerName, query):
			score = 3
		case strings.Contains(lowerRel, query):
			score = 4
		default:
			return nil
		}
		hits = append(hits, hit{Name: name, Path: path, Rel: rel, IsDir: false, score: score})
		return nil
	})

	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score < hits[j].score
		}
		if len(hits[i].Rel) != len(hits[j].Rel) {
			return len(hits[i].Rel) < len(hits[j].Rel)
		}
		return hits[i].Rel < hits[j].Rel
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	if hits == nil {
		hits = []hit{}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"cwd": root, "entries": hits})
}

func (s *Server) handleFsList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	q := r.URL.Query().Get("path")
	if q == "" {
		if home, err := os.UserHomeDir(); err == nil {
			q = home
		} else {
			q = "."
		}
	}
	// expand ~/ like t3code's filesystem browse (~/projects/my-app)
	q = expandHome(q)
	clean := filepath.Clean(q)
	// prevent listing root sensitive? allow but limit to home and /Users for now
	st, err := os.Stat(clean)
	if err != nil {
		http.Error(w, "not found: "+clean, 404)
		return
	}
	dir := clean
	if !st.IsDir() {
		dir = filepath.Dir(clean)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	type item struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		IsDir bool   `json:"isDir"`
	}
	var out []item
	for _, e := range entries {
		// skip hidden dotfiles for cleaner list, but keep .? maybe not
		if len(e.Name()) > 0 && e.Name()[0] == '.' {
			continue
		}
		if !e.IsDir() {
			continue
		}
		out = append(out, item{Name: e.Name(), Path: filepath.Join(dir, e.Name()), IsDir: true})
	}
	if out == nil {
		out = []item{}
	}
	// sort already by ReadDir alphabetical
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"cwd":     dir,
		"entries": out,
	})
}

func runGit(cwd string, args ...string) string {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	out, _ := cmd.CombinedOutput()
	return string(out)
}

// handleGitDiff returns the real working-tree diff (tracked changes vs HEAD, plus
// untracked files rendered as pseudo-diffs) for the given project directory —
// backs the right-panel Diff tab.
func (s *Server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		if wd, err := os.Getwd(); err == nil {
			cwd = wd
		}
	}

	if out := runGit(cwd, "rev-parse", "--is-inside-work-tree"); strings.TrimSpace(out) != "true" {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"cwd": cwd, "isRepo": false, "branch": "", "diff": "", "untracked": "",
		})
		return
	}

	branch := strings.TrimSpace(runGit(cwd, "rev-parse", "--abbrev-ref", "HEAD"))
	diff := runGit(cwd, "diff", "HEAD", "--no-color")
	if strings.Contains(diff, "unknown revision or path not in the working tree") || strings.Contains(diff, "ambiguous argument 'HEAD'") {
		// fresh repo with no commits yet — diff the index instead
		diff = runGit(cwd, "diff", "--no-color", "--cached")
	}

	var untracked strings.Builder
	for _, line := range strings.Split(runGit(cwd, "status", "--porcelain=v1"), "\n") {
		if !strings.HasPrefix(line, "??") {
			continue
		}
		f := strings.TrimSpace(line[2:])
		untracked.WriteString(runGit(cwd, "diff", "--no-color", "--no-index", "--", os.DevNull, f))
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"cwd":       cwd,
		"isRepo":    true,
		"branch":    branch,
		"diff":      diff,
		"untracked": untracked.String(),
	})
}

// handlePreviewPorts probes common local dev-server ports so the Preview tab can
// offer a real, running app instead of a placeholder.
func (s *Server) handlePreviewPorts(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	type portInfo struct {
		Port int  `json:"port"`
		Open bool `json:"open"`
	}
	out := make([]portInfo, len(commonDevPorts))
	var wg sync.WaitGroup
	for i, p := range commonDevPorts {
		i, p := i, p
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", p), 200*time.Millisecond)
			if err == nil {
				conn.Close()
			}
			out[i] = portInfo{Port: p, Open: err == nil}
		}()
	}
	wg.Wait()
	_ = json.NewEncoder(w).Encode(out)
}

func tryCreateOpencodeSession(title, directory string) string {
	body, _ := json.Marshal(map[string]string{"title": title})
	// opencode scopes a session to a directory; without it every thread would
	// run against whatever cwd the server happened to boot in
	target := "http://127.0.0.1:4096/session"
	if directory != "" {
		target += "?directory=" + url.QueryEscape(directory)
	}
	resp, err := http.Post(target, "application/json", bytes.NewReader(body))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ""
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return ""
	}
	return out.ID
}

func (s *Server) handleOpencodeProxy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")

	// lazily boot the device's opencode server on first use
	if err := opencode.EnsureRunning("."); err != nil {
		http.Error(w, "opencode unavailable: "+err.Error(), 502)
		return
	}

	prefix := "/api/opencode"
	path := r.URL.Path
	if len(path) >= len(prefix) {
		path = path[len(prefix):]
	}
	if path == "" {
		path = "/"
	}
	target := "http://127.0.0.1:4096" + path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	req, _ := http.NewRequest(r.Method, target, r.Body)
	for k, v := range r.Header {
		switch http.CanonicalHeaderKey(k) {
		case "Connection", "Keep-Alive", "Proxy-Connection", "Te", "Trailer", "Transfer-Encoding", "Upgrade", "Accept-Encoding", "Host":
			// hop-by-hop, plus Accept-Encoding: a gzipped /event stream would
			// arrive in compressed blocks and stall the live updates
			continue
		default:
			req.Header[k] = v
		}
	}
	req.Header.Set("Accept-Encoding", "identity")
	// no client timeout: /event is a long-lived SSE stream
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		http.Error(w, "opencode not running (run: opencode serve)", 502)
		return
	}
	defer resp.Body.Close()
	for k, v := range resp.Header {
		w.Header()[k] = v
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
	}
	w.WriteHeader(resp.StatusCode)

	// stream (SSE /event needs flushing per chunk)
	flusher, canFlush := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *Server) handleIndex(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, `<!doctype html><title>kusal shell</title>
<style>body{margin:0;background:#0e0e0e;color:#d4d4d4;font-family:monospace}#term{padding:12px;white-space:pre-wrap;word-break:break-all;min-height:100vh;outline:none}</style>
<div id=term tabindex=0></div>
<script>
const term=document.getElementById('term');
const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
term.focus();
function print(s){ term.textContent+=s; window.scrollTo(0,document.body.scrollHeight); }
ws.onmessage=e=>print(e.data);
term.addEventListener('keydown',e=>{
  const k=e.key;
  if(k.length===1) ws.send(k);
  else if(k==='Enter') ws.send('\r');
  else if(k==='Backspace') ws.send('\x7f');
  else if(k==='Tab') ws.send('\t');
  else if(k==='ArrowUp') ws.send('\x1b[A');
  else if(k==='ArrowDown') ws.send('\x1b[B');
  else if(k==='ArrowRight') ws.send('\x1b[C');
  else if(k==='ArrowLeft') ws.send('\x1b[D');
  e.preventDefault();
});
ws.onopen=()=>print('connected to kusal shell\r\nFrontend not built: run pnpm --filter @kusal/web build\r\n');
ws.onclose=()=>print('\r\n[disconnected]\r\n');
</script>`)
}

// ptyControl is the JSON side-channel the browser uses on the same socket:
// everything else on the wire is raw keystrokes.
type ptyControl struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

const (
	ptyPingInterval = 25 * time.Second
	ptyReadTimeout  = 70 * time.Second
)

// handleWS bridges a real PTY to the browser terminal: `?cwd=` picks the
// working directory, `?cols=`/`?rows=` seed the window size, and
// {"type":"resize"} frames keep it in step as the pane is dragged. Output goes
// out as binary frames so a UTF-8 rune split across reads can't corrupt text.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	q := r.URL.Query()
	cwd := expandHome(q.Get("cwd"))
	if cwd != "" {
		if st, err := os.Stat(cwd); err != nil || !st.IsDir() {
			cwd = ""
		}
	}
	if cwd == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cwd = home
		}
	}
	cols, rows := uint16(atoiDefault(q.Get("cols"), 80)), uint16(atoiDefault(q.Get("rows"), 24))

	shellPath := s.Shell
	if shellPath == "" {
		shellPath = os.Getenv("SHELL")
	}
	if shellPath == "" {
		shellPath = "/bin/bash"
	}

	cmd := exec.Command(shellPath, "-l")
	cmd.Dir = cwd
	cmd.Env = ptyEnv()
	// own session id so closing the socket takes the whole job tree with it
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("pty error: "+err.Error()))
		return
	}

	var writeMu sync.Mutex
	write := func(kind int, payload []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteMessage(kind, payload)
	}

	var once sync.Once
	closeAll := func() {
		once.Do(func() {
			// SIGHUP the process group, then the leader, before closing the pty
			if cmd.Process != nil {
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGHUP)
				_ = cmd.Process.Kill()
			}
			_ = ptmx.Close()
			_ = conn.Close()
		})
	}
	defer closeAll()
	go func() { _ = cmd.Wait() }()

	// pty -> browser
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				if werr := write(websocket.BinaryMessage, buf[:n]); werr != nil {
					closeAll()
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					log.Printf("pty read: %v", err)
				}
				closeAll()
				return
			}
		}
	}()

	// keepalive so an idle Cloudflare tunnel doesn't drop the socket
	pinger := time.NewTicker(ptyPingInterval)
	defer pinger.Stop()
	go func() {
		for range pinger.C {
			if err := write(websocket.PingMessage, nil); err != nil {
				closeAll()
				return
			}
		}
	}()

	_ = conn.SetReadDeadline(time.Now().Add(ptyReadTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(ptyReadTimeout))
	})

	// browser -> pty
	for {
		kind, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(ptyReadTimeout))
		if len(msg) == 0 {
			continue
		}
		// control frames are JSON objects; keystrokes never start with '{'
		if kind == websocket.TextMessage && msg[0] == '{' {
			var ctrl ptyControl
			if err := json.Unmarshal(msg, &ctrl); err == nil {
				switch ctrl.Type {
				case "resize":
					if ctrl.Cols > 0 && ctrl.Rows > 0 {
						_ = pty.Setsize(ptmx, &pty.Winsize{Cols: ctrl.Cols, Rows: ctrl.Rows})
					}
				case "ping":
					// client-side keepalive; nothing to do
				}
				continue
			}
		}
		if _, err := ptmx.Write(msg); err != nil {
			return
		}
	}
}

func ptyEnv() []string {
	env := append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if os.Getenv("LANG") == "" {
		env = append(env, "LANG=en_US.UTF-8")
	}
	return env
}

func atoiDefault(v string, fallback int) int {
	if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 1000 {
		return n
	}
	return fallback
}
