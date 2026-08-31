package auth

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"kusal/internal/tunnel"
)

// ParseTunnelToken handles both JWT (3 parts) and plain base64 JSON token from `cloudflared tunnel token`
func ParseTunnelToken(token string) (tunnelID, accountID string, err error) {
	token = strings.TrimSpace(token)
	// cloudflared tunnel token output may contain warning lines; take first token-like line
	if strings.Contains(token, "\n") {
		for _, line := range strings.Split(token, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "202") || strings.Contains(line, "WRN") {
				continue
			}
			if len(line) > 20 {
				token = line
				break
			}
		}
		token = strings.Fields(token)[0]
	}
	parts := strings.Split(token, ".")
	if len(parts) == 3 {
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			payload, err = base64.URLEncoding.DecodeString(parts[1])
			if err != nil {
				return "", "", err
			}
		}
		var data map[string]interface{}
		if err := json.Unmarshal(payload, &data); err != nil {
			return "", "", err
		}
		tid, _ := data["t"].(string)
		aid, _ := data["a"].(string)
		if tid == "" {
			tid, _ = data["tunnel_id"].(string)
		}
		if aid == "" {
			aid, _ = data["account_id"].(string)
		}
		return tid, aid, nil
	}
	// plain base64 JSON: eyJhIjoi... (no dots)
	decoded, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(token)
		if err != nil {
			decoded, err = base64.RawURLEncoding.DecodeString(token)
			if err != nil {
				return "", "", fmt.Errorf("invalid token format")
			}
		}
	}
	var data map[string]interface{}
	if err := json.Unmarshal(decoded, &data); err != nil {
		return "", "", err
	}
	tid, _ := data["t"].(string)
	aid, _ := data["a"].(string)
	if tid == "" {
		tid, _ = data["tunnel_id"].(string)
	}
	if aid == "" {
		aid, _ = data["account_id"].(string)
	}
	return tid, aid, nil
}

func Prompt(label, def string) string {
	if def != "" {
		fmt.Printf("%s [%s]: ", label, def)
	} else {
		fmt.Printf("%s: ", label)
	}
	r := bufio.NewReader(os.Stdin)
	s, _ := r.ReadString('\n')
	s = strings.TrimSpace(s)
	if s == "" {
		return def
	}
	return s
}

func OpenBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func certPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cloudflared", "cert.pem")
}

func certExists() bool {
	_, err := os.Stat(certPath())
	return err == nil
}

// AuthViaBrowser handles the full browser-based login flow.
// It opens the Cloudflare login in the browser via `cloudflared tunnel login`,
// then ensures a tunnel exists and returns its token — no manual paste needed.
func AuthViaBrowser(deviceName string) (string, error) {
	if err := tunnel.EnsureCloudflared(); err != nil {
		return "", err
	}

	// Step 1: ensure Cloudflare cert (login)
	if !certExists() {
		fmt.Println()
		fmt.Println("🔐  Cloudflare authentication required.")
		fmt.Println("    Opening browser to authenticate with Cloudflare...")
		fmt.Println()

		// Try to open the generic login URL as a hint; cloudflared will print its own callback URL
		OpenBrowser("https://dash.cloudflare.com/login")

		fmt.Println("  → If browser didn't open, run will show a URL like:")
		fmt.Println("    https://dash.cloudflare.com/argotunnel?callback=...")
		fmt.Println()
		fmt.Println("  Waiting for you to approve in the browser...")
		fmt.Println("  (This runs: cloudflared tunnel login)")
		fmt.Println()

		cmd := exec.Command("cloudflared", "tunnel", "login")
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("cloudflared login failed: %w\nTip: try running manually: cloudflared tunnel login", err)
		}

		// wait briefly for cert.pem to appear
		for i := 0; i < 10; i++ {
			if certExists() {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		if !certExists() {
			return "", fmt.Errorf("login did not produce %s — please try: cloudflared tunnel login", certPath())
		}
		fmt.Println("\n✓ Authenticated with Cloudflare")
	} else {
		fmt.Println("✓ Already authenticated with Cloudflare (" + certPath() + ")")
	}

	// Step 2: ensure a tunnel exists for this device/account, then get its token
	tunnelName := sanitizeTunnelName("kusal-" + deviceName)

	// Try to fetch token for existing tunnel
	if tok, err := tunnel.GetToken(tunnelName); err == nil && tok != "" {
		fmt.Printf("✓ Using existing tunnel %q\n", tunnelName)
		return strings.TrimSpace(tok), nil
	}

	// Check if tunnel already exists via list
	exists := false
	if list, err := tunnel.List(); err == nil {
		for _, n := range list {
			if n == tunnelName {
				exists = true
				break
			}
		}
	}

	if !exists {
		fmt.Printf("  Creating tunnel %q...\n", tunnelName)
		// Open dashboard as visual feedback
		OpenBrowser("https://one.dash.cloudflare.com/")
		if err := tunnel.CreateTunnel(tunnelName); err != nil {
			// Provide helpful fallback URL
			fmt.Println()
			fmt.Println("  Could not auto-create tunnel. Please create it in the dashboard:")
			fmt.Println("  → https://one.dash.cloudflare.com/ → Networks → Tunnels → Create a tunnel")
			fmt.Printf("  Name it %q then re-run: kusal connect\n", tunnelName)
			return "", fmt.Errorf("auto-create failed: %w", err)
		}
		fmt.Printf("✓ Tunnel %q created\n", tunnelName)
	}

	tok, err := tunnel.GetToken(tunnelName)
	if err != nil {
		return "", fmt.Errorf("failed to get tunnel token for %q: %w", tunnelName, err)
	}
	tok = strings.TrimSpace(tok)
	if tok == "" {
		return "", fmt.Errorf("empty token for tunnel %q", tunnelName)
	}
	return tok, nil
}

func sanitizeTunnelName(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, " ", "-")
	s = strings.ReplaceAll(s, "_", "-")
	var out strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			out.WriteRune(r)
		}
	}
	res := out.String()
	if len(res) > 32 {
		res = res[:32]
	}
	if res == "" {
		res = "kusal-device"
	}
	return res
}
