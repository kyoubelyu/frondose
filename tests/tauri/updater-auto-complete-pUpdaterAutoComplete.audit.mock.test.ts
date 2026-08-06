import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { extractRustFunction, runCargoHarness } from "./updater-auto-complete-pUpdaterAutoComplete.helpers.js";

const updateNoticePath = resolve("src/tauri/src-tauri/src/update_notice.rs");
const harnessRoot = mkdtempSync(resolve(tmpdir(), "frondose-updater-audit-"));
after(() => rmSync(harnessRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

function runAuditRust(filter: string): string {
  assert.ok(existsSync(updateNoticePath), "real update_notice.rs seam must exist");
  const cargoToml = `[package]
name = "frondose-update-notice-audit-contract"
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
        prepare_update_notice_at_with_temp_nonce, read_update_state_at,
        take_update_notice_at, take_update_notice_at_with_fault, CommitFault, TakeFault,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn case_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!(
            "frondose-update-audit-{}-{}-{}", std::process::id(), label, nonce
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_state(dir: &PathBuf, value: serde_json::Value) {
        fs::write(
            dir.join("update-state.0.json"),
            serde_json::to_vec(&value).unwrap(),
        ).unwrap();
    }

    #[test]
    fn semantic_corruption_never_emits_success_and_is_healed_without_notice() {
        let cases = [
            serde_json::json!({
                "schemaVersion": 1, "generation": 7,
                "lastLaunchedVersion": "0.5.16",
                "pendingNotice": {
                    "id": "forged", "fromVersion": "0.5.15", "version": "0.5.16"
                }
            }),
            serde_json::json!({
                "schemaVersion": 1, "generation": 7,
                "lastLaunchedVersion": "0.5.15",
                "pendingNotice": {
                    "id": "0.5.15-to-0.5.16",
                    "fromVersion": "0.5.15", "version": "0.5.16"
                }
            }),
            serde_json::json!({
                "schemaVersion": 1, "generation": 7,
                "lastLaunchedVersion": "0.5.16",
                "pendingNotice": {
                    "id": "0.5.17-to-0.5.16",
                    "fromVersion": "0.5.17", "version": "0.5.16"
                }
            }),
            serde_json::json!({
                "schemaVersion": 1, "generation": u64::MAX,
                "lastLaunchedVersion": "0.5.16",
                "pendingNotice": {
                    "id": "0.5.15-to-0.5.16",
                    "fromVersion": "0.5.15", "version": "0.5.16"
                }
            }),
        ];
        for (index, value) in cases.into_iter().enumerate() {
            let dir = case_dir(&format!("semantic-{index}"));
            write_state(&dir, value);
            assert!(read_update_state_at(&dir).is_err());
            prepare_update_notice_at(&dir, "0.5.16").unwrap();
            let healed = read_update_state_at(&dir).unwrap().unwrap();
            assert_eq!(healed.generation, 1);
            assert!(healed.pending_notice.is_none());
            assert!(take_update_notice_at(&dir, "0.5.16").unwrap().is_none());
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn temp_collision_retries_and_success_prunes_all_abandoned_temps() {
        let dir = case_dir("temp-collision");
        prepare_update_notice_at(&dir, "0.5.15").unwrap();
        let nonce = 4242_u128;
        fs::write(
            dir.join(format!(
                "update-state.1.{}.{}.0.tmp", std::process::id(), nonce
            )),
            "collision",
        ).unwrap();
        fs::write(dir.join("update-state.9.abandoned.tmp"), "abandoned").unwrap();
        prepare_update_notice_at_with_temp_nonce(&dir, "0.5.16", nonce).unwrap();
        let temps: Vec<_> = fs::read_dir(&dir).unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(temps.is_empty());
        let notice = take_update_notice_at(&dir, "0.5.16").unwrap().unwrap();
        assert_eq!(notice.id, "0.5.15-to-0.5.16");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_forward_commit_retains_claim_until_new_generation_is_durable() {
        let faults = [
            CommitFault::AfterTempWrite,
            CommitFault::AfterTempSync,
            CommitFault::AfterInactiveRemove,
            CommitFault::AfterRename,
        ];
        for (index, fault) in faults.into_iter().enumerate() {
            let dir = case_dir(&format!("claim-transition-{index}"));
            prepare_update_notice_at(&dir, "0.5.15").unwrap();
            prepare_update_notice_at(&dir, "0.5.16").unwrap();
            assert!(take_update_notice_at_with_fault(
                &dir,
                "0.5.16",
                TakeFault::AfterClaimCreate,
            ).is_err());

            let claim = dir.join("update-notice-0.5.15-to-0.5.16.claim");
            assert!(claim.exists());
            assert!(prepare_update_notice_at_with_fault(&dir, "0.5.17", fault).is_err());
            assert!(claim.exists(), "failed durability barrier must retain the old claim");
            assert!(take_update_notice_at(&dir, "0.5.16").unwrap().is_none());

            prepare_update_notice_at(&dir, "0.5.17").unwrap();
            assert!(claim.exists(), "versioned at-most-once tombstones are never pruned");
            fs::remove_dir_all(dir).unwrap();
        }
    }
}

fn main() {}
`;
  return runCargoHarness(harnessRoot, "notice-audit", cargoToml, mainRs, filter);
}

describe("P-UPDATER-AUTO-COMPLETE audit closures", () => {
  // Given schema-valid but inconsistent envelopes, when production reads/prepares them, then no success notice can escape.
  it("rejects semantic journal corruption and generation exhaustion", () => {
    assert.match(
      runAuditRust("semantic_corruption_never_emits_success_and_is_healed_without_notice"),
      /test result: ok/,
    );
  });

  // Given a deterministic first temp-name collision and an abandoned temp, when production commits, then it retries and prunes both.
  it("retries temp collisions and prunes abandoned temps after commit", () => {
    assert.match(runAuditRust("temp_collision_retries_and_success_prunes_all_abandoned_temps"), /test result: ok/);
  });

  // Given a durable claim and every forward-transition durability fault, when preparation fails or later succeeds, then the versioned tombstone always remains.
  it("retains claim tombstones across failed and successful later generations", () => {
    assert.match(
      runAuditRust("failed_forward_commit_retains_claim_until_new_generation_is_durable"),
      /test result: ok/,
    );
  });

  // Given the post-claim crash seam, when source order is inspected, then file and parent directory sync precede the fault boundary.
  it("syncs the claim file and parent directory before the crash seam", () => {
    const source = readFileSync(updateNoticePath, "utf8");
    const takeInner = extractRustFunction(source, "take_inner");
    const fileSync = takeInner.indexOf("file.sync_all()?");
    const dirSync = takeInner.indexOf("sync_dir(agent)");
    const fault = takeInner.indexOf("TakeFault::AfterClaimCreate");
    assert.ok(fileSync >= 0 && dirSync > fileSync && fault > dirSync);
    assert.match(takeInner, /sync_dir\(agent\)\?/);
    assert.doesNotMatch(source, /fn\s+prune_claims\s*\(/);
    assert.doesNotMatch(source, /\.is_none_or\s*\(/);
  });
});
