package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "kusal",
	Short: "kusal — share your shell securely via Cloudflare Tunnel",
	Long: `kusal lets you expose this device's bash to any other device
authenticated with the same Cloudflare Zero Trust account.

Each device runs 'kusal connect' with a Cloudflare Tunnel token.
Only identities allowed by your Cloudflare Access policy can reach the shell.`,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
