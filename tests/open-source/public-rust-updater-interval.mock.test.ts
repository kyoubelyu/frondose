import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

const REPO = process.cwd();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});

function extractRustFunction(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}`);
  assert.ok(start >= 0, `${name} must remain discoverable`);
  const open = source.indexOf("{", start);
  assert.ok(open > start, `${name} must have a body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} body must be brace-balanced`);
}

describe("the compiled updater interval reader ignores retired config", () => {
  it("T-NUIF.1/2/3/4/6: the extracted production reader executes the retired-state and retained-value matrix", async () => {
    // Given the real Rust home and interval functions, when compiled against isolated current/retired fixtures, then only current config controls the interval.
    const updater = await readFile(join(REPO, "src/tauri/src-tauri/src/updater.rs"), "utf8");
    const homeReader = extractRustFunction(updater, "config_home_dir");
    const intervalReader = extractRustFunction(updater, "read_update_check_interval_sec").replace(
      "pub(crate) fn read_update_check_interval_sec",
      "pub fn read_update_check_interval_sec",
    );
    const directory = await mkdtemp(join(tmpdir(), "frondose-rust-updater-interval-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "src"));
    const cargoLock = await readFile(join(REPO, "src/tauri/src-tauri/Cargo.lock"), "utf8");
    const serdeJsonVersion = cargoLock.match(/\[\[package\]\]\nname = "serde_json"\nversion = "([^"]+)"/)?.[1];
    assert.ok(serdeJsonVersion, "the App lockfile must pin serde_json");
    await writeFile(
      join(directory, "Cargo.toml"),
      `[package]\nname="updater-interval-contract"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nserde_json="=${serdeJsonVersion}"\n`,
      "utf8",
    );
    await writeFile(
      join(directory, "src", "lib.rs"),
      `use serde_json::Value;
