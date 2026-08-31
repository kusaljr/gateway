package cliagent

func init() { register(&copilot{}) }

// copilot is GitHub Copilot CLI (`npm i -g @github/copilot`), driven over ACP
// rather than its `--output-format json` print mode.
//
// ACP is the better fit for two reasons. Its print mode resumes with
// `--resume <id>`, but the JSONL it emits is Copilot's own envelope
// ({type, id, parentId, timestamp, data} with dotted type names like
// session.mcp_server_status_changed) — a private format that would need its
// own fold path. Over ACP the same turn arrives as the spec's
// agent_message_chunk / tool_call / tool_call_update updates, which every ACP
// backend here already shares. Copilot also reports loadSession, so a thread
// survives its connection being reaped (see acpDriver.canLoad).
//
// As with the other CLI backends this is the user's own locally-installed
// copilot, launched on their machine under their own `copilot login`. kusal
// never handles a GitHub credential and never calls a model API itself.
type copilot struct{}

func (c *copilot) Name() string { return "copilot" }
func (c *copilot) Bin() string  { return "copilot" }

// copilotDefaultModel stands for "whatever this account is configured to use".
// It travels to the client as a normal model id so the picker has something to
// show and store, and is resolved by omitting --model entirely.
const copilotDefaultModel = "default"

// Models: Copilot CLI has no "list models" command, and no catalog over ACP
// either — its session/new advertises only `mode` and `allow_all` config
// options, no availableModels (unlike Cline, whose catalog cline.go reads from
// exactly that response).
//
// `copilot help config` does document the accepted --model values, but that is
// the superset the CLI recognises, not what an account may actually run: with
// no paid Copilot plan every one of them is refused with
//
//	Error: Model "claude-haiku-4.5" from --model flag is not available.
//
// and only the account default works. Offering 25 ids that mostly fail is the
// same "listed but not runnable" trap cline.go's catalog comment describes, and
// here it would be worse — the failure is a hard error before the turn starts.
// So only the default is listed. A specific model stays reachable through the
// picker's custom-id row, which passes any typed id straight to --model, which
// is the right place for it: opt-in, and obviously the user's own choice.
func (c *copilot) Models() []Model {
	return []Model{{ID: copilotDefaultModel, Label: "Default model"}}
}

func (c *copilot) RunTurn(sessionID, cwd, model, conversationID, text string, t *Transcript, flush func()) error {
	return runACPTurn(acpDriver{
		name: c.Name(),
		bin:  c.Bin(),
		args: func(model string) []string {
			// --allow-all-tools: headless has no one to answer a permission
			// prompt. ACP does carry permission requests, and acpAutoApprove
			// answers them, but pre-approving avoids a round trip per tool
			// call. Same posture as claude's bypassPermissions and grok's
			// --always-approve: kusal already exposes a full PTY over this
			// authenticated tunnel, so it doesn't widen what a caller can do.
			//
			// --no-color: ACP framing is JSON, but the notices Copilot prints
			// around it are not, and escape codes in those defeat the
			// "starts with {" test that skips them.
			args := []string{"--acp", "--allow-all-tools", "--no-color"}
			// Copilot has no session/set_model, so the model is fixed here at
			// spawn; changing it reopens the connection (see runACPTurn).
			if model != "" && model != copilotDefaultModel {
				args = append(args, "--model", model)
			}
			return args
		},
		setModel: false,
		canLoad:  true,
	}, sessionID, cwd, model, conversationID, text, t, flush)
}
