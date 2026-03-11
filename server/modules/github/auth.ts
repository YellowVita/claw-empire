import { decryptSecret } from "../../oauth/helpers.ts";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
  };
};

export function getGitHubAccessToken(db: DbLike): string | null {
  const row = db
    .prepare(
      "SELECT access_token_enc FROM oauth_accounts WHERE provider = 'github' AND status = 'active' ORDER BY priority ASC, updated_at DESC LIMIT 1",
    )
    .get() as { access_token_enc: string | null } | undefined;
  if (!row?.access_token_enc) return null;
  try {
    return decryptSecret(row.access_token_enc);
  } catch {
    return null;
  }
}

export function buildGitHubApiHeaders(
  token: string,
  options?: { accept?: string; authScheme?: "Bearer" | "token" },
): Record<string, string> {
  const authScheme = options?.authScheme ?? "Bearer";
  return {
    Authorization: `${authScheme} ${token}`,
    Accept: options?.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