${homeReader}
${intervalReader}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct EnvGuard {
        home: Option<std::ffi::OsString>,
        userprofile: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(home: Option<&std::path::Path>, userprofile: Option<&std::path::Path>) -> Self {
            let guard = Self {
                home: std::env::var_os("HOME"),
                userprofile: std::env::var_os("USERPROFILE"),
            };
            match home {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
            match userprofile {
                Some(value) => std::env::set_var("USERPROFILE", value),
                None => std::env::remove_var("USERPROFILE"),
            }
            guard
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.home {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
            match &self.userprofile {
                Some(value) => std::env::set_var("USERPROFILE", value),
                None => std::env::remove_var("USERPROFILE"),
            }
        }
    }

    fn case_home(name: &str) -> std::path::PathBuf {
        let home = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("cases").join(name);
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".frondose/agent")).unwrap();
        home
    }

    fn write_current(home: &std::path::Path, raw: &str) {
        fs::write(home.join(".frondose/agent/config.json"), raw).unwrap();
    }

    fn write_retired(home: &std::path::Path, raw: &str) {
        fs::create_dir_all(home.join(".mai/agent")).unwrap();
        fs::write(home.join(".mai/agent/config.json"), raw).unwrap();
    }

    fn assert_current(name: &str, raw: &str, expected: u64) {
        let home = case_home(name);
        let _env = EnvGuard::set(Some(&home), None);
        write_current(&home, raw);
        let before = fs::read(home.join(".frondose/agent/config.json")).unwrap();
        assert_eq!(read_update_check_interval_sec(), expected, "{}", name);
        assert_eq!(fs::read(home.join(".frondose/agent/config.json")).unwrap(), before, "{} bytes", name);
    }

    // Given missing current config and hostile retired zero, when read, then the default wins without mutation.
    #[test]
    fn missing_current_ignores_retired_zero() {
        let home = case_home("missing-retired-zero");
        let _env = EnvGuard::set(Some(&home), None);
        let retired = r#"{"updateCheckIntervalSec":0}"#;
        write_retired(&home, retired);
        assert_eq!(read_update_check_interval_sec(), 3600);
        assert_eq!(fs::read_to_string(home.join(".mai/agent/config.json")).unwrap(), retired);
    }

    // Given unreadable current config and hostile retired 7200, when read, then the default wins without mutation.
    #[test]
    fn unreadable_current_ignores_retired_large_value() {
        let home = case_home("unreadable-retired-large");
        let _env = EnvGuard::set(Some(&home), None);
        fs::create_dir(home.join(".frondose/agent/config.json")).unwrap();
        let retired = r#"{"updateCheckIntervalSec":7200}"#;
        write_retired(&home, retired);
        assert_eq!(read_update_check_interval_sec(), 3600);
        assert_eq!(fs::read_to_string(home.join(".mai/agent/config.json")).unwrap(), retired);
    }

    // Given invalid or absent current values, when read, then each returns the built-in default without mutation.
    #[test]
    fn invalid_or_absent_values_use_default() {
        for (name, raw) in [
            ("malformed", "{"),
            ("missing-key", r#"{"schema_version":2}"#),
            ("null", r#"{"updateCheckIntervalSec":null}"#),
            ("string", r#"{"updateCheckIntervalSec":"60"}"#),
            ("negative", r#"{"updateCheckIntervalSec":-1}"#),
            ("fractional", r#"{"updateCheckIntervalSec":60.5}"#),
            ("u64-overflow", r#"{"updateCheckIntervalSec":18446744073709551616}"#),
        ] {
            assert_current(name, raw, 3600);
        }
    }

    // Given valid u64 boundary values, when read, then disable, floor, and exact semantics remain unchanged.
    #[test]
    fn numeric_values_preserve_disable_floor_and_exact_semantics() {
        for (name, raw, expected) in [
            ("zero", r#"{"updateCheckIntervalSec":0}"#, 0_u64),
            ("one", r#"{"updateCheckIntervalSec":1}"#, 60),
            ("fifty-nine", r#"{"updateCheckIntervalSec":59}"#, 60),
            ("sixty", r#"{"updateCheckIntervalSec":60}"#, 60),
            ("sixty-one", r#"{"updateCheckIntervalSec":61}"#, 61),
            ("u64-max", r#"{"updateCheckIntervalSec":18446744073709551615}"#, u64::MAX),
        ] {
            assert_current(name, raw, expected);
        }
    }

    // Given competing HOME and USERPROFILE states, when read, then precedence, fallback, and default behavior are exact.
    #[test]
    fn home_and_userprofile_selection_is_behavioral() {
        let home = case_home("home-precedence");
        let profile = case_home("profile-precedence");
        write_current(&home, r#"{"updateCheckIntervalSec":61}"#);
        write_current(&profile, r#"{"updateCheckIntervalSec":7200}"#);
        let home_before = fs::read(home.join(".frondose/agent/config.json")).unwrap();
        let profile_before = fs::read(profile.join(".frondose/agent/config.json")).unwrap();
        {
            let _env = EnvGuard::set(Some(&home), Some(&profile));
            assert_eq!(read_update_check_interval_sec(), 61);
        }
        {
            let _env = EnvGuard::set(None, Some(&profile));
            assert_eq!(read_update_check_interval_sec(), 7200);
        }
        {
            let _env = EnvGuard::set(Some(std::path::Path::new("  ")), Some(&profile));
            assert_eq!(read_update_check_interval_sec(), 7200);
        }
        {
            let _env = EnvGuard::set(None, None);
            assert_eq!(read_update_check_interval_sec(), 3600);
        }
        {
            let blank = std::path::Path::new("  ");
            let _env = EnvGuard::set(Some(blank), Some(blank));
            assert_eq!(read_update_check_interval_sec(), 3600);
        }
        assert_eq!(fs::read(home.join(".frondose/agent/config.json")).unwrap(), home_before);
        assert_eq!(fs::read(profile.join(".frondose/agent/config.json")).unwrap(), profile_before);
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
    assert.match(result.stdout, /5 passed/);
  });

  it("T-NUIF.5: the interval reader has no retired path and remains wired through the scheduler", async () => {
    // Given production Rust source, when the interval seam is isolated, then it has no retired fallback while main still consumes it as a Duration.
    const updater = await readFile(join(REPO, "src/tauri/src-tauri/src/updater.rs"), "utf8");
    const main = await readFile(join(REPO, "src/tauri/src-tauri/src/main.rs"), "utf8");
    const intervalReader = extractRustFunction(updater, "read_update_check_interval_sec");
    assert.ok(intervalReader.includes("config_home_dir"));
    assert.ok(!intervalReader.includes(".mai/agent/config.json"));
    assert.ok(!intervalReader.includes(".or_else"));
    assert.match(main, /Duration::from_secs\(read_update_check_interval_sec\(\)\)/);
  });
});
