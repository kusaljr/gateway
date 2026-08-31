package cmd

import (
	"fmt"
	"net"

	"github.com/spf13/cobra"
	"kusal/internal/auth"
	"kusal/internal/shell"
)

var webCmd = &cobra.Command{
	Use:   "web",
	Short: "Serve the kusal web UI (tunnel sessions, opencode)",
	Long: `kusal web serves the frontend (packages/web/dist) + shell WS on a local port.
Use 'kusal connect' if you also need Cloudflare Tunnel.

  kusal web                 # random port, opens http://127.0.0.1:XXXXX
  kusal web --port 3000 --open
  kusal web --port 7681 --no-open

Frontend is built via: make build-web`,
	RunE: runWeb,
}

func init() {
	rootCmd.AddCommand(webCmd)
	webCmd.Flags().String("addr", "127.0.0.1:0", "Address to listen (host:port, :0 = random)")
	webCmd.Flags().Int("port", 0, "Shortcut for --addr port (e.g. --port 3000)")
	webCmd.Flags().Bool("open", true, "Open browser automatically")

	// allow `kusal web serve` as alias to `kusal web`
	serveCmd := &cobra.Command{
		Use:   "serve",
		Short: "Serve web UI (alias for kusal web)",
		RunE:  runWeb,
	}
	serveCmd.Flags().String("addr", "127.0.0.1:0", "Address to listen")
	serveCmd.Flags().Int("port", 0, "Shortcut for --addr port")
	serveCmd.Flags().Bool("open", true, "Open browser automatically")
	webCmd.AddCommand(serveCmd)
}

func runWeb(cmd *cobra.Command, args []string) error {
	addr, _ := cmd.Flags().GetString("addr")
	port, _ := cmd.Flags().GetInt("port")
	open, _ := cmd.Flags().GetBool("open")

	if port != 0 {
		addr = fmt.Sprintf("127.0.0.1:%d", port)
	}
	if addr == "127.0.0.1:0" {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		addr = ln.Addr().String()
		ln.Close()
	}

	fmt.Printf("Starting kusal web on http://%s\n", addr)
	fmt.Println("  shell WS: ws://" + addr + "/ws   api: http://" + addr + "/api/*")
	fmt.Println("  tip: kusal connect also serves this UI via Cloudflare Tunnel")
	if open {
		url := "http://" + addr
		fmt.Println("  opening browser →", url)
		auth.OpenBrowser(url)
	}
	fmt.Println("  press Ctrl+C to stop")
	srv := shell.New(addr)
	return srv.Start()
}
