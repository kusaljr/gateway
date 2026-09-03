// Package cfapi is a small client for the handful of Cloudflare API v4 calls
// kusal needs to fully automate tunnel routing: point a device's ingress at
// its local shell server, and make sure a wildcard Access Application exists
// to gate it. Deliberately minimal — not a general Cloudflare SDK.
package cfapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const apiBase = "https://api.cloudflare.com/client/v4"

type apiEnvelope struct {
	Success    bool            `json:"success"`
	Errors     []apiError      `json:"errors"`
	Result     json.RawMessage `json:"result"`
	ResultInfo json.RawMessage `json:"result_info"`
}

type apiError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e apiError) String() string { return fmt.Sprintf("%d: %s", e.Code, e.Message) }

func doRequest(token, method, path string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, apiBase+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var env apiEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("%s %s: non-JSON response (%d): %s", method, path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if !env.Success {
		msgs := make([]string, len(env.Errors))
		for i, e := range env.Errors {
			msgs[i] = e.String()
		}
		if len(msgs) == 0 {
			// error array empty/uninformative — surface the raw body and status
			// instead of a blank message, so failures are diagnosable.
			return nil, fmt.Errorf("%s %s failed (%d): %s", method, path, resp.StatusCode, strings.TrimSpace(string(raw)))
		}
		return nil, fmt.Errorf("%s %s failed: %s", method, path, strings.Join(msgs, "; "))
	}
	return env.Result, nil
}

// DeleteTunnel removes the tunnel itself. cascade=true also clears any
// connections it still holds — without it Cloudflare refuses to delete a tunnel
// whose connector has not yet timed out, which is exactly the state a tunnel is
// in moments after its process was killed.
func DeleteTunnel(token, accountID, tunnelID string) error {
	_, err := doRequest(token, http.MethodDelete,
		fmt.Sprintf("/accounts/%s/cfd_tunnel/%s?cascade=true", accountID, tunnelID), nil)
	return err
}

type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ListAccounts returns the Cloudflare accounts accessible with this token.
func ListAccounts(token string) ([]Account, error) {
	raw, err := doRequest(token, http.MethodGet, "/accounts?per_page=50", nil)
	if err != nil {
		return nil, err
	}
	var accounts []Account
	if err := json.Unmarshal(raw, &accounts); err != nil {
		return nil, fmt.Errorf("could not parse accounts list: %w", err)
	}
	return accounts, nil
}

type Tunnel struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Status          string `json:"status"`
	CreatedAt       string `json:"created_at"`
	ConnsActiveAt   string `json:"conns_active_at"`
	ConnsInactiveAt string `json:"conns_inactive_at"`
	Connections     []struct {
		ColoName      string `json:"colo_name"`
		ClientVersion string `json:"client_version"`
		OpenedAt      string `json:"opened_at"`
	} `json:"connections"`
}

// ListTunnels returns all non-deleted tunnels on the given account.
func ListTunnels(token, accountID string) ([]Tunnel, error) {
	raw, err := doRequest(token, http.MethodGet, fmt.Sprintf("/accounts/%s/cfd_tunnel?is_deleted=false&per_page=50", accountID), nil)
	if err != nil {
		return nil, err
	}
	var tunnels []Tunnel
	if err := json.Unmarshal(raw, &tunnels); err != nil {
		return nil, fmt.Errorf("could not parse tunnels list: %w", err)
	}
	return tunnels, nil
}

