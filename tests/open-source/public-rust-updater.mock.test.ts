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

describe("the actual Rust updater resolver preserves explicit nonblank overrides", () => {
  it("T-NURM.2/3: the production resolver body executes the complete default, disable and override matrix", async () => {
    // Given the exact resolver functions extracted from updater.rs, when compiled and executed, then default/disable/override behavior matches TypeScript.
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
    fn legacy() -> String { format!("http://{}:4875", ["192","0","2","105"].join(".")) }

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
        if let Some(expected_bytes) = raw.as_deref() {
            assert_eq!(fs::read_to_string(home.join(".frondose/agent/config.json")).unwrap(), expected_bytes, "{} bytes", name);
        }
        let _ = fs::remove_dir_all(home);
    }

    fn write_retired_config(home: &std::path::Path, raw: &str) {
        fs::create_dir_all(home.join(".mai/agent")).unwrap();
        fs::write(home.join(".mai/agent/config.json"), raw).unwrap();
    }

    #[test] fn missing_uses_public() { assert_case("missing", None, Some(PUBLIC)); }
    #[test] fn missing_key_uses_public() { assert_case("missing_key", Some(r#"{"schema_version":2}"#.to_string()), Some(PUBLIC)); }
    #[test] fn malformed_uses_public() { assert_case("malformed", Some("{".to_string()), Some(PUBLIC)); }
    #[test] fn non_string_uses_public() { assert_case("non_string", Some(r#"{"updateServerUrl":7}"#.to_string()), Some(PUBLIC)); }
    #[test] fn legacy_stays_legacy() {
        let legacy = legacy();
        assert_case("legacy", Some(format!(r#"{{"updateServerUrl":"{}"}}"#, legacy)), Some(legacy.as_str()));
    }
    #[test] fn null_disables() { assert_case("null", Some(r#"{"updateServerUrl":null}"#.to_string()), None); }
    #[test] fn blank_disables() { assert_case("blank", Some(r#"{"updateServerUrl":"  "}"#.to_string()), None); }
    #[test] fn public_stays_public() { assert_case("public", Some(format!(r#"{{"updateServerUrl":"{}"}}"#, PUBLIC)), Some(PUBLIC)); }
    #[test] fn custom_stays_custom() { assert_case("custom", Some(r#"{"updateServerUrl":"https://updates.example.com"}"#.to_string()), Some("https://updates.example.com")); }
    #[test] fn wrapped_legacy_is_trimmed() {
        let legacy = legacy();
        assert_case("wrapped_legacy", Some(format!(r#"{{"updateServerUrl":"  {}  "}}"#, legacy)), Some(legacy.as_str()));
    }
    #[test] fn wrapped_custom_is_trimmed() { assert_case("wrapped_custom", Some(r#"{"updateServerUrl":"  https://updates.example.com/path  "}"#.to_string()), Some("https://updates.example.com/path")); }
    #[test] fn opaque_stays_opaque() { assert_case("opaque", Some(r#"{"updateServerUrl":"operator-channel"}"#.to_string()), Some("operator-channel")); }
    #[test] fn wrapped_opaque_is_trimmed() { assert_case("wrapped_opaque", Some(r#"{"updateServerUrl":"  operator-channel  "}"#.to_string()), Some("operator-channel")); }
    #[test] fn missing_ignores_retired_config() {
        let home = write_case("missing_retired", None);
        let retired = r#"{"updateServerUrl":"https://retired.example.com"}"#;
        write_retired_config(&home, retired);
        assert_eq!(read_update_server_url().as_deref(), Some(PUBLIC));
        assert_eq!(fs::read_to_string(home.join(".mai/agent/config.json")).unwrap(), retired);
        let _ = fs::remove_dir_all(home);
    }
    #[test] fn unreadable_ignores_retired_config() {
        let home = write_case("unreadable_retired", None);
        fs::create_dir_all(home.join(".frondose/agent/config.json")).unwrap();
        let retired = r#"{"updateServerUrl":"https://retired.example.com"}"#;
        write_retired_config(&home, retired);
        assert_eq!(read_update_server_url().as_deref(), Some(PUBLIC));
        assert_eq!(fs::read_to_string(home.join(".mai/agent/config.json")).unwrap(), retired);
        let _ = fs::remove_dir_all(home);
    }
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
    assert.match(result.stdout, /15 passed/);
  });
});
