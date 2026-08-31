import type { Project } from "./api";

// Router params are strings, so a picked project travels as the three fields
// anything downstream actually reads (id for session filtering, path for the
// opencode cwd, name for the header) instead of the whole row. Keeping it in
// the URL rather than a shared selection object is what makes every screen
// deep-linkable and survive a reload on the web target.
export type ProjectParams = {
  deviceId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
};

export function projectParams(deviceId: string, p: Project): ProjectParams {
  return { deviceId, projectId: p.id, projectName: p.name, projectPath: p.path };
}

export function projectFromParams(p: Partial<ProjectParams>): Project {
  return {
    id: p.projectId || "",
    name: p.projectName || "",
    path: p.projectPath || "",
    device_id: p.deviceId || "",
    created_at: "",
    updated_at: "",
  };
}
