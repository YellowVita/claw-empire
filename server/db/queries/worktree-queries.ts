import type { DatabaseSync } from "node:sqlite";

export function listDistinctProjectPaths(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `
        SELECT DISTINCT project_path
        FROM (
          SELECT project_path FROM projects
          UNION
          SELECT project_path FROM tasks
        )
        WHERE TRIM(COALESCE(project_path, '')) != ''
      `,
    )
    .all() as Array<{ project_path: string }>;
  return rows.map((row) => row.project_path);
}

export function findTasksByShortId(
  db: DatabaseSync,
  shortId: string,
): Array<{
  id: string;
  status: string;
}> {
  return db
    .prepare(
      `
      SELECT id, status
      FROM tasks
      WHERE substr(id, 1, 8) = ?
    `,
    )
    .all(shortId) as Array<{ id: string; status: string }>;
}
