const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// This repo has an npm flat install layered over a pnpm workspace (a stray
// package-lock.json next to pnpm-lock.yaml), so react-native-css-interop exists
// at two physically distinct paths: one real directory in the root
// node_modules, and one inside .pnpm where nativewind's own dependency points.
//
// Metro keys modules by real path, so both end up in the bundle as separate
// instances — each with its own `interopComponents` registry. The Metro
// transformer's injected `import … from "react-native-css-interop/…"` registered
// the compiled CSS into one of them while NativeWind's JSX runtime looked
// components up in the other, so `interopComponents.get(View)` always missed and
// every className was silently dropped. Nothing errored; the app just rendered
// completely unstyled.
//
// Pinning every request to the copy nativewind itself resolves guarantees one
// registry. Remove this once the tree is a single package manager again.
const NATIVEWIND_DIR = path.dirname(require.resolve("nativewind/package.json"));
const CSS_INTEROP_DIR = path.dirname(
  require.resolve("react-native-css-interop/package.json", { paths: [NATIVEWIND_DIR] })
);

const PINNED = "react-native-css-interop";
const previousResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === PINNED || moduleName.startsWith(`${PINNED}/`)) {
    const subpath = moduleName.slice(PINNED.length).replace(/^\//, "");
    const target = subpath
      ? path.join(CSS_INTEROP_DIR, subpath)
      : require.resolve(PINNED, { paths: [NATIVEWIND_DIR] });
    return context.resolveRequest(context, target, platform);
  }
  return (previousResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./global.css" });
