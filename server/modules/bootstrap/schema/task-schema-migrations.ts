import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKFLOW_PACK_KEY, WORKFLOW_PACK_KEYS, isWorkflowPackKey } from "../../workflow/packs/definitions.ts";

type DbLike = Pick<DatabaseSync, "exec" | "prepare">;

export function applyTaskSchemaMigrations(db: DbLike): void {
  // Subtask cross-department delegation columns
  try {
    db.exec("ALTER TABLE subtasks ADD COLUMN target_department_id TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE subtasks ADD COLUMN delegated_task_id TEXT");
  } catch {
    /* already exists */
  }

  // Cross-department collaboration: link collaboration task back to original task
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN source_task_id TEXT");
  } catch {
    /* already exists */
  }
  try {
    const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const hasProjectId = taskCols.some((c) => c.name === "project_id");
    if (!hasProjectId) {
      try {
        db.exec("ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)");
      } catch {
        // Fallback for legacy SQLite builds that reject REFERENCES on ADD COLUMN.
        db.exec("ALTER TABLE tasks ADD COLUMN project_id TEXT");
      }
    }
  } catch {
    /* table missing during migration window */
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, updated_at DESC)");
  } catch {
    /* project_id not ready yet */
  }
  // Task creation audit completion flag
  try {
    db.exec("ALTER TABLE task_creation_audits ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* already exists */
  }
  // Task hidden state (migrated from client localStorage)
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_task_creation_audits_completed ON task_creation_audits(completed, created_at DESC)",
    );
  } catch {
    /* table missing or migration in progress */
  }

  // Interrupt prompt injection queue (pause -> inject -> resume)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_interrupt_injections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        actor_token_hash TEXT,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        consumed_at INTEGER
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_task_interrupt_injections_task ON task_interrupt_injections(task_id, session_id, consumed_at, created_at DESC)",
    );
  } catch {
    /* already exists */
  }

  // 프로젝트별 직원 직접선택 기능: assignment_mode + project_agents 테이블
  try {
    db.exec("ALTER TABLE projects ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'auto'");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE projects ADD COLUMN default_pack_key TEXT NOT NULL DEFAULT 'development'");
  } catch {
    /* already exists */
  }
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS project_agents (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      created_at INTEGER DEFAULT (unixepoch()*1000),
      PRIMARY KEY (project_id, agent_id)
    )
  `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_project_agents_project ON project_agents(project_id)");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN workflow_pack_key TEXT NOT NULL DEFAULT 'development'");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN workflow_meta_json TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN orchestration_version INTEGER NOT NULL DEFAULT 1");
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN orchestration_stage TEXT CHECK(orchestration_stage IN ('owner_prep','foreign_collab','owner_integrate','finalize','review'))",
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN output_format TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      "ALTER TABLE subtasks ADD COLUMN orchestration_phase TEXT CHECK(orchestration_phase IN ('owner_prep','foreign_collab','owner_integrate','finalize'))",
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workflow_pack ON tasks(workflow_pack_key, updated_at DESC)");
  } catch {
    /* already exists */
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_retry_queue (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        last_reason TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        updated_at INTEGER DEFAULT (unixepoch()*1000)
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_task_retry_queue_next_run ON task_retry_queue(next_run_at, updated_at DESC)");
  } catch {
    /* already exists */
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_quality_items (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('acceptance','validation')),
        label TEXT NOT NULL,
        details TEXT,
        required INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0,1)),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','passed','failed','waived')),
        evidence_markdown TEXT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','workflow_meta','workflow_pack','system')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        updated_at INTEGER DEFAULT (unixepoch()*1000),
        completed_at INTEGER
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_task_quality_items_task ON task_quality_items(task_id, sort_order ASC, created_at ASC)",
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_quality_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        quality_item_id TEXT REFERENCES task_quality_items(id) ON DELETE SET NULL,
        run_type TEXT NOT NULL CHECK(run_type IN ('command','artifact_check','system')),
        name TEXT NOT NULL,
        command TEXT,
        status TEXT NOT NULL CHECK(status IN ('passed','failed','skipped')),
        exit_code INTEGER,
        summary TEXT,
        output_excerpt TEXT,
        metadata_json TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()*1000)
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_task_quality_runs_task_created ON task_quality_runs(task_id, created_at DESC)");
  } catch {
    /* already exists */
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        quality_item_id TEXT REFERENCES task_quality_items(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK(kind IN ('report_archive','video','file','document','other')),
        title TEXT NOT NULL,
        path TEXT,
        mime TEXT,
        size_bytes INTEGER,
        source TEXT NOT NULL CHECK(source IN ('auto','report_archive','video_gate','system')),
        metadata_json TEXT,
        created_at INTEGER DEFAULT (unixepoch()*1000)
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_created ON task_artifacts(task_id, created_at DESC)");
  } catch {
    /* already exists */
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_execution_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK(category IN ('retry','hook','watchdog')),
        action TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('info','success','warning','failure')),
        message TEXT NOT NULL,
        details_json TEXT,
        attempt_count INTEGER,
        hook_source TEXT CHECK(hook_source IN ('global','project')),
        duration_ms INTEGER,
        created_at INTEGER DEFAULT (unixepoch()*1000)
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_task_execution_events_task_created ON task_execution_events(task_id, created_at DESC)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_task_execution_events_task_category_created ON task_execution_events(task_id, category, created_at DESC)",
    );
  } catch {
    /* already exists */
  }

  ensureOfficePackScopedDepartmentSchema(db);
  ensureProjectReviewDecisionEventSchema(db);

  migrateMessagesDirectiveType(db);
  migrateLegacyTasksStatusSchema(db);
  repairLegacyTaskForeignKeys(db);
  ensureMessagesIdempotencySchema(db);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ensureOfficePackScopedDepartmentSchema(db: DbLike): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS office_pack_departments (
        workflow_pack_key TEXT NOT NULL,
        department_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_ko TEXT NOT NULL,
        name_ja TEXT NOT NULL DEFAULT '',
        name_zh TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL,
        color TEXT NOT NULL,
        description TEXT,
        prompt TEXT,
        sort_order INTEGER NOT NULL DEFAULT 99,
        created_at INTEGER DEFAULT (unixepoch()*1000),
        PRIMARY KEY (workflow_pack_key, department_id)
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_office_pack_departments_pack_sort ON office_pack_departments(workflow_pack_key, sort_order)",
    );
  } catch {
    /* already exists */
  }

  try {
    db.exec("ALTER TABLE agents ADD COLUMN workflow_pack_key TEXT NOT NULL DEFAULT 'development'");
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_agents_workflow_pack ON agents(workflow_pack_key, department_id, role, created_at)",
    );
  } catch {
    /* best effort */
  }

  // Seed-id based backfill for legacy rows before profile-based backfill.
  for (const packKey of WORKFLOW_PACK_KEYS) {
    if (packKey === DEFAULT_WORKFLOW_PACK_KEY) continue;
    try {
      db.prepare(
        `
          UPDATE agents
          SET workflow_pack_key = ?
          WHERE (workflow_pack_key IS NULL OR workflow_pack_key = '' OR workflow_pack_key = ?)
            AND id LIKE ?
        `,
      ).run(packKey, DEFAULT_WORKFLOW_PACK_KEY, `${packKey}-%`);
    } catch {
      // ignore
    }
  }

  const profileRow = db.prepare("SELECT value FROM settings WHERE key = 'officePackProfiles' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  if (!profileRow) return;

  let parsedRoot: unknown = profileRow.value;
  if (typeof parsedRoot === "string") {
    parsedRoot = safeJsonParse(parsedRoot);
  }
  const root = asObject(parsedRoot);
  if (!root) return;

  const upsertPackDepartment = db.prepare(
    `
      INSERT INTO office_pack_departments (
        workflow_pack_key, department_id, name, name_ko, name_ja, name_zh,
        icon, color, description, prompt, sort_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_pack_key, department_id) DO UPDATE SET
        name = excluded.name,
        name_ko = excluded.name_ko,
        name_ja = excluded.name_ja,
        name_zh = excluded.name_zh,
        icon = excluded.icon,
        color = excluded.color,
        description = excluded.description,
        prompt = excluded.prompt,
        sort_order = excluded.sort_order
    `,
  );
  const updateAgentPack = db.prepare("UPDATE agents SET workflow_pack_key = ? WHERE id = ?");

  const now = Date.now();
  for (const [rawPackKey, rawProfile] of Object.entries(root)) {
    const packKey = normalizeText(rawPackKey);
    if (!isWorkflowPackKey(packKey) || packKey === DEFAULT_WORKFLOW_PACK_KEY) continue;
    const profile = asObject(rawProfile);
    if (!profile) continue;

    if (Array.isArray(profile.departments)) {
      for (const rawDepartment of profile.departments) {
        const department = asObject(rawDepartment);
        if (!department) continue;
        const departmentId = normalizeText(department.id);
        if (!departmentId) continue;

        const name = normalizeText(department.name) || departmentId;
        const nameKo = normalizeText(department.name_ko) || name;
        const nameJa = normalizeText(department.name_ja);
        const nameZh = normalizeText(department.name_zh);
        const icon = normalizeText(department.icon) || "🏢";
        const color = normalizeText(department.color) || "#64748b";
        const description = normalizeText(department.description) || null;
        const prompt = normalizeText(department.prompt) || null;
        const sortOrderRaw = Number(department.sort_order);
        const sortOrder = Number.isFinite(sortOrderRaw) ? Math.max(0, Math.trunc(sortOrderRaw)) : 99;
        const createdAtRaw = Number(department.created_at);
        const createdAt = Number.isFinite(createdAtRaw) ? Math.max(0, Math.trunc(createdAtRaw)) : now;

        try {
          upsertPackDepartment.run(
            packKey,
            departmentId,
            name,
            nameKo,
            nameJa,
            nameZh,
            icon,
            color,
            description,
            prompt,
            sortOrder,
            createdAt,
          );
        } catch {
          // ignore malformed profile rows
        }
      }
    }

    if (Array.isArray(profile.agents)) {
      for (const rawAgent of profile.agents) {
        const agent = asObject(rawAgent);
        if (!agent) continue;
        const agentId = normalizeText(agent.id);
        if (!agentId) continue;
        try {
          updateAgentPack.run(packKey, agentId);
        } catch {
          // ignore missing agents
        }
      }
    }
  }
}

export function ensureProjectReviewDecisionEventSchema(db: DbLike): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_review_decision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        snapshot_hash TEXT,
        event_type TEXT NOT NULL
          CHECK(event_type IN (
            'planning_summary',
            'representative_pick',
            'followup_request',
            'start_review_meeting',
            'start_review_meeting_blocked'
          )),
        summary TEXT NOT NULL,
        selected_options_json TEXT,
        note TEXT,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        meeting_id TEXT REFERENCES meeting_minutes(id) ON DELETE SET NULL,
        created_at INTEGER DEFAULT (unixepoch()*1000)
      )
    `);
  } catch {
    /* already exists */
  }

  const tableRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_review_decision_events' LIMIT 1")
    .get() as { sql?: string } | undefined;
  const ddl = String(tableRow?.sql ?? "");
  if (!ddl || ddl.includes("start_review_meeting_blocked")) return;

  const legacyTable = `project_review_decision_events_legacy_${Date.now()}`;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec(`ALTER TABLE project_review_decision_events RENAME TO ${legacyTable}`);
    db.exec(`
      CREATE TABLE project_review_decision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        snapshot_hash TEXT,
        event_type TEXT NOT NULL
          CHECK(event_type IN (
            'planning_summary',
            'representative_pick',
            'followup_request',
            'start_review_meeting',
            'start_review_meeting_blocked'
          )),
        summary TEXT NOT NULL,
        selected_options_json TEXT,
        note TEXT,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        meeting_id TEXT REFERENCES meeting_minutes(id) ON DELETE SET NULL,
        created_at INTEGER DEFAULT (unixepoch()*1000)
      )
    `);
    db.exec(`
      INSERT INTO project_review_decision_events (
        id,
        project_id,
        snapshot_hash,
        event_type,
        summary,
        selected_options_json,
        note,
        task_id,
        meeting_id,
        created_at
      )
      SELECT
        id,
        project_id,
        snapshot_hash,
        event_type,
        summary,
        selected_options_json,
        note,
        task_id,
        meeting_id,
        created_at
      FROM ${legacyTable}
    `);
    db.exec(`DROP TABLE ${legacyTable}`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_project_review_decision_events_project ON project_review_decision_events(project_id, created_at DESC)",
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateMessagesDirectiveType(db: DbLike): void {
  const row = db
    .prepare(
      `
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'
  `,
    )
    .get() as { sql?: string } | undefined;
  const ddl = (row?.sql ?? "").toLowerCase();
  if (ddl.includes("'directive'")) return;

  console.log("[Claw-Empire] Migrating messages.message_type CHECK to include 'directive'");
  const oldTable = "messages_directive_migration_old";
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`ALTER TABLE messages RENAME TO ${oldTable}`);
      const oldCols = db.prepare(`PRAGMA table_info(${oldTable})`).all() as Array<{ name: string }>;
      const hasIdempotencyKey = oldCols.some((c) => c.name === "idempotency_key");
      const idempotencyExpr = hasIdempotencyKey ? "idempotency_key" : "NULL";
      db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          sender_type TEXT NOT NULL CHECK(sender_type IN ('ceo','agent','system')),
          sender_id TEXT,
          receiver_type TEXT NOT NULL CHECK(receiver_type IN ('agent','department','all')),
          receiver_id TEXT,
          content TEXT NOT NULL,
          message_type TEXT DEFAULT 'chat' CHECK(message_type IN ('chat','task_assign','announcement','directive','report','status_update')),
          task_id TEXT REFERENCES tasks(id),
          idempotency_key TEXT,
          created_at INTEGER DEFAULT (unixepoch()*1000)
        );
      `);
      db.exec(`
        INSERT INTO messages (id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, idempotency_key, created_at)
        SELECT id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, ${idempotencyExpr}, created_at
        FROM ${oldTable};
      `);
      db.exec(`DROP TABLE ${oldTable}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      // Restore original table if migration failed
      try {
        db.exec(`ALTER TABLE ${oldTable} RENAME TO messages`);
      } catch {
        /* */
      }
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  // Recreate index
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_type, receiver_id, created_at DESC)");
}

