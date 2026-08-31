// Package awake keeps the machine from sleeping while a kusal connection is
// up. A laptop that suspends takes the tunnel down with it, and the phone on
// the other end sees a device that was online a moment ago and is now
// unreachable for no visible reason — the single most confusing way for this
// to fail.
//
// Idle and system sleep are inhibited; the DISPLAY is deliberately left alone.
// A closed-lid machine serving a tunnel is the normal case here, and forcing
// the screen to stay lit would burn battery for nothing.
package awake

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
)

// Keep starts the platform's sleep inhibitor and returns a function that stops
// it. The helper is also told to exit when THIS process does, so a kusal killed
// with SIGKILL — which runs no cleanup — cannot leave the machine permanently
// awake.
//
// Every failure is silent by design: not being able to inhibit sleep is worth
// no more than the sleep itself, and a warning on every connect for a machine
// that simply has no inhibitor would be noise.
func Keep() (stop func()) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		// -i idle sleep, -s system sleep, -m disk idle; -w ties its lifetime to
		// this process. No -d: the screen may sleep.
		cmd = exec.Command("caffeinate", "-i", "-s", "-m", "-w", strconv.Itoa(os.Getpid()))
	case "linux":
		// systemd's own inhibitor; --mode=block holds it for as long as the
		// child runs, which is why the child is a sleep that never returns.
		cmd = exec.Command("systemd-inhibit", "--what=idle:sleep", "--who=kusal",
			"--why=serving a Cloudflare Tunnel", "--mode=block", "sleep", "infinity")
	default:
		return func() {}
	}
	if err := cmd.Start(); err != nil {
		return func() {}
	}
	// reaped here so the helper does not linger as a zombie for the life of the
	// daemon
	go func() { _ = cmd.Wait() }()
	return func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}
}

// Active reports whether an inhibitor of ours is currently running. Used by
// `kusal status`, so the answer to "why is my laptop not sleeping" is one
// command away.
func Active() bool {
	if runtime.GOOS == "windows" {
		return false
	}
	pattern := "caffeinate -i -s -m -w"
	if runtime.GOOS == "linux" {
		pattern = "systemd-inhibit --what=idle:sleep --who=kusal"
	}
	return exec.Command("pgrep", "-f", pattern).Run() == nil
}
