package cliagent

import (
	"encoding/json"
	"strings"
)

func init() { register(&claudeCode{}) }

// claudeCode drives Anthropic's Claude Code CLI. One turn per process:
//
//	claude -p <text> --output-format stream-json --verbose [--model M] [--resume ID]
//
// This is the same integration shape the other backends use, and the reason it
// stays within Claude Code's terms: kusal never sees or moves Anthropic
// credentials, never calls the Anthropic API itself, and never resells access.
// It launches the user's own locally-installed Claude Code on the user's own
// machine, under the user's own login, exactly as if they had typed the command
// in the terminal that kusal already exposes. What travels over the tunnel is
// the prompt and the rendered transcript — not a token.
//
// Its stream is Anthropic Messages-shaped: `assistant` events carry content
// blocks (text or tool_use), `user` events carry tool_result blocks, and a
// final `result` event carries the whole reply. `system` and `rate_limit_event`
// lines are lifecycle noise and are skipped.
type claudeCode struct{}

func (c *claudeCode) Name() string { return "claude" }
func (c *claudeCode) Bin() string  { return "claude" }

// Models: Claude Code takes either an alias or a full model name and has no
// "list models" command. The aliases below are the ones its own --model help
// documents, so they track "latest" without kusal hardcoding dated ids; any
// specific version can still be reached through the picker's custom-id row.
func (c *claudeCode) Models() []Model {
	return []Model{
		{ID: "opus", Label: "Opus (latest)"},
		{ID: "sonnet", Label: "Sonnet (latest)"},
		{ID: "haiku", Label: "Haiku (latest)"},
		{ID: "fable", Label: "Fable (latest)"},
	}
}

func (c *claudeCode) Args(model, conversationID, text string) []string {
	args := []string{"-p", text, "--output-format", "stream-json", "--verbose"}
	if model != "" {
		args = append(args, "--model", model)
	}
	if conversationID != "" {
		args = append(args, "--resume", conversationID)
	}
	// Headless Claude Code cannot show a permission prompt, so anything short
	// of bypass leaves tool calls hanging or denied — acceptEdits only covers
	// file edits, not Bash. Same reasoning as agy's --dangerously-skip-
	// permissions and cline's --auto-approve: kusal already exposes a full PTY
	// over this authenticated tunnel, so this doesn't widen what a caller can
	// already do.
	return append(args, "--permission-mode", "bypassPermissions")
}

type claudeContentBlock struct {
	Type string `json:"type"` // text | tool_use | tool_result | thinking
	Text string `json:"text"`
	// tool_use
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Input map[string]any `json:"input"`
	// tool_result
	ToolUseID string          `json:"tool_use_id"`
	IsError   bool            `json:"is_error"`
	Content   json.RawMessage `json:"content"`
}

type claudeEvent struct {
	Type      string `json:"type"` // system | assistant | user | result | rate_limit_event
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	Message   *struct {
		Content []claudeContentBlock `json:"content"`
	} `json:"message"`
	// result
	Result  string `json:"result"`
	IsError bool   `json:"is_error"`
}

func (c *claudeCode) Fold(line string, t *Transcript) {
	var e claudeEvent
	if err := json.Unmarshal([]byte(line), &e); err != nil {
		return
	}
	// every event carries it; it's what --resume takes next turn
	if e.SessionID != "" {
		t.ConversationID = e.SessionID
	}

	switch e.Type {
	case "system", "rate_limit_event":
		// hook lifecycle and quota notices — nothing user-facing
		return

	case "assistant":
		if e.Message == nil {
			return
		}
		for _, b := range e.Message.Content {
			switch b.Type {
			case "text":
				// Claude Code emits each text block whole rather than as
				// deltas, and a turn can contain several separated by tool
				// calls — SetText closes the block so the next one is its own
				// part instead of concatenating.
				t.SetText(b.Text)
			case "tool_use":
				t.ToolStart(b.ID, b.Name, b.Input)
			}
		}

	case "user":
		// tool results come back as a synthetic user turn
		if e.Message == nil {
			return
		}
		for _, b := range e.Message.Content {
			if b.Type != "tool_result" {
				continue
			}
			t.ToolEnd(b.ToolUseID, claudeResultText(b.Content), b.IsError)
		}

	case "result":
		// the final reply, already streamed as assistant text in the normal
		// case — only used when nothing else produced any
		if !t.HasText() {
			t.SetText(e.Result)
		}
		t.CloseText()
	}
}

// claudeResultText flattens a tool_result's content, which is either a plain
// string or an array of typed blocks depending on the tool.
func claudeResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var sb strings.Builder
		for _, b := range blocks {
			if b.Text != "" {
				sb.WriteString(b.Text)
			}
		}
		return sb.String()
	}
	return string(raw)
}
