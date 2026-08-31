import { useEffect } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Redirect, router } from "expo-router";
import Shimmer from "../components/Shimmer";
import { MONO_FONT } from "../lib/fonts";
import { useSession } from "../lib/session";

export default function LoginScreen() {
  const { ready, user, busy, magicStep, err, tunnelChoices, login } = useSession();

  // The chooser is the main screen now, so a list to choose from is reason
  // enough to go there. Replace, never push: leaving /login underneath is what
  // made the back gesture from the device list land on a finished login screen.
  useEffect(() => {
    if (tunnelChoices) router.replace("/");
  }, [tunnelChoices]);

  if (!ready) return <BootSkeleton />;
  // bootstrap can restore a session (or auto re-login) while this screen is
  // mounted — bounce back to the device list the moment it does
  if (user) return <Redirect href="/" />;

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 justify-between px-7 pb-8 pt-10">
        <View className="mx-auto w-full max-w-sm">
          <Text style={{ fontFamily: MONO_FONT }} className="text-[11px] uppercase text-zinc-400">
            kusal
          </Text>
          <Text className="mt-5 text-[30px] font-bold leading-9 text-zinc-900">
            Your machines,{"\n"}in your pocket.
          </Text>
          <Text className="mt-3 text-[13px] leading-5 text-zinc-500">
            Coding agents keep running on your own hardware, under your own logins. kusal only
            carries the connection — over a Cloudflare Tunnel you own.
          </Text>
        </View>

        <View className="mx-auto w-full max-w-sm">
          {err ? (
            <View className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3">
              <Text className="text-xs leading-4 text-red-700">{err}</Text>
            </View>
          ) : null}

          {/* progress replaces the button while a sign-in is in flight: the
              steps are real (discover, sign in, list tunnels, probe) and the
              only honest thing to show is which one is running */}
          {busy && magicStep ? (
            <View className="mb-1 py-3">
              <Shimmer tint="rgba(255,255,255,0.85)">
                <Text className="text-[13px] font-medium text-zinc-600">{magicStep}</Text>
              </Shimmer>
              <Text className="mt-2 text-[11px] text-zinc-400">
                A browser tab may open — that page is Cloudflare's, not ours.
              </Text>
            </View>
          ) : (
            <>
              {/* Cloudflare's own mark, bundled as an asset — it only reads
                  correctly in its brand colours, so the button goes dark
                  rather than tinting the logo to fit. */}
              <Pressable
                onPress={() => login()}
                disabled={busy}
                className={`flex-row items-center justify-center gap-2.5 rounded-2xl bg-zinc-900 px-4 py-4 ${busy ? "opacity-60" : "active:opacity-90"}`}
              >
                <Image
                  source={require("../assets/logo-cloudflare.png")}
                  style={{ width: 26, height: 12 }}
                  resizeMode="contain"
                  accessibilityIgnoresInvertColors
                />
                <Text className="text-[15px] font-bold text-white">
                  {busy ? "Signing in…" : "Continue with Cloudflare"}
                </Text>
              </Pressable>
              <Text className="mt-3 px-1 text-[11px] leading-4 text-zinc-400">
                Sign-in happens on Cloudflare's own page. kusal never sees your credentials — it
                receives a session for the device behind Access, nothing more.
              </Text>
            </>
          )}
        </View>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

// Bootstrap greys out the copy and the button in place rather than showing a
// spinner — the layout is fixed, so the sign-in button lands exactly where its
// placeholder sat.
function BootSkeleton() {
  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 justify-between px-7 pb-8 pt-10">
        <View className="mx-auto w-full max-w-sm">
          <Text style={{ fontFamily: MONO_FONT }} className="text-[11px] uppercase text-zinc-400">
            kusal
          </Text>
          <View className="mt-6 gap-3">
            <View className="h-6 w-4/5 rounded-full bg-zinc-100" />
            <View className="h-6 w-3/5 rounded-full bg-zinc-100" />
          </View>
          <View className="mt-6 gap-2">
            <View className="h-2.5 w-full rounded-full bg-zinc-100" />
            <View className="h-2.5 w-full rounded-full bg-zinc-100" />
            <View className="h-2.5 w-1/2 rounded-full bg-zinc-100" />
          </View>
        </View>

        <View className="mx-auto w-full max-w-sm">
          <View className="h-14 rounded-2xl bg-zinc-100" />
          <View className="mt-4 gap-2">
            <View className="h-2.5 w-full rounded-full bg-zinc-100" />
            <View className="h-2.5 w-2/3 rounded-full bg-zinc-100" />
          </View>
        </View>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}
