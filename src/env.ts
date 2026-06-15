/**
 * Env reader. Reads FRONDOSE_<name>. `name` is the BARE suffix (no FRONDOSE_
 * prefix). The legacy MAI_<name> back-compat fallback was removed in the full
 * rebrand (2026-06-15) — only FRONDOSE_* is honored.
 *
 * The optional `env` arg is a test/injection seam (used by resolveTier).
 */
export function frondoseEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`FRONDOSE_${name}`];
}
