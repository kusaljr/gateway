import { Redirect, router, useLocalSearchParams } from "expo-router";
import TerminalScreen from "../../../components/TerminalScreen";
import Splash from "../../../components/Splash";
import { useSession } from "../../../lib/session";

export default function TerminalRoute() {
  const { deviceId, cwd } = useLocalSearchParams<{ deviceId: string; cwd?: string }>();
  const { ready, user, tunnelUrl, cfJwt, deviceById } = useSession();

  if (!ready) return <Splash />;
  if (!user) return <Redirect href="/login" />;

  // The shell attaches by device, so unlike the project screens this one can't
  // fall back to the id alone — wait for the device list rather than opening a
  // terminal against a device we can't name.
  const device = deviceById(deviceId);
  if (!device) return <Splash />;

  return (
    <TerminalScreen
      tunnelUrl={tunnelUrl}
      cfJwt={cfJwt}
      device={device}
      cwd={cwd}
      onClose={() => router.back()}
    />
  );
}
