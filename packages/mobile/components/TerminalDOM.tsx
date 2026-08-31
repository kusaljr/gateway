"use dom";

import { useEffect, useRef, type Ref } from "react";
import { useDOMImperativeHandle, type DOMImperativeFactory } from "expo/dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// expo/dom's public entry doesn't export JSONValue itself, only the types
// that reference it — mirrors expo/build/dom/dom.types.d.ts exactly.
type JSONValue = boolean | number | string | null | JSONValue[] | { [key: string]: JSONValue | undefined };

export interface TerminalDOMRef extends DOMImperativeFactory {
  // DOMImperativeFactory methods must accept JSONValue[] (the native<->DOM
  // bridge is JSON-only) — always called with exactly one string in practice.
  write: (...args: JSONValue[]) => void;
}

// Real xterm.js (same terminal engine the web app uses), rendered via Expo's
// DOM Components — this file runs in an embedded web context, everything
// else (the WebSocket, auth, launching the agent) stays native. Props cross
// an async JSON bridge, so callbacks are captured via a ref to avoid acting
// on a stale closure from the render that set up the effect.
export default function TerminalDOM(props: {
  ref: Ref<TerminalDOMRef>;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  dom?: import("expo/dom").DOMProps;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!containerRef.current) return;
    // 13px is a desktop size; on a phone it wasted most of the width on ~40
    // columns, so anything wrapping (a git diff, a stack trace, `ls -l`) became
    // unreadable. 11px with a tight line height fits roughly 60 columns on a
    // modern handset while staying legible, and scrollback exists so output
    // that scrolls past is still there.
    const term = new Terminal({
      convertEol: true,
      fontSize: 11,
      lineHeight: 1.15,
      letterSpacing: 0,
      scrollback: 5000,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#f97316",
        cursorAccent: "#0a0a0a",
        selectionBackground: "#f9731644",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;

    term.onData((data) => propsRef.current.onData(data));
    propsRef.current.onResize(term.cols, term.rows);

    const refit = () => {
      fit.fit();
      propsRef.current.onResize(term.cols, term.rows);
    };
    window.addEventListener("resize", refit);

    // Primary mechanism: WebViews don't reliably fire a window "resize" event
    // when their NATIVE host view is resized by React Native's layout (the
    // HTML viewport doesn't always change in a way that triggers one) —
    // ResizeObserver watches the container element's actual box size
    // directly instead, catching the container settling to full height after
    // mount and any later size changes regardless of whether "resize" fired.
    const ro = new ResizeObserver(() => refit());
    ro.observe(containerRef.current);

    return () => {
      window.removeEventListener("resize", refit);
      ro.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useDOMImperativeHandle(
    props.ref,
    () => ({
      write: (data: JSONValue) => {
        if (typeof data === "string") termRef.current?.write(data);
      },
    }),
    []
  );

  // Fixed (viewport-relative) instead of 100% — percentage height only
  // resolves if every ancestor up to <html>/<body> also has an explicit
  // height, which isn't guaranteed inside the DOM component's own document
  // shell. Fixed positioning sidesteps that cascade entirely.
  // A few pixels of inset so glyphs are not flush against the bezel; fit()
  // measures the container, so the padding is accounted for in the column count
  // rather than clipping the last one.
  return <div ref={containerRef} style={{ position: "fixed", inset: 0, padding: "4px 6px", background: "#0a0a0a" }} />;
}
