import fs from "node:fs";
import path from "node:path";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { buildTerminalProgressHints } from "./progress-hints.ts";
import { prettyStreamJson } from "./pretty-stream-json.ts";

export function registerTaskTerminalRoutes(ctx: RuntimeContext): void {
  const { app, logsDir, hasStructuredJsonLines, db } = ctx;

  app.get("/api/tasks/:id/terminal", (req, res) => {
    const id = String(req.params.id);
    const lines = Math.min(Math.max(Number(req.query.lines ?? 200), 20), 20000);
    const logLimit = Math.min(Math.max(Number(req.query.log_limit ?? 400), 50), 2000);
    const pretty = String(req.query.pretty ?? "0") === "1";
    const filePath = path.join(logsDir, `${id}.log`);

    if (!fs.existsSync(filePath)) {
      return res.json({ ok: true, exists: false, path: filePath, text: "" });
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parts = raw.split(/\r?\n/);
    const tail = parts.slice(Math.max(0, parts.length - lines)).join("\n");
    let text = tail;
    let progressHints: ReturnType<typeof buildTerminalProgressHints> | null = null;
    if (pretty) {
      const parsed = prettyStreamJson(tail, { includeReasoning: true });
      text = parsed;
      if (hasStructuredJsonLines(tail)) {
        const hints = buildTerminalProgressHints(tail);
        if (hints.hints.length > 0) {
          progressHints = hints;
        }
      }
    }

    const taskLogs = db
      .prepare("SELECT id, kind, message, created_at FROM task_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(id, logLimit) as Array<{ id: number; kind: string; message: string; created_at: number }>;
    taskLogs.reverse();

    res.json({
      ok: true,
      exists: true,
      path: filePath,
      text,
      task_logs: taskLogs,
      progress_hints: progressHints,
    });
  });
}
