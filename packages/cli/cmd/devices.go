package cmd

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"kusal/internal/db"
)

var devicesCmd = &cobra.Command{
	Use:   "devices",
	Short: "List devices known to this account (from local SQLite)",
}

var devicesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List devices",
	RunE: func(cmd *cobra.Command, args []string) error {
		store, err := db.Open()
		if err != nil {
			return err
		}
		defer store.DB.Close()
		devs, err := store.ListDevices()
		if err != nil {
			return err
		}
		if len(devs) == 0 {
			fmt.Println("no devices yet. Run 'kusal connect' on each device.")
			return nil
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tNAME\tHOSTNAME\tTUNNEL\tSTATUS\tLAST SEEN")
		for _, d := range devs {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", d.ID[:8], d.Name, d.Hostname, d.TunnelID, d.Status, d.LastSeen.Format("2006-01-02 15:04:05"))
		}
		w.Flush()
		fmt.Println("\nNote: devices are stored locally in SQLite. Each device writes its own row.")
		fmt.Println("For a shared view, run a tunnel per device with the same Cloudflare account and protect with Access.")
		return nil
	},
}

func init() {
	devicesCmd.AddCommand(devicesListCmd)
	rootCmd.AddCommand(devicesCmd)
}
