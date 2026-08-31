import "../global.css";
import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import * as WebBrowser from "expo-web-browser";
import Splash from "../components/Splash";
import { FONTS, applyGlobalFont } from "../lib/fonts";
import { SessionProvider } from "../lib/session";

SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 350, fade: true });

// only matters on the web target — native handles the redirect via the OS itself
WebBrowser.maybeCompleteAuthSession();

// The splash must never be able to outlive a font load. Gating purely on
// `fontsLoaded` means any failure to register a family — a missing asset, a
// resolution change after a reinstall — leaves the app on the splash screen
// forever with nothing on screen to say why. Falling back to the system font
// is a cosmetic loss; a permanently stuck launch is not.
const FONT_TIMEOUT_MS = 4000;

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FONTS);
  const [fontsTimedOut, setFontsTimedOut] = useState(false);
  const ready = fontsLoaded || !!fontError || fontsTimedOut;

  useEffect(() => {
    const t = setTimeout(() => setFontsTimedOut(true), FONT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  // Patch Text/TextInput only once the files are actually registered —
  // referencing a family that hasn't loaded renders nothing on Android.
  if (fontsLoaded) applyGlobalFont();

  useEffect(() => {
    if (ready) SplashScreen.hide();
  }, [ready]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {ready ? (
          <SessionProvider>
            {/* Every screen draws its own header row, and each one is a real
                stack entry — so Android back / the iOS edge swipe pop one
                level on their own instead of the hand-rolled BackHandler
                chain this used to need. */}
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="device/[deviceId]/terminal" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
            </Stack>
          </SessionProvider>
        ) : (
          <Splash />
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
