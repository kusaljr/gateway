package cliagent

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func init() { register(&cline{}) }

// cline is the Cline CLI. Unlike the other backends it is Conversational
// rather than one-shot: turns run over ACP (`cline --acp`), because its
// --json print mode cannot resume a conversation. See cline_acp.go.
type cline struct{ models modelCache }

func (c *cline) Name() string { return "cline" }
func (c *cline) Bin() string  { return "cline" }

// Models asks Cline's ACP endpoint for the catalog belonging to its configured
// provider. Cline has no standalone `list models` command, but ACP returns the
// same availableModels collection used by its own model picker. Older Cline
// versions did not support ACP, so retain the configured model as a fallback.
//
// The whole catalog is returned, unfiltered. ACP gives only {modelId, name} —
// there is no price, tier or "free" flag anywhere in its response — so any
// attempt to single out the free models here can only be a guess at the id
// string, and guessing surfaced the wrong ones. The picker's search is the
// honest way to find a specific model among these.
func (c *cline) Models() []Model {
	return c.models.get(func() []Model {
		// ACP's catalog is the main source but it is NOT exhaustive — Cline
		// happily runs ids it omits (z-ai/glm-5.3-flash was Cline's own
		// configured model and appears throughout its history, yet never
		// shows up in availableModels). So the ids this account has actually
		// used are merged in: they are proven runnable by definition.
		out := clineACPModels()
		seen := make(map[string]bool, len(out))
		for _, m := range out {
			seen[m.ID] = true
		}
		for _, extra := range append(clineConfiguredModels(), clineHistoryModels()...) {
			if extra.ID == "" || seen[extra.ID] {
				continue
			}
			seen[extra.ID] = true
			out = append(out, extra)
		}
		return clineOnlyFree(out)
	})
}

func clineACPModels() []Model {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "cline", "--acp")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil
	}
	if err := cmd.Start(); err != nil {
		return nil
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	encode := json.NewEncoder(stdin)
	if err := encode.Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion":    1,
			"clientCapabilities": map[string]any{},
			"clientInfo": map[string]string{
				"name": "kusal", "title": "Kusal", "version": "1",
			},
		},
	}); err != nil {
		return nil
	}

	type response struct {
		ID     int             `json:"id"`
		Error  json.RawMessage `json:"error"`
		Result struct {
			Models struct {
				Available []struct {
					ID   string `json:"modelId"`
					Name string `json:"name"`
				} `json:"availableModels"`
			} `json:"models"`
		} `json:"result"`
	}

	initialized := false
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "{") {
			continue // Cline prints an ACP startup notice before the JSON stream
		}
		var msg response
		if err := json.Unmarshal([]byte(line), &msg); err != nil || len(msg.Error) > 0 {
			continue
		}
		if msg.ID == 1 && !initialized {
			initialized = true
			cwd, err := os.Getwd()
			if err != nil {
				cwd = "."
			}
			if err := encode.Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      2,
				"method":  "session/new",
				"params": map[string]any{
					"cwd": cwd, "mcpServers": []any{},
				},
			}); err != nil {
				return nil
			}
			continue
		}
		if msg.ID != 2 {
			continue
		}

		models := make([]Model, 0, len(msg.Result.Models.Available))
		seen := make(map[string]bool, len(msg.Result.Models.Available))
		for _, available := range msg.Result.Models.Available {
			id := strings.TrimSpace(available.ID)
			if id == "" || seen[id] {
				continue
			}
			label := strings.TrimSpace(available.Name)
			if label == "" {
				label = id
			}
			seen[id] = true
			models = append(models, Model{ID: id, Label: label})
		}
		return models
	}
	return nil
}

// clineHistoryModels reads the model ids of past sessions from `cline history`.
// Anything here has already run on this account, which makes it a reliable
// supplement to a catalog that turns out to have gaps.
// The Cline models that actually run on this account without credit. Cline's
// own CLI shows exactly these three under "free models"; everything else in
// its 290-entry catalog bills against a balance.
//
// This is an explicit list rather than something derived, because Cline
// exposes no usable signal: ACP returns only {modelId, name}, and the pricing
// metadata bundled in the CLI spans several provider catalogs at once — it
// marks laguna as zero-priced but not the other two, so filtering on it
// surfaces the wrong set. An earlier attempt to infer "free" from id patterns
// had the same problem.
//
// Anything omitted here is still reachable: the picker's custom-id row sends
// any model id straight through.
var clineFreeModels = []string{
	"poolside/laguna-s-2.1:free",
	"deepseek/deepseek-v4-flash",
	"z-ai/glm-5.3-flash",
}

// clineOnlyFree narrows the catalog to clineFreeModels, in that order, and
// keeps whatever label the catalog gave each one.
func clineOnlyFree(all []Model) []Model {
	byID := make(map[string]Model, len(all))
	for _, m := range all {
		byID[m.ID] = m
	}
	out := make([]Model, 0, len(clineFreeModels))
	for _, id := range clineFreeModels {
		if m, ok := byID[id]; ok {
			out = append(out, m)
			continue
		}
		// not in the catalog (Cline omits some ids it can still run) — offer
		// it anyway, since it is known to work on this account
		out = append(out, Model{ID: id, Label: id})
	}
	return out
}

func clineHistoryModels() []Model {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "cline", "history", "--json", "--limit", "100").Output()
	if err != nil {
		return nil
	}
	var sessions []struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(out, &sessions); err != nil {
		var wrapped struct {
			Sessions []struct {
				Model string `json:"model"`
			} `json:"sessions"`
		}
		if json.Unmarshal(out, &wrapped) != nil {
			return nil
		}
		sessions = wrapped.Sessions
	}
	var models []Model
	seen := map[string]bool{}
	for _, s := range sessions {
		id := strings.TrimSpace(s.Model)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, Model{ID: id, Label: id})
	}
	return models
}

func clineConfiguredModels() []Model {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	blob, err := os.ReadFile(filepath.Join(home, ".cline", "data", "settings", "providers.json"))
	if err != nil {
		return nil
	}
	var cfg struct {
		LastUsedProvider string `json:"lastUsedProvider"`
		Providers        map[string]struct {
			Settings struct {
				Model string `json:"model"`
			} `json:"settings"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(blob, &cfg); err != nil {
		return nil
	}
	var out []Model
	seen := map[string]bool{}
	for _, p := range cfg.Providers {
		id := strings.TrimSpace(p.Settings.Model)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, Model{ID: id, Label: id})
	}
	return out
}

// RunTurn drives one Cline turn over ACP. Its --json print mode cannot resume
// a conversation, so ACP is the only path with memory — see acp.go.
func (c *cline) RunTurn(sessionID, cwd, model, conversationID, text string, t *Transcript, flush func()) error {
	return runACPTurn(acpDriver{
		name: c.Name(),
		bin:  c.Bin(),
		// Cline takes no model on argv: it switches on a live session instead.
		args:     func(string) []string { return []string{"--acp"} },
		setModel: true,
		// session/load reports success but a prompt to a loaded session comes
		// back empty, so a reaped connection has to start cold.
		canLoad: false,
	}, sessionID, cwd, model, conversationID, text, t, flush)
}
