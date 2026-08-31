package cliagent

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"
)

func init() { register(&grok{}) }

// grok is xAI's Grok CLI. One turn per process:
//
//	grok -p <text> --output-format streaming-json --cwd <dir> [-m MODEL] [-r ID]
//
// Its streaming-json is NDJSON of ACP-style session updates: `text` and
// `thought` carry deltas, `tool_call`/`tool_call_update` carry tool activity,
// and a final `end` carries the sessionId that -r resumes.
type grok struct{ models modelCache }

func (g *grok) Name() string { return "grok" }
func (g *grok) Bin() string  { return "grok" }

// Models runs `grok models`, which prints a human-readable list rather than
// JSON: a "Default model: x" line, then "Available models:" followed by
// "  * id (default)" entries.
func (g *grok) Models() []Model {
	return g.models.get(func() []Model {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "grok", "models").Output()
		if err != nil {
			return nil
		}
		var models []Model
		seen := map[string]bool{}
		inList := false
		for _, line := range strings.Split(string(out), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "Available models:") {
				inList = true
				continue
			}
			if !inList || !strings.HasPrefix(trimmed, "*") {
				continue
			}
			id := strings.TrimSpace(strings.TrimPrefix(trimmed, "*"))
			id = strings.TrimSpace(strings.TrimSuffix(id, "(default)"))
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			models = append(models, Model{ID: id, Label: id})
		}
		return models
	})
}

func (g *grok) Args(model, conversationID, text string) []string {
	args := []string{"-p", text, "--output-format", "streaming-json"}
	if model != "" {
		args = append(args, "-m", model)
	}
	if conversationID != "" {
		args = append(args, "-r", conversationID)
	}
	// Headless has no one to answer a permission prompt, so tools would
	// otherwise stall. Same posture as the other CLI backends — kusal already
	// exposes a full PTY over this authenticated tunnel.
	return append(args, "--always-approve")
}

type grokEvent struct {
	Type string `json:"type"`
	// text / thought deltas
	Data string `json:"data"`
	// tool_call / tool_call_update
	ToolCallID string         `json:"toolCallId"`
	ToolName   string         `json:"toolName"`
	Title      string         `json:"title"`
	Status     string         `json:"status"`
	RawInput   map[string]any `json:"rawInput"`
	Content    []struct {
		Content *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"content"`
	// end
	StopReason string `json:"stopReason"`
	SessionID  string `json:"sessionId"`
}

func (g *grok) Fold(line string, t *Transcript) {
	var e grokEvent
	if err := json.Unmarshal([]byte(line), &e); err != nil {
		return
	}

	switch e.Type {
	case "text":
		t.AppendText(e.Data)

	case "tool_call":
		name := e.ToolName
		if name == "" {
			name = e.Title
		}
		t.ToolStart(e.ToolCallID, name, e.RawInput)

	case "tool_call_update":
		// rawOutput carries the command's stdout as a byte array, which is
		// unreadable; the content blocks hold the same thing as text.
		output := grokContentText(e.Content)
		switch e.Status {
		case "completed":
			t.ToolEnd(e.ToolCallID, output, false)
		case "failed", "error":
			t.ToolEnd(e.ToolCallID, output, true)
		default:
			t.ToolOutput(e.ToolCallID, "")
		}

	case "end":
		// what -r resumes on the next turn
		if e.SessionID != "" {
			t.ConversationID = e.SessionID
		}
		t.CloseText()

		// `thought` (reasoning deltas), `usage` and `available_commands` are
		// skipped: the first is streamed token-by-token and would bury the
		// reply, the rest aren't user-facing.
	}
}

func grokContentText(blocks []struct {
	Content *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}) string {
	var sb strings.Builder
	for _, b := range blocks {
		if b.Content != nil {
			sb.WriteString(b.Content.Text)
		}
	}
	return sb.String()
}
