import { Redirect, router, useLocalSearchParams } from "expo-router";
import ProjectPicker from "../../../components/ProjectPicker";
import Splash from "../../../components/Splash";
import { projectParams } from "../../../lib/routes";
import { useSession } from "../../../lib/session";

export default function ProjectsScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const { ready, user, tunnelUrl, auth, deviceById } = useSession();

  if (!ready) return <Splash />;
  if (!user) return <Redirect href="/login" />;

  // deviceById reads the polled list, which is empty for a beat after a cold
  // deep-link into this route — the header just shows the id until it lands.
  const device = deviceById(deviceId);

  return (
    <ProjectPicker
      tunnelUrl={tunnelUrl}
      auth={auth}
      deviceName={device?.name || device?.hostname || deviceId.slice(0, 8)}
      deviceOnline={device ? device.status === "connected" : undefined}
      onPicked={(p) => router.push({ pathname: "/device/[deviceId]/threads", params: projectParams(deviceId, p) })}
      onOpenUsage={() => router.push({ pathname: "/device/[deviceId]/usage", params: { deviceId } })}
      onOpenProviders={() => router.push({ pathname: "/device/[deviceId]/providers", params: { deviceId } })}
      onBack={() => router.back()}
    />
  );
}
