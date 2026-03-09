import type { DatabaseSync } from "node:sqlite";

import { getAgentById, listBreakRotationAgents, updateAgentStatus } from "../../db/queries/agent-queries.ts";

export interface BreakRotationDeps {
  db: DatabaseSync;
  broadcast: (type: string, payload: unknown) => void;
  isAgentInMeeting: (agentId: string) => boolean;
  random?: () => number;
}

export function rotateBreaks({ db, broadcast, isAgentInMeeting, random = Math.random }: BreakRotationDeps): void {
  const allAgents = listBreakRotationAgents(db);
  if (allAgents.length === 0) return;

  for (const agent of allAgents) {
    if (agent.status === "break" && isAgentInMeeting(agent.id)) {
      updateAgentStatus(db, agent.id, "idle");
      broadcast("agent_status", getAgentById(db, agent.id));
    }
  }

  const candidates = allAgents.filter((agent) => !isAgentInMeeting(agent.id));
  if (candidates.length === 0) return;

  const byDept = new Map<string, typeof candidates>();
  for (const agent of candidates) {
    const list = byDept.get(agent.department_id) || [];
    list.push(agent);
    byDept.set(agent.department_id, list);
  }

  for (const [, members] of byDept) {
    const onBreak = members.filter((agent) => agent.status === "break");
    const idle = members.filter((agent) => agent.status === "idle");

    if (onBreak.length > 1) {
      const extras = onBreak.slice(1);
      for (const agent of extras) {
        updateAgentStatus(db, agent.id, "idle");
        broadcast("agent_status", getAgentById(db, agent.id));
      }
    } else if (onBreak.length === 1) {
      if (random() < 0.4) {
        updateAgentStatus(db, onBreak[0]!.id, "idle");
        broadcast("agent_status", getAgentById(db, onBreak[0]!.id));
      }
    } else if (idle.length > 0 && random() < 0.5) {
      const pick = idle[Math.floor(random() * idle.length)];
      if (!pick) continue;
      updateAgentStatus(db, pick.id, "break");
      broadcast("agent_status", getAgentById(db, pick.id));
    }
  }
}
