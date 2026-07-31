use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: u64 = 1;
const LEGACY_BRIDGE_VERSION: &str = "0.5.16";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateNotice {
    pub(crate) id: String,
    pub(crate) from_version: Option<String>,
    pub(crate) version: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateState {
    schema_version: u64,
    pub(crate) generation: u64,
    pub(crate) last_launched_version: String,
    pub(crate) pending_notice: Option<UpdateNotice>,
}

#[derive(Clone, Copy)]
#[allow(dead_code)]
pub(crate) enum CommitFault {
    AfterTempWrite,
    AfterTempSync,
    AfterInactiveRemove,
    AfterRename,
}

#[derive(Clone, Copy)]
#[allow(dead_code)]
pub(crate) enum TakeFault {
    AfterClaimCreate,
    AfterStateCommit,
}

enum StateRead {
    Missing,
    Valid(UpdateState, usize),
    Malformed,
}

fn slot_path(agent: &Path, slot: usize) -> PathBuf {
    agent.join(format!("update-state.{slot}.json"))
}

fn claim_path(agent: &Path, id: &str) -> PathBuf {
    agent.join(format!("update-notice-{id}.claim"))
}

fn state_is_valid(state: &UpdateState) -> bool {
    if state.schema_version != SCHEMA_VERSION
        || state.generation == 0
        || state.generation == u64::MAX
        || Version::parse(&state.last_launched_version).is_err()
    {
        return false;
    }
    let Some(pending) = &state.pending_notice else {
        return true;
    };
    if pending.version != state.last_launched_version {
        return false;
    }
    match pending.from_version.as_deref() {
        None => {
            pending.version == LEGACY_BRIDGE_VERSION
                && pending.id == format!("legacy-to-{}", pending.version)
        }
        Some(from) => {
            let is_forward = Version::parse(from)
                .ok()
                .zip(Version::parse(&pending.version).ok())
                .map_or(false, |(from, to)| to > from);
            is_forward && pending.id == format!("{from}-to-{}", pending.version)
        }
    }
}

fn read_state(agent: &Path) -> StateRead {
    let mut found = false;
    let mut best: Option<(UpdateState, usize)> = None;
    for slot in 0..=1 {
        let path = slot_path(agent, slot);
        let raw = match fs::read(&path) {
            Ok(raw) => {
                found = true;
                raw
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                found = true;
                continue;
            }
        };
        let state = match serde_json::from_slice::<UpdateState>(&raw) {
            Ok(state) if state_is_valid(&state) => state,
            _ => continue,
        };
        if best
            .as_ref()
            .map_or(true, |(current, _)| state.generation > current.generation)
        {
            best = Some((state, slot));
        }
    }
    match best {
        Some((state, slot)) => StateRead::Valid(state, slot),
        None if found => StateRead::Malformed,
        None => StateRead::Missing,
    }
}

#[allow(dead_code)]
pub(crate) fn read_update_state_at(agent: &Path) -> io::Result<Option<UpdateState>> {
    match read_state(agent) {
        StateRead::Valid(state, _) => Ok(Some(state)),
        StateRead::Missing => Ok(None),
        StateRead::Malformed => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "no valid update-state journal slot",
        )),
    }
}

fn next_generation(generation: u64) -> io::Result<u64> {
    generation
        .checked_add(1)
        .filter(|next| *next < u64::MAX)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "update-state generation exhausted",
            )
        })
}

#[cfg(unix)]
fn sync_dir(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(windows)]
fn sync_dir(path: &Path) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;

    // CreateFileW needs FILE_FLAG_BACKUP_SEMANTICS for a directory handle.
    // GENERIC_WRITE is required by FlushFileBuffers; share all access so this
    // durability barrier does not exclude the updater or antivirus scanners.
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_ALL: u32 = 0x0000_0007;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    OpenOptions::new()
        .access_mode(GENERIC_WRITE)
        .share_mode(FILE_SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?
        .sync_all()
}

fn prune_temps(agent: &Path) {
    let Ok(entries) = fs::read_dir(agent) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("update-state.") && name.ends_with(".tmp") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn open_unique_temp(
    agent: &Path,
    inactive: usize,
    nonce_override: Option<u128>,
) -> io::Result<(PathBuf, fs::File)> {
    let nonce = nonce_override.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    });
    for attempt in 0..32_u8 {
        let temp = agent.join(format!(
            "update-state.{inactive}.{}.{nonce}.{attempt}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "update-state temp name collision retry exhausted",
    ))
}

fn commit_state(
    agent: &Path,
    state: &UpdateState,
    active_slot: Option<usize>,
    fault: Option<CommitFault>,
    nonce_override: Option<u128>,
) -> io::Result<()> {
    fs::create_dir_all(agent)?;
    let inactive = active_slot.map_or(0, |slot| 1 - slot);
    let (temp, mut file) = open_unique_temp(agent, inactive, nonce_override)?;
    file.write_all(&serde_json::to_vec(state)?)?;
    if matches!(fault, Some(CommitFault::AfterTempWrite)) {
        return Err(io::Error::other("injected fault after temp write"));
    }
    file.sync_all()?;
    if matches!(fault, Some(CommitFault::AfterTempSync)) {
        return Err(io::Error::other("injected fault after temp sync"));
    }
    drop(file);

    let inactive_path = slot_path(agent, inactive);
    match fs::remove_file(&inactive_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if matches!(fault, Some(CommitFault::AfterInactiveRemove)) {
        return Err(io::Error::other("injected fault after inactive remove"));
    }
    fs::rename(&temp, &inactive_path)?;
    if matches!(fault, Some(CommitFault::AfterRename)) {
        return Err(io::Error::other("injected fault after rename"));
    }
    sync_dir(agent)?;
    prune_temps(agent);
    sync_dir(agent)?;
    Ok(())
}

fn has_legacy_evidence(agent: &Path) -> bool {
    let entries = match fs::read_dir(agent) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    entries.filter_map(Result::ok).any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        name != "chrome-profile"
            && !name.starts_with("update-state.")
            && !name.starts_with("update-notice-")
    })
}