function migrateLegacyTasksStatusSchema(db: DbLike): void {
  const row = db
    .prepare(
      `
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'tasks'
  `,
    )
    .get() as { sql?: string } | undefined;
  const ddl = (row?.sql ?? "").toLowerCase();
  if (ddl.includes("'collaborating'") && ddl.includes("'pending'")) return;

  console.log("[Claw-Empire] Migrating legacy tasks.status CHECK constraint");
  const newTable = "tasks_status_migration_new";
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`DROP TABLE IF EXISTS ${newTable}`);
      db.exec(`
        CREATE TABLE ${newTable} (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          department_id TEXT REFERENCES departments(id),
          assigned_agent_id TEXT REFERENCES agents(id),
          project_id TEXT REFERENCES projects(id),
          status TEXT NOT NULL DEFAULT 'inbox'
            CHECK(status IN ('inbox','planned','collaborating','in_progress','review','done','cancelled','pending')),
          priority INTEGER DEFAULT 0,
          task_type TEXT DEFAULT 'general'
            CHECK(task_type IN ('general','development','design','analysis','presentation','documentation')),
          workflow_pack_key TEXT NOT NULL DEFAULT 'development',
          orchestration_version INTEGER NOT NULL DEFAULT 1,
          orchestration_stage TEXT
            CHECK(orchestration_stage IN ('owner_prep','foreign_collab','owner_integrate','finalize','review')),
          workflow_meta_json TEXT,
          output_format TEXT,
          project_path TEXT,
          result TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch()*1000),
          updated_at INTEGER DEFAULT (unixepoch()*1000),
          source_task_id TEXT
        );
      `);

      const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
      const hasSourceTaskId = cols.some((c) => c.name === "source_task_id");
      const hasProjectId = cols.some((c) => c.name === "project_id");
      const hasWorkflowPackKey = cols.some((c) => c.name === "workflow_pack_key");
      const hasOrchestrationVersion = cols.some((c) => c.name === "orchestration_version");
      const hasOrchestrationStage = cols.some((c) => c.name === "orchestration_stage");
      const hasWorkflowMeta = cols.some((c) => c.name === "workflow_meta_json");
      const hasOutputFormat = cols.some((c) => c.name === "output_format");
      const sourceTaskIdExpr = hasSourceTaskId ? "source_task_id" : "NULL AS source_task_id";
      const projectIdExpr = hasProjectId ? "project_id" : "NULL AS project_id";
      const workflowPackExpr = hasWorkflowPackKey ? "workflow_pack_key" : "'development' AS workflow_pack_key";
      const orchestrationVersionExpr = hasOrchestrationVersion ? "orchestration_version" : "1 AS orchestration_version";
      const orchestrationStageExpr = hasOrchestrationStage ? "orchestration_stage" : "NULL AS orchestration_stage";
      const workflowMetaExpr = hasWorkflowMeta ? "workflow_meta_json" : "NULL AS workflow_meta_json";
      const outputFormatExpr = hasOutputFormat ? "output_format" : "NULL AS output_format";
      db.exec(`
        INSERT INTO ${newTable} (
          id, title, description, department_id, assigned_agent_id,
          project_id, status, priority, task_type, workflow_pack_key, orchestration_version, orchestration_stage,
          workflow_meta_json, output_format, project_path, result,
          started_at, completed_at, created_at, updated_at, source_task_id
        )
        SELECT
          id, title, description, department_id, assigned_agent_id,
          ${projectIdExpr},
          CASE
            WHEN status IN ('inbox','planned','collaborating','in_progress','review','done','cancelled','pending')
              THEN status
            ELSE 'inbox'
          END,
          priority, task_type, ${workflowPackExpr}, ${orchestrationVersionExpr}, ${orchestrationStageExpr},
          ${workflowMetaExpr}, ${outputFormatExpr}, project_path, result,
          started_at, completed_at, created_at, updated_at, ${sourceTaskIdExpr}
        FROM tasks;
      `);

      db.exec("DROP TABLE tasks");
      db.exec(`ALTER TABLE ${newTable} RENAME TO tasks`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_dept ON tasks(department_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, updated_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workflow_pack ON tasks(workflow_pack_key, updated_at DESC)");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function repairLegacyTaskForeignKeys(db: DbLike): void {
  const refCount = (
    db
      .prepare(
        `
    SELECT COUNT(*) AS cnt
    FROM sqlite_master
    WHERE type = 'table' AND sql LIKE '%tasks_legacy_status_migration%'
  `,
      )
      .get() as { cnt: number }
  ).cnt;
  if (refCount === 0) return;

  console.log("[Claw-Empire] Repairing legacy foreign keys to tasks_legacy_status_migration");
  const messagesOld = "messages_fkfix_old";
  const taskLogsOld = "task_logs_fkfix_old";
  const subtasksOld = "subtasks_fkfix_old";
  const meetingMinutesOld = "meeting_minutes_fkfix_old";
  const meetingEntriesOld = "meeting_minute_entries_fkfix_old";

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`ALTER TABLE messages RENAME TO ${messagesOld}`);
      const legacyMessageCols = db.prepare(`PRAGMA table_info(${messagesOld})`).all() as Array<{ name: string }>;
      const hasLegacyIdempotencyKey = legacyMessageCols.some((c) => c.name === "idempotency_key");
      const legacyIdempotencyExpr = hasLegacyIdempotencyKey ? "idempotency_key" : "NULL";
      db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          sender_type TEXT NOT NULL CHECK(sender_type IN ('ceo','agent','system')),
          sender_id TEXT,
          receiver_type TEXT NOT NULL CHECK(receiver_type IN ('agent','department','all')),
          receiver_id TEXT,
          content TEXT NOT NULL,
          message_type TEXT DEFAULT 'chat' CHECK(message_type IN ('chat','task_assign','announcement','directive','report','status_update')),
          task_id TEXT REFERENCES tasks(id),
          idempotency_key TEXT,
          created_at INTEGER DEFAULT (unixepoch()*1000)
        );
      `);
      db.exec(`
        INSERT INTO messages (id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, idempotency_key, created_at)
        SELECT id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, ${legacyIdempotencyExpr}, created_at
        FROM ${messagesOld};
      `);

      db.exec(`ALTER TABLE task_logs RENAME TO ${taskLogsOld}`);
      db.exec(`
        CREATE TABLE task_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT REFERENCES tasks(id),
          kind TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()*1000)
        );
      `);
      db.exec(`
        INSERT INTO task_logs (id, task_id, kind, message, created_at)
        SELECT id, task_id, kind, message, created_at
        FROM ${taskLogsOld};
      `);

      db.exec(`ALTER TABLE subtasks RENAME TO ${subtasksOld}`);
      db.exec(`
        CREATE TABLE subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','in_progress','done','blocked')),
          assigned_agent_id TEXT REFERENCES agents(id),
          blocked_reason TEXT,
          orchestration_phase TEXT
            CHECK(orchestration_phase IN ('owner_prep','foreign_collab','owner_integrate','finalize')),
          cli_tool_use_id TEXT,
          created_at INTEGER DEFAULT (unixepoch()*1000),
          completed_at INTEGER,
          target_department_id TEXT,
          delegated_task_id TEXT
        );
      `);
      const subtasksCols = db.prepare(`PRAGMA table_info(${subtasksOld})`).all() as Array<{ name: string }>;
      const hasTargetDept = subtasksCols.some((c) => c.name === "target_department_id");
      const hasDelegatedTask = subtasksCols.some((c) => c.name === "delegated_task_id");
      const hasOrchestrationPhase = subtasksCols.some((c) => c.name === "orchestration_phase");
      db.exec(`
        INSERT INTO subtasks (
          id, task_id, title, description, status, assigned_agent_id,
          blocked_reason, orchestration_phase, cli_tool_use_id, created_at, completed_at,
          target_department_id, delegated_task_id
        )
        SELECT
          id, task_id, title, description, status, assigned_agent_id,
          blocked_reason, ${hasOrchestrationPhase ? "orchestration_phase" : "NULL"}, cli_tool_use_id, created_at, completed_at,
          ${hasTargetDept ? "target_department_id" : "NULL"},
          ${hasDelegatedTask ? "delegated_task_id" : "NULL"}
        FROM ${subtasksOld};
      `);

      db.exec(`ALTER TABLE meeting_minute_entries RENAME TO ${meetingEntriesOld}`);
      db.exec(`ALTER TABLE meeting_minutes RENAME TO ${meetingMinutesOld}`);
      db.exec(`
        CREATE TABLE meeting_minutes (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          meeting_type TEXT NOT NULL CHECK(meeting_type IN ('planned','review')),
          round INTEGER NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','revision_requested','failed')),
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch()*1000)
        );
      `);
      db.exec(`
        INSERT INTO meeting_minutes (
          id, task_id, meeting_type, round, title, status, started_at, completed_at, created_at
        )
        SELECT
          id, task_id, meeting_type, round, title, status, started_at, completed_at, created_at
        FROM ${meetingMinutesOld};
      `);

      db.exec(`
        CREATE TABLE meeting_minute_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          meeting_id TEXT NOT NULL REFERENCES meeting_minutes(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          speaker_agent_id TEXT REFERENCES agents(id),
          speaker_name TEXT NOT NULL,
          department_name TEXT,
          role_label TEXT,
          message_type TEXT NOT NULL DEFAULT 'chat',
          content TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()*1000)
        );
      `);
      db.exec(`
        INSERT INTO meeting_minute_entries (
          id, meeting_id, seq, speaker_agent_id, speaker_name,
          department_name, role_label, message_type, content, created_at
        )
        SELECT
          id, meeting_id, seq, speaker_agent_id, speaker_name,
          department_name, role_label, message_type, content, created_at
        FROM ${meetingEntriesOld};
      `);

      db.exec(`DROP TABLE ${messagesOld}`);
      db.exec(`DROP TABLE ${taskLogsOld}`);
      db.exec(`DROP TABLE ${subtasksOld}`);
      db.exec(`DROP TABLE ${meetingEntriesOld}`);
      db.exec(`DROP TABLE ${meetingMinutesOld}`);

      db.exec("CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, created_at DESC)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_type, receiver_id, created_at DESC)",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_meeting_minutes_task ON meeting_minutes(task_id, started_at DESC)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_meeting_minute_entries_meeting ON meeting_minute_entries(meeting_id, seq ASC)",
      );

      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function ensureMessagesIdempotencySchema(db: DbLike): void {
  try {
    db.exec("ALTER TABLE messages ADD COLUMN idempotency_key TEXT");
  } catch {
    /* already exists */
  }

  db.prepare(
    `
    UPDATE messages
    SET idempotency_key = NULL
    WHERE idempotency_key IS NOT NULL
      AND TRIM(idempotency_key) = ''
  `,
  ).run();

  const duplicateKeys = db
    .prepare(
      `
    SELECT idempotency_key
    FROM messages
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key
    HAVING COUNT(*) > 1
  `,
    )
    .all() as Array<{ idempotency_key: string }>;

  for (const row of duplicateKeys) {
    const keep = db
      .prepare(
        `
      SELECT id
      FROM messages
      WHERE idempotency_key = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `,
      )
      .get(row.idempotency_key) as { id: string } | undefined;
    if (!keep) continue;
    db.prepare(
      `
      UPDATE messages
      SET idempotency_key = NULL
      WHERE idempotency_key = ?
        AND id != ?
    `,
    ).run(row.idempotency_key, keep.id);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency_key
    ON messages(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);
}
