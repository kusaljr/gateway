import { Redirect } from "expo-router";

// kusal://auth is the OAuth/Access redirect target (see lib/cloudflare.ts).
// expo-web-browser resolves the login flow itself, but the same deep link also
// reaches the router's linking handler — without this route it would land on
// expo-router's unmatched-route screen. Nothing to render: whichever flow
// opened the browser already has its result.
export default function AuthRedirect() {
  return <Redirect href="/" />;
}
