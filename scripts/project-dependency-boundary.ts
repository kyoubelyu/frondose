import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const RETIRED_ROOT_DEPENDENCIES = [
  "ssh2",
  "ws",
  "react",
  "react-dom",
  "@xterm/xterm",
  "@xterm/addon-fit",
  "@tailwindcss/cli",
  "@novnc/novnc",
];

export const APPROVED_WS_OWNERS = ["@earendil-works/pi-ai", "@modelcontextprotocol/sdk", "chrome-remote-interface"];

function containsDependencyToken(text: string, dependency: string): boolean {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9@/._-])${escaped}($|[^A-Za-z0-9@/._-])`).test(text);
}

/** True when the text actually references the package as a module (import/require), not merely mentions its name. */
function referencesDependency(text: string, dependency: string): boolean {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:from|import|require)\\s*\\(?\\s*["']${escaped}(?:/|["'])`).test(text);
}

export function checkExportedDependencySurface(
  packageJsonBytes: Uint8Array | undefined,
  lockBytes: Uint8Array | undefined,
): void {
  if (packageJsonBytes) {
    const pkg = JSON.parse(Buffer.from(packageJsonBytes).toString("utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const rootDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const dependency of RETIRED_ROOT_DEPENDENCIES) {
      if (dependency in rootDeps) throw new Error(`exported package.json declares retired dependency ${dependency}`);
    }
  }
  if (!lockBytes) return;
  const lock = JSON.parse(Buffer.from(lockBytes).toString("utf8")) as {
    packages?: Record<
      string,
      {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      }
    >;
  };
  const packages = lock.packages ?? {};
  const lockRoot = packages[""] ?? {};
  const rootDeps = { ...lockRoot.dependencies, ...lockRoot.devDependencies };
  for (const dependency of RETIRED_ROOT_DEPENDENCIES) {
    if (dependency in rootDeps)
      throw new Error(`exported package-lock.json root declares retired dependency ${dependency}`);
  }
  const retainedPeerOwners = new Set([
    "node_modules/ai",
    "node_modules/@ai-sdk/react",
    "node_modules/swr",
    "node_modules/use-sync-external-store",
  ]);
  const reactFamily = new Set(["react", "react-dom", "@types/react", "@types/react-dom"]);
  for (const dependency of RETIRED_ROOT_DEPENDENCIES) {
    if (dependency === "ws") continue;
    if (reactFamily.has(dependency)) {
      const resolved = `node_modules/${dependency}`;
      if (!(resolved in packages)) continue;
      const owners = Object.entries(packages).filter(
        ([, entry]) => entry?.peerDependencies?.[dependency] ?? entry?.dependencies?.[dependency],
      );
      for (const [owner] of owners) {
        if (!retainedPeerOwners.has(owner)) {
          throw new Error(`exported package-lock.json resolves retired dependency ${dependency} under ${owner}`);
        }
      }
      continue;
    }
    if (`node_modules/${dependency}` in packages) {
      throw new Error(`exported package-lock.json resolves retired dependency ${dependency}`);
    }
  }
}

function installedPackages(projectRoot: string): Map<string, { dependencies: Record<string, string>; path: string }> {
  const installed = new Map<string, { dependencies: Record<string, string>; path: string }>();
  const modulesRoot = join(projectRoot, "node_modules");
  if (!existsSync(modulesRoot)) return installed;
  const walk = (dir: string, relativePath: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const stat = statSync(full);
      if (!stat.isDirectory()) continue;
      const packageJsonPath = join(full, "package.json");
      const hasManifest = existsSync(packageJsonPath);
      if (hasManifest) {
        const meta = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          name?: string;
          dependencies?: Record<string, string>;
        };
        const pkgName = meta.name ?? (relativePath ? `${relativePath}/${name}` : name);
        installed.set(pkgName, {
          dependencies: meta.dependencies ?? {},
          path: relativePath ? `${relativePath}/${name}` : name,
        });
      }
      const nestedModules = join(full, "node_modules");
      if (existsSync(nestedModules)) walk(nestedModules, relativePath ? `${relativePath}/${name}` : name);
      else if (!hasManifest) walk(full, relativePath ? `${relativePath}/${name}` : name);
    }
  };
  walk(modulesRoot, "");
  return installed;
}

