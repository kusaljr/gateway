import { Text, View } from "react-native";

// Initial-in-a-circle rather than a gravatar fetch — the app is behind
// Cloudflare Access and has no reason to hit a third-party image host.
export default function Avatar({ email, size = 32 }: { email: string; size?: number }) {
  const initial = (email || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <View className="items-center justify-center rounded-full bg-zinc-900" style={{ width: size, height: size }}>
      <Text className="font-semibold text-white" style={{ fontSize: Math.round(size * 0.42) }}>{initial}</Text>
    </View>
  );
}
