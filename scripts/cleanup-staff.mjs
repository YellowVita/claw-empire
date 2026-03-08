#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.resolve(scriptDir, "..", "claw-empire.sqlite");
const dbPath = String(process.env.DB_PATH || defaultDbPath).trim();

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const resetBreak = args.has("--reset-break") || args.has("--all");
const showDuplicates = args.has("--show-duplicates") || args.has("--all");
const showRoles = args.has("--show-roles") || args.has("--all");

function printUsage() {
  console.log("Claw-Empire staff maintenance");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node scripts/cleanup-staff.mjs [--dry-run] [--reset-break] [--show-duplicates] [--show-roles] [--all]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --dry-run          Show changes without updating the database");
  console.log("  --reset-break      Reset agents in break status back to idle");
  console.log("  --show-duplicates  Report duplicate agent names");
  console.log("  --show-roles       Report role composition and top performers");
  console.log("  --all              Run every report and reset break agents");
}

function isPackSeed(agentId) {
  return /^[a-z_]+-seed-\d+$/i.test(agentId);
}

function countByRole(rows, role) {
  return rows.filter((row) => row.role === role).length;
}

function reportBreakAgents(db) {
  const rows = db
    .prepare("SELECT id, name, role, cli_provider FROM agents WHERE status = 'break' ORDER BY name ASC")
    .all();

  if (rows.length === 0) {
    console.log("No agents are currently in break status.");
    return rows;
  }

  console.log(`Agents in break status (${rows.length})`);
  for (const row of rows) {
    const seedLabel = isPackSeed(row.id) ? " [pack-seed]" : "";
    console.log(`- ${row.name} (${row.role}${row.cli_provider ? `, ${row.cli_provider}` : ""})${seedLabel}`);
  }
  return rows;
}

function resetBreakAgents(db) {
  const rows = reportBreakAgents(db);
  if (rows.length === 0) return;

  if (dryRun) {
    console.log(`dry-run: would reset ${rows.length} break agent(s) to idle`);
    return;
  }

  const result = db.prepare("UPDATE agents SET status = 'idle' WHERE status = 'break'").run();
  console.log(`Reset ${result.changes} agent(s) from break to idle`);
}

function reportRoles(db) {
  const rows = db.prepare("SELECT id, name, role, cli_provider, stats_tasks_done FROM agents ORDER BY name ASC").all();
  const coreAgents = rows.filter((row) => !isPackSeed(row.id));
  const seedAgents = rows.filter((row) => isPackSeed(row.id));
  const topAgents = [...rows].sort((a, b) => (b.stats_tasks_done ?? 0) - (a.stats_tasks_done ?? 0)).slice(0, 5);

  console.log("Role composition");
  console.log(`- core team_leader: ${countByRole(coreAgents, "team_leader")}`);
  console.log(`- core senior: ${countByRole(coreAgents, "senior")}`);
  console.log(`- core junior: ${countByRole(coreAgents, "junior")}`);
  console.log(`- core intern: ${countByRole(coreAgents, "intern")}`);
  console.log(`- core total: ${coreAgents.length}`);
  console.log(`- seed team_leader: ${countByRole(seedAgents, "team_leader")}`);
  console.log(`- seed senior: ${countByRole(seedAgents, "senior")}`);
  console.log(`- seed junior: ${countByRole(seedAgents, "junior")}`);
  console.log(`- seed total: ${seedAgents.length}`);

  if (topAgents.length > 0) {
    console.log("Top completed-task agents");
    for (const row of topAgents) {
      console.log(`- ${row.name}: ${row.stats_tasks_done ?? 0} (${row.role})`);
    }
  }
}

function reportDuplicates(db) {
  const rows = db.prepare("SELECT id, name, role, cli_provider FROM agents ORDER BY name ASC, id ASC").all();
  const byName = new Map();
  for (const row of rows) {
    const bucket = byName.get(row.name) || [];
    bucket.push(row);
    byName.set(row.name, bucket);
  }

  const duplicates = [...byName.entries()].filter(([, bucket]) => bucket.length > 1);
  if (duplicates.length === 0) {
    console.log("Duplicate agent names: none");
    return;
  }

  console.log(`Duplicate agent names (${duplicates.length} group(s))`);
  for (const [name, bucket] of duplicates) {
    console.log(`- ${name}`);
    for (const row of bucket) {
      const scope = isPackSeed(row.id) ? `pack-seed:${row.id}` : `core:${row.id.slice(0, 8)}`;
      console.log(`  ${row.role}${row.cli_provider ? ` / ${row.cli_provider}` : ""} / ${scope}`);
    }
  }
}

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

if (args.size === 0 || (args.size === 1 && dryRun)) {
  printUsage();
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
try {
  console.log("Claw-Empire staff maintenance");
  if (dryRun) {
    console.log("Mode: dry-run");
  }
  console.log(`DB: ${dbPath}`);
  console.log("");

  if (resetBreak) {
    resetBreakAgents(db);
    console.log("");
  }
  if (showRoles) {
    reportRoles(db);
    console.log("");
  }
  if (showDuplicates) {
    reportDuplicates(db);
    console.log("");
  }

  console.log("Done");
} finally {
  db.close();
}
