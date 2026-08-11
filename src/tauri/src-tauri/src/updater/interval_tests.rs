use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempHome {
    dir: std::path::PathBuf,
    original_home: Option<std::ffi::OsString>,
    original_userprofile: Option<std::ffi::OsString>,
}

impl TempHome {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("frondose-interval-test-{}-{}", tag, nanos));
        std::fs::create_dir_all(&dir).unwrap();
        let original_home = std::env::var_os("HOME");
        let original_userprofile = std::env::var_os("USERPROFILE");
        std::env::set_var("HOME", &dir);
        std::env::remove_var("USERPROFILE");
        Self {
            dir,
            original_home,
            original_userprofile,
        }
    }

    fn write_config(&self, raw: &str) {
        let directory = self.dir.join(".frondose/agent");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("config.json"), raw).unwrap();
    }

    fn write_retired_config(&self, raw: &str) {
        let directory = self.retired_config_path().parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("config.json"), raw).unwrap();
    }

    fn retired_config_path(&self) -> std::path::PathBuf {
        self.dir
            .join([".", "mai"].concat())
            .join("agent/config.json")
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        match &self.original_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        match &self.original_userprofile {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// Given no current config and retired interval zero, when read, then default wins and retired bytes remain unchanged.
#[test]
fn t_nuif_1_absent_current_ignores_retired_interval() {
    let _guard = TEST_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let home = TempHome::new("retired-only");
    let retired = r#"{"updateCheckIntervalSec":0}"#;
    home.write_retired_config(retired);
    assert_eq!(read_update_check_interval_sec(), 3600);
    assert_eq!(
        std::fs::read_to_string(home.retired_config_path()).unwrap(),
        retired
    );
}

// Given unreadable current config and retired 7200, when read, then default wins and retired bytes remain unchanged.
#[test]
fn t_nuif_2_unreadable_current_ignores_retired_interval() {
    let _guard = TEST_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let home = TempHome::new("unreadable-current");
    std::fs::create_dir_all(home.dir.join(".frondose/agent/config.json")).unwrap();
    let retired = r#"{"updateCheckIntervalSec":7200}"#;
    home.write_retired_config(retired);
    assert_eq!(read_update_check_interval_sec(), 3600);
    assert_eq!(
        std::fs::read_to_string(home.retired_config_path()).unwrap(),
        retired
    );
}

// Given current u64 values, when read, then disable, floor, exact, and maximum semantics remain byte-preserving.
#[test]
fn t_nuif_4_current_values_retain_interval_semantics() {
    let _guard = TEST_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    for (tag, value, expected) in [
        ("zero", 0_u64, 0_u64),
        ("floor", 59, 60),
        ("exact", 61, 61),
        ("u64-max", u64::MAX, u64::MAX),
    ] {
        let home = TempHome::new(tag);
        let raw = format!(r#"{{"updateCheckIntervalSec":{}}}"#, value);
        home.write_config(&raw);
        assert_eq!(read_update_check_interval_sec(), expected);
        assert_eq!(
            std::fs::read_to_string(home.dir.join(".frondose/agent/config.json")).unwrap(),
            raw
        );
    }
}

// Given a raw integer above u64::MAX, when read, then the locked parser returns default without rewriting bytes.
#[test]
fn t_nuif_3_u64_overflow_uses_default() {
    let _guard = TEST_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let home = TempHome::new("u64-overflow");
    let raw = r#"{"updateCheckIntervalSec":18446744073709551616}"#;
    home.write_config(raw);
    assert_eq!(read_update_check_interval_sec(), 3600);
    assert_eq!(
        std::fs::read_to_string(home.dir.join(".frondose/agent/config.json")).unwrap(),
        raw
    );
}
