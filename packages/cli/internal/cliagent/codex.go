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

func init() { register(&codex{}) }

// codex is OpenAI's Codex CLI. One turn per process:
//
//	codex exec --json [-m MODEL] -C <dir> <text>
//	codex exec resume <thread-id> --json ... <text>
//
// Its JSONL is item-oriented rather than token-oriented: `thread.started`
// carries the id used to resume, then item.started/updated/completed events
// each carry a whole item (an agent message, a command execution…), and
// `turn.completed` ends the turn. Text arrives complete, never as deltas.
type codex struct{ models modelCache }

func (c *codex) Name() string { return "codex" }
func (c *codex) Bin() string  { return "codex" }

// Models asks Codex app-server for its picker-visible model catalog. This is
// the same account-aware model/list method used by Codex's rich clients. Older
// versions without app-server retain the configured model as a fallback.
func (c *codex) Models() []Model {
	return c.models.get(func() []Model {
		if models := codexAppServerModels(); len(models) > 0 {
			return models
		}
		return codexConfiguredModels()
	})
}

func codexAppServerModels() []Model {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "codex", "app-server")
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
		"method": "initialize",
		"id":     0,
		"params": map[string]any{
			"clientInfo": map[string]string{
				"name": "kusal", "title": "Kusal", "version": "1",
			},
		},
	}); err != nil {
		return nil
	}

	type response struct {
		ID     *int            `json:"id"`
		Error  json.RawMessage `json:"error"`
		Result struct {
			Data []struct {
				ID          string `json:"id"`
				Model       string `json:"model"`
				DisplayName string `json:"displayName"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		} `json:"result"`
	}

	sendPage := func(id int, cursor *string) error {
		params := map[string]any{"limit": 100, "includeHidden": false}
		if cursor != nil && *cursor != "" {
			params["cursor"] = *cursor
		}
		return encode.Encode(map[string]any{"method": "model/list", "id": id, "params": params})
	}

	initialized := false
	pageID := 1
	var models []Model
	seen := map[string]bool{}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var msg response
		if err := json.Unmarshal([]byte(line), &msg); err != nil || msg.ID == nil {
			continue
		}
		if len(msg.Error) > 0 && string(msg.Error) != "null" {
			return nil
		}
		if *msg.ID == 0 && !initialized {
			initialized = true
			if err := encode.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
				return nil
			}
			if err := sendPage(pageID, nil); err != nil {
				return nil
			}
			continue
		}
		if *msg.ID != pageID {
			continue
		}
		for _, available := range msg.Result.Data {
			id := strings.TrimSpace(available.Model)
			if id == "" {
				id = strings.TrimSpace(available.ID)
			}
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			label := strings.TrimSpace(available.DisplayName)
			if label == "" {
				label = id
			}
			models = append(models, Model{ID: id, Label: label})
		}
		if msg.Result.NextCursor == nil || *msg.Result.NextCursor == "" {
			return models
		}
		pageID++
		if err := sendPage(pageID, msg.Result.NextCursor); err != nil {
			return nil
		}
	}
	return nil
}

func codexConfiguredModels() []Model {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	blob, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		return nil
	}
	// Deliberately not a TOML parse: only the top-level `model = "..."`
	// matters, and it appears before any [section] header. Scanning stops at
	// the first section so a per-project override can't become the default.
	for _, line := range strings.Split(string(blob), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) != "model" {
			continue
		}
		id := strings.Trim(strings.TrimSpace(val), `"'`)
		if id != "" {
			return []Model{{ID: id, Label: id}}
		}
	}
	return nil
}

func (c *codex) Args(model, conversationID, text string) []string {
	args := []string{"exec"}
	resuming := conversationID != ""
	if resuming {
		// resume takes the thread id positionally, before the flags
		args = append(args, "resume", conversationID)
	}
	args = append(args, "--json", "--skip-git-repo-check")
	// workspace-write is the middle sandbox tier: the agent can edit the
	// project and run commands, but not reach the wider filesystem. agy and
	// cline are fully auto-approved because neither offers a sandbox at all;
	// codex does, so it gets the tighter setting rather than
	// --dangerously-bypass-approvals-and-sandbox.
	//
	// `codex exec` and `codex exec resume` take different flag sets: resume
	// rejects -s outright ("unexpected argument '-s'"), so the same policy has
	// to go through a config override there. Verified against both paths —
	// passing -s to resume fails instantly and the turn returns nothing.
	if resuming {
		args = append(args, "-c", `sandbox_mode="workspace-write"`)
	} else {
		args = append(args, "-s", "workspace-write")
	}
	if model != "" {
		args = append(args, "-m", model)
	}
	return append(args, text)
}

type codexItem struct {
	ID     string `json:"id"`
	Type   string `json:"type"` // agent_message | command_execution | reasoning | file_change | mcp_tool_call | error
	Text   string `json:"text"`
	Status string `json:"status"` // in_progress | completed | failed
	// command_execution
	Command          string `json:"command"`
	AggregatedOutput string `json:"aggregated_output"`
	ExitCode         *int   `json:"exit_code"`
	// mcp_tool_call
	Tool   string `json:"tool"`
	Server string `json:"server"`
	// error
	Message string `json:"message"`
}

type codexEvent struct {
	Type     string     `json:"type"`
	ThreadID string     `json:"thread_id"`
	Item     *codexItem `json:"item"`
	Error    *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *codex) Fold(line string, t *Transcript) {
	var e codexEvent
	if err := json.Unmarshal([]byte(line), &e); err != nil {
		return
	}

	switch e.Type {
	case "thread.started":
		if e.ThreadID != "" {
			t.ConversationID = e.ThreadID
		}
		return

	case "turn.failed", "error":
		if e.Error != nil && e.Error.Message != "" {
			t.SetText(e.Error.Message)
		}
		return
	}

	it := e.Item
	if it == nil {
		return
	}
	done := e.Type == "item.completed"

	switch it.Type {
	case "agent_message":
		// text arrives whole, so only the terminal event is worth taking —
		// an earlier partial would otherwise be duplicated by the final one
		if done {
			t.SetText(it.Text)
		}

	case "reasoning":
		// summaries only; skipped for the same reason the clients collapse
		// opencode's reasoning parts — they're noise in a phone transcript

	case "command_execution":
		key := "cmd-" + it.ID
		t.ToolStart(key, "run_command", map[string]any{"command": it.Command})
		if done {
			failed := it.Status == "failed" || (it.ExitCode != nil && *it.ExitCode != 0)
			t.ToolEnd(key, it.AggregatedOutput, failed)
		} else {
			t.ToolOutput(key, "")
		}

	case "file_change":
		key := "file-" + it.ID
		t.ToolStart(key, "edit", map[string]any{"description": it.Text})
		if done {
			t.ToolEnd(key, it.Text, it.Status == "failed")
		}

	case "mcp_tool_call":
		key := "mcp-" + it.ID
		name := it.Tool
		if it.Server != "" {
			name = it.Server + "/" + it.Tool
		}
		t.ToolStart(key, name, nil)
		if done {
			t.ToolEnd(key, it.Text, it.Status == "failed")
		}

	case "error":
		if done || it.Message != "" {
			t.SetText(firstNonEmpty(it.Message, it.Text))
		}
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
