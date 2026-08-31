import { createElement } from "react";
import { StyleSheet } from "react-native";
import { cssInterop } from "nativewind";
// Imported per weight, NOT from the package root: the root index re-exports all
// nine weights plus their italics, and Metro then bundles every one of those
// .ttf files (measured: 18 files, ~780KB) even though four are registered.
import { Urbanist_400Regular } from "@expo-google-fonts/urbanist/400Regular";
import { Urbanist_500Medium } from "@expo-google-fonts/urbanist/500Medium";
import { Urbanist_600SemiBold } from "@expo-google-fonts/urbanist/600SemiBold";
import { Urbanist_700Bold } from "@expo-google-fonts/urbanist/700Bold";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono/400Regular";

// Passed to useFonts() in app/_layout.tsx. Urbanist for UI, JetBrains Mono for
// code. Urbanist ships nine weights; only these four are registered, since a
// weight nobody renders is bundle size for nothing (see FAMILY_BY_WEIGHT below,
// which folds the rest onto these).
export const FONTS = {
  Urbanist_400Regular,
  Urbanist_500Medium,
  Urbanist_600SemiBold,
  Urbanist_700Bold,
  JetBrainsMono_400Regular,
};

export const MONO_FONT = "JetBrainsMono_400Regular";

// Android can only pick a font file by exact family name — it will not derive
// SemiBold from a Regular file, and asking it to renders faux-bold instead. So
// every weight maps to its own family, and the numeric weight is then cleared
// (see below) to stop the platform synthesising a second layer of boldness.
const FAMILY_BY_WEIGHT: Record<string, string> = {
  "100": "Urbanist_400Regular",
  "200": "Urbanist_400Regular",
  "300": "Urbanist_400Regular",
  "400": "Urbanist_400Regular",
  normal: "Urbanist_400Regular",
  "500": "Urbanist_500Medium",
  "600": "Urbanist_600SemiBold",
  "700": "Urbanist_700Bold",
  bold: "Urbanist_700Bold",
  "800": "Urbanist_700Bold",
  "900": "Urbanist_700Bold",
};

function familyForWeight(weight: unknown): string {
  if (weight === undefined || weight === null) return "Urbanist_400Regular";
  return FAMILY_BY_WEIGHT[String(weight)] || "Urbanist_400Regular";
}

/**
 * Applies Urbanist to every <Text>/<TextInput> in the app.
 *
 * React Native has no font inheritance — a font set on a parent doesn't reach
 * its children — so the only way to avoid tagging hundreds of call sites is to
 * replace the two leaf components once, here.
 *
 * This used to monkey-patch `Text.render`. As of RN 0.86 those components are
 * plain function components (`export default TextImpl`), so there is no
 * `.render` to wrap and that patch silently did nothing at all. Instead the
 * module's own export is swapped for a wrapper: `module.exports` in
 * react-native/index.js is an object literal of getters, so the properties are
 * configurable, and Metro's CJS interop reads `_reactNative.Text` at render
 * time rather than binding it at import time — so a swap made before the first
 * screen mounts is picked up everywhere.
 *
 * The wrapper is registered with NativeWind's cssInterop so className is
 * already resolved into `style` by the time it runs. That matters: the family
 * is chosen from the *resolved* fontWeight, which is what `font-semibold` and
 * friends produce.
 *
 * Anything that sets its own fontFamily (the markdown code styles, the mono
 * path lines) is left untouched.
 */
let patched = false;

export function applyGlobalFont() {
  // the export swap must happen exactly once — wrapping a wrapper would nest
  // on every Fast Refresh
  if (patched) return;
  patched = true;

  const RN = require("react-native");
  for (const name of ["Text", "TextInput"] as const) {
    const Original = RN[name];
    if (typeof Original !== "function") continue;

    const Wrapped = (props: any) => {
      const flat = (StyleSheet.flatten(props?.style) || {}) as Record<string, unknown>;
      // an explicit family wins — that's how code blocks keep JetBrains Mono
      if (flat.fontFamily) return createElement(Original, props);
      return createElement(Original, {
        ...props,
        style: [
          props?.style,
          // the numeric weight is cleared so the platform doesn't synthesise a
          // second layer of boldness on top of an already-bold file
          { fontFamily: familyForWeight(flat.fontWeight), fontWeight: "normal" },
        ],
      });
    };
    Wrapped.displayName = `Urbanist${name}`;
    cssInterop(Wrapped, { className: "style" });

    Object.defineProperty(RN, name, { value: Wrapped, configurable: true, enumerable: true });
  }
}
