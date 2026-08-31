import { Redirect, router, useLocalSearchParams } from "expo-router";
import ThreadList from "../../../components/ThreadList";
import Splash from "../../../components/Splash";
import { projectFromParams, type ProjectParams } from "../../../lib/routes";
import { useSession } from "../../../lib/session";

export default function ThreadsScreen() {
  const params = useLocalSearchParams<ProjectParams>();
  const { ready, user, tunnelUrl, auth } = useSession();

  if (!ready) return <Splash />;
  if (!user) return <Redirect href="/login" />;

  const project = projectFromParams(params);

  return (
    <ThreadList
      tunnelUrl={tunnelUrl}
      auth={auth}
      project={project}
      onPick={(id, model) =>
        router.push({
          pathname: "/device/[deviceId]/chat",
          // "new thread" is a null id — pass nothing rather than an empty
          // param so ChatScreen opens on its blank state
          params: { ...params, ...(id ? { sessionId: id } : {}), ...(model ? { model } : {}) },
        })
      }
      onBack={() => router.back()}
    />
  );
}
