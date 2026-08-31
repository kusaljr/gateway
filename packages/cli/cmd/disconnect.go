package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"kusal/internal/config"
	"kusal/internal/db"
	"kusal/internal/tunnel"
)

var disconnectCmd = &cobra.Command{
	Use:   "disconnect",
	Short: "Stop the tunnel and shell sharing",
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := stopDaemonAndTunnel(); err != nil {
			return err
		}
		store, err := db.Open()
		if err == nil {
			defer store.DB.Close()
			id := store.GetKV("device_id")
			if id != "" {
				_ = store.UpdateStatus(id, "disconnected")
			}
		}
		fmt.Println("✓ disconnected, tunnel stopped")
		return nil
	},
}

func init() { rootCmd.AddCommand(disconnectCmd) }

// stopDaemonAndTunnel kills the shell daemon and the cloudflared process it
// parented. Shared with `kusal remove`, which has to stop the connection before
// it can delete what the connection was using.
func stopDaemonAndTunnel() error {
	if data, err := os.ReadFile(filepath.Join(config.Dir(), "daemon.pid")); err == nil {
		var pid int
		_, _ = fmt.Sscanf(string(data), "%d", &pid)
		if pid > 0 {
			if proc, err := os.FindProcess(pid); err == nil {
				_ = proc.Kill()
				fmt.Printf("stopped daemon (pid %d)\n", pid)
			}
		}
		_ = os.Remove(filepath.Join(config.Dir(), "daemon.pid"))
	}
	return tunnel.Stop()
}
