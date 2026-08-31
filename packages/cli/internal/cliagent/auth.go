package cliagent

// Provider inventory: which coding-agent CLIs exist on this machine, and
// whether each one looks signed in.
//
// kusal never handles a provider credential (see the package doc), so "signed
// in" can only ever be inferred from what a login leaves behind: a credential
// file, an API key in the environment, or — for Claude Code on macOS — a
// Keychain item. That makes the answer three-valued rather than a boolean. A
// positive signal is proof; the absence of every known signal only proves
// "signed out" for agents whose credential store we can actually inspect. An
// agent that keeps its auth somewhere opaque (a SQLite database, or a path it
// moved between versions) reports `unknown` instead, so the UI never tells
// someone to log into something they're already logged into.

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type AuthState = string

const (
	AuthSignedIn  AuthState = "signed_in"
	AuthSignedOut AuthState = "signed_out"
	AuthUnknown   AuthState = "unknown"
)

// CredFile is one place a login may leave a credential, relative to $HOME.
type CredFile struct {
	Path string
	// When set, the file must also contain this substring. Needed where the
	// file exists whether or not a login happened — ~/.claude.json holds
	// settings and history too, and only gains an oauthAccount once signed in.
	Needle string
}

// Probe describes where one CLI's evidence of a login lives.
type Probe struct {
	Files []CredFile
	// Env vars that are themselves a credential — several of these CLIs accept
	// a key from the environment instead of a stored login.
	Envs []string
	// macOS Keychain service name. Checked with `security find-generic-password`
	// WITHOUT -w, which reports existence and never prints the secret.
	Keychain string
	// false when a login can leave no trace we know how to read, so "found
	// nothing" has to report unknown rather than signed out.
	Conclusive bool
}

// Check reports the login state and, when positive, which signal proved it.
// The source is a location, never a credential.
func (p Probe) Check() (AuthState, string) {
	if p.Keychain != "" && runtime.GOOS == "darwin" {
		cmd := exec.Command("security", "find-generic-password", "-s", p.Keychain)
		cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
		if cmd.Run() == nil {
			return AuthSignedIn, "macOS Keychain"
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, f := range p.Files {
			full := filepath.Join(home, f.Path)
			st, err := os.Stat(full)
			// an empty (or truncated) credential file is not a login
			if err != nil || st.IsDir() || st.Size() < 3 {
				continue
			}
			if f.Needle != "" && !fileContains(full, f.Needle) {
				continue
			}
			return AuthSignedIn, "~/" + f.Path
		}
	}
	for _, env := range p.Envs {
		if strings.TrimSpace(os.Getenv(env)) != "" {
			return AuthSignedIn, "$" + env
		}
	}
	if p.Conclusive {
		return AuthSignedOut, ""
	}
	return AuthUnknown, ""
}

// Reads at most 4MB: ~/.claude.json in particular grows with project history,
// and only the presence of a key matters here.
func fileContains(path, needle string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	blob, err := io.ReadAll(io.LimitReader(f, 4<<20))
	if err != nil {
		return false
	}
	return strings.Contains(string(blob), needle)
}

// order is also the order clients display these in.
var order = []string{"claude", "codex", "agy", "grok", "copilot", "cline"}

var labels = map[string]string{
	"claude":  "Claude Code",
	"codex":   "Codex",
	"agy":     "Gemini CLI",
	"grok":    "Grok CLI",
	"copilot": "Copilot CLI",
	"cline":   "Cline",
}

// Where each CLI stores a login, as of the versions this was written against.
// A path that moves in a later release costs a false "signed out" for that
// agent only — hence the needles and the multiple candidates per agent.
var probes = map[string]Probe{
	// Claude Code puts its OAuth token in the login keychain on macOS and in
	// ~/.claude/.credentials.json elsewhere; ~/.claude.json exists either way,
	// so it only counts when it carries the signed-in account object.
	"claude": {
		Keychain:   "Claude Code-credentials",
		Files:      []CredFile{{Path: ".claude/.credentials.json"}, {Path: ".claude.json", Needle: "oauthAccount"}},
		Envs:       []string{"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"},
		Conclusive: true,
	},
	"codex": {
		Files:      []CredFile{{Path: ".codex/auth.json"}},
		Envs:       []string{"OPENAI_API_KEY"},
		Conclusive: true,
	},
	// agy is the Gemini CLI: OAuth writes oauth_creds.json, and an API key can
	// come from the environment instead.
	"agy": {
		Files:      []CredFile{{Path: ".gemini/oauth_creds.json"}, {Path: ".agy/oauth_creds.json"}},
		Envs:       []string{"GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"},
		Conclusive: true,
	},
	"grok": {
		Files:      []CredFile{{Path: ".grok/user-settings.json", Needle: "apiKey"}},
		Envs:       []string{"GROK_API_KEY", "XAI_API_KEY"},
		Conclusive: true,
	},
	// The Copilot CLI reuses the GitHub CLI's own OAuth store.
	"copilot": {
		Files: []CredFile{
			{Path: ".config/github-copilot/apps.json", Needle: "oauth_token"},
			{Path: ".config/github-copilot/hosts.json", Needle: "oauth_token"},
		},
		Envs:       []string{"GH_TOKEN", "GITHUB_TOKEN"},
		Conclusive: true,
	},
	// Cline signs into a provider rather than a Cline account, so the key sits
	// in its provider settings.
	"cline": {
		Files: []CredFile{
			{Path: ".cline/data/settings/providers.json", Needle: "apiKey"},
			{Path: ".cline/data/settings/providers.json", Needle: "api_key"},
		},
		Envs:       []string{"CLINE_API_KEY"},
		Conclusive: false,
	},
}

// Status is one row of the provider inventory.
type Status struct {
	Name      string `json:"name"`
	Label     string `json:"label"`
	Bin       string `json:"bin"`
	Installed bool   `json:"installed"`
	// resolved path on PATH — the quickest way to tell two installs apart
	Path string `json:"path,omitempty"`
	// signed_in | signed_out | unknown; empty when the CLI isn't installed
	Auth AuthState `json:"auth,omitempty"`
	// where the login was found (a location, never a credential)
	Source string `json:"source,omitempty"`
}

// Statuses reports every known CLI agent, installed or not, in display order.
func Statuses() []Status {
	out := make([]Status, 0, len(order))
	for _, name := range order {
		b, ok := registry[name]
		if !ok {
			continue
		}
		st := Status{Name: name, Label: labels[name], Bin: b.Bin()}
		if path, err := exec.LookPath(b.Bin()); err == nil {
			st.Installed, st.Path = true, path
			// only meaningful for something that can actually run
			st.Auth, st.Source = probes[name].Check()
		}
		out = append(out, st)
	}
	return out
}