fn notice(from_version: Option<&str>, version: &str) -> UpdateNotice {
    UpdateNotice {
        id: from_version.map_or_else(
            || format!("legacy-to-{version}"),
            |from| format!("{from}-to-{version}"),
        ),
        from_version: from_version.map(str::to_owned),
        version: version.to_owned(),
    }
}

fn prepare_inner(
    agent: &Path,
    current: &str,
    fault: Option<CommitFault>,
    nonce_override: Option<u128>,
) -> io::Result<()> {
    let existing = read_state(agent);
    let (mut next, active_slot) = match existing {
        StateRead::Missing => {
            let pending_notice = (current == LEGACY_BRIDGE_VERSION && has_legacy_evidence(agent))
                .then(|| notice(None, current));
            (
                UpdateState {
                    schema_version: SCHEMA_VERSION,
                    generation: 1,
                    last_launched_version: current.to_owned(),
                    pending_notice,
                },
                None,
            )
        }
        StateRead::Malformed => (
            UpdateState {
                schema_version: SCHEMA_VERSION,
                generation: 1,
                last_launched_version: current.to_owned(),
                pending_notice: None,
            },
            None,
        ),
        StateRead::Valid(state, slot) => {
            if state.last_launched_version == current {
                if state
                    .pending_notice
                    .as_ref()
                    .is_some_and(|pending| claim_path(agent, &pending.id).exists())
                {
                    let mut cleared = state;
                    cleared.generation = next_generation(cleared.generation)?;
                    cleared.pending_notice = None;
                    (cleared, Some(slot))
                } else {
                    return Ok(());
                }
            } else {
                let is_forward = Version::parse(current)
                    .ok()
                    .zip(Version::parse(&state.last_launched_version).ok())
                    .is_some_and(|(current, previous)| current > previous);
                let previous = state.last_launched_version.clone();
                let mut advanced = state;
                advanced.generation = next_generation(advanced.generation)?;
                advanced.last_launched_version = current.to_owned();
                advanced.pending_notice = is_forward.then(|| notice(Some(&previous), current));
                (advanced, Some(slot))
            }
        }
    };
    next.schema_version = SCHEMA_VERSION;
    commit_state(agent, &next, active_slot, fault, nonce_override)
}

pub(crate) fn prepare_update_notice_at(agent: &Path, current: &str) -> io::Result<()> {
    prepare_inner(agent, current, None, None)
}

#[allow(dead_code)]
pub(crate) fn prepare_update_notice_at_with_fault(
    agent: &Path,
    current: &str,
    fault: CommitFault,
) -> io::Result<()> {
    prepare_inner(agent, current, Some(fault), None)
}

#[allow(dead_code)]
pub(crate) fn prepare_update_notice_at_with_temp_nonce(
    agent: &Path,
    current: &str,
    nonce: u128,
) -> io::Result<()> {
    prepare_inner(agent, current, None, Some(nonce))
}

fn agent_dir() -> io::Result<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".frondose").join("agent"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory unavailable"))
}

pub(crate) fn prepare_update_notice(current: &str) {
    match agent_dir().and_then(|agent| prepare_update_notice_at(&agent, current)) {
        Ok(()) => {}
        Err(error) => eprintln!("[frondose] update notice preparation failed: {error}"),
    }
}

fn take_inner(
    agent: &Path,
    current: &str,
    fault: Option<TakeFault>,
) -> io::Result<Option<UpdateNotice>> {
    let StateRead::Valid(state, slot) = read_state(agent) else {
        return Ok(None);
    };
    let Some(pending) = state.pending_notice.clone() else {
        return Ok(None);
    };
    if pending.version != current {
        return Ok(None);
    }
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(claim_path(agent, &pending.id))
    {
        Ok(mut file) => {
            file.write_all(b"claimed\n")?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(None),
        Err(error) => return Err(error),
    }
    sync_dir(agent)?;
    if matches!(fault, Some(TakeFault::AfterClaimCreate)) {
        return Err(io::Error::other("injected fault after claim create"));
    }

    let mut cleared = state;
    cleared.generation = next_generation(cleared.generation)?;
    cleared.pending_notice = None;
    commit_state(agent, &cleared, Some(slot), None, None)?;
    if matches!(fault, Some(TakeFault::AfterStateCommit)) {
        return Err(io::Error::other("injected fault after state commit"));
    }
    Ok(Some(pending))
}

pub(crate) fn take_update_notice_at(
    agent: &Path,
    current: &str,
) -> io::Result<Option<UpdateNotice>> {
    take_inner(agent, current, None)
}

#[allow(dead_code)]
pub(crate) fn take_update_notice_at_with_fault(
    agent: &Path,
    current: &str,
    fault: TakeFault,
) -> io::Result<Option<UpdateNotice>> {
    take_inner(agent, current, Some(fault))
}

pub(crate) fn take_update_notice_response_at(agent: &Path, current: &str) -> Value {
    match take_update_notice_at(agent, current) {
        Ok(notice) => json!({ "notice": notice }),
        Err(error) => {
            eprintln!("[frondose] update notice consume failed: {error}");
            json!({ "notice": null })
        }
    }
}

pub(crate) fn take_update_notice_response(current: &str) -> Value {
    match agent_dir() {
        Ok(agent) => take_update_notice_response_at(&agent, current),
        Err(error) => {
            eprintln!("[frondose] update notice path unavailable: {error}");
            json!({ "notice": null })
        }
    }
}