function climbToRootOwner(
  packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>,
  lockRootDeps: Record<string, string>,
  directOwnerKey: string,
): string {
  let current = directOwnerKey;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const pkgName = current.slice("node_modules/".length);
    if (pkgName in lockRootDeps) return pkgName;
    let parent: string | undefined;
    for (const [key, meta] of Object.entries(packages)) {
      if (key === "" || key === current) continue;
      const deps = { ...meta?.dependencies, ...meta?.devDependencies };
      if (pkgName in deps) {
        parent = key;
        break;
      }
    }
    if (!parent) return pkgName;
    current = parent;
  }
  return current.slice("node_modules/".length);
}

export function validateInstalledDependencyBoundary(
  projectRoot: string,
  dependencyNames: string[],
): Record<string, Array<{ topLevelOwner: string; direct: boolean }>> {
  const rootPkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
  const lock = JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
  };
  const packages = lock.packages ?? {};
  const lockRoot = packages[""] ?? {};
  const lockRootDeps = { ...lockRoot.dependencies, ...lockRoot.devDependencies };
  const installed = installedPackages(projectRoot);
  const result: Record<string, Array<{ topLevelOwner: string; direct: boolean }>> = {};
  for (const name of dependencyNames) {
    if (name in rootDeps) throw new Error(`retired dependency ${name} is directly owned by the root manifest`);
    if (name in lockRootDeps) throw new Error(`retired dependency ${name} is root-owned in the lockfile`);
    const lockOwners = new Map<string, string>();
    for (const [key, meta] of Object.entries(packages)) {
      if (key === "" || !key.startsWith("node_modules/")) continue;
      const deps = { ...meta?.dependencies, ...meta?.devDependencies };
      if (name in deps) lockOwners.set(climbToRootOwner(packages, lockRootDeps, key), key);
    }
    const installedOwners = new Map<string, string>();
    for (const [pkgName, meta] of installed) {
      if (pkgName === name) continue;
      if (name in meta.dependencies) {
        installedOwners.set(climbToRootOwner(packages, lockRootDeps, `node_modules/${meta.path}`), pkgName);
      }
    }
    for (const [owner, key] of lockOwners) {
      if (!installedOwners.has(owner))
        throw new Error(`lockfile edge for ${name} has no matching installed owner: ${key}`);
    }
    for (const [owner, pkgName] of installedOwners) {
      if (!lockOwners.has(owner))
        throw new Error(`installed edge for ${name} has no matching lockfile edge: ${pkgName}`);
    }
    if (name === "ws") {
      const rows = [...lockOwners.keys()].sort().map((owner) => ({ topLevelOwner: owner, direct: false }));
      for (const row of rows) {
        if (!APPROVED_WS_OWNERS.includes(row.topLevelOwner)) {
          throw new Error(`transitive ws owner ${row.topLevelOwner} is not approved`);
        }
      }
      result.ws = rows;
    } else if (lockOwners.size > 0 || installedOwners.size > 0) {
      throw new Error(`retired dependency ${name} has resolved owners in the installed graph`);
    }
  }
  return result;
}

export function validatePublishedArtifactDependencyBoundary(input: {
  artifacts: Array<{ path: string; text: string }>;
}): void {
  for (const artifact of input.artifacts) {
    for (const dependency of RETIRED_ROOT_DEPENDENCIES) {
      // Bundled artifacts may legitimately contain a retired package's name as
      // a string literal (e.g. a LinkedIn action named "react"); require an
      // actual module reference form before flagging.
      if (referencesDependency(artifact.text, dependency)) {
        throw new Error(`retired dependency ${dependency} referenced in published artifact ${artifact.path}`);
      }
    }
  }
}
