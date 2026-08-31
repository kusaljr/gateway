import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import ProviderRow, { ProviderRowSkeleton } from "../../../components/ProviderRow";
import Splash from "../../../components/Splash";
import { MONO_FONT } from "../../../lib/fonts";
import { useSession } from "../../../lib/session";
import { fetchProviders, type ProviderStatus } from "../../../lib/api";

export default function ProvidersScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const { ready, user, tunnelUrl, auth, deviceById } = useSession();
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [reportedHost, setReportedHost] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!tunnelUrl || !auth.token) return;
    try {
      const res = await fetchProviders(tunnelUrl, auth);
      setReportedHost(res.hostname);
      setProviders(res.providers);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ? String(e.message).slice(0, 240) : "Could not read providers");
    }
  }, [tunnelUrl, auth]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!ready) return <Splash />;
  if (!user) return <Redirect href="/login" />;

  const device = deviceById(deviceId);
  const deviceLabel = device?.name || device?.hostname || deviceId.slice(0, 8);
  // /api/providers can only describe the machine that answered it — the one
  // serving this tunnel. When the row tapped belongs to a different device,
  // say so instead of labelling another machine's CLIs as this one's.
  const foreign = Boolean(
    reportedHost && device && ![device.hostname, device.name].some((n) => n && hostMatches(n, reportedHost))
  );

  const counts = providers
    ? {
        signedIn: providers.filter((p) => p.installed && p.auth === "signed_in").length,
        signedOut: providers.filter((p) => p.installed && p.auth === "signed_out").length,
        missing: providers.filter((p) => !p.installed).length,
      }
    : null;

  return (
    <SafeAreaView className="flex-1 bg-zinc-50">
      <View className="flex-row items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
        <Pressable onPress={() => router.back()}>
          <Text className="text-sm text-zinc-600">← Back</Text>
        </Pressable>
        <Text className="flex-1 px-2 text-center text-sm font-semibold text-zinc-900" numberOfLines={1}>Providers</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 18, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" colors={["#f97316"]} />}
      >
        <View className="mx-auto w-full max-w-md">
          <Text className="text-xl font-bold text-zinc-900" numberOfLines={1}>{deviceLabel}</Text>
          <Text style={{ fontFamily: MONO_FONT }} className="mt-1 text-[11px] text-zinc-400" numberOfLines={1}>
            {reportedHost || "—"}
          </Text>
          {counts ? (
            <Text className="mt-2 text-xs text-zinc-500">
              {counts.signedIn} signed in
              {counts.signedOut ? ` · ${counts.signedOut} need login` : ""}
              {counts.missing ? ` · ${counts.missing} not installed` : ""}
            </Text>
          ) : null}

          {foreign ? (
            <View className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
              <Text className="text-[11px] leading-4 text-amber-800">
                This inventory comes from {reportedHost}, the machine serving the tunnel you signed
                into. Reaching another device's CLIs needs its own tunnel — not wired up yet.
              </Text>
            </View>
          ) : null}

          <View className="mt-4 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
            {err ? (
              <View className="px-4 py-4">
                <Text className="text-xs leading-4 text-red-600">{err}</Text>
              </View>
            ) : providers === null ? (
              <ProviderRowSkeleton />
            ) : providers.length === 0 ? (
              <View className="px-4 py-4">
                <Text className="text-[13px] text-zinc-500">No agent CLIs found on this device</Text>
              </View>
            ) : (
              providers.map((p, i) => (
                <View key={p.name} className={i === 0 ? undefined : "border-t border-zinc-100"}>
                  <ProviderRow provider={p} />
                </View>
              ))
            )}
          </View>

          <Text className="mt-3 px-1 text-[11px] leading-4 text-zinc-400">
            Every CLI runs on that machine under your own login. kusal checks only whether a
            credential exists — it never reads one, and never calls a model API itself.
          </Text>
        </View>
      </ScrollView>

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

// The device row stores a machine hostname ("yarsakusal") while /api/providers
// reports whatever os.Hostname() gives ("yarsakusal.local"), so compare on the
// first label rather than the full string.
function hostMatches(a: string, b: string) {
  const short = (s: string) => s.trim().toLowerCase().split(".")[0];
  return short(a) === short(b);
}
