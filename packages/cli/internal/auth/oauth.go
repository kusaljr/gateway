package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Self-managed OAuth client registered in the Cloudflare dashboard (Manage
// account -> OAuth clients) under the "kusal" app. client_id is a public
// identifier for a PKCE public client (token_endpoint_auth_method: none) — no
// secret to protect, safe to ship in source.
const (
	cfOAuthClientID  = "82de03435724c4f303d8c095ec008e4b"
	cfOAuthAuthorize = "https://dash.cloudflare.com/oauth2/auth"
	cfOAuthToken     = "https://dash.cloudflare.com/oauth2/token"
	// Exact scopes registered on the client — omitting `scope` grants zero
	// permissions (verified empirically), so this must be listed explicitly.
	//
	// offline_access is deliberately absent: this client is not registered for
	// it, and asking anyway fails the authorize request outright with "OAuth
	// 2.0 client is not allowed to request scope offline_access" — no code, no
	// redirect back, sign-in dead. Cost of leaving it out: Cloudflare returns
	// no refresh_token, so the refresh plumbing here and in the app has nothing
	// to use and a dead access token means another browser sign-in. Grant the
	// scope on the OAuth client in the dashboard first, then add it here and in
	// CF_OAUTH_SCOPES (packages/mobile/lib/cloudflare.ts) together.
	cfOAuthScopes       = "account-settings.read argotunnel.read argotunnel.write zone.read zone.write zone-access.write user-details.read"
	cfOAuthRedirectURI  = "http://127.0.0.1:41830/callback"
	cfOAuthCallbackAddr = "127.0.0.1:41830"
	CFAPIBase           = "https://api.cloudflare.com/client/v4"
)

type CloudflareSession struct {
	AccessToken  string
	RefreshToken string
	Email        string
}

func randomPkceString(n int) (string, error) {
	const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i, b := range buf {
		buf[i] = charset[int(b)%len(charset)]
	}
	return string(buf), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// LoginToCloudflareAccount runs a full PKCE Authorization Code flow against
// Cloudflare's self-managed OAuth: opens the system browser, listens on a
// fixed loopback port for the redirect, exchanges the code, and looks up the
// account email. Returns a session usable against the Cloudflare API
// (accounts, cfd_tunnel, access/apps) scoped exactly to cfOAuthScopes.
func LoginToCloudflareAccount() (*CloudflareSession, error) {
	verifier, err := randomPkceString(64)
	if err != nil {
		return nil, err
	}
	state, err := randomPkceString(24)
	if err != nil {
		return nil, err
	}
	challenge := pkceChallenge(verifier)

	authURL := cfOAuthAuthorize + "?" + url.Values{
		"response_type":         {"code"},
		"client_id":             {cfOAuthClientID},
		"redirect_uri":          {cfOAuthRedirectURI},
		"scope":                 {cfOAuthScopes},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}.Encode()

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	mux := http.NewServeMux()
	srv := &http.Server{Addr: cfOAuthCallbackAddr, Handler: mux}
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if e := q.Get("error"); e != "" {
			desc := q.Get("error_description")
			fmt.Fprintf(w, "<html><body>Login failed: %s %s<br>You can close this tab.</body></html>", e, desc)
			errCh <- fmt.Errorf("cloudflare rejected login: %s %s", e, desc)
			return
		}
		if q.Get("state") != state {
			fmt.Fprint(w, "<html><body>Login failed: state mismatch.<br>You can close this tab.</body></html>")
			errCh <- fmt.Errorf("oauth state mismatch")
			return
		}
		code := q.Get("code")
		if code == "" {
			fmt.Fprint(w, "<html><body>Login failed: no code returned.<br>You can close this tab.</body></html>")
			errCh <- fmt.Errorf("no authorization code returned")
			return
		}
		fmt.Fprint(w, "<html><body>&#10003; Logged in with Cloudflare — you can close this tab and return to the terminal.</body></html>")
		codeCh <- code
	})

	ln, err := net.Listen("tcp", cfOAuthCallbackAddr)
	if err != nil {
		return nil, fmt.Errorf("could not bind %s for the OAuth callback: %w", cfOAuthCallbackAddr, err)
	}
	go func() { _ = srv.Serve(ln) }()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	fmt.Println("\n🔐 Opening browser to sign in with Cloudflare...")
	fmt.Println("   " + authURL)
	OpenBrowser(authURL)
	fmt.Println("  Waiting for you to approve in the browser...")

	var code string
	select {
	case code = <-codeCh:
	case err := <-errCh:
		return nil, err
	case <-time.After(3 * time.Minute):
		return nil, fmt.Errorf("timed out waiting for Cloudflare login")
	}

	tok, err := exchangeCode(code, verifier)
	if err != nil {
		return nil, err
	}
	fmt.Println("✓ Signed in with Cloudflare")

	email, _ := fetchUserEmail(tok.AccessToken)
	return &CloudflareSession{AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken, Email: email}, nil
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
}

// RefreshCloudflareSession renews an expired dashboard token from the refresh
// token kept at login. These access tokens are short-lived, so without this a
// stored session goes permanently dead: every API call keeps failing with
// "9109: Invalid access token" and no amount of re-running the command helps,
// because the dead token is still sitting in the store. cloudflared's own
// cert.pem is unaffected, which is what makes the failure so confusing — tunnel
// creation keeps working while every API call refuses.
func RefreshCloudflareSession(refreshToken string) (*CloudflareSession, error) {
	tok, err := postToken(url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {cfOAuthClientID},
	})
	if err != nil {
		return nil, err
	}
	email, _ := fetchUserEmail(tok.AccessToken)
	// Cloudflare may or may not rotate the refresh token; keep the old one when
	// it doesn't, or the next refresh has nothing to present.
	if tok.RefreshToken == "" {
		tok.RefreshToken = refreshToken
	}
	return &CloudflareSession{AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken, Email: email}, nil
}

// VerifyCloudflareToken reports whether a stored access token still works, and
// who it belongs to. fetchUserEmail alone can't answer that: it ignores the
// status code, so a 401 comes back as an empty email and a nil error.
func VerifyCloudflareToken(accessToken string) (string, error) {
	req, _ := http.NewRequest("GET", CFAPIBase+"/user", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("cloudflare rejected the stored token (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var j struct {
		Success bool `json:"success"`
		Result  struct {
			Email string `json:"email"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &j); err != nil || !j.Success {
		return "", fmt.Errorf("cloudflare rejected the stored token")
	}
	return j.Result.Email, nil
}

func exchangeCode(code, verifier string) (*tokenResponse, error) {
	return postToken(url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {cfOAuthRedirectURI},
		"client_id":     {cfOAuthClientID},
		"code_verifier": {verifier},
	})
}

func postToken(form url.Values) (*tokenResponse, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.PostForm(cfOAuthToken, form)
	if err != nil {
		return nil, fmt.Errorf("token exchange request failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("token exchange failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var tok tokenResponse
	if err := json.Unmarshal(body, &tok); err != nil {
		return nil, fmt.Errorf("could not parse token response: %w", err)
	}
	if tok.AccessToken == "" {
		return nil, fmt.Errorf("token exchange did not return an access_token")
	}
	return &tok, nil
}

func fetchUserEmail(accessToken string) (string, error) {
	req, _ := http.NewRequest("GET", CFAPIBase+"/user", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var j struct {
		Result struct {
			Email string `json:"email"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &j); err != nil {
		return "", err
	}
	return j.Result.Email, nil
}
