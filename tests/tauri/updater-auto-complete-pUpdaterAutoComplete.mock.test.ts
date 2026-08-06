/**
 * P-UPDATER-AUTO-COMPLETE — Step-2 RED contract.
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/tauri/updater-auto-complete-pUpdaterAutoComplete.mock.test.ts
 *
 * Pre-build RED:
 * - main.rs has two Ready waiters but only one notify_one permit;
 * - no durable update-notice backend/command exists;
 * - no FE update-completion helper exists.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { setLocale } from "../../src/tauri/ui/i18n.js";
import {
  braceDepthAt,
  createPersistedChineseActions,
  extractBraceBlock,
  extractParenCall,
  extractRustFunction,
  loadUpdateCompletion,
  runCargoHarness,
  runNoticeProcess,
  stripRustComments,
  waitForReadyFiles,
} from "./updater-auto-complete-pUpdaterAutoComplete.helpers.js";

const mainSource = readFileSync(resolve("src/tauri/src-tauri/src/main.rs"), "utf8");
const commandsSource = readFileSync(resolve("src/tauri/src-tauri/src/commands.rs"), "utf8");
const updateNoticePath = resolve("src/tauri/src-tauri/src/update_notice.rs");
const updateSchedulerPath = resolve("src/tauri/src-tauri/src/update_scheduler.rs");
const rustHarnessRoot = mkdtempSync(resolve(tmpdir(), "frondose-updater-contract-"));

after(() => rmSync(rustHarnessRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

function runSchedulerRust(filter: string): string {
  assert.ok(existsSync(updateSchedulerPath), "real update_scheduler.rs seam must exist");
  const cargoToml = `[package]
name = "frondose-update-scheduler-contract"
version = "0.0.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["macros", "rt-multi-thread", "sync", "time"] }
`;
  const mainRs = `#[path = ${JSON.stringify(updateSchedulerPath)}]
mod update_scheduler;

#[cfg(test)]
mod tests {
    use super::update_scheduler::run_update_scheduler;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    use std::time::Duration;
    use tokio::sync::{Notify, mpsc};
    use tokio::time::timeout;

    #[tokio::test]
    async fn stored_ready_permit_runs_one_boot_check_even_when_periodic_is_disabled() {
        let ready = Arc::new(Notify::new());
        ready.notify_one();
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = hits.clone();
        timeout(
            Duration::from_millis(500),
            run_update_scheduler(ready, || Duration::ZERO, move || {
                let seen = seen.clone();
                async move { seen.fetch_add(1, Ordering::SeqCst); }
            }),
        ).await.expect("zero interval scheduler must exit");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ready_runs_immediately_then_the_same_owner_runs_periodic_ticks() {
        let ready = Arc::new(Notify::new());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run_update_scheduler(
            ready.clone(),
            || Duration::from_millis(25),
            move || {
            let tx = tx.clone();
            async move { tx.send(()).expect("receiver alive"); }
        }));
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err(),
            "no updater check may run before Ready");
        ready.notify_one();
        timeout(Duration::from_millis(500), rx.recv()).await
            .expect("boot check must be immediate").expect("sender alive");
        assert!(
            timeout(Duration::from_millis(10), rx.recv()).await.is_err(),
            "the periodic check must not run before its injected cadence"
        );
        timeout(Duration::from_millis(500), rx.recv()).await
            .expect("periodic check must follow").expect("sender alive");
        task.abort();
    }
}

fn main() {}
`;
  return runCargoHarness(rustHarnessRoot, "scheduler", cargoToml, mainRs, filter);
}

function noticeHarness(): { cargoToml: string; mainRs: string } {
  assert.ok(existsSync(updateNoticePath), "real update_notice.rs seam must exist");
  const cargoToml = `[package]
name = "frondose-update-notice-contract"
version = "0.0.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
semver = "1"
dirs = "6"
`;
  const mainRs = `#[path = ${JSON.stringify(updateNoticePath)}]
mod update_notice;

#[cfg(test)]
mod tests {
    use super::update_notice::{
        prepare_update_notice_at, prepare_update_notice_at_with_fault,
        prepare_update_notice,
        read_update_state_at,
        take_update_notice_at, take_update_notice_at_with_fault,
        take_update_notice_response, take_update_notice_response_at,
        CommitFault, TakeFault,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn case_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!(
            "frondose-update-notice-{}-{}-{}", std::process::id(), label, nonce
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn valid_slot_count(dir: &PathBuf) -> usize {
        [0, 1].into_iter().filter(|slot| {
            let path = dir.join(format!("update-state.{}.json", slot));
            fs::read(path).ok()
                .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
                .filter(|v| {
                    v.get("schemaVersion").and_then(|n| n.as_u64()) == Some(1)
                        && v.get("generation").and_then(|n| n.as_u64()).is_some()
                        && v.get("lastLaunchedVersion").and_then(|s| s.as_str()).is_some()
                        && v.get("pendingNotice").is_some_and(|pending| {
                            pending.is_null()
                                || (pending.get("id").and_then(|s| s.as_str()).is_some()
                                    && pending.get("version").and_then(|s| s.as_str()).is_some()
                                    && pending.get("fromVersion").is_some())
                        })
                })
                .is_some()
        }).count()
    }

    fn physical_slots(dir: &PathBuf) -> [Option<serde_json::Value>; 2] {
        std::array::from_fn(|slot| {
            fs::read(dir.join(format!("update-state.{}.json", slot))).ok()
                .and_then(|raw| serde_json::from_slice(&raw).ok())
        })
    }

    fn slot_generation(slot: &Option<serde_json::Value>) -> Option<u64> {
        slot.as_ref()?.get("generation")?.as_u64()
    }

    fn temp_files(dir: &PathBuf) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with("update-state.") && name.ends_with(".tmp"))
            .collect();
        names.sort();
        names
    }

    fn write_slot(
        dir: &PathBuf,
        slot: usize,
        schema: u64,
        generation: u64,
        last: &str,
        pending: serde_json::Value,
    ) {
        let value = serde_json::json!({
            "schemaVersion": schema,
            "generation": generation,
            "lastLaunchedVersion": last,
            "pendingNotice": pending,
        });
        fs::write(
            dir.join(format!("update-state.{}.json", slot)),
            serde_json::to_vec(&value).unwrap(),
        ).unwrap();
    }

    #[test]
    fn forward_transition_creates_and_consumes_the_exact_notice() {
        let dir = case_dir("forward");
        prepare_update_notice_at(&dir, "0.5.15").unwrap();
        assert!(take_update_notice_at(&dir, "0.5.15").unwrap().is_none());
        prepare_update_notice_at(&dir, "0.5.16").unwrap();
        let notice = take_update_notice_at(&dir, "0.5.16").unwrap().expect("notice");
        assert_eq!(notice.from_version.as_deref(), Some("0.5.15"));
        assert_eq!(notice.version, "0.5.16");
        assert!(take_update_notice_at(&dir, "0.5.16").unwrap().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn classification_distinguishes_fresh_legacy_malformed_downgrade_and_later_missing() {
        let empty = case_dir("empty");
        prepare_update_notice_at(&empty, "0.5.16").unwrap();
        assert!(take_update_notice_at(&empty, "0.5.16").unwrap().is_none());

        let profile = case_dir("profile");
        fs::create_dir_all(profile.join("chrome-profile")).unwrap();
        prepare_update_notice_at(&profile, "0.5.16").unwrap();
        assert!(take_update_notice_at(&profile, "0.5.16").unwrap().is_none());

        let legacy = case_dir("legacy");
        fs::create_dir_all(legacy.join("logs")).unwrap();
        fs::write(legacy.join("logs/sidecar.log"), "old launch").unwrap();
        prepare_update_notice_at(&legacy, "0.5.16").unwrap();
        let bridged = take_update_notice_at(&legacy, "0.5.16").unwrap().expect("legacy bridge");
        assert_eq!(bridged.from_version, None);

        let malformed = case_dir("malformed");
        fs::write(malformed.join("update-state.0.json"), "{broken").unwrap();
        fs::write(malformed.join("update-state.1.json"), "[]").unwrap();
        prepare_update_notice_at(&malformed, "0.5.16").unwrap();
        assert!(take_update_notice_at(&malformed, "0.5.16").unwrap().is_none());

        let later = case_dir("later");
        fs::create_dir_all(later.join("logs")).unwrap();
        prepare_update_notice_at(&later, "0.5.17").unwrap();
        assert!(take_update_notice_at(&later, "0.5.17").unwrap().is_none());

        let downgrade = case_dir("downgrade");
        prepare_update_notice_at(&downgrade, "0.5.17").unwrap();
        prepare_update_notice_at(&downgrade, "0.5.16").unwrap();
        assert!(take_update_notice_at(&downgrade, "0.5.16").unwrap().is_none());

        for path in [empty, profile, legacy, malformed, later, downgrade] {
            fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn semver_target_and_slot_selection_reject_false_successes() {
        let numeric = case_dir("numeric");
        prepare_update_notice_at(&numeric, "0.5.9").unwrap();
        prepare_update_notice_at(&numeric, "0.5.10").unwrap();
        assert_eq!(
            take_update_notice_at(&numeric, "0.5.10").unwrap().unwrap().version,
            "0.5.10"
        );

        let prerelease = case_dir("prerelease");
        prepare_update_notice_at(&prerelease, "0.5.16-beta.1").unwrap();
        prepare_update_notice_at(&prerelease, "0.5.16").unwrap();
        assert!(take_update_notice_at(&prerelease, "0.5.16").unwrap().is_some());

        let invalid = case_dir("invalid");
        prepare_update_notice_at(&invalid, "not-semver").unwrap();
        prepare_update_notice_at(&invalid, "0.5.16").unwrap();
        assert!(take_update_notice_at(&invalid, "0.5.16").unwrap().is_none());
        prepare_update_notice_at(&invalid, "still-invalid").unwrap();
        assert!(take_update_notice_at(&invalid, "still-invalid").unwrap().is_none());

        let stale = case_dir("stale");
        prepare_update_notice_at(&stale, "0.5.15").unwrap();
        prepare_update_notice_at(&stale, "0.5.16").unwrap();
        assert!(take_update_notice_at(&stale, "0.5.17").unwrap().is_none());
        let still_valid = take_update_notice_at(&stale, "0.5.16").unwrap()
            .expect("stale consumer must not destroy the target-bound notice");
        assert_eq!(still_valid.id, "0.5.15-to-0.5.16");
        assert_eq!(still_valid.from_version.as_deref(), Some("0.5.15"));
        assert_eq!(still_valid.version, "0.5.16");
        assert!(take_update_notice_at(&stale, "0.5.16").unwrap().is_none());

        let slots = case_dir("slots");
        write_slot(&slots, 0, 1, 4, "0.5.14", serde_json::Value::Null);
        fs::write(slots.join("update-state.1.json"), "{broken").unwrap();
        assert_eq!(
            read_update_state_at(&slots).unwrap().unwrap().last_launched_version,
            "0.5.14"
        );
        write_slot(&slots, 1, 1, 7, "0.5.15", serde_json::Value::Null);
        assert_eq!(
            read_update_state_at(&slots).unwrap().unwrap().generation,
            7
        );

        let unsupported = case_dir("unsupported");
        write_slot(&unsupported, 0, 99, 10, "0.5.15", serde_json::Value::Null);
        prepare_update_notice_at(&unsupported, "0.5.16").unwrap();
        assert!(take_update_notice_at(&unsupported, "0.5.16").unwrap().is_none());

        for path in [numeric, prerelease, invalid, stale, slots, unsupported] {
            fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn same_version_preserves_pending_and_thread_take_has_one_winner() {
        let dir = case_dir("concurrent");
        prepare_update_notice_at(&dir, "0.5.15").unwrap();
        prepare_update_notice_at(&dir, "0.5.16").unwrap();
        prepare_update_notice_at(&dir, "0.5.16").unwrap();
        let shared = Arc::new(dir.clone());
        let barrier = Arc::new(Barrier::new(8));
        let mut threads = Vec::new();
        for _ in 0..8 {
            let path = shared.clone();
            let gate = barrier.clone();
            threads.push(std::thread::spawn(move || {
                gate.wait();
                take_update_notice_at(path.as_path(), "0.5.16").unwrap().is_some()
            }));
        }
        let winners: usize = threads
            .into_iter()
            .map(|thread| usize::from(thread.join().unwrap()))
            .sum();
        assert_eq!(winners, 1);
        assert!(take_update_notice_at(&dir, "0.5.16").unwrap().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn journal_faults_preserve_the_expected_authoritative_generation() {
        for (fault, after_rename) in [
            (CommitFault::AfterTempWrite, false),
            (CommitFault::AfterTempSync, false),
            (CommitFault::AfterInactiveRemove, false),
            (CommitFault::AfterRename, true),
        ] {
            let dir = case_dir("commit-fault");
            prepare_update_notice_at(&dir, "0.5.14").unwrap();
            prepare_update_notice_at(&dir, "0.5.15").unwrap();
            assert!(take_update_notice_at(&dir, "0.5.15").unwrap().is_some());
            assert_eq!(valid_slot_count(&dir), 2, "baseline must contain two complete slots");
            let physical_before = physical_slots(&dir);
            let before = read_update_state_at(&dir).unwrap().unwrap();
            assert_eq!(before.generation, 3);
            assert_eq!(before.last_launched_version, "0.5.15");
            assert!(before.pending_notice.is_none());
            let active_slot = if slot_generation(&physical_before[0]) > slot_generation(&physical_before[1]) {
                0
            } else {
                1
            };
            let inactive_slot = 1 - active_slot;
            assert_eq!(slot_generation(&physical_before[active_slot]), Some(3));
            assert_eq!(slot_generation(&physical_before[inactive_slot]), Some(2));
            assert_eq!(
                physical_before[active_slot],
                Some(serde_json::json!({
                    "schemaVersion": 1,
                    "generation": 3,
                    "lastLaunchedVersion": "0.5.15",
                    "pendingNotice": null,
                }))
            );
            assert_eq!(
                physical_before[inactive_slot],
                Some(serde_json::json!({
                    "schemaVersion": 1,
                    "generation": 2,
                    "lastLaunchedVersion": "0.5.15",
                    "pendingNotice": {
                        "id": "0.5.14-to-0.5.15",
                        "fromVersion": "0.5.14",
                        "version": "0.5.15",
                    },
                }))
            );
            assert!(prepare_update_notice_at_with_fault(&dir, "0.5.16", fault).is_err());
            let physical_after = physical_slots(&dir);
            let after = read_update_state_at(&dir).unwrap().unwrap();
            assert_eq!(
                physical_after[active_slot],
                physical_before[active_slot],
                "the previous active envelope must never be rewritten"
            );
            if after_rename {
                assert_eq!(
                    physical_after[inactive_slot],
                    Some(serde_json::json!({
                        "schemaVersion": 1,
                        "generation": 4,
                        "lastLaunchedVersion": "0.5.16",
                        "pendingNotice": {
                            "id": "0.5.15-to-0.5.16",
                            "fromVersion": "0.5.15",
                            "version": "0.5.16",
                        },
                    }))
                );
                assert_eq!(valid_slot_count(&dir), 2);
                assert!(temp_files(&dir).is_empty(), "rename must consume the unique temp");
                assert_eq!(after.generation, before.generation + 1);
                assert_eq!(after.last_launched_version, "0.5.16");
                assert_eq!(after.pending_notice.as_ref().unwrap().version, "0.5.16");
            } else {
                if matches!(fault, CommitFault::AfterInactiveRemove) {
                    assert!(physical_after[inactive_slot].is_none());
                } else {
                    assert_eq!(physical_after[inactive_slot], physical_before[inactive_slot]);
                }
                assert_eq!(temp_files(&dir).len(), 1, "the reached pre-rename boundary must leave its temp artifact");
                assert_eq!(after.generation, before.generation);
                assert_eq!(after.last_launched_version, "0.5.15");
                assert!(after.pending_notice.is_none());
            }
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn claim_faults_leave_the_claim_and_expected_journal_state() {
        for fault in [TakeFault::AfterClaimCreate, TakeFault::AfterStateCommit] {
            let dir = case_dir("take-fault");
            prepare_update_notice_at(&dir, "0.5.15").unwrap();
            prepare_update_notice_at(&dir, "0.5.16").unwrap();
            let pending = read_update_state_at(&dir).unwrap().unwrap()
                .pending_notice.unwrap();
            assert_eq!(pending.id, "0.5.15-to-0.5.16");
            assert!(take_update_notice_at_with_fault(&dir, "0.5.16", fault).is_err());
            let claim_path = dir.join("update-notice-0.5.15-to-0.5.16.claim");
            assert!(fs::metadata(&claim_path).unwrap().is_file());
            let after = read_update_state_at(&dir).unwrap().unwrap();
            match fault {
                TakeFault::AfterClaimCreate => assert!(after.pending_notice.is_some()),
                TakeFault::AfterStateCommit => assert!(after.pending_notice.is_none()),
            }
            assert!(take_update_notice_at(&dir, "0.5.16").unwrap().is_none());
            prepare_update_notice_at(&dir, "0.5.16").unwrap();
            assert!(read_update_state_at(&dir).unwrap().unwrap().pending_notice.is_none());
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn command_response_seam_returns_the_exact_json_envelope() {
        let dir = case_dir("response");
        prepare_update_notice_at(&dir, "0.5.15").unwrap();
        prepare_update_notice_at(&dir, "0.5.16").unwrap();
        let response = take_update_notice_response_at(&dir, "0.5.16");
        assert_eq!(response["notice"]["fromVersion"], "0.5.15");
        assert_eq!(response["notice"]["version"], "0.5.16");
        assert!(take_update_notice_response_at(&dir, "0.5.16")["notice"].is_null());
        fs::remove_dir_all(dir).unwrap();

        let home = case_dir("production-wrapper-home");
        let prior_home = std::env::var_os("HOME");
        let prior_profile = std::env::var_os("USERPROFILE");
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        prepare_update_notice("0.5.15");
        prepare_update_notice("0.5.16");
        let agent = home.join(".frondose").join("agent");
        assert!(agent.join("update-state.0.json").exists()
            || agent.join("update-state.1.json").exists());
        let production_response = take_update_notice_response("0.5.16");
        assert_eq!(production_response["notice"]["fromVersion"], "0.5.15");
        assert_eq!(production_response["notice"]["version"], "0.5.16");
        assert!(take_update_notice_response("0.5.16")["notice"].is_null());
        match prior_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        match prior_profile {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }
        fs::remove_dir_all(home).unwrap();
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 { return; }
    let dir = std::path::Path::new(&args[2]);
    match args[1].as_str() {
        "prepare" => {
            update_notice::prepare_update_notice_at(dir, &args[3]).unwrap();
        }
        "take" => {
            if args.len() >= 6 {
                let barrier = std::path::Path::new(&args[4]);
                std::fs::create_dir_all(barrier).unwrap();
                std::fs::write(barrier.join(format!("ready-{}", args[5])), "").unwrap();
                while !barrier.join("release").exists() {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
            let result = update_notice::take_update_notice_at(dir, &args[3]).unwrap();
            println!("{}", if result.is_some() { "SOME" } else { "NONE" });
        }
        _ => panic!("unknown command"),
    }
}
`;
  return { cargoToml, mainRs };
}

function runNoticeRust(filter: string): string {
  const { cargoToml, mainRs } = noticeHarness();
  return runCargoHarness(rustHarnessRoot, "notice", cargoToml, mainRs, filter);
}

function buildNoticeBinary(): string {
  const { cargoToml, mainRs } = noticeHarness();
  const root = resolve(rustHarnessRoot, "notice");
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(resolve(root, "Cargo.toml"), cargoToml);
  writeFileSync(resolve(root, "src/main.rs"), mainRs);
  execFileSync("cargo", ["build", "--offline"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return resolve(root, "target/debug/frondose-update-notice-contract");
}

describe("startup updater scheduling — one Ready owner carries boot and periodic checks", () => {
  // Given a Ready permit stored before the task polls, when the real Rust scheduler runs with
  // interval zero, then it executes exactly one boot check and exits.
  it("T-UpAuto.1: stored Ready permit runs one boot check even when periodic polling is disabled", () => {
    const out = runSchedulerRust("stored_ready_permit_runs_one_boot_check_even_when_periodic_is_disabled");
    assert.match(out, /1 passed/);
  });

  // Given the real scheduler has no Ready permit, when Ready arrives, then no check occurs
  // before it, one check occurs immediately after it, and the same owner later ticks.
  it("T-UpAuto.2: Ready gates an immediate check before the first periodic tick", () => {
    const out = runSchedulerRust("ready_runs_immediately_then_the_same_owner_runs_periodic_ticks");
    assert.match(out, /1 passed/);
  });
});

describe("durable update completion — the real Rust journal is forward-only and at-most-once", () => {
  // Given a recorded 0.5.15 launch, when the real notice module prepares 0.5.16, then the exact
  // forward notice is returned once and never returned again.
  it("T-UpNotice.1: forward transition creates and consumes the exact notice", () => {
    const out = runNoticeRust("forward_transition_creates_and_consumes_the_exact_notice");
    assert.match(out, /1 passed/);
  });

  // Given profile-only, legacy, malformed, later-missing, and downgrade states, when the real
  // classifier prepares state, then only the launched legacy 0.5.15 case bridges to a notice.
  it("T-UpNotice.2: fresh, legacy, malformed, downgrade, and later-missing states stay distinct", () => {
    const out = runNoticeRust("classification_distinguishes_fresh_legacy_malformed_downgrade_and_later_missing");
    assert.match(out, /1 passed/);
  });

  // Given numeric, prerelease, invalid, stale-target, malformed-slot, unsupported-schema, and
  // competing-generation states, when the real module reads/prepares/takes, then semver and
  // highest-valid-generation rules prevent every false success.
  it("T-UpNotice.3: semver, target binding, and slot selection reject false success", () => {
    const out = runNoticeRust("semver_target_and_slot_selection_reject_false_successes");
    assert.match(out, /1 passed/);
  });

  // Given a pending notice survives one same-version prepare, when eight real consumers race,
  // then create-new claiming permits exactly one winner and no later duplicate.
  it("T-UpNotice.4: concurrent thread take has exactly one winner", () => {
    const out = runNoticeRust("same_version_preserves_pending_and_thread_take_has_one_winner");
    assert.match(out, /1 passed/);
  });

  // Given injected failures at every commit boundary, when authoritative state is inspected
  // immediately, then pre-rename faults preserve the prior generation and post-rename exposes new.
  it("T-UpNotice.5: journal boundaries preserve the specified authoritative generation", () => {
    const out = runNoticeRust("journal_faults_preserve_the_expected_authoritative_generation");
    assert.match(out, /1 passed/);
  });

  // Given a consumer faults after claim creation or state commit, when files are inspected,
  // then the claim exists and pending state matches the precise boundary before later cleanup.
  it("T-UpNotice.6: claim faults leave the expected tombstone and journal state", () => {
    const out = runNoticeRust("claim_faults_leave_the_claim_and_expected_journal_state");
    assert.match(out, /1 passed/);
  });

  // Given one pending notice and eight separate OS processes, when all execute the real take
  // binary concurrently, then create_new permits exactly one process to return SOME.
  it("T-UpNotice.7: concurrent process take has exactly one winner", async () => {
    assert.ok(existsSync(updateNoticePath), "real update_notice.rs seam must exist");
    const binary = buildNoticeBinary();
    const dir = mkdtempSync(resolve(tmpdir(), "frondose-update-notice-process-"));
    const barrier = resolve(dir, "barrier");
    try {
      execFileSync(binary, ["prepare", dir, "0.5.15"]);
      execFileSync(binary, ["prepare", dir, "0.5.16"]);
      const attempts = Array.from({ length: 8 }, (_, index) =>
        runNoticeProcess(binary, ["take", dir, "0.5.16", barrier, String(index)]),
      );
      await waitForReadyFiles(barrier, 8);
      writeFileSync(resolve(barrier, "release"), "");
      const results = await Promise.all(attempts);
      assert.equal(results.filter((result) => result === "SOME").length, 1);
      assert.equal(results.filter((result) => result === "NONE").length, 7);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  // Given a forward notice, when the real response formatter is executed, then it returns
  // the FE's exact JSON envelope once and a null envelope thereafter.
  it("T-UpNotice.8: command response seam returns the exact one-shot JSON", () => {
    const out = runNoticeRust("command_response_seam_returns_the_exact_json_envelope");
    assert.match(out, /1 passed/);
  });
});

describe("production composition — real scheduler, command, and boot order are reachable", () => {
  // Given the production main function, when its executable body is inspected without comments,
  // then notice preparation precedes sidecar provisioning and one Ready waiter reaches the real scheduler.
  it("T-UpWire.1: main prepares legacy evidence early and wires one Ready scheduler owner", () => {
    const body = extractRustFunction(mainSource, "main");
    assert.match(
      body,
      /^async fn main\s*\(\s*\)\s*\{\s*prepare_update_notice\s*\(\s*env!\(\s*"CARGO_PKG_VERSION"\s*\)\s*\)\s*;\s*let\s*\(\s*token\s*,\s*port_file\s*,\s*parent_dir\s*\)\s*=\s*provision_state\s*\(\s*\)/,
      "unconditional notice preparation must be main's first action before sidecar provisioning",
    );
    const mainWaiters = stripRustComments(mainSource).match(/\.notified\(\)\.await/g) ?? [];
    assert.equal(mainWaiters.length, 0, "main must not consume Ready before the scheduler helper");
    assert.ok(existsSync(updateSchedulerPath), "real scheduler module must exist");
    const schedulerSource = stripRustComments(readFileSync(updateSchedulerPath, "utf8"));
    const schedulerWaiters = schedulerSource.match(/\.notified\(\)\.await/g) ?? [];
    assert.equal(schedulerWaiters.length, 1, "the real scheduler must own the only Ready wait");
    const schedulerCalls = body.match(/\brun_update_scheduler\s*\(/g) ?? [];
    assert.equal(schedulerCalls.length, 1, "main must create exactly one runtime scheduler owner");
    const schedulerCall = extractParenCall(body, "run_update_scheduler");
    assert.match(
      schedulerCall,
      /^run_update_scheduler\s*\(\s*ready_notify(?:\.clone\(\))?\s*,\s*\|\|\s*Duration::from_secs\s*\(\s*read_update_check_interval_sec\s*\(\s*\)\s*\)\s*,\s*move\s*\|\|\s*\{\s*let app = updater_app\.clone\(\)\s*;\s*async move\s*\{\s*run_update_check\s*\(\s*app\s*\)\s*\.await\s*;\s*\}\s*\}\s*\)$/,
      "the only scheduler call must bind Ready, seconds cadence, and the real updater check",
    );
    const schedulerCallIndex = body.indexOf(schedulerCall);
    const spawnStart = body.lastIndexOf("tokio::spawn(async move", schedulerCallIndex);
    assert.notEqual(spawnStart, -1, "the scheduler call must run in a spawned task");
    assert.equal(braceDepthAt(body, spawnStart), 1, "scheduler spawn must be top-level in main");
    const spawnBlock = extractBraceBlock(body.slice(spawnStart), "tokio::spawn(async move");
    const escapedCall = schedulerCall.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      spawnBlock,
      new RegExp(`^tokio::spawn\\(async move\\s*\\{\\s*${escapedCall}\\s*\\.await\\s*;\\s*\\}$`),
      "the depth-one spawn must await the scheduler as its unconditional statement",
    );
  });

  // Given the Tauri command and handler macro, when executable code is inspected without comments,
  // then the registered command delegates to the behaviorally-tested response formatter with
  // the compiled running version.
  it("T-UpWire.2: registered command delegates the tested response for CARGO_PKG_VERSION", () => {
    const command = extractRustFunction(commandsSource, "frondose_take_update_notice");
    assert.match(command, /\{\s*take_update_notice_response\s*\(\s*env!\(\s*"CARGO_PKG_VERSION"\s*\)\s*\)\s*\}$/);
    const cleanMain = stripRustComments(mainSource);
    const handlerStart = cleanMain.indexOf(".invoke_handler(tauri::generate_handler![");
    assert.notEqual(handlerStart, -1, "invoke handler macro must exist");
    const handlerEnd = cleanMain.indexOf("])", handlerStart);
    assert.notEqual(handlerEnd, -1, "invoke handler macro must close");
    const handler = cleanMain.slice(handlerStart, handlerEnd);
    assert.match(handler, /\bfrondose_take_update_notice\b/);
  });

  // Given app boot composition, when executable code is inspected without comments, then the
  // behaviorally-tested language+completion composition runs before identity load.
  it("T-UpWire.3: boot reaches language+completion composition before identity load", () => {
    const appSource = readFileSync(resolve("src/tauri/ui/app.ts"), "utf8");
    assert.match(
      stripRustComments(appSource),
      /import\s*\{\s*applyLanguageAndShowUpdateCompletion\s*\}\s*from\s*["']\.\/updateCompletion\.js["'];/,
      "boot must use the imported production completion helper",
    );
    const boot = extractBraceBlock(appSource, "async function boot()");
    const guardMarker = "if (!windowRef.__TAURI__)";
    const guard = extractBraceBlock(boot, guardMarker);
    const bodyOpen = boot.indexOf("{");
    const guardStart = boot.indexOf(guardMarker);
    assert.equal(boot.slice(bodyOpen + 1, guardStart).trim(), "", "the Tauri guard must be first");
    const continuation = boot.slice(guardStart + guard.length, boot.lastIndexOf("}"));
    assert.match(
      continuation,
      /^\s*await windowRef\.__TAURI__\.event\.listen<[^>]+>\([^;]+;\s*await applyLanguageAndShowUpdateCompletion\s*\(\s*\{[\s\S]*?\}\s*\)\s*;\s*await loadIdentity\s*\(\s*\)\s*;\s*syncModeUi\s*\(\s*"manual"\s*\)\s*;\s*$/,
      "the whole live-Tauri continuation must be event → imported locale/completion → identity → mode",
    );
  });
});

describe("relaunched UI — a valid notice surfaces one localized success toast", () => {
  // Given the backend returns a completion notice, when the FE helper runs under English, then
  // it invokes the one-shot command and surfaces exactly one toast containing the new version.
  it("T-UpComplete.2: valid notice produces one English completion toast", async () => {
    setLocale("en");
    const { showUpdateCompletion } = await loadUpdateCompletion();
    const calls: string[] = [];
    const toasts: string[] = [];
    await showUpdateCompletion({
      invoke: async <T>(cmd: string) => {
        calls.push(cmd);
        return { notice: { fromVersion: "0.5.15", version: "0.5.16" } } as T;
      },
      surfaceToast: (message) => toasts.push(message),
    });
    assert.deepEqual(calls, ["frondose_take_update_notice"]);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0] ?? "", /0\.5\.16/);
    assert.match(toasts[0] ?? "", /updated/i);
  });

  // Given the backend returns no notice, when the helper runs, then it emits no false success.
  it("T-UpComplete.3: null notice produces no toast", async () => {
    setLocale("en");
    const { showUpdateCompletion } = await loadUpdateCompletion();
    const calls: string[] = [];
    const toasts: string[] = [];
    await showUpdateCompletion({
      invoke: async <T>(cmd: string) => {
        calls.push(cmd);
        return { notice: null } as T;
      },
      surfaceToast: (message) => toasts.push(message),
    });
    assert.deepEqual(calls, ["frondose_take_update_notice"]);
    assert.deepEqual(toasts, []);
  });

  // Given notice persistence is unavailable, when invoke rejects, then boot remains fail-soft
  // and no completion success is claimed.
  it("T-UpComplete.4: invoke rejection is swallowed without a toast", async () => {
    setLocale("en");
    const { showUpdateCompletion } = await loadUpdateCompletion();
    const calls: string[] = [];
    const toasts: string[] = [];
    await assert.doesNotReject(
      showUpdateCompletion({
        invoke: async (cmd: string) => {
          calls.push(cmd);
          throw new Error("notice unavailable");
        },
        surfaceToast: (message) => toasts.push(message),
      }),
    );
    assert.deepEqual(calls, ["frondose_take_update_notice"]);
    assert.deepEqual(toasts, []);
  });

  // Given the real app-actions locale loader receives persisted Chinese settings, when the real
  // boot composition runs, then settings are applied before notice invoke and localized toast.
  it("T-UpComplete.5: persisted Chinese settings drive ordered localized completion", async () => {
    setLocale("en");
    const { applyLanguageAndShowUpdateCompletion } = await loadUpdateCompletion();
    const order: string[] = [];
    const toasts: string[] = [];
    const actions = createPersistedChineseActions(order);
    await applyLanguageAndShowUpdateCompletion({
      applyLanguagePref: actions.applyLanguagePref,
      invoke: async <T>(cmd: string) => {
        order.push(cmd);
        return { notice: { fromVersion: "0.5.15", version: "0.5.16" } } as T;
      },
      surfaceToast: (message) => toasts.push(message),
    });
    assert.deepEqual(order, ["settings", "frondose_take_update_notice"]);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0] ?? "", /0\.5\.16/);
    assert.match(toasts[0] ?? "", /更新/);
  });
});
