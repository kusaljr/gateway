import { useCallback, useState } from "react";
import { ActivityIndicator, Text, View, Pressable, ScrollView, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Redirect, router, useFocusEffect } from "expo-router";
import Avatar from "../components/Avatar";
import DeviceCard from "../components/DeviceCard";
import TunnelList from "../components/TunnelList";
import { MONO_FONT } from "../lib/fonts";
import { useSession } from "../lib/session";

export default function DevicesScreen() {
  const { ready, user, devices, devicesLoaded, refreshDevices, tunnelUrl, tunnelChoices, choicesLoaded, pickTunnel, login, busy, magicStep, err, accountEmail } = useSession();
  const [refreshing, setRefreshing] = useState(false);

  // Poll while the device list is on screen so a disconnect shows up on its
  // own — otherwise the stale "connected" dot only clears on a manual
  // pull-to-refresh. Focus-scoped, so it stops once a project/chat is open.
  useFocusEffect(
    useCallback(() => {
      if (!user) return; // the chooser refreshes by pull, not on a timer
      const t = setInterval(refreshDevices, 5000);
      return () => clearInterval(t);
    }, [refreshDevices, user])
  );

  // Choosing a device is a request to USE that machine, so make it the active
  // one and then open it — one await, one push.
  //
  // Navigating here rather than from an effect is the fix for "six back presses
  // to leave a project list": the old version parked the chosen tunnel id in
  // context and let an effect keyed on [pickedTunnelId, devicesLoaded, devices]
  // do the pushing, and every state commit inside the sign-in it was waiting on
  // re-ran that effect before the clear landed. Each run pushed the same route
  // again.
  //
  // Switching first also stops a device screen from rendering a different
  // machine's projects: every screen below reads the active session, so the
  // active session has to be the device whose id is in the route. pickTunnel
  // reuses the stored Access session for that hostname, so this is only a
  // browser trip the first time.
  const onPick = useCallback(
    async (url: string, tunnelId: string) => {
      const match = await pickTunnel(url, tunnelId);
      if (match) router.push({ pathname: "/device/[deviceId]", params: { deviceId: match.id } });
    },
    [pickTunnel]
  );

  // Pull-to-refresh is the "show me what this account has" gesture, so it asks
  // for the list explicitly. Without that it would take login()'s fast path and
  // walk straight into the device already paired — which is the right default
  // for signing in, and useless as a refresh.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([login({ discover: true }), user ? refreshDevices() : Promise.resolve()]);
    setRefreshing(false);
  }, [refreshDevices, login, user]);

  if (!ready) return <BootSkeleton />;
  // Never signed in anywhere and nothing to choose from — the login screen is
  // the only thing left to show. Not while a sign-in is in flight, though:
  // that one is already being driven from here, the login screen would only
  // show the same progress, and bouncing there and back the moment a session
  // lands is what made entering a device flash through three screens.
  if (!user && !tunnelChoices && !busy) return <Redirect href="/login" />;

  const host = tunnelUrl.replace(/^https?:\/\//, "");
  const hasChoices = !!tunnelChoices && tunnelChoices.length > 0;
  // "No devices yet" is a claim about the whole account, so it waits until
  // something has actually finished looking. devicesLoaded alone could not
  // carry that: it describes the backend of the one device already entered.
  const searching = busy || (!choicesLoaded && !devicesLoaded);
  const online = devices.filter((d) => d.status === "connected").length;

  return (
    <SafeAreaView className="flex-1 bg-zinc-50">
      <View className="px-5 pb-4 pt-1">
        <View className="flex-row items-start justify-between">
          <View className="flex-1">
            <Text style={{ fontFamily: MONO_FONT }} className="text-[10px] uppercase text-zinc-400">
              kusal
            </Text>
            <Text className="mt-2 text-2xl font-bold text-zinc-900">Devices</Text>
            <Text className="mt-1 text-xs text-zinc-500">
              {hasChoices
                ? `${tunnelChoices!.filter((c) => c.usable).length} of ${tunnelChoices!.length} ready`
                : devices.length > 0
                  ? `${online} of ${devices.length} online`
                  : searching
                    ? "Looking for your machines…"
                    : "No machines found"}
            </Text>
          </View>
          <Pressable onPress={() => router.push("/profile")} className="active:opacity-70" hitSlop={8}>
            <Avatar email={user?.email || accountEmail} size={36} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 28 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" colors={["#f97316"]} />}
      >
        <View className="mx-auto w-full max-w-md">
          {err ? (
            <View className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3">
              <Text className="text-xs leading-4 text-red-700">{err}</Text>
            </View>
          ) : null}

          {/* Entering a device runs a real sequence — Access sign-in, a
              reachability check, then the device's own list — and it happens on
              this screen now rather than on the login screen. Without this the
              list simply froze for several seconds and then jumped. */}
          {busy && magicStep ? (
            <View className="mb-3 flex-row items-center gap-2.5 rounded-xl border border-zinc-200 bg-white px-3.5 py-3">
              <ActivityIndicator size="small" color="#f97316" />
              <Text className="flex-1 text-xs text-zinc-600" numberOfLines={1}>
                {magicStep}
              </Text>
            </View>
          ) : null}

          {hasChoices ? (
            <TunnelList choices={tunnelChoices!} onPick={onPick} busy={busy} current={tunnelUrl} devices={devices} />
          ) : devices.length > 0 ? (
            // The account listing is gone or has not come back yet, but this
            // app is signed into a machine and that machine is a device the
            // user can open. Showing it beats the empty state, which was
            // flatly untrue here — it is what the back gesture out of a
            // device used to land on.
            <View className="gap-2.5">
              {devices.map((d) => (
                <DeviceCard
                  key={d.id}
                  device={d}
                  onPress={() => router.push({ pathname: "/device/[deviceId]", params: { deviceId: d.id } })}
                />
              ))}
            </View>
          ) : searching ? (
            <Skeleton />
          ) : (
            <EmptyState />
          )}

          {host ? (
            <Text style={{ fontFamily: MONO_FONT }} className="mt-6 text-center text-[10px] text-zinc-300" numberOfLines={1}>
              {host}
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function EmptyState() {
  return (
    <View className="items-center rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-8">
      <Text className="text-sm font-semibold text-zinc-900">No devices yet</Text>
      <Text className="mt-1.5 text-center text-xs leading-5 text-zinc-500">
        Run this on the machine you want to reach, then pull to refresh.
      </Text>
      <View className="mt-4 rounded-xl bg-zinc-900 px-3.5 py-2.5">
        <Text style={{ fontFamily: MONO_FONT }} className="text-xs text-zinc-100">
          kusal connect
        </Text>
      </View>
    </View>
  );
}

// Bootstrap draws the finished screen with its contents greyed out instead of a
// spinner: the header, the card rows and their spacing are all known before the
// tunnel answers, so only the parts that depend on it are placeholders — and
// nothing moves when the real list lands.
function BootSkeleton() {
  return (
    <SafeAreaView className="flex-1 bg-zinc-50">
      <View className="px-5 pb-4 pt-1">
        <View className="flex-row items-start justify-between">
          <View className="flex-1">
            <Text style={{ fontFamily: MONO_FONT }} className="text-[10px] uppercase text-zinc-400">
              kusal
            </Text>
            <Text className="mt-2 text-2xl font-bold text-zinc-900">Devices</Text>
            <View className="mt-2.5 h-2.5 w-40 rounded-full bg-zinc-200" />
          </View>
          <View className="h-9 w-9 rounded-full bg-zinc-200" />
        </View>
      </View>

      <View className="flex-1 px-5">
        <View className="mx-auto w-full max-w-md">
          <Skeleton />
        </View>
      </View>

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

// Placeholder rows sized like real cards, so the list doesn't jump when the
// first fetch lands — and an empty list never gets misread as "no devices"
// while it's still loading.
function Skeleton() {
  return (
    <View className="gap-2.5">
      {[0, 1].map((i) => (
        <View key={i} className="rounded-2xl border border-zinc-200 bg-white px-4 py-3.5">
          <View className="flex-row items-center gap-3">
            <View className="h-7 w-7 rounded-full bg-zinc-100" />
            <View className="flex-1 gap-1.5">
              <View className="h-3 w-1/2 rounded-full bg-zinc-100" />
              <View className="h-2 w-1/3 rounded-full bg-zinc-100" />
            </View>
          </View>
          <View className="mt-3 border-t border-zinc-100 pt-2.5">
            <View className="h-2.5 w-24 rounded-full bg-zinc-100" />
          </View>
        </View>
      ))}
    </View>
  );
}
