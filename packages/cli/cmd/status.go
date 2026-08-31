package cmd

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"kusal/internal/auth"
	"kusal/internal/awake"
	"kusal/internal/config"
	"kusal/internal/db"
	"kusal/internal/tunnel"
)

func parseToken(tok string) (string, string, error) { return auth.ParseTunnelToken(tok) }

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show connection and tunnel status",
	RunE: func(cmd *cobra.Command, args []string) error {
		store, err := db.Open()
		if err != nil {
			return err
		}
		defer store.DB.Close()

		deviceID := store.GetKV("device_id")
		deviceName := store.GetKV("device_name")
		tunnelID := store.GetKV("tunnel_id")
		accountID := store.GetKV("account_id")
		localAddr := store.GetKV("local_addr")
		publicHostname := store.GetKV("public_hostname")
		// auto-repair bogus "unknown" from old bug (parse stored token)
		if (tunnelID == "" || tunnelID == "unknown") && store.GetKV("tunnel_token") != "" {
			if tid, aid, err := parseToken(store.GetKV("tunnel_token")); err == nil && tid != "" {
				tunnelID = tid
				accountID = aid
				_ = store.SetKV("tunnel_id", tid)
				_ = store.SetKV("account_id", aid)
			}
		}

		daemonPID := readPID(filepath.Join(config.Dir(), "daemon.pid"))
		tunnelPID := readPID(filepath.Join(config.Dir(), "tunnel.pid"))
		running := tunnel.IsRunning()

		fmt.Println("┌─ kusal status")
		fmt.Printf("│  device:  %s (%s)  id %s\n", bold(deviceName), dim(hostnameOr()), shortID(deviceID))
		if tunnelID == "" || tunnelID == "unknown" {
			fmt.Printf("│  tunnel:  %s  %s\n", dim("unknown"), dim("(re-run: kusal connect to fix)"))
		} else {
			fmt.Printf("│  tunnel:  %s  account %s\n", tunnelID, dim(accountID))
		}
		fmt.Printf("│  local:   http://%s  %s\n", localAddr, dim("(shell + frontend)"))
		if localAddr != "" {
			if isLocalHealthy(localAddr) {
				fmt.Printf("│  shell:   %s  %s\n", green("● healthy"), dim("GET /health ok"))
			} else {
				fmt.Printf("│  shell:   %s  %s\n", red("● unreachable"), dim("no response on "+localAddr))
			}
		}
		if running {
			fmt.Printf("│  tunnel:  %s  pid %s  %s\n", green("● running"), dim(tunnelPID), dim("quic"))
		} else {
			fmt.Printf("│  tunnel:  %s  %s\n", red("● stopped"), dim("run: kusal connect"))
		}
		if daemonPID != "" {
			fmt.Printf("│  daemon:  %s  pid %s  %s\n", green("● running"), dim(daemonPID), dim("~/.kusal/daemon.log"))
		} else {
			fmt.Printf("│  daemon:  %s\n", dim("not running"))
		}
		// "why is my laptop not sleeping" should be answerable without guessing
		if awake.Active() {
			fmt.Printf("│  awake:   %s  %s\n", green("● holding"), dim("machine kept awake while connected"))
		} else if daemonPID != "" {
			fmt.Printf("│  awake:   %s  %s\n", dim("off"), dim("machine may sleep and drop the tunnel"))
		}
		fmt.Printf("│  db:      %s\n", dim(config.DBPath()))
		fmt.Println("└─")

		if !running {
			fmt.Println("\n  → start: kusal connect")
		} else {
			fmt.Println("\n  logs:  kusal logs --follow   (or: kusal logs --which daemon | cloudflared)")
			if publicHostname != "" {
				fmt.Printf("  public: https://%s\n", publicHostname)
			} else if tunnelID != "" && tunnelID != "unknown" {
				fmt.Printf("  route: cloudflared tunnel route dns %s <hostname>   (or: kusal connect --domain <base> to automate this)\n", tunnelID)
			}
		}

		if v, _ := cmd.Flags().GetBool("verbose"); v {
			fmt.Println("\n[kv]")
			for _, k := range []string{"device_id", "device_name", "tunnel_id", "account_id", "local_addr"} {
				fmt.Printf("  %s=%s\n", k, store.GetKV(k))
			}
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(statusCmd)
	statusCmd.Flags().BoolP("verbose", "v", false, "Show raw kv")
}

func readPID(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
func shortID(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}
func hostnameOr() string {
	h, _ := os.Hostname()
	if h == "" {
		return "unknown"
	}
	return h
}
func isLocalHealthy(addr string) bool {
	if addr == "" {
		return false
	}
	c, err := net.DialTimeout("tcp", addr, 600*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}
func bold(s string) string  { return "\033[1m" + s + "\033[0m" }
func dim(s string) string   { return "\033[2m" + s + "\033[0m" }
func green(s string) string { return "\033[32m" + s + "\033[0m" }
func red(s string) string   { return "\033[31m" + s + "\033[0m" }
