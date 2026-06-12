/**
 * F-REN-3 back-compat env shim. Reads FRONDOSE_<name> first, then legacy
 * MAI_<name>, so pre-existing operator setups (.env / ~/.mai / launchd plists
 * that set MAI_*) keep working while production code + new installs use
 * FRONDOSE_*. `name` is the BARE suffix (no MAI_/FRONDOSE_ prefix).
 *
 * Precedence is `??`: an explicit empty FRONDOSE_<name>="" returns "" and does
 * NOT fall through to MAI_<name> (only undefined falls through).
 *
 * The optional `env` arg is a test/injection seam (used by resolveTier).
 */
export function frondoseEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`FRONDOSE_${name}`] ?? env[`MAI_${name}`];
}
