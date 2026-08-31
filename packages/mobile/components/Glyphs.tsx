import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

// Small marks drawn from Views — no icon font, no SVG runtime in this app, and
// these are simple enough geometry to build directly. Real brand logos are the
// exception: those ship as bundled PNGs (see assets/logo-*.png).

// Three ascending bars: usage over time.
//
// Every dimension is floored out of the box rather than scaled by a ratio —
// rounding three bars and two gaps up can exceed `size`, and an overflowing
// child inside a 36px circle is immediately visible.
export function BarsGlyph({ color = "#52525b", size = 14 }: { color?: string; size?: number }) {
  const gap = Math.max(1, Math.floor(size * 0.14));
  const bar = Math.max(2, Math.floor((size - gap * 2) / 3));
  const heights = [0.45, 0.72, 1];
  return (
    <View style={{ width: size, height: size, flexDirection: "row", alignItems: "flex-end" }}>
      {heights.map((h, i) => (
        <View
          key={i}
          style={{
            width: bar,
            height: Math.max(2, Math.floor(size * h)),
            marginLeft: i === 0 ? 0 : gap,
            borderRadius: 1,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

// A 2×2 grid: the installed set of agent CLIs.
//
// Laid out as two explicit rows instead of flexWrap: wrapping depends on the
// rounded cell width fitting twice plus a gap, and when it doesn't the four
// cells silently become three rows that spill out of the button.
export function GridGlyph({ color = "#52525b", size = 14 }: { color?: string; size?: number }) {
  const gap = Math.max(2, Math.floor(size * 0.18));
  const cell = Math.max(2, Math.floor((size - gap) / 2));
  const box = cell * 2 + gap;
  const dot = { width: cell, height: cell, borderRadius: 1.5, backgroundColor: color };
  return (
    <View style={{ width: box, height: box, justifyContent: "space-between" }}>
      {[0, 1].map((row) => (
        <View key={row} style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <View style={dot} />
          <View style={dot} />
        </View>
      ))}
    </View>
  );
}

// A check, drawn as two borders of a rotated box — same trick as Chevron.
export function CheckGlyph({ color = "#a1a1aa", size = 9, width = 1.5 }: { color?: string; size?: number; width?: number }) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: size * 0.9,
          height: size * 0.5,
          borderLeftWidth: width,
          borderBottomWidth: width,
          borderColor: color,
          transform: [{ rotate: "-45deg" }],
        }}
      />
    </View>
  );
}

// A shell prompt: chevron plus a caret bar. Marks the terminal action without
// borrowing an emoji for it.
export function TerminalGlyph({ color = "#52525b", size = 14 }: { color?: string; size?: number }) {
  const stroke = 1.5;
  return (
    <View style={{ width: size, height: size, justifyContent: "center" }}>
      <View
        style={{
          position: "absolute",
          left: 1,
          top: size * 0.28,
          width: size * 0.34,
          height: size * 0.34,
          borderTopWidth: stroke,
          borderRightWidth: stroke,
          borderColor: color,
          transform: [{ rotate: "45deg" }],
        }}
      />
      <View
        style={{
          position: "absolute",
          right: 1,
          bottom: size * 0.22,
          width: size * 0.42,
          height: stroke,
          borderRadius: stroke,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

// Status mark for one step of a turn: running, failed, or done.
export function StepMark({ status }: { status: "running" | "failed" | "done" }) {
  if (status === "done") {
    return (
      <View style={{ width: 14, alignItems: "center" }}>
        <CheckGlyph color="#71717a" />
      </View>
    );
  }
  return (
    <View style={{ width: 14, alignItems: "center" }}>
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: status === "failed" ? "#ef4444" : "#f97316",
        }}
      />
    </View>
  );
}

// Icon-only control, so the label lives in accessibilityLabel rather than on
// screen — the shapes carry it visually and the tap target stays 36px.
export function CircleButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      className="h-9 w-9 items-center justify-center rounded-full border border-zinc-200 bg-white active:bg-zinc-100"
    >
      {children}
    </Pressable>
  );
}
