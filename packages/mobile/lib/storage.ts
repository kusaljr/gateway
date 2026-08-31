import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

export const STORAGE_TUNNEL = "kusal:tunnel_url";
export const STORAGE_TOKEN = "kusal:session_token";
export const STORAGE_EMAIL = "kusal:email";
export const STORAGE_CF_JWT = "kusal:cf_jwt";
// The Cloudflare ACCOUNT session (dashboard OAuth), distinct from the Access
// JWT above: this one lists tunnels, that one enters a device. Persisted
// because it is what made every app reload demand a fresh browser sign-in.
export const STORAGE_CF_ACCOUNT_TOKEN = "kusal:cf_account_token";
export const STORAGE_CF_ACCOUNT_REFRESH = "kusal:cf_account_refresh";
// The last device list Cloudflare returned. Cached because the account token
// that produced it is short-lived and comes with no refresh token, so without
// this every app start had nothing to show and fell back to the login screen —
// even though entering a device needs the Access flow, not the account one.
export const STORAGE_TUNNEL_CHOICES = "kusal:tunnel_choices";
// One Access session per hostname, as a JSON map keyed by tunnel URL:
// { "https://host": { token, cfJwt, email } }. Cloudflare Access issues its
// JWT per hostname, so a single slot (STORAGE_TOKEN/STORAGE_CF_JWT above) meant
// entering device B overwrote device A's credentials — and going back to A had
// to run the whole Access flow again, every time, forever. Those two keys are
// still written, but only as "which device is active now"; this map is what
// makes switching free. Entries are dropped when they stop verifying.
export const STORAGE_SESSIONS = "kusal:sessions";

// Set when the user signs out on purpose. Bootstrap re-logs in silently when a
// stored session has merely expired, and without this marker it cannot tell
// that case apart from a deliberate sign-out — Cloudflare Access still holds
// its own browser session, so that re-login succeeds with no prompt and the
// user lands straight back in.
export const STORAGE_SIGNED_OUT = "kusal:signed_out";

// SecureStore can stall indefinitely on some Android Keystore states — never await it unbounded.
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// Unified storage: SecureStore is included in Expo Go (no native null), AsyncStorage fallback for web
export const Storage = {
  getItem: async (k: string): Promise<string | null> => {
    try {
      const v = await withTimeout(SecureStore.getItemAsync(k), 3000, null);
      if (v !== null) return v;
    } catch {}
    try {
      return await AsyncStorage.getItem(k);
    } catch (e: any) {
      // native module null (Expo Go without prebuild) -> fallback to in-memory/web localStorage
      try {
        if (typeof window !== "undefined" && (window as any).localStorage) return (window as any).localStorage.getItem(k);
      } catch {}
      return null;
    }
  },
  setItem: async (k: string, v: string) => {
    try {
      const ok = await withTimeout(SecureStore.setItemAsync(k, v).then(() => true), 3000, false);
      if (ok) return;
    } catch {}
    try {
      await AsyncStorage.setItem(k, v);
      return;
    } catch {}
    try {
      if (typeof window !== "undefined" && (window as any).localStorage) (window as any).localStorage.setItem(k, v);
    } catch {}
  },
  removeItem: async (k: string) => {
    try { await withTimeout(SecureStore.deleteItemAsync(k).then(() => true), 3000, false); } catch {}
    try { await AsyncStorage.removeItem(k); } catch {}
    try { if (typeof window !== "undefined" && (window as any).localStorage) (window as any).localStorage.removeItem(k); } catch {}
  },
};
