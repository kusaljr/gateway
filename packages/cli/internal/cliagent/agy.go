package cliagent

import (
	"encoding/json"
	"os/exec"
	"strings"
)

func init() { register(&agy{}) }

// agy is the Gemini/Antigravity CLI. One turn per process:
//
//	agy -p <text> --output-format stream-json [--model M] [--conversation ID]
//
// It emits an `init` event carrying the conversation id, `step_update` events
// (one per step, repeated as the step progresses), and a final `result`.
type agy struct{ models modelCache }

func (a *agy) Name() string { return "agy" }
func (a *agy) Bin() string  { return "agy" }

func (a *agy) Models() []Model {
	return a.models.get(func() []Model {
		out, err := exec.Command("agy", "models").Output()
		if err != nil {
			return nil
		}
		// "Fetching available models..." preamble, then "id\tLabel" lines
		var models []Model
		for _, line := range strings.Split(string(out), "\n") {
			id, label, ok := strings.Cut(strings.TrimSpace(line), "\t")
			if !ok {
				continue
			}
			id, label = strings.TrimSpace(id), strings.TrimSpace(label)
			if id == "" {
				continue
			}
			if label == "" {
				label = id
			}
			models = append(models, Model{ID: id, Label: label})
		}
		return models
	})
}

func (a *agy) Args(model, conversationID, text string) []string {
	args := []string{"-p", text, "--output-format", "stream-json"}
	if model != "" {
		args = append(args, "--model", model)
	}
	if conversationID != "" {
		args = append(args, "--conversation", conversationID)
	}
	// Headless agy cannot prompt for tool permissions, so without this every
	// tool call is auto-denied and it can do nothing but talk (its own error
	// output says exactly that). kusal already exposes a full PTY over the
	// same authenticated tunnel, so this doesn't widen the trust boundary.
	return append(args, "--dangerously-skip-permissions")
}

type agyToolInfo struct {
	Name       string         `json:"name"`
	Parameters map[string]any `json:"parameters"`
	Error      *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type agyEvent struct {
	Event          string `json:"event"` // init | step_update | result
	ConversationID string `json:"conversation_id"`
	Init           *struct {
		ConversationID string `json:"conversation_id"`
	} `json:"init"`
	StepUpdate *struct {
		ConversationID string       `json:"conversation_id"`
		StepIndex      int          `json:"step_index"`
		State          string       `json:"state"`      // ACTIVE | DONE | ERROR
		StepType       string       `json:"step_type"`  // user_input | agent_response | tool
		TextDelta      string       `json:"text_delta"` // appended, not replaced
		ToolName       string       `json:"tool_name"`
		ToolInfo       *agyToolInfo `json:"tool_info"`
	} `json:"step_update"`
	Result *struct {
		ConversationID string `json:"conversation_id"`
		Status         string `json:"status"`
		Response       string `json:"response"`
	} `json:"result"`
}

func (a *agy) Fold(line string, t *Transcript) {
	var e agyEvent
	if err := json.Unmarshal([]byte(line), &e); err != nil {
		return
	}
	if e.ConversationID != "" {
		t.ConversationID = e.ConversationID
	}

	switch e.Event {
	case "init":
		if e.Init != nil && e.Init.ConversationID != "" {
			t.ConversationID = e.Init.ConversationID
		}

	case "step_update":
		su := e.StepUpdate
		if su == nil || su.StepType == "user_input" { // already echoed locally
			return
		}
		if su.ConversationID != "" {
			t.ConversationID = su.ConversationID
		}
		if su.StepType == "tool" {
			key := stepKey(su.StepIndex)
			var input map[string]any
			var errMsg string
			if su.ToolInfo != nil {
				input = su.ToolInfo.Parameters
				if su.ToolInfo.Error != nil {
					errMsg = su.ToolInfo.Error.Message
				}
			}
			t.ToolStart(key, su.ToolName, input)
			switch su.State {
			case "DONE":
				t.ToolEnd(key, errMsg, false)
			case "ERROR":
				t.ToolEnd(key, errMsg, true)
			}
			return
		}
		// agent_response: text_delta is incremental, and a step that never
		// emits any is thinking-only — AppendText ignores the empty case, so
		// no empty bubble is created for it.
		t.AppendText(su.TextDelta)

	case "result":
		if e.Result == nil {
			return
		}
		if e.Result.ConversationID != "" {
			t.ConversationID = e.Result.ConversationID
		}
		// A turn can finish with text only in the final response (agy reports
		// SUCCESS with an empty one when every tool was denied) — surface it
		// rather than showing a blank reply.
		if !t.HasText() {
			t.SetText(e.Result.Response)
		}
		t.CloseText()
	}
}

func stepKey(i int) string {
	return "step-" + itoa(i)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		b[pos] = '-'
	}
	return string(b[pos:])
}
