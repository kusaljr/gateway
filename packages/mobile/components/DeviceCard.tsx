import { Pressable, Text, View } from "react-native";
import { relativeTime } from "../lib/format";
import { MONO_FONT } from "../lib/fonts";
import type { Device } from "../lib/api";

// Drawn from two borders instead of a glyph: the app ships no icon font and no
// SVG runtime, and a rotated square stays crisp at every screen density.
const CHEVRON_ROTATION = { right: "45deg", down: "135deg", left: "-135deg", up: "-45deg" } as const;

export function Chevron({
  color = "#a1a1aa",
  size = 7,
  width = 1.5,
  direction = "right",
}: {
  color?: string;
  size?: number;
  width?: number;
  direction?: keyof typeof CHEVRON_ROTATION;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderTopWidth: width,
        borderRightWidth: width,
        borderColor: color,
        transform: [{ rotate: CHEVRON_ROTATION[direction] }],
      }}
    />
  );
}

export function StatusDot({ online, size = 8 }: { online: boolean; size?: number }) {
  // dot inside a tinted halo — reads as a state at a glance without needing a
  // legend, and keeps the row's left edge aligned with the section labels
  const halo = Math.round(size * 3.5);
  return (
    <View
      className={online ? "items-center justify-center rounded-full bg-emerald-500/10" : "items-center justify-center rounded-full bg-zinc-100"}
      style={{ width: halo, height: halo }}
    >
      <View className={online ? "rounded-full bg-emerald-500" : "rounded-full bg-zinc-300"} style={{ width: size, height: size }} />
    </View>
  );
}

export default function DeviceCard({ device, onPress }: { device: Device; onPress: () => void }) {
  const online = device.status === "connected";
  const title = device.name || device.hostname || device.id.slice(0, 8);
  // hostname usually IS the title — a second line only earns its space when it
  // carries something the title doesn't
  const subtitle = device.hostname && device.hostname !== title ? device.hostname : device.id.slice(0, 12);

  return (
    <Pressable
      onPress={onPress}
      className={`rounded-2xl border px-4 py-3.5 active:bg-zinc-100 ${online ? "border-zinc-200 bg-white" : "border-zinc-200/70 bg-white/60"}`}
    >
      <View className="flex-row items-center gap-3">
        <StatusDot online={online} />
        <View className="flex-1">
          <Text className={`text-[15px] font-semibold ${online ? "text-zinc-900" : "text-zinc-500"}`} numberOfLines={1}>
            {title}
          </Text>
          <Text style={{ fontFamily: MONO_FONT }} className="mt-0.5 text-[11px] text-zinc-400" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Chevron color={online ? "#a1a1aa" : "#d4d4d8"} />
      </View>

      <View className="mt-3 flex-row items-center gap-2 border-t border-zinc-100 pt-2.5">
        <View className={`rounded-full px-2 py-0.5 ${online ? "bg-emerald-50" : "bg-zinc-100"}`}>
          <Text className={`text-[10px] font-semibold uppercase ${online ? "text-emerald-700" : "text-zinc-500"}`}>
            {online ? "Online" : "Offline"}
          </Text>
        </View>
        <Text className="flex-1 text-[11px] text-zinc-400" numberOfLines={1}>
          {online ? `active ${relativeTime(device.last_seen)}` : `last seen ${relativeTime(device.last_seen)}`}
        </Text>
      </View>
    </Pressable>
  );
}
