package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"
	"kusal/internal/config"
)

var logsCmd = &cobra.Command{
	Use:   "logs",
	Short: "Show kusal and tunnel logs",
	Long:  "Show daemon.log and cloudflared.log. Use --follow to tail.",
	RunE: func(cmd *cobra.Command, args []string) error {
		follow, _ := cmd.Flags().GetBool("follow")
		lines, _ := cmd.Flags().GetInt("lines")
		which, _ := cmd.Flags().GetString("which")
		if which == "" {
			which = "all"
		}
		files := []string{}
		switch which {
		case "daemon":
			files = []string{filepath.Join(config.Dir(), "daemon.log")}
		case "cloudflared", "tunnel":
			files = []string{filepath.Join(config.Dir(), "cloudflared.log")}
		default:
			files = []string{filepath.Join(config.Dir(), "daemon.log"), filepath.Join(config.Dir(), "cloudflared.log")}
		}
		if follow {
			args := []string{"-F", "-n", fmt.Sprintf("%d", lines)}
			args = append(args, files...)
			c := exec.Command("tail", args...)
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			c.Stdin = os.Stdin
			return c.Run()
		}
		for _, f := range files {
			fmt.Printf("── %s ──\n", f)
			data, err := os.ReadFile(f)
			if err != nil {
				fmt.Printf("(no log yet: %v)\n\n", err)
				continue
			}
			s := string(data)
			// trim to last N lines
			linesArr := splitLines(s)
			if len(linesArr) > lines {
				linesArr = linesArr[len(linesArr)-lines:]
			}
			for _, l := range linesArr {
				fmt.Println(l)
			}
			fmt.Println()
		}
		return nil
	},
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func init() {
	rootCmd.AddCommand(logsCmd)
	logsCmd.Flags().BoolP("follow", "f", false, "Follow logs (tail -F)")
	logsCmd.Flags().IntP("lines", "n", 60, "Number of lines to show")
	logsCmd.Flags().String("which", "all", "Which log: all, daemon, cloudflared")
}
