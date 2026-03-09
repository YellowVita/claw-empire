import type { DatabaseSync } from "node:sqlite";

export type BreakRotationAgentRow = {
  id: string;
  department_id: string;
  status: string;
};

export type RetryAgentRow = {
  id: string;
  name: string;
  name_ko: string | null;
  department_id: string | null;
  status: string;
  role: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
  personality: string | null;
  department_name: string;
};

export function listBreakRotationAgents(db: DatabaseSync): BreakRotationAgentRow[] {
  return db
    .prepare("SELECT id, department_id, status FROM agents WHERE status IN ('idle','break')")
    .all() as BreakRotationAgentRow[];
}

export function updateAgentStatus(db: DatabaseSync, agentId: string, status: string): void {
  db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, agentId);
}

export function setAgentIdleAndClearTask(db: DatabaseSync, agentId: string): void {
  db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(agentId);
}

export function getAgentById(db: DatabaseSync, agentId: string) {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
}

export function getRetryAgentById(db: DatabaseSync, agentId: string): RetryAgentRow | undefined {
  return db
    .prepare(
      `SELECT a.id, a.name, a.department_id, a.status, COALESCE(d.name, 'Unassigned') AS department_name
              , a.name_ko, a.role, a.cli_provider, a.oauth_account_id, a.api_provider_id,
                a.api_model, a.cli_model, a.cli_reasoning_level, a.personality
       FROM agents a
       LEFT JOIN departments d ON d.id = a.department_id
       WHERE a.id = ?`,
    )
    .get(agentId) as RetryAgentRow | undefined;
}

export function listAgentsForAutoAssign(db: DatabaseSync): Array<{
  id: string;
  name: string;
  cli_provider: string | null;
}> {
  return db.prepare("SELECT id, name, cli_provider FROM agents").all() as Array<{
    id: string;
    name: string;
    cli_provider: string | null;
  }>;
}

export function setAgentProvider(db: DatabaseSync, agentId: string, provider: string): void {
  db.prepare("UPDATE agents SET cli_provider = ? WHERE id = ?").run(provider, agentId);
}
