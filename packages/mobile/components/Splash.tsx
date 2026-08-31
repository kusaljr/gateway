import { ActivityIndicator, Image, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

const WORDMARK = require("../assets/kusal-wordmark.png");

export default function Splash({ label }: { label?: string }) {
  return (
    <SafeAreaView className="flex-1 items-center justify-center bg-white">
      <Image
        source={WORDMARK}
        resizeMode="contain"
        accessibilityLabel="Kusal"
        style={{ width: 216, height: 72 }}
      />
      <ActivityIndicator className="mt-6" color="#18181b" />
      {label ? <Text className="mt-3 text-sm text-zinc-500">{label}</Text> : null}
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}
