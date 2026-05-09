import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PackageJson {
  version: string;
}

export function runVersionSubcommand(): void {
  // package.json (mai-agent root)
  const pkg = require("../../../package.json") as PackageJson;
  // node_modules/ai/package.json (Vercel AI SDK)
  let aiVersion = "(unknown)";
  try {
    const aiPkg = require("ai/package.json") as PackageJson;
    aiVersion = aiPkg.version;
  } catch {
    // ai/package.json may not be require()-able under Node16 ESM resolution; tolerate.
  }
  process.stdout.write(`mai-agent ${pkg.version}\n`);
  process.stdout.write(`Node.js    ${process.version}\n`);
  process.stdout.write(`Vercel AI  ${aiVersion}\n`);
}
