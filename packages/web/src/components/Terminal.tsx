import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export type TerminalStatus = "connecting" | "open" | "closed";

/**
 * PTY bridge, same shape as t3code's terminal drawer: the socket carries raw
 * keystrokes plus JSON control frames, and the server is told the window size
 * up front and on every fit so output wraps at the right column.
 */
export function Terminal({ wsUrl = "/ws", cwd, onStatus }: {
  wsUrl?: string;
  /** working directory for the shell — the open thread's project */
  cwd?: string;
  onStatus?: (status: TerminalStatus) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // kept in a ref so a new callback identity never tears down the PTY
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    const host = ref.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      // light terminal, mirroring t3code's light --terminal-* tokens
      theme: {
        background: "#fcfcfc",
        foreground: "#3f3f46",
        cursor: "#26384e",
        cursorAccent: "#fcfcfc",
        selectionBackground: "rgba(37,63,99,0.2)",
        black: "#3f3f46",
        red: "#b91c1c",
        green: "#047857",
        yellow: "#b45309",
        blue: "#1d4ed8",
        magenta: "#a21caf",
        cyan: "#0e7490",
        white: "#71717a",
        brightBlack: "#71717a",
        brightRed: "#dc2626",
        brightGreen: "#059669",
        brightYellow: "#d97706",
        brightBlue: "#2563eb",
        brightMagenta: "#c026d3",
        brightCyan: "#0891b2",
        brightWhite: "#18181b",
      },
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();

    let ws: WebSocket | null = null;
    let disposed = false;
    let retry = 0;
    let retryTimer: number | undefined;
    // a rune can straddle two frames; a streaming decoder keeps text intact
    const decoder = new TextDecoder("utf-8");

    const sendResize = () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const base = wsUrl.startsWith("/") ? `${proto}//${location.host}${wsUrl}` : wsUrl;
      const qs = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows) });
      if (cwd) qs.set("cwd", cwd);
      const url = `${base}${base.includes("?") ? "&" : "?"}${qs.toString()}`;

      statusRef.current?.("connecting");
      try {
        ws = new WebSocket(url);
      } catch {
        statusRef.current?.("closed");
        return;
      }
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        retry = 0;
        statusRef.current?.("open");
        sendResize();
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") term.write(e.data);
        else term.write(decoder.decode(e.data as ArrayBuffer, { stream: true }));
      };
      ws.onclose = () => {
        statusRef.current?.("closed");
        if (disposed) return;
        // backoff, so a dropped tunnel reconnects without hammering
        const delay = Math.min(8000, 500 * 2 ** retry++);
        term.writeln(`\r\n\x1b[90m[disconnected — retrying in ${Math.round(delay / 100) / 10}s]\x1b[0m`);
        retryTimer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    const onData = term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(d);
    });
    connect();

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* pane mid-collapse */ }
      sendResize();
    });
    ro.observe(host);
    const onWindowResize = () => { fit.fit(); sendResize(); };
    window.addEventListener("resize", onWindowResize);

    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      ro.disconnect();
      window.removeEventListener("resize", onWindowResize);
      onData.dispose();
      ws?.close();
      term.dispose();
      statusRef.current?.("closed");
    };
  }, [wsUrl, cwd]);

  return <div ref={ref} className="h-full w-full bg-[#fcfcfc]" />;
}
