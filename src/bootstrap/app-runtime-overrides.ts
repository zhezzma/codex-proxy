import type { AppConfig } from "../config.js";

/**
 * Apply runtime-only environment overrides after YAML config load.
 *
 * This keeps the persisted config files untouched while still allowing
 * process-level overrides from PM2 / shell / container environments.
 */
export function applyRuntimeEnvOverrides(config: AppConfig): void {
  const port = Number.parseInt(process.env.PORT ?? "", 10);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    config.server.port = port;
  }

  const proxyApiKey = process.env.PROXY_API_KEY?.trim();
  if (proxyApiKey) {
    config.server.proxy_api_key = proxyApiKey;
  }
}
