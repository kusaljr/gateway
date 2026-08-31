package tunnel

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"kusal/internal/config"
)

func EnsureCloudflared() error {
	if _, err := exec.LookPath(config.TunnelBin()); err == nil {
		return nil
	}
	return fmt.Errorf("cloudflared not found. Install: brew install cloudflared (macOS) or https://developers.cloudflare.com/cloudflare-one/connections/connect/networks/downloads/")
}

// Run starts cloudflared tunnel with given token forwarding to localAddr.
func Run(token, localAddr string) (*exec.Cmd, error) {
	if err := EnsureCloudflared(); err != nil {
		return nil, err
	}
	if err := config.EnsureDir(); err != nil {
		return nil, err
	}
	logFile := filepath.Join(config.Dir(), "cloudflared.log")
	// rotate: keep last 200k
	if st, err := os.Stat(logFile); err == nil && st.Size() > 500*1024 {
		_ = os.Rename(logFile, logFile+".old")
	}
	f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(config.TunnelBin(), "tunnel", "--no-autoupdate", "run", "--token", token)
	if runtime.GOOS == "windows" {
		cmd.SysProcAttr = nil
	}
	cmd.Stdout = f
	cmd.Stderr = f
	cmd.Env = append(os.Environ(), "KUSAL_LOCAL_ADDR="+localAddr)

	if err := cmd.Start(); err != nil {
		f.Close()
		return nil, fmt.Errorf("failed to start cloudflared: %w", err)
	}
	_ = os.WriteFile(filepath.Join(config.Dir(), "tunnel.pid"), []byte(fmt.Sprintf("%d", cmd.Process.Pid)), 0600)
	_ = os.WriteFile(filepath.Join(config.Dir(), "tunnel.addr"), []byte(localAddr), 0600)
	return cmd, nil
}

// Stop kills the cloudflared this machine started, then sweeps any that were
// left behind. The pid file alone is not enough: it holds ONE pid, and every
// connect overwrites it, so a cloudflared whose pid was overwritten before it
// was killed could never be stopped again by any later command. That is not
// hypothetical — it stranded three of them at once, each still serving a tunnel
// that had already been deleted.
//
// The sweep matches the exact argv kusal launches with, which nothing else on a
// machine produces: a hand-run `cloudflared tunnel run` has neither the
// --no-autoupdate nor the --token, so someone else's tunnel is never touched.
func Stop() error {
	pidFile := filepath.Join(config.Dir(), "tunnel.pid")
	if data, err := os.ReadFile(pidFile); err == nil {
		var pid int
		_, _ = fmt.Sscanf(string(data), "%d", &pid)
		if pid > 0 {
			if proc, err := os.FindProcess(pid); err == nil {
				_ = proc.Kill()
			}
		}
	}
	_ = os.Remove(pidFile)
	for _, pid := range kusalCloudflaredPIDs() {
		if proc, err := os.FindProcess(pid); err == nil {
			_ = proc.Kill()
		}
	}
	return nil
}

// kusalCloudflaredPIDs lists the cloudflared processes kusal itself started.
// pgrep is POSIX-only, hence the guard; on Windows the pid file remains the
// only handle, which is the pre-existing behaviour rather than a regression.
func kusalCloudflaredPIDs() []int {
	if runtime.GOOS == "windows" {
		return nil
	}
	out, err := exec.Command("pgrep", "-f", "cloudflared tunnel --no-autoupdate run --token").Output()
	if err != nil {
		return nil // no matches exits non-zero
	}
	var pids []int
	for _, line := range strings.Fields(string(out)) {
		var pid int
		if _, err := fmt.Sscanf(line, "%d", &pid); err == nil && pid > 0 && pid != os.Getpid() {
			pids = append(pids, pid)
		}
	}
	return pids
}

