import * as api from "../api";
import type { Dispatch, SetStateAction } from "react";

import { normalizeOfficeWorkflowPack } from "./office-workflow-pack";
import type { Agent, CompanySettings, Task } from "../types";

export function shouldIncludeSeedAgents(settings: Pick<CompanySettings, "officeWorkflowPack">): boolean {
  const activePack = normalizeOfficeWorkflowPack(settings.officeWorkflowPack ?? "development");
  return activePack !== "development";
}

export async function refreshTasksAndAgents(params: {
  settings: Pick<CompanySettings, "officeWorkflowPack">;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
}): Promise<void> {
  const includeSeedAgents = shouldIncludeSeedAgents(params.settings);
  const [tasks, agents] = await Promise.all([api.getTasks(), api.getAgents({ includeSeed: includeSeedAgents })]);
  params.setTasks(tasks);
  params.setAgents(agents);
}
