import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { AccountPool } from "../auth/account-pool.js";
import type { AccountPersistence } from "../auth/account-persistence.js";
import { validateManualToken } from "../auth/chatgpt-oauth.js";
import { refreshAccessToken } from "../auth/oauth-pkce.js";
import { getDataDir } from "../paths.js";

interface BootstrapAccountsFile {
  accounts?: Array<Record<string, unknown>>;
}

export interface BootstrapNormalizeResult {
  imported: number;
  updated: number;
  failed: number;
  skipped: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Prefer CODEX_PROXY_DATA_DIR when explicitly injected by runtime wrappers.
 * Falls back to the regular app data directory otherwise.
 */
function getBootstrapAccountsPath(): string {
  return resolve(process.env.CODEX_PROXY_DATA_DIR ?? getDataDir(), "accounts.json");
}

function writeBootstrapAccounts(filePath: string, accounts: Array<Record<string, unknown>>): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

/**
 * Upgrade refresh-token-only bootstrap entries into normal persisted accounts
 * before AccountPool loads from disk.
 */
export async function normalizeBootstrapAccounts(): Promise<BootstrapNormalizeResult> {
  const accountsPath = getBootstrapAccountsPath();
  if (!existsSync(accountsPath)) {
    return { imported: 0, updated: 0, failed: 0, skipped: 0 };
  }

  let parsed: BootstrapAccountsFile;
  try {
    parsed = JSON.parse(readFileSync(accountsPath, "utf-8")) as BootstrapAccountsFile;
  } catch (err) {
    console.warn("[Bootstrap] Failed to parse accounts.json:", err instanceof Error ? err.message : err);
    return { imported: 0, updated: 0, failed: 1, skipped: 0 };
  }

  const sourceAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  const validEntries = sourceAccounts.filter((entry) => isNonEmptyString(entry.id) && isNonEmptyString(entry.token));
  const needsBootstrap = sourceAccounts.some((entry) => !isNonEmptyString(entry.id) && isNonEmptyString(entry.refreshToken));

  if (!needsBootstrap) {
    return { imported: 0, updated: 0, failed: 0, skipped: sourceAccounts.length };
  }

  let normalizedEntries: Array<Record<string, unknown>> = [...validEntries];
  const persistence: AccountPersistence = {
    load: () => ({ entries: validEntries as never[], needsPersist: false }),
    save: (accounts) => {
      normalizedEntries = accounts as unknown as Array<Record<string, unknown>>;
    },
  };
  const pool = new AccountPool({ persistence });

  let imported = 0;
  let failed = 0;
  let skipped = 0;
  const unresolvedEntries: Array<Record<string, unknown>> = [];

  for (const entry of sourceAccounts) {
    if (isNonEmptyString(entry.id) && isNonEmptyString(entry.token)) {
      skipped++;
      continue;
    }

    const refreshToken = isNonEmptyString(entry.refreshToken) ? entry.refreshToken.trim() : null;
    if (!refreshToken) {
      skipped++;
      unresolvedEntries.push(entry);
      continue;
    }

    try {
      const refreshed = await refreshAccessToken(refreshToken);
      const token = refreshed.access_token;
      const nextRefreshToken = refreshed.refresh_token ?? refreshToken;
      const validation = validateManualToken(token);
      if (!validation.valid) {
        throw new Error(validation.error ?? "Invalid token");
      }
      pool.addAccount(token, nextRefreshToken);
      imported++;
    } catch (err) {
      failed++;
      unresolvedEntries.push(entry);
      const email = isNonEmptyString(entry.email) ? entry.email : "unknown";
      console.warn(`[Bootstrap] Failed to import account ${email}:`, err instanceof Error ? err.message : err);
    }
  }

  writeBootstrapAccounts(accountsPath, [...normalizedEntries, ...unresolvedEntries]);

  return { imported, updated: 0, failed, skipped };
}
