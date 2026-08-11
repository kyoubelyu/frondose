use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    bytes.extend(width.to_be_bytes());
    bytes.extend(height.to_be_bytes());
    bytes
}

fn test_root(name: &str) -> PathBuf {
    env::temp_dir().join(format!(
        "frondose-ui-validation-{name}-{}",
        std::process::id()
    ))
}

#[test]
fn rejects_wrong_duplicate_and_out_of_order_stage() {
    let mut reducer = RequestReducer::new(7, "nonce-------------------".into(), Stage::En);
    assert!(reducer
        .accept(
            8,
            "nonce-------------------",
            Stage::En,
            EventKind::JavaScriptStart
        )
        .is_err());
    let mut reducer = RequestReducer::new(7, "nonce-------------------".into(), Stage::En);
    assert!(reducer
        .accept(
            7,
            "nonce-------------------",
            Stage::En,
            EventKind::Snapshot
        )
        .is_err());
    let mut reducer = RequestReducer::new(7, "nonce-------------------".into(), Stage::En);
    reducer
        .accept(
            7,
            "nonce-------------------",
            Stage::En,
            EventKind::JavaScriptStart,
        )
        .unwrap();
    assert!(reducer
        .accept(
            7,
            "nonce-------------------",
            Stage::En,
            EventKind::JavaScriptStart
        )
        .is_err());
}

#[test]
fn rejects_timeout_and_late_callback() {
    let mut reducer = RequestReducer::new(1, "nonce-------------------".into(), Stage::Zh);
    reducer.timeout();
    assert!(reducer
        .accept(
            1,
            "nonce-------------------",
            Stage::Zh,
            EventKind::JavaScriptResult
        )
        .is_err());
    assert_eq!(reducer.state, RequestState::Failed);

    let reducer = Arc::new(Mutex::new(RequestReducer::new(
        2,
        "nonce-------------------".into(),
        Stage::En,
    )));
    let (_tx, rx) = mpsc::channel();
    assert!(receive_javascript_result(rx, &reducer, Duration::from_millis(1)).is_err());
    assert_eq!(reducer.lock().unwrap().state, RequestState::Failed);

    for error in ["NSError", "null result", "wrong type"] {
        let reducer = Arc::new(Mutex::new(RequestReducer::new(
            3,
            "nonce-------------------".into(),
            Stage::En,
        )));
        assert!(terminalize_callback::<()>(&reducer, Err(error.into())).is_err());
        assert_eq!(reducer.lock().unwrap().state, RequestState::Failed);
        assert!(reducer
            .lock()
            .unwrap()
            .accept(
                3,
                "nonce-------------------",
                Stage::En,
                EventKind::JavaScriptStart
            )
            .is_err());
    }
}

#[test]
fn rejects_unsafe_output_roots_and_duplicate_entries() {
    let requested_root = test_root("outputs");
    fs::create_dir_all(&requested_root).unwrap();
    let root = requested_root.canonicalize().unwrap();
    let stage = root.join("ui-validation/en");
    fs::create_dir_all(&stage).unwrap();
    fs::set_permissions(&stage, fs::Permissions::from_mode(0o700)).unwrap();
    let owner = SafeStageDir::open(&root, &stage, Stage::En).unwrap();
    owner.write_leaf("stage.json", b"one").unwrap();
    assert!(owner.write_leaf("stage.json", b"two").is_err());
    drop(owner);
    fs::remove_dir_all(&root).unwrap();

    assert!(validate_directory_metadata(
        u32::from(libc::S_IFDIR) | 0o755,
        unsafe { libc::geteuid() },
        unsafe { libc::geteuid() }
    )
    .is_err());
    assert!(validate_directory_metadata(
        u32::from(libc::S_IFDIR) | 0o700,
        unsafe { libc::geteuid() } + 1,
        unsafe { libc::geteuid() }
    )
    .is_err());

    let root = test_root("symlink");
    let target = root.join("target");
    fs::create_dir_all(root.join("ui-validation")).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&target, root.join("ui-validation/en")).unwrap();
    assert!(SafeStageDir::open(&root, &root.join("ui-validation/en"), Stage::En).is_err());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn rejects_replaced_output_parent() {
    let requested_root = test_root("replacement");
    fs::create_dir_all(requested_root.join("ui-validation/en")).unwrap();
    let root = requested_root.canonicalize().unwrap();
    let stage = root.join("ui-validation/en");
    fs::set_permissions(&stage, fs::Permissions::from_mode(0o700)).unwrap();
    let owner = SafeStageDir::open(&root, &stage, Stage::En).unwrap();
    fs::rename(&stage, root.join("ui-validation/old-en")).unwrap();
    fs::create_dir(&stage).unwrap();
    fs::set_permissions(&stage, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(owner.write_leaf("stage.json", b"blocked").is_err());
    drop(owner);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn rejects_invalid_png_and_viewport_mismatch() {
    let viewport = Viewport {
        width: 480.0,
        height: 612.0,
        scale: 2.0,
    };
    assert_eq!(
        validate_png(&png(960, 1280), &viewport, (960, 1280)).unwrap(),
        (960, 1280)
    );
    assert!(validate_png(b"not png", &viewport, (960, 1280)).is_err());
    assert!(validate_png(&png(480, 640), &viewport, (960, 1280)).is_err());
    assert!(validate_capture_dimensions(
        &Viewport {
            width: f64::NAN,
            height: 1.0,
            scale: 1.0
        },
        (1, 1)
    )
    .is_err());
}

#[test]
fn rejects_activation_without_exact_stage_contract() {
    assert_eq!(
        validate_stage_nonce("en", "nonce-------------------".into())
            .unwrap()
            .0,
        Stage::En
    );
    assert!(validate_stage_nonce("EN", "nonce-------------------".into()).is_err());
    assert!(validate_stage_nonce("en", "short".into()).is_err());
    assert_eq!(STAGE_SCRIPT_SHA256.len(), 64);
    assert!(!STAGE_SCRIPT.contains("callAsyncJavaScript"));
}
