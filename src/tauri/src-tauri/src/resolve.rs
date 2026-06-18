use std::path::PathBuf;

use rand::RngCore;

/// WIN-1: generate a per-process port-file path under $TMPDIR and a 32-byte hex token.
/// The sidecar binds 127.0.0.1:0 and writes the chosen port to the port-file; the bearer
/// token (not the dir perms) is the request guard, so no chmod is needed (cross-platform).
pub(crate) fn provision_state() -> Result<(String, PathBuf, PathBuf), String> {
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = token_bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    let mut suffix = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut suffix);
    let suffix_hex = suffix
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    let tmp = std::env::temp_dir();
    let parent_dir = tmp.join(format!("frondose-com.kyoube.frondose-{}", suffix_hex));
    std::fs::create_dir(&parent_dir).map_err(|e| format!("mkdir {}: {}", parent_dir.display(), e))?;
    let port_file = parent_dir.join("frondose.port");
    Ok((token, port_file, parent_dir))
}

/// [P-58d.3] Resource dir WITHOUT an AppHandle — resolve_* run before Tauri is built.
/// macOS: Contents/MacOS/Frondose -> Contents -> Contents/Resources.
/// Windows: Frondose.exe sits beside bundled runtime/.
fn bundled_resource_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if cfg!(windows) {
        exe.parent().map(PathBuf::from)
    } else {
        exe.parent()?.parent()?.join("Resources").into()
    }
}

#[cfg(windows)]
pub(crate) fn windows_sidecar_log_path() -> Option<PathBuf> {
    let profile = std::env::var("USERPROFILE").ok()?;
    if profile.trim().is_empty() {
        return None;
    }
    let dir = std::path::Path::new(&profile)
        .join(".frondose")
        .join("agent")
        .join("logs");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[frondose] sidecar log mkdir failed: {}", e);
        return None;
    }
    Some(dir.join("sidecar.log"))
}

/// Resolve an absolute `node` executable. A GUI-launched `.app` inherits launchd's
/// minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — Homebrew node at
/// `/opt/homebrew/bin` is NOT on it — so a bare `Command::new("node")` fails from
/// Finder (BLOCKER-RISK #1). Probe an ordered candidate list; fall back to bare
/// "node" for the `cargo tauri dev` shell-PATH case.
pub(crate) fn resolve_node() -> String {
    if let Ok(p) = std::env::var("FRONDOSE_NODE_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            if std::path::Path::new(p).is_file() {
                return p.to_string();
            }
            eprintln!(
                "[frondose] ignoring FRONDOSE_NODE_PATH={} (not a file)",
                p
            );
        }
    }
    if let Some(dir) = bundled_resource_dir() {
        let runtime = dir.join("runtime");
        if cfg!(windows) {
            let node_exe = runtime.join("node.exe");
            if node_exe.is_file() {
                return node_exe.to_string_lossy().into_owned();
            }
        }
        let node = runtime.join("node");
        if node.is_file() {
            return node.to_string_lossy().into_owned();
        }
    }
    for candidate in [
        "/opt/homebrew/bin/node", // Apple Silicon Homebrew
        "/usr/local/bin/node",    // Intel Homebrew
        "/usr/bin/node",          // system
    ] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "node".to_string() // dev fallback (shell PATH under `cargo tauri dev`)
}

/// [P-APP-6] Resolve the app sidecar entrypoint (dist/app/sidecarMain.js).
/// Replaces the CLI-routed sidecar boot. FRONDOSE_SIDECAR_BIN_PATH overrides
/// (dev / sibling installs). Bundled path is the .app's
/// Contents/Resources/runtime/dist/app/sidecarMain.js. CLI `serve` stays in
/// parallel during P-APP-11 migration; it is not the spawn target.
pub(crate) fn resolve_sidecar_bin() -> String {
    if let Ok(p) = std::env::var("FRONDOSE_SIDECAR_BIN_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            if std::path::Path::new(p).is_file() {
                return p.to_string();
            }
            eprintln!(
                "[frondose] ignoring FRONDOSE_SIDECAR_BIN_PATH={} (not a file)",
                p
            );
        }
    }
    if let Some(dir) = bundled_resource_dir() {
        let entry = dir.join("runtime").join("dist").join("app").join("sidecarMain.js");
        if entry.is_file() {
            return entry.to_string_lossy().into_owned();
        }
    }
    for candidate in [
        "/opt/homebrew/lib/node_modules/@kyoube/frondose/dist/app/sidecarMain.js",
        "/usr/local/lib/node_modules/@kyoube/frondose/dist/app/sidecarMain.js",
    ] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "../../../dist/app/sidecarMain.js".to_string() // dev fallback (cargo tauri dev)
}

/// Resolve the install.sh-installed `mai` CLI entry. install.sh symlinks the
/// npm-global package at `<brew-prefix>/lib/node_modules/@kyoube/frondose` →
/// `~/.frondose/agent/releases/<tag>`; the runnable entry is `dist/cli/main.js` inside.
/// `FRONDOSE_BIN_PATH` overrides (dev / `cargo tauri dev`). Fall back to the dev
/// relative path so `cargo tauri dev` (CWD = src-tauri) keeps working.
/// NOTE: a fresh Mac with ONLY the `.app` (no prior install.sh) hits the dev
/// fallback, fails to resolve, and exits via the existing `await_serve_ready`
/// timeout — DEFERRED to P-58c (self-contained bundle).
// Kept for the P-APP-11 transition; delete with the CLI entrypoint.
#[allow(dead_code)]
fn resolve_frondose_bin() -> String {
    if let Ok(p) = std::env::var("FRONDOSE_BIN_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            if std::path::Path::new(p).is_file() {
                return p.to_string();
            }
            eprintln!(
                "[frondose] ignoring FRONDOSE_BIN_PATH={} (not a file)",
                p
            );
        }
    }
    if let Some(dir) = bundled_resource_dir() {
        let main_js = dir.join("runtime").join("dist").join("cli").join("main.js");
        if main_js.is_file() {
            return main_js.to_string_lossy().into_owned();
        }
    }
    for candidate in [
        "/opt/homebrew/lib/node_modules/@kyoube/frondose/dist/cli/main.js", // Apple Silicon
        "/usr/local/lib/node_modules/@kyoube/frondose/dist/cli/main.js",    // Intel
    ] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "../../../dist/cli/main.js".to_string() // dev fallback (cargo tauri dev)
}
