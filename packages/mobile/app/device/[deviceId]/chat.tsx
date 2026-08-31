import { Redirect, router, useLocalSearchParams } from "expo-router";
import ChatScreen from "../../../components/ChatScreen";
import Splash from "../../../components/Splash";
import { projectFromParams, type ProjectParams } from "../../../lib/routes";
import { useSession } from "../../../lib/session";

type ChatParams = ProjectParams & { sessionId?: string; model?: string };

export default function ChatRoute() {
  const params = useLocalSearchParams<ChatParams>();
  const { ready, user, tunnelUrl, auth } = useSession();

  if (!ready) return <Splash />;
  if (!user) return <Redirect href="/login" />;

  const project = projectFromParams(params);

  return (
    <ChatScreen
      tunnelUrl={tunnelUrl}
      auth={auth}
      project={project}
      initialSessionId={params.sessionId || null}
      // the model that thread actually ran on, so ChatScreen opens showing it
      // rather than whatever model was last used globally
      initialModelKey={params.model || null}
      onBack={() => router.back()}
      onOpenTerminal={() =>
        router.push({
          pathname: "/device/[deviceId]/terminal",
          params: { deviceId: params.deviceId, cwd: project.path },
        })
      }
    />
  );
}
