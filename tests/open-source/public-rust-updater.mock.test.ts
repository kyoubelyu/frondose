import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

const REPO = process.cwd();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("the actual Rust updater resolver migrates only the historical default", () => {
  it("T-OS.Update.Rust.1: the production resolver body executes all eight public migration branches", async () => {
    // Given the exact resolver functions extracted from updater.rs, when compiled and executed, then default/migration/disable/custom behavior matches TS.
    const updater = await readFile(join(REPO, "src/tauri/src-tauri/src/updater.rs"), "utf8");
    const start = updater.indexOf("const DEFAULT_UPDATE_SERVER_URL");
    const end = updater.indexOf("/// P-58d.3", start);
    assert.ok(start > 0 && end > start, "actual Rust updater resolver seam must remain discoverable");
    const resolver = updater
      .slice(start, end)
      .replace("pub(crate) fn read_update_server_url", "pub fn read_update_server_url");
    const directory = await mkdtemp(join(tmpdir(), "frondose-rust-updater-contract-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "src"));
    await writeFile(
      join(directory, "Cargo.toml"),
      '[package]\nname="updater-contract"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nserde_json="1"\n',
      "utf8",
    );
    await writeFile(
      join(directory, "src", "lib.rs"),
      `use serde_json::Value;
${resolver}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PUBLIC: &str = "https://github.com/kyoubelyu/frondose/releases/latest/download";
    const LEGACY: &str = "http://192.0.2.105:4875";

    fn write_case(name: &str, raw: Option<&str>) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!("frondose-updater-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".frondose/agent")).unwrap();
        if let Some(bytes) = raw {
            fs::write(home.join(".frondose/agent/config.json"), bytes).unwrap();
        }
        std::env::set_var("HOME", &home);
        std::env::remove_var("USERPROFILE");
        home
    }

    fn assert_case(name: &str, raw: Option<String>, expected: Option<&str>) {
        let home = write_case(name, raw.as_deref());
        assert_eq!(read_update_server_url().as_deref(), expected, "{}", name);
        let _ = fs::remove_dir_all(home);
    }

    #[test] fn missing_uses_public() { assert_case("missing", None, Some(PUBLIC)); }
    #[test] fn malformed_uses_public() { assert_case("malformed", Some("{".to_string()), Some(PUBLIC)); }
    #[test] fn non_string_uses_public() { assert_case("non_string", Some(r#"{"updateServerUrl":7}"#.to_string()), Some(PUBLIC)); }
    #[test] fn legacy_migrates_public() { assert_case("legacy", Some(format!(r#"{{"updateServerUrl":"{}"}}"#, LEGACY)), Some(PUBLIC)); }
    #[test] fn null_disables() { assert_case("null", Some(r#"{"updateServerUrl":null}"#.to_string()), None); }
    #[test] fn blank_disables() { assert_case("blank", Some(r#"{"updateServerUrl":"  "}"#.to_string()), None); }
    #[test] fn public_stays_public() { assert_case("public", Some(format!(r#"{{"updateServerUrl":"{}"}}"#, PUBLIC)), Some(PUBLIC)); }
    #[test] fn custom_stays_custom() { assert_case("custom", Some(r#"{"updateServerUrl":"https://updates.example.com"}"#.to_string()), Some("https://updates.example.com")); }
}
`,
      "utf8",
    );
    const result = spawnSync("cargo", ["test", "--offline", "--quiet", "--", "--test-threads=1"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, CARGO_TARGET_DIR: join(directory, "target") },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /8 passed/);
  });
});
