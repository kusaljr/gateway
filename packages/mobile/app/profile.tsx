import { Children, useCallback, useState, type ReactNode } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Redirect, router } from "expo-router";
import Constants from "expo-constants";
import Avatar from "../components/Avatar";
import Splash from "../components/Splash";
import { MONO_FONT } from "../lib/fonts";
import { useSession } from "../lib/session";

export default function ProfileScreen() {
  const { ready, user, accountEmail, tunnelUrl, devices, refreshDevices, logout } = useSession();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshDevices();
    setRefreshing(false);
  }, [refreshDevices]);

  if (!ready) return <Splash />;
  // Reachable before any device is entered: the avatar sits on the main screen
  // in both states, so signing out has to work from a Cloudflare account alone.
  if (!user && !accountEmail) return <Redirect href="/login" />;

  const email = user?.email || accountEmail;
  const host = tunnelUrl.replace(/^https?:\/\//, "");
  const online = devices.filter((d) => d.status === "connected").length;
  const version = Constants.expoConfig?.version || "—";

  return (
    <SafeAreaView className="flex-1 bg-zinc-50">
      <View className="flex-row items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
        <Pressable onPress={() => router.back()}>
          <Text className="text-sm text-zinc-600">← Back</Text>
        </Pressable>
        <Text className="text-sm font-semibold text-zinc-900">Profile</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 20, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" colors={["#f97316"]} />}
      >
        <View className="mx-auto w-full max-w-md">
          <View className="items-center rounded-2xl border border-zinc-200 bg-white px-5 py-6">
            <Avatar email={email} size={56} />
            <Text className="mt-3 text-[15px] font-semibold text-zinc-900" numberOfLines={1}>{email}</Text>
            <Text className="mt-1 text-[11px] text-zinc-400">
              {user
                ? `signed in via ${user.provider === "cloudflare" ? "Cloudflare Access" : user.provider}`
                : "Cloudflare account — no device entered yet"}
            </Text>
          </View>

          <Section label="Connection">
            <Row label="Tunnel" value={host || "no device entered"} mono />
            <Row label="Devices" value={user ? `${devices.length} paired · ${online} online` : "—"} />
          </Section>

          {/* Usage and providers belong to a machine, not to the account —
              this only points the way. */}
          <Text className="mt-2 px-1 text-[11px] leading-4 text-zinc-400">
            Usage and agent CLIs are per device: open a device, then Usage or Providers.
          </Text>

          <Section label="App">
            <Row label="Version" value={version} mono />
            <Row label="Platform" value={`${Platform.OS} ${String(Platform.Version)}`} />
          </Section>

          <Pressable
            onPress={async () => {
              // pop first: this screen unmounts either way once the session
              // clears, and the device list redirects itself to /login
              router.back();
              await logout();
            }}
            className="mt-6 items-center rounded-xl bg-red-50 py-3.5 active:opacity-70"
          >
            <Text className="text-sm font-semibold text-red-600">Sign out</Text>
          </Pressable>

          <Text className="mt-4 text-center text-[11px] leading-4 text-zinc-400">
            Signing out clears this device's session token and Access JWT.
          </Text>
        </View>
      </ScrollView>

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

// The section draws the dividers, not the rows — so rows stay position-agnostic
// and no caller has to know which one is first.
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="mt-6">
      <Text className="mb-2 px-1 text-[10px] font-semibold uppercase text-zinc-400">{label}</Text>
      <View className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        {Children.toArray(children).map((row, i) => (
          <View key={i} className={i === 0 ? undefined : "border-t border-zinc-100"}>
            {row}
          </View>
        ))}
      </View>
    </View>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View className="flex-row items-center gap-3 px-4 py-3">
      <Text className="text-[13px] text-zinc-500">{label}</Text>
      <Text
        style={mono ? { fontFamily: MONO_FONT } : undefined}
        className="flex-1 text-right text-[13px] text-zinc-900"
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}
