import { copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mutation, root] = process.argv.slice(2);
if (!mutation || !root) throw new Error("usage: mutate-candidate.mjs <mutation> <root>");
const path = (name) => join(root, name);

switch (mutation) {
  case "missing-exe":
    rmSync(path("Frondose.nsis.exe"));
    break;
  case "missing-exe-sig":
    rmSync(path("Frondose.nsis.exe.sig"));
    break;
  case "renamed-exe":
    renameSync(path("Frondose.nsis.exe"), path("Frondose-renamed.nsis.exe"));
    break;
  case "renamed-exe-sig":
    renameSync(path("Frondose.nsis.exe.sig"), path("Frondose-renamed.nsis.exe.sig"));
    break;
  case "substituted-exe":
    writeFileSync(path("Frondose.nsis.exe"), "different installer bytes\n");
    break;
  case "foreign-exe-sig":
    copyFileSync(path("Frondose.app.tar.gz.sig"), path("Frondose.nsis.exe.sig"));
    break;
  case "foreign-mac-sig":
    copyFileSync(path("Frondose.nsis.exe.sig"), path("Frondose.app.tar.gz.sig"));
    break;
  case "stale-latest-url": {
    const latest = JSON.parse(readFileSync(path("latest.json"), "utf8"));
    latest.platforms["windows-x86_64"].url =
      "https://github.com/kyoubelyu/frondose/releases/latest/download/Frondose-old.nsis.exe";
    writeFileSync(path("latest.json"), JSON.stringify(latest));
    break;
  }
  case "wrong-latest-signature": {
    const latest = JSON.parse(readFileSync(path("latest.json"), "utf8"));
    latest.platforms["windows-x86_64"].signature = "signature-for-other-bytes";
    writeFileSync(path("latest.json"), JSON.stringify(latest));
    break;
  }
  case "missing-checksum": {
    const lines = readFileSync(path("SHA256SUMS"), "utf8").split("\n");
    writeFileSync(path("SHA256SUMS"), `${lines.filter((line) => !line.endsWith("  Frondose.nsis.exe")).join("\n")}`);
    break;
  }
  case "missing-provenance": {
    const provenance = JSON.parse(readFileSync(path("provenance.json"), "utf8"));
    provenance.subject = provenance.subject.filter((subject) => subject.name !== "Frondose.nsis.exe");
    writeFileSync(path("provenance.json"), JSON.stringify(provenance));
    break;
  }
  case "missing-sbom":
    rmSync(path("sbom.cdx.json"));
    break;
  case "zip-reintroduced":
    writeFileSync(path("Frondose.nsis.zip"), readFileSync(path("Frondose.nsis.exe")));
    break;
  default:
    throw new Error(`unknown mutation: ${mutation}`);
}
