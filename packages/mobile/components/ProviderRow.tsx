import { Text, View } from "react-native";
import ProviderGlyph from "./ProviderGlyph";
import { MONO_FONT } from "../lib/fonts";
import type { ProviderStatus } from "../lib/api";

// Three-valued on purpose: an agent whose credential store kusal can't inspect
// reports "unknown", and saying so beats a confident wrong "not signed in"
// (see cliagent/auth.go for what counts as evidence of a login).
export function statusBadge(p: ProviderStatus): { text: string; bg: string; fg: string } {
  if (!p.installed) return { text: "Not installed", bg: "bg-zinc-100", fg: "text-zinc-400" };
  if (p.auth === "signed_in") return { text: "Signed in", bg: "bg-emerald-50", fg: "text-emerald-700" };
  if (p.auth === "signed_out") return { text: "Not signed in", bg: "bg-amber-50", fg: "text-amber-700" };
  return { text: "Unknown", bg: "bg-zinc-100", fg: "text-zinc-500" };
}

export default function ProviderRow({ provider: p }: { provider: ProviderStatus }) {
  const badge = statusBadge(p);
  const detail = !p.installed ? `${p.bin} not on PATH` : p.source || p.path || p.bin;
  return (
    <View className="flex-row items-center gap-3 px-4 py-3.5">
      <View className={p.installed ? undefined : "opacity-40"}>
        <ProviderGlyph providerID={p.name} size={22} />
      </View>
      <View className="flex-1">
        <Text className={`text-[13px] font-medium ${p.installed ? "text-zinc-900" : "text-zinc-400"}`} numberOfLines={1}>
          {p.label}
        </Text>
        <Text style={{ fontFamily: MONO_FONT }} className="mt-0.5 text-[10px] text-zinc-400" numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <View className={`rounded-full px-2 py-0.5 ${badge.bg}`}>
        <Text className={`text-[10px] font-semibold ${badge.fg}`}>{badge.text}</Text>
      </View>
    </View>
  );
}

export function ProviderRowSkeleton() {
  return (
    <View>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} className={`flex-row items-center gap-3 px-4 py-3.5 ${i === 0 ? "" : "border-t border-zinc-100"}`}>
          <View className="h-[22px] w-[22px] rounded-md bg-zinc-100" />
          <View className="flex-1 gap-1.5">
            <View className="h-3 w-1/3 rounded-full bg-zinc-100" />
            <View className="h-2 w-1/2 rounded-full bg-zinc-100" />
          </View>
          <View className="h-4 w-16 rounded-full bg-zinc-100" />
        </View>
      ))}
    </View>
  );
}
