import { useEffect, useRef, useState } from "react";
import { Text, View, Pressable } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import TerminalDOM, { type TerminalDOMRef } from "./TerminalDOM";
import KeyboardResponsiveView from "./KeyboardResponsiveView";
import type { Device } from "../lib/api";

function normalizeUrl(v: string) {
  let s = v.trim();
  if (!s) return s;
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

// A plain real shell in the given directory over the same /ws PTY endpoint
// the web app's own terminal uses — rendered with real xterm.js via
// TerminalDOM, not a hand-rolled text dump. Nothing is auto-launched; typing
// goes straight into the shell like any real terminal. Auth stays entirely
// native: Access only recognizes its own JWT, so the WebSocket handshake
// carries Cf-Access-Jwt-Assertion directly (same constraint fetchMe/
// fetchDevices hit earlier).
export default function TerminalScreen({ tunnelUrl, cfJwt, device, cwd, onClose }: { tunnelUrl: string; cfJwt: string; device: Device; cwd?: string; onClose: () => void }) {
  const domRef = useRef<TerminalDOMRef>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(0);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";
    const wsUrl = normalizeUrl(tunnelUrl).replace(/^http/, "ws") + `/ws?cols=100&rows=30${cwdParam}`;
    // React Native's WebSocket supports a non-standard 3rd `options.headers`
    // arg (not in the DOM lib types) — Access only recognizes its own JWT, so
    // this header is what gets the handshake past the edge at all.
    const WS = WebSocket as unknown as new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => WebSocket;
    const ws = new WS(wsUrl, undefined, { headers: { "Cf-Access-Jwt-Assertion": cfJwt } });
    ws.binaryType = "arraybuffer";

    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => {
      const data = e.data;
      let text = "";
      if (typeof data === "string") {
        text = data;
      } else {
        try {
          text = new TextDecoder().decode(data as ArrayBuffer);
        } catch {
          text = String.fromCharCode(...new Uint8Array(data as ArrayBuffer));
        }
      }
      domRef.current?.write(text);
    };
    ws.onerror = () => setConnected(false);
    ws.onclose = () => setConnected(false);
    wsRef.current = ws;
    return () => ws.close();
  }, [tunnelUrl, cfJwt, cwd]);

  const sendRaw = (text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(text);
  };

  return (
    <SafeAreaView className="flex-1 bg-black">
      <View
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
        className="flex-row items-center gap-3 border-b border-zinc-800 px-3 py-1.5"
      >
        {/* the header is overhead on a screen whose whole value is rows of
            output: half the padding, smaller type, and the cwd folded onto the
            same line instead of a second one */}
        <Pressable onPress={onClose} hitSlop={10}>
          <Text className="text-[13px] text-zinc-400">←</Text>
        </Pressable>
        <View className="flex-1">
          <Text className="text-[12px] font-semibold text-zinc-200" numberOfLines={1}>
            {device.name || device.hostname}
            {cwd ? <Text className="font-normal text-zinc-500">{`  ${cwd.replace(/^.*\//, "")}`}</Text> : null}
          </Text>
        </View>
        <View className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-600"}`} />
      </View>

      <KeyboardResponsiveView
        androidBottomInset={insets.bottom}
        iosVerticalOffset={insets.top + headerHeight}
      >
        <TerminalDOM
          ref={domRef}
          onData={sendRaw}
          onResize={(cols, rows) => sendRaw(JSON.stringify({ type: "resize", cols, rows }))}
          dom={{ style: { flex: 1 }, matchContents: false }}
        />
      </KeyboardResponsiveView>
      <StatusBar style="light" />
    </SafeAreaView>
  );
}
