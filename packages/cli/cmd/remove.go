package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"kusal/internal/auth"
	"kusal/internal/cfapi"
	"kusal/internal/db"
	"kusal/internal/tunnel"
)

// Keys that describe THIS connection. Everything else in the store — sessions,
// projects, the agent usage cache — belongs to the machine rather than to the
// tunnel, and survives. `auth_session:` is cleared wholesale on top of these:
// a removed connection must not leave behind a session that would still
// authenticate if the shell were ever exposed again.
var connectionKeys = []string{
	"device_id",
	"device_name",
	"tunnel_token",
	"tunnel_id",
	"account_id",
	"local_addr",
	"public_hostname",
	"domain",
	"cf_access_token",
	"cf_refresh_token",
	"cf_email",
}

var removeCmd = &cobra.Command{
	Use:   "remove",
	Short: "Delete this device's tunnel and clear its connection state",
	Long: `kusal remove tears the connection down for good:
  1. Stops the shell daemon and the cloudflared tunnel
  2. Deletes the hostname's DNS record and the Cloudflare Tunnel itself
  3. Clears this device's connection state and revokes its login sessions

Threads, projects and usage history stay — they belong to the machine, not to
the tunnel. The wildcard Access Application is never touched: it covers every
device on the domain, not just this one.

Use --local to keep the Cloudflare side and only clear local state, e.g. when
the tunnel is shared or you intend to reconnect to it later.`,
	RunE: runRemove,
}

func init() {
	rootCmd.AddCommand(removeCmd)
	removeCmd.Flags().Bool("local", false, "Only clear local state; leave the Cloudflare tunnel and DNS record in place")
	removeCmd.Flags().Bool("yes", false, "Skip the confirmation prompt")
}

func runRemove(cmd *cobra.Command, _ []string) error {
	localOnly, _ := cmd.Flags().GetBool("local")
	assumeYes, _ := cmd.Flags().GetBool("yes")

	store, err := db.Open()
	if err != nil {
		return err
	}
	defer store.DB.Close()

	deviceID := store.GetKV("device_id")
	name := store.GetKV("device_name")
	hostname := store.GetKV("public_hostname")
	tunnelID := store.GetKV("tunnel_id")
	accountID := store.GetKV("account_id")

	if deviceID == "" && tunnelID == "" && hostname == "" {
		fmt.Println("Nothing to remove — this machine has no kusal connection stored.")
		return nil
	}

	fmt.Println()
	fmt.Println("This will remove:")
	if name != "" {
		fmt.Println("  device       ", name)
	}
	if hostname != "" {
		fmt.Println("  hostname     ", hostname)
	}
	if tunnelID != "" {
		fmt.Println("  tunnel       ", tunnelID)
	}
	fmt.Println("  local state   connection keys + login sessions (threads and projects stay)")
	if localOnly {
		fmt.Println()
		fmt.Println("  --local: the Cloudflare tunnel and DNS record are left in place.")
	} else if tunnelID != "" {
		fmt.Println()
		fmt.Println("  The Cloudflare Tunnel and its DNS record are deleted. This cannot be undone;")
		fmt.Println("  a later `kusal connect` mints a new tunnel with a new id.")
	}

	// Typing the device name back is deliberate friction: this deletes remote
	// infrastructure, and a bare y/n is too easy to answer on autopilot.
	if !assumeYes {
		want, label := "yes", `"yes"`
		if name != "" {
			want, label = name, "the device name"
		}
		fmt.Println()
		if auth.Prompt("Type "+label+" to confirm", "") != want {
			fmt.Println("Aborted — nothing was removed.")
			return nil
		}
	}

	fmt.Println()
	if err := stopDaemonAndTunnel(); err != nil {
		fmt.Println("⚠ Could not stop the running tunnel:", err)
	}

	if !localOnly && tunnelID != "" {
		removeCloudflareSide(store, hostname, tunnelID, accountID)
	}

	if deviceID != "" {
		_ = store.DeleteDevice(deviceID)
	}
	_ = store.DeleteKVPrefix("auth_session:")
	if err := store.DeleteKV(connectionKeys...); err != nil {
		return err
	}
	fmt.Println("✓ local connection state cleared")

	fmt.Println()
	fmt.Println("Removed. `kusal connect` starts a fresh connection whenever you want one.")
	return nil
}

// removeCloudflareSide deletes the tunnel through cloudflared and the DNS
// record through the API, because only one of those two credentials can be
// counted on at teardown. cloudflared authenticates with cert.pem, which is
// long-lived; the REST API needs a dashboard OAuth token, which is short-lived
// and — the first time this command ran for real — was expired, so the tunnel
// survived a removal that reported itself done. Deleting a tunnel must not
// depend on the credential most likely to be dead.
//
// DNS still has to go through the API: cloudflared creates records but cannot
// remove them. When no working token is available this says so rather than
// opening a browser — a teardown that demands an interactive login is a
// teardown people abandon half-finished.
//
// Every failure is reported and stepped over rather than returned. The local
// half must still complete: a half-removed connection that still holds its own
// tunnel token is worse than an orphaned Cloudflare resource, and the user is
// told exactly what to clean up by hand.
func removeCloudflareSide(store *db.Store, hostname, tunnelID, accountID string) {
	tunnelGone := false
	if err := tunnel.Delete(tunnelID); err != nil {
		fmt.Println("⚠ cloudflared could not delete the tunnel:", err)
	} else {
		fmt.Println("✓ Cloudflare Tunnel deleted:", tunnelID)
		tunnelGone = true
	}

	token, _, ok := storedCloudflareSession(store)
	if !ok {
		fmt.Println("· No usable Cloudflare API session — sign in again with `kusal connect` to finish.")
		leftHostname := hostname
		leftTunnel := ""
		if !tunnelGone {
			leftTunnel = tunnelID
		}
		if leftHostname != "" || leftTunnel != "" {
			reportOrphans(leftHostname, leftTunnel)
		}
		return
	}

	// The API is the fallback for the tunnel, not the primary: worth trying
	// when cloudflared is missing or refused, pointless otherwise.
	if !tunnelGone {
		if err := cfapi.DeleteTunnel(token, accountID, tunnelID); err != nil {
			fmt.Println("⚠ Could not delete the Cloudflare Tunnel:", err)
			reportOrphans("", tunnelID)
		} else {
			fmt.Println("✓ Cloudflare Tunnel deleted:", tunnelID)
		}
	}

	if hostname == "" {
		return
	}
	zoneID, err := cfapi.GetZoneID(token, accountID, hostname)
	if err != nil {
		fmt.Println("⚠ Could not find the zone for", hostname+":", err)
		reportOrphans(hostname, "")
		return
	}
	switch deleted, err := cfapi.DeleteDNSRecord(token, zoneID, hostname); {
	case err != nil:
		fmt.Println("⚠ Could not delete the DNS record for", hostname+":", err)
		reportOrphans(hostname, "")
	case deleted:
		fmt.Println("✓ DNS record deleted:", hostname)
	default:
		fmt.Println("· no DNS record for", hostname, "— nothing to delete")
	}
}

func reportOrphans(hostname, tunnelID string) {
	fmt.Println("  The Cloudflare side was left as-is. To finish by hand:")
	if hostname != "" {
		fmt.Println("    dashboard -> DNS -> delete the record for", hostname)
	}
	if tunnelID != "" {
		fmt.Println("    dashboard -> Zero Trust -> Networks -> Tunnels -> delete", tunnelID)
		fmt.Println("    or: " + tunnel.DeleteCommand(tunnelID))
	}
}
