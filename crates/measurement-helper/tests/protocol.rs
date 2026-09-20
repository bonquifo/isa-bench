use measurement_helper::{Request, handle, perf_scale, rapl_delta, rapl_delta_bounded};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn root(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("measurement-helper-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn validates_affinity_and_monotonic_clock() {
    assert!(handle(Request::Topology { cpus: vec![] }).is_err());
    let first = handle(Request::Clock).unwrap();
    let second = handle(Request::Clock).unwrap();
    assert_eq!(first["monotonic"], true);
    assert_eq!(second["monotonic"], true);
}

#[test]
fn scales_perf_and_detects_rapl_wrap_ambiguity() {
    assert_eq!(perf_scale(100, 100, 50).unwrap(), Some(200));
    assert!(perf_scale(1, 1, 2).is_err());
    assert_eq!(rapl_delta(90, 10, 100, 1).unwrap(), (20, 1));
    assert!(rapl_delta(90, 10, 100, 2).is_err());
    assert_eq!(rapl_delta_bounded(10, 20, 100, 1_000_000_000, 50).unwrap(), (10, 0));
    assert_eq!(rapl_delta_bounded(90, 10, 100, 1_000_000_000, 50).unwrap(), (20, 1));
    assert!(rapl_delta_bounded(90, 10, 100, 1_000_000_000, 120).is_err());
}

#[test]
fn controls_restore_and_reject_paths() {
    let root = root("controls");
    let relative = PathBuf::from("devices/system/cpu/cpu0/cpufreq/scaling_governor");
    fs::create_dir_all(root.join(relative.parent().unwrap())).unwrap();
    fs::write(root.join(&relative), "powersave").unwrap();
    let transaction = root.join("restore.json");
    let mut controls = BTreeMap::new();
    controls.insert("cpu0.governor".to_owned(), json!("performance"));
    let applied = handle(Request::Controls { controls, sysfs_root: Some(root.clone()), transaction: transaction.clone() }).unwrap();
    assert_eq!(applied["verified"], true);
    assert_eq!(fs::read_to_string(root.join(&relative)).unwrap(), "performance");
    handle(Request::Restore { transaction: transaction.clone(), sysfs_root: Some(root.clone()) }).unwrap();
    assert_eq!(fs::read_to_string(root.join(&relative)).unwrap(), "powersave");
    let mut rejected = BTreeMap::new();
    rejected.insert("../../etc/passwd".to_owned(), json!("x"));
    assert!(handle(Request::Controls { controls: rejected, sysfs_root: Some(root.clone()), transaction: root.join("bad.json") }).is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn run_rejects_unapproved_binary_root() {
    let request: Request = serde_json::from_value(json!({
        "operation": "run",
        "binary": {"path": "anything", "sha256": "00".repeat(32), "size": "0", "corpusId": "fixture"},
        "argv": [], "iterations": "1", "cpus": [0], "timeoutMs": 10,
        "jobNonce": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "corpusIdentity": "00".repeat(32), "adapters": []
    })).unwrap();
    assert!(handle(request).is_err());
    assert!(serde_json::from_value::<Request>(json!({
        "operation":"run","binary":{"path":"x","sha256":"00".repeat(32),"size":"1","corpusId":"x"},
        "argv":[],"iterations":"1","cpus":[0],"timeout_ms":10,"jobNonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","corpusIdentity":"00".repeat(32),"adapters":[]
    })).is_err());
}

#[test]
fn recursively_discovers_rapl_and_rejects_empty_sensor_claims() {
    let root = root("rapl");
    let domain = root.join("intel-rapl-0").join("intel-rapl-0-0");
    fs::create_dir_all(&domain).unwrap();
    fs::write(domain.join("name"), "dram\n").unwrap();
    fs::write(domain.join("max_energy_range_uj"), "1000\n").unwrap();
    fs::write(domain.join("energy_uj"), "20\n").unwrap();
    let found = handle(Request::RaplDiscover { powercap_root: Some(root.clone()) }).unwrap();
    assert_eq!(found["supported"], true);
    assert_eq!(found["domains"].as_array().unwrap().len(), 1);
    let thermal = handle(Request::ThermalFrequency { sysfs_root: Some(root.clone()) }).unwrap();
    assert_eq!(thermal["supported"], false);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn turbo_semantics_are_inverted_for_no_turbo_and_restore_is_idempotent() {
    let root = root("turbo");
    let relative = PathBuf::from("devices/system/cpu/intel_pstate/no_turbo");
    fs::create_dir_all(root.join(relative.parent().unwrap())).unwrap();
    fs::write(root.join(&relative), "1").unwrap();
    let transaction = root.join("restore.json");
    let mut controls = BTreeMap::new(); controls.insert("turbo".to_owned(), json!(true));
    handle(Request::Controls { controls, sysfs_root: Some(root.clone()), transaction: transaction.clone() }).unwrap();
    assert_eq!(fs::read_to_string(root.join(&relative)).unwrap(), "0");
    handle(Request::Restore { transaction: transaction.clone(), sysfs_root: Some(root.clone()) }).unwrap();
    let second = handle(Request::Restore { transaction, sysfs_root: Some(root.clone()) }).unwrap();
    assert_eq!(second["idempotent"], true);
    assert_eq!(fs::read_to_string(root.join(&relative)).unwrap(), "1");
    let _ = fs::remove_dir_all(root);
}