// GetTunnelHostnames returns public hostnames configured in this tunnel's ingress rules.
func GetTunnelHostnames(token, accountID, tunnelID string) ([]string, error) {
	raw, err := doRequest(token, http.MethodGet, fmt.Sprintf("/accounts/%s/cfd_tunnel/%s/configurations", accountID, tunnelID), nil)
	if err != nil {
		return nil, err
	}
	var cfg struct {
		Config struct {
			Ingress []struct {
				Hostname string `json:"hostname"`
			} `json:"ingress"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("could not parse tunnel configurations: %w", err)
	}
	var hostnames []string
	for _, ing := range cfg.Config.Ingress {
		if ing.Hostname != "" {
			hostnames = append(hostnames, ing.Hostname)
		}
	}
	return hostnames, nil
}

// DeleteDNSRecord removes the CNAME that points hostname at the tunnel. Reports
// whether a record was actually there: "nothing to delete" is a normal outcome
// (never routed, or already cleaned up) and must not read as a failure.
//
// Matched on the exact name only. A looser match could take out an unrelated
// record in the same zone, which is not a mistake worth risking to save a call.
func DeleteDNSRecord(token, zoneID, hostname string) (bool, error) {
	raw, err := doRequest(token, http.MethodGet,
		fmt.Sprintf("/zones/%s/dns_records?name=%s", zoneID, url.QueryEscape(hostname)), nil)
	if err != nil {
		return false, dnsScopeHint(err)
	}
	var records []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &records); err != nil {
		return false, fmt.Errorf("could not parse DNS records: %w", err)
	}
	deleted := false
	for _, r := range records {
		if !strings.EqualFold(r.Name, hostname) {
			continue
		}
		if _, err := doRequest(token, http.MethodDelete, fmt.Sprintf("/zones/%s/dns_records/%s", zoneID, r.ID), nil); err != nil {
			return deleted, dnsScopeHint(err)
		}
		deleted = true
	}
	return deleted, nil
}

// dnsScopeHint turns Cloudflare's flat "10000: Authentication error" on the DNS
// endpoints into something a user can act on. The OAuth client kusal ships is
// registered with zone.read and zone.write, and neither grants DNS record
// access — so this call fails for everyone, not just for an expired session,
// and re-authenticating will never change it. Measured against a live account:
// /zones answers fine with the same token that /zones/{id}/dns_records refuses.
func dnsScopeHint(err error) error {
	msg := err.Error()
	if !strings.Contains(msg, "10000") && !strings.Contains(msg, "Authentication error") {
		return err
	}
	return fmt.Errorf("%w\n  (the OAuth client has no DNS permission: add #dns_records:edit to it in "+
		"Cloudflare dashboard -> Manage account -> OAuth clients, or delete the record by hand)", err)
}

// GetZoneID finds the account's zone whose name is the longest matching
// suffix of hostname (e.g. hostname "kusal.example.com" matches zone
// "example.com", not some unrelated zone). Needed because Access
// Applications for a "zone-access.write"-scoped token live under
// /zones/{zone_id}/access/apps, not /accounts/{account_id}/access/apps.
// Zone is a domain on the account, as Cloudflare names it (the apex, e.g.
// "example.com" — never a subdomain).
type Zone struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ListZones returns the zones this token can see on the account. An empty list
// is a real answer, not an error: an account can legitimately hold no domain at
// all, and the caller has to say so rather than fail obscurely later.
func ListZones(token, accountID string) ([]Zone, error) {
	raw, err := doRequest(token, http.MethodGet, fmt.Sprintf("/zones?account.id=%s&per_page=50", accountID), nil)
	if err != nil {
		return nil, err
	}
	var zones []Zone
	if err := json.Unmarshal(raw, &zones); err != nil {
		return nil, fmt.Errorf("could not parse zones list: %w", err)
	}
	return zones, nil
}

func GetZoneID(token, accountID, hostname string) (string, error) {
	zones, err := ListZones(token, accountID)
	if err != nil {
		return "", err
	}
	bestID, bestLen := "", -1
	for _, z := range zones {
		if (hostname == z.Name || strings.HasSuffix(hostname, "."+z.Name)) && len(z.Name) > bestLen {
			bestID, bestLen = z.ID, len(z.Name)
		}
	}
	if bestID == "" {
		return "", fmt.Errorf("no zone in this account matches %q", hostname)
	}
	return bestID, nil
}

// SetTunnelIngress replaces the tunnel's ingress config with a single rule
// routing hostname -> service (plus the mandatory catch-all). Safe to call on
// every connect: each device owns its own tunnel, so this never touches
// another device's routing.
func SetTunnelIngress(token, accountID, tunnelID, hostname, service string) error {
	body := map[string]any{
		"config": map[string]any{
			"ingress": []map[string]any{
				{"hostname": hostname, "service": service},
				{"service": "http_status:404"},
			},
		},
	}
	path := fmt.Sprintf("/accounts/%s/cfd_tunnel/%s/configurations", accountID, tunnelID)
	_, err := doRequest(token, http.MethodPut, path, body)
	return err
}

type accessApp struct {
	ID              string         `json:"id"`
	Domain          string         `json:"domain"`
	Name            string         `json:"name"`
	Type            string         `json:"type"`
	SessionDuration string         `json:"session_duration"`
	Policies        []accessPolicy `json:"policies"`
}

// The writable half of an Access policy. Everything else the API returns
// (id, uid, created_at, updated_at) is server-owned and cannot be sent back.
type accessPolicy struct {
	Decision   string            `json:"decision"`
	Include    []json.RawMessage `json:"include"`
	Exclude    []json.RawMessage `json:"exclude"`
	Require    []json.RawMessage `json:"require"`
	Precedence int               `json:"precedence"`
}

// How long an Access session lasts before the user has to sign in again.
//
// 730h (one month) is the longest Cloudflare allows, and the shorter values it
// also accepts — 30m, 6h, 12h, 24h, 168h — are the whole of the choice. This
// used to be 24h, which meant signing in again EVERY DAY on every device: the
// Access JWT is what gets a request past Cloudflare's edge, so when it expires
// the app has no way to renew it without a browser round-trip.
//
// The trade-off is real and worth stating: a stolen device keeps access for up
// to a month rather than a day. It is bounded by the same allow-policy either
// way (one email address), revoking the Access app or the policy cuts every
// session immediately, and the tunnel can be torn down from the dashboard.
const accessSessionDuration = "730h"

// EnsureAccessSessionDuration raises an existing Access application's session
// duration to accessSessionDuration, and reports whether it changed anything.
//
// PUT, not PATCH. PATCH is the obvious call and Cloudflare refuses it for this
// credential — "code 10405: Method not allowed for this authentication scheme",
// verified against a live zone with the exact OAuth token kusal itself holds.
// The dashboard OAuth scopes permit creating and replacing an application but
// not patching one, so a full replace is the only route available.
//
// A replace is also the dangerous route: the body IS the new application, so
// omitting `policies` would delete the allow rule that is the only thing
// standing between the tunnel and the open internet. Hence the guard below —
// this refuses to write at all unless it has read back a policy to re-send.
func EnsureAccessSessionDuration(token, zoneID, appID string) (changed bool, err error) {
	raw, err := doRequest(token, http.MethodGet, fmt.Sprintf("/zones/%s/access/apps/%s", zoneID, appID), nil)
	if err != nil {
		return false, err
	}
	var app accessApp
	if err := json.Unmarshal(raw, &app); err != nil {
		return false, fmt.Errorf("could not parse access app: %w", err)
	}
	if app.SessionDuration == accessSessionDuration {
		return false, nil
	}
	// Never replace an application whose policies we could not read: sending
	// none would strip its protection entirely, which is far worse than
	// leaving the session short.
	if len(app.Policies) == 0 {
		return false, fmt.Errorf("refusing to update access app %s: it reported no policies to preserve", appID)
	}
	policies := make([]map[string]any, 0, len(app.Policies))
	for _, p := range app.Policies {
		// only the fields that define the rule travel back — created_at, uid
		// and friends are server-owned and rejected on write
		entry := map[string]any{"decision": p.Decision}
		if len(p.Include) > 0 {
			entry["include"] = p.Include
		}
		if len(p.Exclude) > 0 {
			entry["exclude"] = p.Exclude
		}
		if len(p.Require) > 0 {
			entry["require"] = p.Require
		}
		if p.Precedence > 0 {
			entry["precedence"] = p.Precedence
		}
		if len(p.Include) == 0 {
			return false, fmt.Errorf("refusing to update access app %s: a policy had no include rules", appID)
		}
		policies = append(policies, entry)
	}
	body := map[string]any{
		"name":             app.Name,
		"domain":           app.Domain,
		"type":             app.Type,
		"session_duration": accessSessionDuration,
		"policies":         policies,
	}
	if _, err := doRequest(token, http.MethodPut, fmt.Sprintf("/zones/%s/access/apps/%s", zoneID, appID), body); err != nil {
		return false, err
	}
	return true, nil
}

// findAccessApp is FindAccessAppForDomain's full-record form: the caller needs
// the app's current session_duration, not only whether it exists.
func findAccessApp(token, zoneID, wildcardDomain string) (*accessApp, error) {
	raw, err := doRequest(token, http.MethodGet, fmt.Sprintf("/zones/%s/access/apps", zoneID), nil)
	if err != nil {
		return nil, err
	}
	var apps []accessApp
	if err := json.Unmarshal(raw, &apps); err != nil {
		return nil, fmt.Errorf("could not parse access apps list: %w", err)
	}
	for i := range apps {
		if apps[i].Domain == wildcardDomain {
			return &apps[i], nil
		}
	}
	return nil, nil
}

// FindAccessAppForDomain looks for an existing Access Application whose
// domain matches wildcardDomain (e.g. "*.kusal.example.com") exactly. Returns
// ("", nil) if none found — never guesses a partial/looser match, since
// acting on the wrong app would change someone else's access policy.
//
// Zone-scoped (not /accounts/.../access/apps): the OAuth client's
// "zone-access.write" permission grants Access Application management at the
// zone level, matching how Cloudflare models Access apps tied to a zone's DNS.
func FindAccessAppForDomain(token, zoneID, wildcardDomain string) (string, error) {
	raw, err := doRequest(token, http.MethodGet, fmt.Sprintf("/zones/%s/access/apps", zoneID), nil)
	if err != nil {
		return "", err
	}
	var apps []accessApp
	if err := json.Unmarshal(raw, &apps); err != nil {
		return "", fmt.Errorf("could not parse access apps list: %w", err)
	}
	for _, a := range apps {
		if a.Domain == wildcardDomain {
			return a.ID, nil
		}
	}
	return "", nil
}

// CreateWildcardAccessApp creates a self-hosted Access Application covering
// wildcardDomain (e.g. "*.kusal.example.com") with a single allow policy for
// exactly allowEmail. Returns the new app's ID.
func CreateWildcardAccessApp(token, zoneID, wildcardDomain, appName, allowEmail string) (string, error) {
	body := map[string]any{
		"type":             "self_hosted",
		"name":             appName,
		"domain":           wildcardDomain,
		"session_duration": accessSessionDuration,
		"policies": []map[string]any{
			{
				"decision": "allow",
				"include": []map[string]any{
					{"email": map[string]string{"email": allowEmail}},
				},
			},
		},
	}
	raw, err := doRequest(token, http.MethodPost, fmt.Sprintf("/zones/%s/access/apps", zoneID), body)
	if err != nil {
		return "", err
	}
	var app accessApp
	if err := json.Unmarshal(raw, &app); err != nil {
		return "", fmt.Errorf("created access app but could not parse response: %w", err)
	}
	if app.ID == "" {
		return "", fmt.Errorf("created access app but response had no id")
	}
	return app.ID, nil
}

// EnsureWildcardAccessApp finds or creates an Access Application for
// wildcardDomain, gated to allowEmail. Idempotent — safe to call on every
// connect. Returns the app's domain and id as actually confirmed by the API
// (never assumed), so the caller can print/verify what's really protecting
// the tunnel.
func EnsureWildcardAccessApp(token, zoneID, wildcardDomain, appName, allowEmail string) (id string, created bool, err error) {
	existing, err := findAccessApp(token, zoneID, wildcardDomain)
	if err != nil {
		return "", false, err
	}
	if existing != nil {
		// The session-duration bump is the CALLER's job (see
		// EnsureAccessSessionDuration), deliberately: doing it here meant
		// swallowing its error to keep connect working, and a silent failure
		// looked exactly like success — the app reported "already covers this
		// domain" while its sessions stayed 24h.
		return existing.ID, false, nil
	}
	id, err = CreateWildcardAccessApp(token, zoneID, wildcardDomain, appName, allowEmail)
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}
