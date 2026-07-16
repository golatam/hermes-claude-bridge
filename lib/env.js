import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader: only fills in vars not already set in process.env,
// so an explicit shell export always wins over the file (useful for manual
// runs/overrides). No third-party dependency needed for this.
export function loadDotEnv(path) {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}
