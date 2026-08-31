package opencode

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"sync"
	"time"
)

// Detect if opencode is installed
func IsInstalled() bool {
	_, err := exec.LookPath("opencode")
	return err == nil
}

const baseURL = "http://127.0.0.1:4096"

type Session struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Model     string `json:"model"`
	Cwd       string `json:"cwd"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updatedAt"`
	Provider  string `json:"provider"`
}

// raw session shape returned by GET /session
type ocSession struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Directory string `json:"directory"`
	Model     *struct {
		ID         string `json:"id"`
		ProviderID string `json:"providerID"`
	} `json:"model"`
	Time struct {
		Created int64 `json:"created"`
		Updated int64 `json:"updated"`
	} `json:"time"`
}

func healthy() bool {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	for _, path := range []string{"/global/health", "/health"} {
		if resp, err := client.Get(baseURL + path); err == nil {
			resp.Body.Close()
			return true
		}
	}
	return false
}

var startMu sync.Mutex

// EnsureRunning starts a headless opencode server (:4096) if one isn't already listening.
func EnsureRunning(cwd string) error {
	if !IsInstalled() {
		return fmt.Errorf("opencode is not installed")
	}
	if healthy() {
		return nil
	}
	startMu.Lock()
	defer startMu.Unlock()
	if healthy() {
		return nil
	}
	cmd := exec.Command("opencode", "serve", "--port", "4096", "--hostname", "127.0.0.1")
	if cwd != "" {
		cmd.Dir = cwd
	}
	if err := cmd.Start(); err == nil {
		go func(p *exec.Cmd) { _ = p.Wait() }(cmd)
		for i := 0; i < 40; i++ {
			if healthy() {
				return nil
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	if !healthy() {
		return fmt.Errorf("could not reach opencode server on :4096")
	}
	return nil
}

// Try to fetch sessions from local opencode server (default :4096)
func ListSessions() []Session {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(baseURL + "/session")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var raw []ocSession
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil
	}
	out := make([]Session, 0, len(raw))
	for _, s := range raw {
		model := ""
		if s.Model != nil && s.Model.ID != "" {
			model = s.Model.ProviderID + "/" + s.Model.ID
		}
		ts := time.Now().Format(time.RFC3339)
		if s.Time.Updated > 0 {
			ts = time.UnixMilli(s.Time.Updated).Format(time.RFC3339)
		} else if s.Time.Created > 0 {
			ts = time.UnixMilli(s.Time.Created).Format(time.RFC3339)
		}
		out = append(out, Session{
			ID:        s.ID,
			Title:     s.Title,
			Model:     model,
			Cwd:       s.Directory,
			Status:    "idle",
			UpdatedAt: ts,
			Provider:  "opencode",
		})
	}
	return out
}