// IsRunning reports whether a cloudflared kusal started is actually alive.
// Signal 0 is the check that matters: os.FindProcess never fails on Unix, so
// the old form ("err == nil || pid > 0") was true for any pid ever recorded,
// and a stale pid file read as a healthy tunnel forever.
func IsRunning() bool {
	pidFile := filepath.Join(config.Dir(), "tunnel.pid")
	data, err := os.ReadFile(pidFile)
	if err != nil {
		// the pid file can go missing while cloudflared runs on (a kill -9'd
		// daemon, a disconnect that removed it); the process list is the truth
		return len(kusalCloudflaredPIDs()) > 0
	}
	var pid int
	_, _ = fmt.Sscanf(string(data), "%d", &pid)
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

// CreateTunnel creates a named tunnel (requires cert.pem from `cloudflared tunnel login`)
func CreateTunnel(name string) error {
	cmd := exec.Command(config.TunnelBin(), "tunnel", "create", name)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}

// RouteDNS points hostname at tunnelName (creates/updates the CNAME to
// <tunnel-id>.cfargotunnel.com). Cheap and idempotent — safe to call on every
// connect. Requires hostname to fall under a zone already in this account and,
// for traffic to actually reach the tunnel, requires the tunnel's ingress
// (Public Hostname) to also be configured — this only does the DNS half.
func RouteDNS(tunnelName, hostname string) error {
	out, err := exec.Command(config.TunnelBin(), "tunnel", "route", "dns", "--overwrite-dns", tunnelName, hostname).CombinedOutput()
	if err != nil {
		return fmt.Errorf("route dns failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Delete removes a tunnel using cloudflared's own credential (cert.pem), which
// is long-lived — unlike the dashboard OAuth token the REST API needs. That
// difference matters at teardown: the token is exactly what tends to be expired
// by the time someone gets round to deleting something.
//
// cleanup runs first because Cloudflare refuses to delete a tunnel that still
// holds connections, and a connector killed moments ago is still registered.
// Its own failure is not fatal — a tunnel with nothing connected makes cleanup
// a no-op that can still exit non-zero, and the delete below is the real test.
func Delete(tunnelID string) error {
	_, _ = exec.Command(config.TunnelBin(), "tunnel", "cleanup", tunnelID).CombinedOutput()
	out, err := exec.Command(config.TunnelBin(), "tunnel", "delete", tunnelID).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, meaningfulLine(string(out)))
	}
	return nil
}

// meaningfulLine picks the reason out of cloudflared's output. It logs its own
// INF/WRN lines — an update notice among them — around whatever actually went
// wrong, and wrapping all of that into an error message buries the one line the
// user needs behind noise about a version upgrade.
func meaningfulLine(out string) string {
	last := ""
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.Contains(line, " INF ") || strings.Contains(line, " WRN ") || strings.Contains(line, " DBG ") {
			continue
		}
		last = line
	}
	if last == "" {
		return strings.TrimSpace(out)
	}
	return last
}

// DeleteCommand is the cloudflared invocation that removes a tunnel, printed as
// a fallback when the API call could not do it (an expired dashboard token, for
// instance) — cloudflared authenticates with its own cert.pem instead.
func DeleteCommand(tunnelID string) string {
	return config.TunnelBin() + " tunnel delete " + tunnelID
}

// GetToken returns the token for a named tunnel (handles warning lines in output)
func GetToken(name string) (string, error) {
	out, err := exec.Command(config.TunnelBin(), "tunnel", "token", name).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	// cloudflared prints "WRN Your version..." to stderr which is in CombinedOutput
	// take first line that looks like a token (base64, no spaces, len>20)
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "202") || strings.Contains(line, "WRN") || strings.Contains(line, "Your version") {
			continue
		}
		// token is single base64 chunk, no spaces
		fields := strings.Fields(line)
		if len(fields) > 0 {
			candidate := fields[0]
			if len(candidate) > 40 && !strings.Contains(candidate, " ") {
				return candidate, nil
			}
		}
	}
	return strings.TrimSpace(string(out)), nil
}

// List returns tunnel names via `cloudflared tunnel list --output json`
func List() ([]string, error) {
	out, err := exec.Command(config.TunnelBin(), "tunnel", "list", "--output", "json").CombinedOutput()
	if err != nil {
		// fallback: try without json
		txt, err2 := exec.Command(config.TunnelBin(), "tunnel", "list").CombinedOutput()
		if err2 != nil {
			return nil, fmt.Errorf("list failed: %s", strings.TrimSpace(string(out)))
		}
		return parseListText(string(txt)), nil
	}
	// json is []{id, name, ...}
	var arr []map[string]interface{}
	if err := json.Unmarshal(out, &arr); err != nil {
		return parseListText(string(out)), nil
	}
	var names []string
	for _, m := range arr {
		if n, _ := m["name"].(string); n != "" {
			names = append(names, n)
		}
	}
	return names, nil
}

func parseListText(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			// skip header
			if f[0] == "ID" || f[1] == "NAME" {
				continue
			}
			out = append(out, f[1])
		}
	}
	return out
}
