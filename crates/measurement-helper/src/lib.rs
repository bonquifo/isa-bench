use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "inventory")]
    Inventory,
    #[serde(rename = "clock")]
    Clock,
    #[serde(rename = "topology")]
    Topology { cpus: Vec<usize> },
    #[serde(rename = "perf-scale")]
    PerfScale { raw: u64, time_enabled: u64, time_running: u64 },
    #[serde(rename = "rapl-delta")]
    RaplDelta { #[serde(rename="beforeUj")] before_uj: u64, #[serde(rename="afterUj")] after_uj: u64, #[serde(rename="maxRangeUj")] max_range_uj: u64, #[serde(rename="elapsedNs")] elapsed_ns:u64, #[serde(rename="maxPowerUw")] max_power_uw:u64 },
    #[serde(rename = "controls")]
    Controls { controls: BTreeMap<String, Value>, #[serde(default, rename = "sysfsRoot")] sysfs_root: Option<PathBuf>, transaction: PathBuf },
    #[serde(rename = "restore")]
    Restore { transaction: PathBuf, #[serde(default, rename = "sysfsRoot")] sysfs_root: Option<PathBuf> },
    #[serde(rename = "recover-controls")]
    RecoverControls,
    #[serde(rename = "run")]
    Run {
        binary: EligibleBinary, argv: Vec<String>, iterations: String, cpus: Vec<usize>,
        #[serde(rename = "timeoutMs")] timeout_ms: u64,
        #[serde(rename = "jobNonce")] job_nonce: String,
        #[serde(rename = "corpusIdentity")] corpus_identity: String,
        adapters: Vec<String>,
    },
    #[serde(rename = "idle")]
    Idle { #[serde(rename = "durationNs")] duration_ns: String, cpus: Vec<usize>, adapters: Vec<String> },
    #[serde(rename = "rapl-discover")]
    RaplDiscover { #[serde(default)] powercap_root: Option<PathBuf> },
    #[serde(rename = "thermal-frequency")]
    ThermalFrequency { #[serde(default)] sysfs_root: Option<PathBuf> },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EligibleBinary {
    pub path: PathBuf,
    pub sha256: String,
    pub size: String,
    #[serde(rename = "corpusId")]
    pub corpus_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct RestoreEntry { #[serde(default)] key:String, relative: PathBuf, original: String }

#[derive(Debug, Serialize, Deserialize)]
struct RestoreTransaction { version: u8, restored: bool, entries: Vec<RestoreEntry> }

pub fn handle(request: Request) -> Result<Value, String> {
    match request {
        Request::Inventory => Ok(inventory()),
        Request::Clock => Ok(clock_metadata()),
        Request::Topology { cpus } => validate_affinity(&cpus),
        Request::PerfScale { raw, time_enabled, time_running } =>
            perf_scale(raw, time_enabled, time_running).map(|value| json!({"raw": raw.to_string(), "scaled": value.map(|v| v.to_string()), "timeEnabled": time_enabled.to_string(), "timeRunning": time_running.to_string()})),
        Request::RaplDelta { before_uj, after_uj, max_range_uj, elapsed_ns, max_power_uw } =>
            rapl_delta_bounded(before_uj, after_uj, max_range_uj, elapsed_ns, max_power_uw).map(|(delta, wraps)| json!({"microjoules": delta.to_string(), "wraps": wraps})),
        Request::Controls { controls, sysfs_root, transaction } =>
            apply_controls(&configured_root(sysfs_root, "/sys")?, &validated_transaction(&transaction)?, controls),
        Request::Restore { transaction, sysfs_root } =>
            restore(&configured_root(sysfs_root, "/sys")?, &validated_transaction(&transaction)?),
        Request::RecoverControls => recover_controls(),
        Request::Run { binary, argv, iterations, cpus, timeout_ms, job_nonce, corpus_identity, adapters } =>
            run_binary(binary, argv, iterations, cpus, timeout_ms, job_nonce, corpus_identity, adapters),
        Request::Idle { duration_ns, cpus, adapters } => idle(duration_ns, cpus, adapters),
        Request::RaplDiscover { powercap_root } =>
            discover_rapl(&configured_root(powercap_root, "/sys/class/powercap")?),
        Request::ThermalFrequency { sysfs_root } =>
            thermal_frequency(&configured_root(sysfs_root, "/sys")?),
    }
}
fn recover_controls()->Result<Value,String>{
    let root=std::env::var_os("ISA_SIM_RESTORE_ROOT").map(PathBuf::from).unwrap_or_else(||PathBuf::from("/var/lib/isa-sim/measurement-restores"));
    if !root.exists(){return Ok(json!({"restored":0}));}let mut restored=0u64;
    for item in fs::read_dir(&root).map_err(|e|e.to_string())?.flatten(){let path=item.path();if path.extension().and_then(|v|v.to_str())==Some("json"){let value:RestoreTransaction=serde_json::from_slice(&fs::read(&path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;if !value.restored{restore(Path::new("/sys"),&path)?;restored+=1;}}}
    Ok(json!({"restored":restored}))
}
fn configured_root(requested:Option<PathBuf>,default:&str)->Result<PathBuf,String>{
    #[cfg(feature="test-only-fixture")] { return Ok(requested.unwrap_or_else(||PathBuf::from(default))); }
    #[cfg(not(feature="test-only-fixture"))] { if requested.is_some(){return Err("root overrides are test-only".into());}Ok(PathBuf::from(default)) }
}
fn validated_transaction(path:&Path)->Result<PathBuf,String>{
    #[cfg(feature="test-only-fixture")] { return Ok(path.to_path_buf()); }
    #[cfg(not(feature="test-only-fixture"))] {
      let root=std::env::var_os("ISA_SIM_RESTORE_ROOT").map(PathBuf::from).unwrap_or_else(||PathBuf::from("/var/lib/isa-sim/measurement-restores"));
      if !path.is_absolute()||!path.starts_with(&root){return Err("restore transaction outside configured root".into());}Ok(path.to_path_buf())
    }
}

fn inventory() -> Value {
    let logical = std::thread::available_parallelism().map_or(0, |value| value.get());
    let (identity,features)=cpu_identity();
    let topology=cpu_topology(logical);
    json!({
        "supported": true, "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
        "abi": if cfg!(target_env="msvc"){"msvc"}else if cfg!(target_env="musl"){"musl"}else if cfg!(target_env="gnu"){"gnu"}else{"unknown"},
        "logicalCpus": logical, "kernel": read_trimmed(Path::new("/proc/sys/kernel/osrelease")),
        "cpuInfo": read_trimmed(Path::new("/proc/cpuinfo")),
        "cpuIdentity":identity,"cpuFeatures":features,"topology":topology,
        "windowsCapabilities": if cfg!(windows) { json!(["qpc", "processor-affinity", "inventory"]) } else { json!([]) }
    })
}

#[cfg(target_arch="x86_64")]
fn cpu_identity()->(Value,Value){let leaf=std::arch::x86_64::__cpuid(1);let base_family=(leaf.eax>>8)&15;let family=if base_family==15{base_family+((leaf.eax>>20)&255)}else{base_family};let base_model=(leaf.eax>>4)&15;let model=if base_family==6||base_family==15{base_model+(((leaf.eax>>16)&15)<<4)}else{base_model};let stepping=leaf.eax&15;let features=format!("{:08x}:{:08x}",leaf.ecx,leaf.edx);(json!({"supported":true,"family":family.to_string(),"model":model.to_string(),"stepping":stepping.to_string(),"microcode":null}),json!({"supported":true,"values":[features]}))}
#[cfg(not(target_arch="x86_64"))]
fn cpu_identity()->(Value,Value){(json!({"supported":false,"reason":"validated CPU identity probe unavailable"}),json!({"supported":false,"reason":"validated CPU feature probe unavailable"}))}

#[cfg(windows)]
fn cpu_topology(logical:usize)->Value{
    use windows_sys::Win32::System::SystemInformation::*;
    fn count(relation:LOGICAL_PROCESSOR_RELATIONSHIP)->Result<(usize,Vec<u8>),String>{let mut size=0u32;unsafe{GetLogicalProcessorInformationEx(relation,std::ptr::null_mut(),&mut size)};if size==0{return Err("topology sizing failed".into());}let mut bytes=vec![0u8;size as usize];if unsafe{GetLogicalProcessorInformationEx(relation,bytes.as_mut_ptr().cast(),&mut size)}==0{return Err("topology query failed".into());}let(mut offset,mut count)=(0usize,0usize);while offset<size as usize{let item=unsafe{&*(bytes.as_ptr().add(offset)as*const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)};if item.Size==0{return Err("zero topology record".into());}count+=1;offset+=item.Size as usize;}if offset!=size as usize{return Err("misaligned topology records".into());}Ok((count,bytes))}
    let cores=count(RelationProcessorCore);let packages=count(RelationProcessorPackage);let numa=count(RelationNumaNodeEx).or_else(|_|count(RelationNumaNode));
    match(cores,packages,numa){(Ok((core_count,core_bytes)),Ok((package_count,_)),Ok((numa_count,_)))=>{let mut efficiency=std::collections::BTreeSet::new();let mut offset=0;while offset<core_bytes.len(){let item=unsafe{&*(core_bytes.as_ptr().add(offset)as*const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)};efficiency.insert(unsafe{item.Anonymous.Processor.EfficiencyClass});offset+=item.Size as usize;}json!({"supported":true,"packages":package_count,"numaNodes":numa_count,"physicalCores":core_count,"logicalCpus":logical,"smt":logical>core_count,"hybrid":efficiency.len()>1})},_=>json!({"supported":false,"reason":"GetLogicalProcessorInformationEx failed"})}
}
#[cfg(target_os="linux")]
fn cpu_topology(logical:usize)->Value{let mut packages=std::collections::BTreeSet::new();let mut cores=std::collections::BTreeSet::new();for cpu in 0..logical{let root=PathBuf::from(format!("/sys/devices/system/cpu/cpu{cpu}/topology"));let package=read_trimmed_opt(&root.join("physical_package_id"));let core=read_trimmed_opt(&root.join("core_id"));if let(Some(package),Some(core))=(package,core){packages.insert(package.clone());cores.insert((package,core));}}let numa=fs::read_dir("/sys/devices/system/node").ok().map(|items|items.flatten().filter(|item|item.file_name().to_string_lossy().starts_with("node")).count()).unwrap_or(0);if packages.is_empty()||cores.is_empty(){json!({"supported":false,"reason":"Linux sysfs topology incomplete"})}else{json!({"supported":true,"packages":packages.len(),"numaNodes":numa,"physicalCores":cores.len(),"logicalCpus":logical,"smt":logical>cores.len(),"hybrid":false})}}
#[cfg(not(any(windows,target_os="linux")))]
fn cpu_topology(_logical:usize)->Value{json!({"supported":false,"reason":"topology probe unsupported"})}

fn clock_metadata() -> Value {
    let unix_ns = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
        let mut ticks = 0_i64; let mut frequency = 0_i64;
        // QPC is the documented monotonic high-resolution Windows counter.
        let ok = unsafe { QueryPerformanceCounter(&mut ticks) != 0 && QueryPerformanceFrequency(&mut frequency) != 0 };
        return json!({"source": "QPC", "unixNs": unix_ns.to_string(), "rawTicks": ticks.to_string(), "frequencyHz": frequency.to_string(), "monotonic": ok});
    }
    #[cfg(target_os = "linux")]
    {
        let mut value = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        let ok = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC_RAW, &mut value) == 0 };
        let ticks = (value.tv_sec as i128) * 1_000_000_000 + value.tv_nsec as i128;
        return json!({"source": "CLOCK_MONOTONIC_RAW", "unixNs": unix_ns.to_string(), "rawTicks": ticks.to_string(), "frequencyHz": "1000000000", "monotonic": ok});
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    json!({"source": "unsupported", "unixNs": unix_ns.to_string(), "supported": false, "reason": "raw monotonic clock unsupported on this platform"})
}

fn validate_affinity(cpus: &[usize]) -> Result<Value, String> {
    let logical = std::thread::available_parallelism().map_err(|error| error.to_string())?.get();
    if cpus.is_empty() || cpus.iter().any(|cpu| *cpu >= logical) { return Err("invalid processor affinity".into()); }
    let mut unique = cpus.to_vec(); unique.sort_unstable(); unique.dedup();
    if unique.len() != cpus.len() { return Err("duplicate processor affinity".into()); }
    Ok(json!({"valid": true, "cpus": cpus, "logicalCpus": logical}))
}

pub fn perf_scale(raw: u64, enabled: u64, running: u64) -> Result<Option<u128>, String> {
    if running > enabled { return Err("time_running exceeds time_enabled".into()); }
    if running == 0 { return Ok(None); }
    Ok(Some((raw as u128).saturating_mul(enabled as u128) / running as u128))
}

pub fn rapl_delta(before: u64, after: u64, range: u64, possible_wraps: u32) -> Result<(u64, u32), String> {
    if range == 0 || before >= range || after >= range { return Err("invalid RAPL range/read".into()); }
    let wraps = u32::from(after < before);
    if possible_wraps > wraps { return Err("ambiguous RAPL wrap".into()); }
    let delta = if wraps == 1 { range - before + after } else { after - before };
    Ok((delta, wraps))
}
pub fn rapl_delta_bounded(before:u64,after:u64,range:u64,elapsed_ns:u64,max_power_uw:u64)->Result<(u64,u32),String>{
    if range==0||before>=range||after>=range||elapsed_ns==0||max_power_uw==0{return Err("invalid RAPL bound/read".into());}
    let bound=(max_power_uw as u128).saturating_mul(elapsed_ns as u128)/1_000_000_000u128;
    let wraps=u32::from(after<before);let delta=if wraps==1{range-before+after}else{after-before};
    if delta as u128>bound{return Err("RAPL delta exceeds max-power bound".into());}
    if (delta as u128).saturating_add(range as u128)<=bound{return Err("ambiguous RAPL wrap".into());}
    Ok((delta,wraps))
}

fn allowed_control(key: &str) -> Option<PathBuf> {
    if key == "turbo" { return Some(PathBuf::from("devices/system/cpu/intel_pstate/no_turbo")); }
    let (cpu, leaf) = key.split_once('.')?;
    if !cpu.starts_with("cpu") || cpu[3..].is_empty() || !cpu[3..].chars().all(|c| c.is_ascii_digit()) { return None; }
    let filename = match leaf { "governor" => "scaling_governor", "min_khz" => "scaling_min_freq", "max_khz" => "scaling_max_freq", _ => return None };
    Some(PathBuf::from(format!("devices/system/cpu/{cpu}/cpufreq/{filename}")))
}

fn safe_relative(path: &Path) -> bool {
    !path.is_absolute() && path.components().all(|part| matches!(part, Component::Normal(_)))
}

fn apply_controls(root: &Path, transaction_path: &Path, controls: BTreeMap<String, Value>) -> Result<Value, String> {
    if controls.is_empty() { return Err("empty control transaction".into()); }
    if transaction_path.exists() { return Err("restore transaction already exists".into()); }
    let mut transaction = RestoreTransaction { version: 1, restored: false, entries: vec![] };
    for (key, value) in &controls {
        let relative = allowed_control(key).ok_or_else(|| format!("control not allowlisted: {key}"))?;
        if !safe_relative(&relative) { return Err("unsafe control path".into()); }
        let path = root.join(&relative);
        let original = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
        transaction.entries.push(RestoreEntry { key:key.clone(), relative, original });
        render_control(key, value)?;
    }
    write_transaction(transaction_path, &transaction)?;
    for (key,value) in &controls {
        let path=root.join(allowed_control(key).ok_or("not allowlisted")?);
        if let Err(error)=write_control(&path,&render_control(key,value)?) { let _=restore(root,transaction_path);return Err(error); }
    }
    for (key, value) in &controls {
        let path = root.join(allowed_control(key).ok_or("not allowlisted")?);
        let actual = match fs::read_to_string(path){Ok(value)=>value.trim().to_owned(),Err(error)=>{let restore_error=restore(root,transaction_path).err();return Err(format!("control read-back failed: {error}{}",restore_error.map(|value|format!("; restore failed: {value}")).unwrap_or_default()));}};
        let expected = render_control(key,value)?;
        if actual != expected.trim() { let restore_error=restore(root, transaction_path).err();return Err(format!("control read-back mismatch: {key}{}",restore_error.map(|value|format!("; restore failed: {value}")).unwrap_or_default())); }
    }
    let before:BTreeMap<String,String>=transaction.entries.iter().map(|entry|(entry.key.clone(),entry.original.trim().to_owned())).collect();
    let after:BTreeMap<String,String>=controls.iter().map(|(key,value)|(key.clone(),render_control(key,value).unwrap_or_default())).collect();
    Ok(json!({"verified": true, "restoreTransaction": transaction_path, "controlsBefore":before,"controlsAfter":after}))
}
fn render_control(key:&str,value:&Value)->Result<String,String>{
    if key=="turbo"{return match value{Value::Bool(enabled)=>Ok(if *enabled{"0".into()}else{"1".into()}),_=>Err("turbo control must be boolean".into())};}
    match value{Value::String(v)=>Ok(v.clone()),Value::Number(v)=>Ok(v.to_string()),_=>Err("frequency control value has wrong type".into())}
}

fn restore(root: &Path, transaction_path: &Path) -> Result<Value, String> {
    let mut transaction: RestoreTransaction = serde_json::from_slice(&fs::read(transaction_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if transaction.restored { return Ok(json!({"restored": true, "idempotent": true})); }
    for entry in transaction.entries.iter().rev() {
        if !safe_relative(&entry.relative) || allowed_path(&entry.relative).is_none() { return Err("transaction contains non-allowlisted path".into()); }
        write_control(&root.join(&entry.relative), entry.original.trim())?;
        let actual=fs::read_to_string(root.join(&entry.relative)).map_err(|e|e.to_string())?;
        if actual.trim()!=entry.original.trim(){return Err("restore read-back mismatch".into());}
    }
    transaction.restored = true;
    write_transaction(transaction_path, &transaction)?;
    Ok(json!({"restored": true}))
}

fn allowed_path(relative: &Path) -> Option<()> {
    if relative == Path::new("devices/system/cpu/intel_pstate/no_turbo") { return Some(()); }
    let text = relative.to_string_lossy().replace('\\', "/");
    let parts: Vec<_> = text.split('/').collect();
    if parts.len() == 6 && parts[0..3] == ["devices", "system", "cpu"] && parts[3].starts_with("cpu") &&
       parts[3][3..].chars().all(|c| c.is_ascii_digit()) && parts[4] == "cpufreq" &&
       ["scaling_governor", "scaling_min_freq", "scaling_max_freq"].contains(&parts[5]) { Some(()) } else { None }
}

fn write_control(path: &Path, value: &str) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() { return Err("control path must be a regular non-symlink file".into()); }
    fs::write(path, value).map_err(|e| e.to_string())
}
fn write_transaction(path: &Path, value: &RestoreTransaction) -> Result<(), String> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    if let Some(parent)=path.parent(){if let Ok(directory)=fs::File::open(parent){let _=directory.sync_all();}}
    Ok(())
}

struct AdapterPolicy{name:String,required:bool}
fn parse_adapters(values:&[String])->Result<Vec<AdapterPolicy>,String>{let mut names=std::collections::BTreeSet::new();values.iter().map(|value|{let(required,name)=value.strip_prefix("optional:").map_or((true,value.as_str()),|name|(false,name));if !["wall-clock","linux-perf","rapl-powercap","rapl-perf","ina","external","null"].contains(&name)||!names.insert(name.to_owned()){return Err("unknown or duplicate adapter".into());}Ok(AdapterPolicy{name:name.to_owned(),required})}).collect()}
fn finish_energy(policy:&[AdapterPolicy],snapshots:Vec<RaplSnapshot>,elapsed_ns:u64)->Vec<Value>{let mut energy=finish_rapl(snapshots,elapsed_ns);for adapter in policy{if adapter.name=="rapl-powercap"&&!energy.iter().any(|item|item.get("adapter").and_then(Value::as_str)==Some("rapl-powercap")){energy.push(json!({"adapter":"rapl-powercap","supported":false,"processEnergy":false,"reason":"no readable RAPL powercap domains"}));}else if adapter.name=="rapl-perf"{energy.push(json!({"adapter":"rapl-perf","supported":false,"processEnergy":false,"reason":"RAPL perf adapter unavailable"}));}else if ["ina","external","null"].contains(&adapter.name.as_str()){energy.push(json!({"adapter":adapter.name,"supported":false,"processEnergy":false,"reason":format!("{} adapter unavailable",adapter.name)}));}}energy}
fn adapter_status(policy:&[AdapterPolicy],perf:Option<&Vec<PerfResult>>,energy:&[Value])->Vec<Value>{policy.iter().map(|adapter|{let supported=match adapter.name.as_str(){"wall-clock"=>true,"linux-perf"=>perf.is_some_and(|items|!items.is_empty()),name if name.starts_with("rapl")=>energy.iter().any(|item|item.get("adapter").and_then(Value::as_str)==Some(name)&&item.get("supported")==Some(&Value::Bool(true))),_=>false};json!({"adapter":adapter.name,"required":adapter.required,"supported":supported,"reason":if supported{"supported"}else{"adapter unavailable for this phase/host"}})}).collect()}

fn run_binary(binary: EligibleBinary, argv: Vec<String>, iterations: String, cpus: Vec<usize>, timeout_ms: u64, job_nonce: String, corpus_identity: String, adapters:Vec<String>) -> Result<Value, String> {
    let adapter_policy=parse_adapters(&adapters)?;
    validate_affinity(&cpus)?;
    if timeout_ms == 0 || timeout_ms > 3_600_000 { return Err("invalid timeout".into()); }
    let iterations_num: u64 = iterations.parse().map_err(|_| "invalid iterations")?;
    if iterations_num == 0 { return Err("iterations must be positive".into()); }
    if binary.corpus_id.is_empty() || binary.sha256.len() != 64 || !binary.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) { return Err("invalid eligible binary descriptor".into()); }
    let trusted_root = std::env::var_os("ISA_SIM_TRUSTED_CORPUS_ROOT").ok_or("trusted corpus root is not configured")?;
    let root = fs::canonicalize(trusted_root).map_err(|e| e.to_string())?;
    let canonical = fs::canonicalize(&binary.path).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root) { return Err("binary is outside configured corpus root".into()); }
    let metadata = fs::symlink_metadata(&binary.path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() { return Err("eligible binary symlink rejected".into()); }
    if !metadata.is_file() || metadata.len().to_string() != binary.size { return Err("eligible binary size mismatch".into()); }
    let (exec_path, _verified_handle) = verified_executable(&canonical, &binary.sha256, metadata.len())?;
    let nonce = decode_b64_32(&job_nonce)?;
    let corpus = decode_hex_32(&corpus_identity)?;
    if sha256_bytes(binary.corpus_id.as_bytes()) != corpus_identity { return Err("corpus identity does not match corpus ID".into()); }
    let control = control_frame(iterations_num, &nonce, &corpus);
    prepare_process_tree()?;
    let mut command=Command::new(&exec_path);command.args(&argv).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)] { use std::os::unix::process::CommandExt;unsafe{command.pre_exec(||{
      #[cfg(target_os="linux")] if libc::prctl(libc::PR_SET_PDEATHSIG,libc::SIGKILL)!=0{return Err(std::io::Error::last_os_error());}
      if libc::setpgid(0,0)!=0{return Err(std::io::Error::last_os_error());}Ok(())
    });} }
    #[cfg(windows)] { use std::os::windows::process::CommandExt;command.creation_flags(0x00000004); }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let process_tree = attach_process_tree(child.id())?;
    if let Err(error) = pin_child(child.id(), &cpus) {
        let _ = child.kill();
        return Err(error);
    }
    let effective = effective_affinity(child.id()).unwrap_or_default();
    let perf_session = if adapter_policy.iter().any(|adapter|adapter.name=="linux-perf"){open_perf_session(child.id())}else{None};
    let stdout = child.stdout.take().ok_or("stdout pipe unavailable")?;
    let stderr = child.stderr.take().ok_or("stderr pipe unavailable")?;
    let (stdout_tx,stdout_rx)=std::sync::mpsc::channel();let(stdout_done_tx,stdout_done_rx)=std::sync::mpsc::channel();
    std::thread::spawn(move ||{let result=read_bounded(stdout,1024*1024);let _=stdout_tx.send(result);let _=stdout_done_tx.send(());});
    let (stderr_tx,stderr_rx)=std::sync::mpsc::channel();let(stderr_done_tx,stderr_done_rx)=std::sync::mpsc::channel();
    std::thread::spawn(move ||{let result=read_bounded(stderr,1024*1024);let _=stderr_tx.send(result);let _=stderr_done_tx.send(());});
    let usage_before = usage_snapshot();
    let rapl_before=if adapter_policy.iter().any(|adapter|adapter.name=="rapl-powercap"){rapl_snapshots(Path::new("/sys/class/powercap"))}else{vec![]};
    let start_ns = monotonic_raw_ns()?;
    let start = Instant::now();
    child.stdin.take().ok_or("stdin pipe unavailable")?.write_all(&control).map_err(|e| e.to_string())?;
    resume_process(&process_tree)?;
    let mut timed_out = false;
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { break; }
        if start.elapsed() >= Duration::from_millis(timeout_ms) { timed_out = true; terminate_process_tree(&process_tree,&mut child); break; }
        std::thread::sleep(Duration::from_millis(2));
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    terminate_process_tree(&process_tree,&mut child);
    terminate_remaining_descendants();
    let end_ns = monotonic_raw_ns()?;
    let energy=finish_energy(&adapter_policy,rapl_before,end_ns.saturating_sub(start_ns));
    let descendant_pipes=stdout_done_rx.recv_timeout(Duration::from_millis(500)).is_err()||stderr_done_rx.recv_timeout(Duration::from_millis(500)).is_err();
    if descendant_pipes{terminate_process_tree(&process_tree,&mut child);}
    let stdout=stdout_rx.recv_timeout(Duration::from_secs(2)).map_err(|_|"stdout reader deadline exceeded")??;
    let stderr=stderr_rx.recv_timeout(Duration::from_secs(2)).map_err(|_|"stderr reader deadline exceeded")??;
    let usage = process_usage(&process_tree,usage_before,usage_snapshot());
    drop(process_tree);
    let perf = finish_perf_session(perf_session);
    let migrations = perf.as_ref().and_then(|items| items.iter().find(|item| item.name=="cpu-migrations")).and_then(|item| item.raw.parse::<u64>().ok());
    let oracle = parse_oracle(&stdout.bytes, iterations_num, &nonce, &corpus);
    let mut reasons = vec![];
    if timed_out { reasons.push("timeout"); }
    if stdout.exceeded || stderr.exceeded { reasons.push("output-cap-exceeded"); }
    if !status.success() { reasons.push("nonzero-or-signal"); }
    if oracle.is_err() { reasons.push("oracle-frame-invalid"); }
    if effective != cpus { reasons.push("affinity-readback-mismatch"); }
    if usage.is_none() { reasons.push("resource-usage-unavailable"); }
    if descendant_pipes { reasons.push("descendant-retained-output-pipes"); }
    let perf_required=adapter_policy.iter().any(|adapter|adapter.required&&adapter.name=="linux-perf");
    if perf_required&&migrations.is_none() { reasons.push("perf-migration-evidence-unavailable"); }
    if perf_required&&!cfg!(target_os="linux") { reasons.push("context-switch-and-fault-evidence-unavailable"); }
    if adapter_policy.iter().any(|adapter|adapter.required&&adapter.name.starts_with("rapl"))&&!energy.iter().any(|item|item.get("supported")==Some(&Value::Bool(true))){reasons.push("required-energy-evidence-unavailable");}
    let adapter_status=adapter_status(&adapter_policy,perf.as_ref(),&energy);
    if adapter_status.iter().any(|item|item.get("required")==Some(&Value::Bool(true))&&item.get("supported")==Some(&Value::Bool(false))){reasons.push("required-adapter-unavailable");}
    let valid = reasons.is_empty();
    let (clock_source,clock_uncertainty)=clock_evidence()?;
    let (user_ns, system_ns, minor, major, voluntary, involuntary) = usage.unwrap_or((0,0,0,0,0,0));
    let context_evidence=if cfg!(target_os="linux"){json!({"voluntary":voluntary,"involuntary":involuntary})}else{Value::Null};
    let fault_evidence=if cfg!(target_os="linux"){json!({"minor":minor,"major":major})}else{Value::Null};
    Ok(json!({
        "valid": valid, "validityReasons": reasons, "monotonicStartedNs": start_ns.to_string(),
        "monotonicDurationNs": end_ns.saturating_sub(start_ns).to_string(), "userCpuNs": user_ns.to_string(),
        "systemCpuNs": system_ns.to_string(), "exitCode": status.code(), "signal": exit_signal(&status),
        "timedOut": timed_out, "stdoutSha256": sha256_bytes(&stdout.bytes), "stderrSha256": sha256_bytes(&stderr.bytes),
        "oraclePassed": oracle.is_ok(), "oracleDetail": oracle.unwrap_or_else(|error| error),
        "oracleIterations": iterations_num.to_string(), "oracleNonce": job_nonce, "affinity": {"requested": cpus, "effective": effective},
        "contextSwitches": context_evidence, "migrations": migrations,
        "faults": fault_evidence, "perf": perf.unwrap_or_default(), "energy": energy, "adapterStatus":adapter_status,"sensors": [],
        "clockSource": clock_source, "clockUncertaintyNs": clock_uncertainty.to_string(), "temperatureC": null, "frequencyKHz": null, "throttle": null, "controlsBefore": {}, "controlsAfter": {}
    }))
}

fn idle(duration_ns: String, cpus: Vec<usize>,adapters:Vec<String>) -> Result<Value, String> {
    let adapter_policy=parse_adapters(&adapters)?;
    validate_affinity(&cpus)?;
    let duration: u64 = duration_ns.parse().map_err(|_| "invalid idle duration")?;
    if duration == 0 || duration > 1_000_000_000 { return Err("idle duration out of bounds".into()); }
    let affinity=pin_idle_thread(&cpus)?;
    let perf_session=if adapter_policy.iter().any(|adapter|adapter.name=="linux-perf"){open_perf_session(std::process::id())}else{None};
    let rapl_before=if adapter_policy.iter().any(|adapter|adapter.name=="rapl-powercap"){rapl_snapshots(Path::new("/sys/class/powercap"))}else{vec![]};
    let start = monotonic_raw_ns()?;
    std::thread::sleep(Duration::from_nanos(duration));
    let end = monotonic_raw_ns()?;
    let perf=finish_perf_session(perf_session);
    let energy=finish_energy(&adapter_policy,rapl_before,end.saturating_sub(start));
    let mut reasons=if affinity==cpus{vec![]}else{vec!["idle-affinity-readback-mismatch"]};
    if adapter_policy.iter().any(|adapter|adapter.required&&adapter.name=="linux-perf")&&perf.as_ref().is_none_or(|items|items.is_empty()){reasons.push("required-perf-evidence-unavailable");}
    if adapter_policy.iter().any(|adapter|adapter.required&&adapter.name.starts_with("rapl"))&&!energy.iter().any(|item|item.get("supported")==Some(&Value::Bool(true))){reasons.push("required-energy-evidence-unavailable");}
    let adapter_status=adapter_status(&adapter_policy,perf.as_ref(),&energy);
    if adapter_status.iter().any(|item|item.get("required")==Some(&Value::Bool(true))&&item.get("supported")==Some(&Value::Bool(false))){reasons.push("required-adapter-unavailable");}
    let (clock_source,clock_uncertainty)=clock_evidence()?;
    Ok(json!({"valid": reasons.is_empty(), "validityReasons":reasons, "monotonicStartedNs": start.to_string(), "monotonicDurationNs": end.saturating_sub(start).to_string(), "userCpuNs": "0", "systemCpuNs": "0", "exitCode": 0, "signal": null, "timedOut": false, "stdoutSha256": sha256_bytes(&[]), "stderrSha256": sha256_bytes(&[]), "oraclePassed": true, "oracleDetail": "true-idle-no-child", "oracleIterations":"0","oracleNonce":"","affinity": {"requested": cpus, "effective": affinity}, "contextSwitches": {"voluntary": 0, "involuntary": 0}, "migrations": 0, "faults": {"minor": 0, "major": 0}, "perf": perf.unwrap_or_default(), "energy": energy,"adapterStatus":adapter_status, "sensors": [], "clockSource":clock_source,"clockUncertaintyNs": clock_uncertainty.to_string(), "temperatureC": null, "frequencyKHz": null, "throttle": null, "controlsBefore": {}, "controlsAfter": {}}))
}

struct BoundedOutput { bytes: Vec<u8>, exceeded: bool }
fn read_bounded<R: Read>(mut reader: R, cap: usize) -> Result<BoundedOutput, String> {
    let mut bytes = vec![]; let mut buffer = [0u8; 8192]; let mut exceeded = false;
    loop {
        let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        if bytes.len() + count <= cap { bytes.extend_from_slice(&buffer[..count]); } else { exceeded = true; }
    }
    Ok(BoundedOutput { bytes, exceeded })
}
fn control_frame(iterations: u64, nonce: &[u8;32], corpus: &[u8;32]) -> Vec<u8> {
    let mut value=vec![0u8;80]; value[0..4].copy_from_slice(&0x43415349u32.to_le_bytes());
    value[4..6].copy_from_slice(&1u16.to_le_bytes()); value[8..16].copy_from_slice(&iterations.to_le_bytes());
    value[16..48].copy_from_slice(nonce); value[48..80].copy_from_slice(corpus); value
}
fn parse_oracle(bytes:&[u8], iterations:u64, nonce:&[u8;32], corpus:&[u8;32])->Result<String,String>{
    if bytes.len()!=112{return Err("oracle frame size invalid".into());}
    if u32::from_le_bytes(bytes[0..4].try_into().unwrap())!=0x46415349||u16::from_le_bytes(bytes[4..6].try_into().unwrap())!=1||bytes[6]!=0||u32::from_le_bytes(bytes[16..20].try_into().unwrap())!=0||u32::from_le_bytes(bytes[20..24].try_into().unwrap())!=0{return Err("result frame invalid".into());}
    let offset=bytes.len()-88;let frame=&bytes[offset..];
    if u32::from_le_bytes(frame[0..4].try_into().unwrap())!=0x4f415349||u16::from_le_bytes(frame[4..6].try_into().unwrap())!=1||frame[6]!=0{return Err("oracle header invalid".into());}
    if u64::from_le_bytes(frame[8..16].try_into().unwrap())!=iterations{return Err("oracle iterations mismatch".into());}
    if frame[16..24]!=bytes[8..16]{return Err("oracle result mismatch".into());}
    if &frame[24..56]!=nonce||&frame[56..88]!=corpus{return Err("oracle nonce/corpus mismatch".into());}
    Ok(format!("oracle-v1 iterations={iterations}"))
}
fn decode_b64_32(value:&str)->Result<[u8;32],String>{
    use base64::Engine;let bytes=base64::engine::general_purpose::STANDARD.decode(value).map_err(|_|"invalid nonce base64")?;
    if base64::engine::general_purpose::STANDARD.encode(&bytes)!=value{return Err("noncanonical nonce base64".into());}
    bytes.try_into().map_err(|_|"nonce must be 32 bytes".into())
}
fn decode_hex_32(value:&str)->Result<[u8;32],String>{
    if value.len()!=64{return Err("corpus identity must be SHA-256".into());}
    let mut out=[0u8;32];for i in 0..32{out[i]=u8::from_str_radix(&value[i*2..i*2+2],16).map_err(|_|"invalid corpus identity")?;}Ok(out)
}
fn monotonic_raw_ns()->Result<u64,String>{
    #[cfg(target_os="linux")] { let mut ts=libc::timespec{tv_sec:0,tv_nsec:0};if unsafe{libc::clock_gettime(libc::CLOCK_MONOTONIC_RAW,&mut ts)}!=0{return Err(std::io::Error::last_os_error().to_string());}return Ok(ts.tv_sec as u64*1_000_000_000+ts.tv_nsec as u64); }
    #[cfg(windows)] { use windows_sys::Win32::System::Performance::{QueryPerformanceCounter,QueryPerformanceFrequency};let(mut ticks,mut freq)=(0i64,0i64);if unsafe{QueryPerformanceCounter(&mut ticks)==0||QueryPerformanceFrequency(&mut freq)==0}{return Err("QPC unavailable".into());}return Ok((ticks as u128*1_000_000_000u128/freq as u128) as u64); }
    #[cfg(not(any(target_os="linux",windows)))] Err("raw monotonic clock unsupported".into())
}
fn clock_evidence()->Result<(&'static str,u64),String>{
    #[cfg(target_os="linux")] { return Ok(("CLOCK_MONOTONIC_RAW",1)); }
    #[cfg(windows)] { use windows_sys::Win32::System::Performance::QueryPerformanceFrequency;let mut frequency=0i64;if unsafe{QueryPerformanceFrequency(&mut frequency)}==0||frequency<=0{return Err("QPC frequency unavailable".into());}return Ok(("QPC",(1_000_000_000u64+frequency as u64-1)/frequency as u64)); }
    #[cfg(not(any(target_os="linux",windows)))] Err("clock evidence unavailable".into())
}
#[cfg(target_os="linux")]
fn pin_idle_thread(cpus:&[usize])->Result<Vec<usize>,String>{pin_child(0,cpus)?;effective_affinity(0)}
#[cfg(windows)]
fn pin_idle_thread(cpus:&[usize])->Result<Vec<usize>,String>{
    use windows_sys::Win32::System::Threading::{GetCurrentThread,GetThreadGroupAffinity,SetThreadAffinityMask};
    use windows_sys::Win32::System::SystemInformation::GROUP_AFFINITY;
    if cpus.iter().any(|cpu|*cpu>=usize::BITS as usize){return Err("idle processor group unsupported".into());}
    let mask=cpus.iter().fold(0usize,|value,cpu|value|(1usize<<cpu));
    let thread=unsafe{GetCurrentThread()};if unsafe{SetThreadAffinityMask(thread,mask)}==0{return Err("idle affinity set failed".into());}
    let mut group:GROUP_AFFINITY=unsafe{std::mem::zeroed()};if unsafe{GetThreadGroupAffinity(thread,&mut group)}==0{return Err("idle affinity readback failed".into());}
    Ok((0..usize::BITS as usize).filter(|cpu|group.Mask&(1usize<<cpu)!=0).collect())
}
#[cfg(not(any(target_os="linux",windows)))]
fn pin_idle_thread(_cpus:&[usize])->Result<Vec<usize>,String>{Err("idle affinity unsupported".into())}
#[cfg(target_os="linux")]
fn usage_snapshot()->Option<(u64,u64,u64,u64,u64,u64)>{let mut r:libc::rusage=unsafe{std::mem::zeroed()};if unsafe{libc::getrusage(libc::RUSAGE_CHILDREN,&mut r)}!=0{return None;}Some((timeval_ns(r.ru_utime),timeval_ns(r.ru_stime),r.ru_minflt as u64,r.ru_majflt as u64,r.ru_nvcsw as u64,r.ru_nivcsw as u64))}
#[cfg(target_os="linux")]
fn timeval_ns(v:libc::timeval)->u64{v.tv_sec as u64*1_000_000_000+v.tv_usec as u64*1000}
#[cfg(not(target_os="linux"))]
fn usage_snapshot()->Option<(u64,u64,u64,u64,u64,u64)>{None}
#[cfg(not(windows))]
fn usage_delta(a:Option<(u64,u64,u64,u64,u64,u64)>,b:Option<(u64,u64,u64,u64,u64,u64)>)->Option<(u64,u64,u64,u64,u64,u64)>{match(a,b){(Some(a),Some(b))=>Some((b.0.saturating_sub(a.0),b.1.saturating_sub(a.1),b.2.saturating_sub(a.2),b.3.saturating_sub(a.3),b.4.saturating_sub(a.4),b.5.saturating_sub(a.5))),_=>None}}
#[cfg(not(windows))]
fn process_usage(_tree:&ProcessTree,a:Option<(u64,u64,u64,u64,u64,u64)>,b:Option<(u64,u64,u64,u64,u64,u64)>)->Option<(u64,u64,u64,u64,u64,u64)>{usage_delta(a,b)}
#[cfg(windows)]
fn process_usage(tree:&ProcessTree,_a:Option<(u64,u64,u64,u64,u64,u64)>,_b:Option<(u64,u64,u64,u64,u64,u64)>)->Option<(u64,u64,u64,u64,u64,u64)>{
    use windows_sys::Win32::Foundation::FILETIME;use windows_sys::Win32::System::Threading::GetProcessTimes;
    let(mut creation,mut exit,mut kernel,mut user)=unsafe{(std::mem::zeroed::<FILETIME>(),std::mem::zeroed::<FILETIME>(),std::mem::zeroed::<FILETIME>(),std::mem::zeroed::<FILETIME>())};
    if unsafe{GetProcessTimes(tree.process,&mut creation,&mut exit,&mut kernel,&mut user)}==0{return None;}
    let ns=|value:FILETIME|(((value.dwHighDateTime as u64)<<32)|value.dwLowDateTime as u64)*100;
    Some((ns(user),ns(kernel),0,0,0,0))
}
#[cfg(unix)]
fn exit_signal(status:&std::process::ExitStatus)->Option<i32>{use std::os::unix::process::ExitStatusExt;status.signal()}
#[cfg(not(unix))]
fn exit_signal(_status:&std::process::ExitStatus)->Option<i32>{None}
#[cfg(target_os="linux")]
fn prepare_process_tree()->Result<(),String>{if unsafe{libc::prctl(libc::PR_SET_CHILD_SUBREAPER,1)}!=0{Err(std::io::Error::last_os_error().to_string())}else{Ok(())}}
#[cfg(not(target_os="linux"))]
fn prepare_process_tree()->Result<(),String>{Ok(())}
#[cfg(target_os="linux")]
fn terminate_remaining_descendants(){let self_pid=std::process::id()as i32;for _ in 0..8{let mut descendants=vec![];if let Ok(items)=fs::read_dir("/proc"){for item in items.flatten(){let Ok(pid)=item.file_name().to_string_lossy().parse::<i32>()else{continue};let Ok(stat)=fs::read_to_string(item.path().join("stat"))else{continue};let Some(rest)=stat.rsplit_once(") ").map(|(_,rest)|rest)else{continue};let parent=rest.split_whitespace().nth(1).and_then(|value|value.parse::<i32>().ok());if parent==Some(self_pid){descendants.push(pid);}}}if descendants.is_empty(){break;}for pid in descendants{unsafe{libc::kill(pid,libc::SIGKILL);}}std::thread::sleep(Duration::from_millis(10));while unsafe{libc::waitpid(-1,std::ptr::null_mut(),libc::WNOHANG)}>0{}}}
#[cfg(not(target_os="linux"))]
fn terminate_remaining_descendants(){}
#[cfg(windows)]
struct ProcessTree{job:windows_sys::Win32::Foundation::HANDLE,process:windows_sys::Win32::Foundation::HANDLE}
#[cfg(windows)]
impl Drop for ProcessTree{fn drop(&mut self){unsafe{windows_sys::Win32::Foundation::CloseHandle(self.process);windows_sys::Win32::Foundation::CloseHandle(self.job);}}}
#[cfg(windows)]
fn attach_process_tree(pid:u32)->Result<ProcessTree,String>{
    use windows_sys::Win32::System::JobObjects::*;use windows_sys::Win32::System::Threading::*;
    let job=unsafe{CreateJobObjectW(std::ptr::null(),std::ptr::null())};if job.is_null(){return Err("CreateJobObject failed".into());}
    let mut info:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=unsafe{std::mem::zeroed()};info.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe{SetInformationJobObject(job,JobObjectExtendedLimitInformation,&info as *const _ as _,std::mem::size_of_val(&info)as u32)}==0{unsafe{windows_sys::Win32::Foundation::CloseHandle(job)};return Err("SetInformationJobObject failed".into());}
    let process=unsafe{OpenProcess(PROCESS_SET_QUOTA|PROCESS_TERMINATE|PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_SUSPEND_RESUME,0,pid)};if process.is_null(){unsafe{windows_sys::Win32::Foundation::CloseHandle(job)};return Err("OpenProcess for Job Object failed".into());}
    let assigned=unsafe{AssignProcessToJobObject(job,process)!=0};if !assigned{unsafe{windows_sys::Win32::Foundation::CloseHandle(process);windows_sys::Win32::Foundation::CloseHandle(job)};return Err("AssignProcessToJobObject failed".into());}Ok(ProcessTree{job,process})
}
#[cfg(windows)]
fn resume_process(tree:&ProcessTree)->Result<(),String>{#[link(name="ntdll")]unsafe extern "system"{fn NtResumeProcess(handle:windows_sys::Win32::Foundation::HANDLE)->i32;}if unsafe{NtResumeProcess(tree.process)}<0{Err("NtResumeProcess failed".into())}else{Ok(())}}
#[cfg(not(windows))]
struct ProcessTree;
#[cfg(not(windows))]
fn attach_process_tree(_pid:u32)->Result<ProcessTree,String>{Ok(ProcessTree)}
#[cfg(not(windows))]
fn resume_process(_tree:&ProcessTree)->Result<(),String>{Ok(())}
fn terminate_process_tree(tree:&ProcessTree,child:&mut std::process::Child){
    #[cfg(windows)]unsafe{windows_sys::Win32::System::JobObjects::TerminateJobObject(tree.job,124);}
    #[cfg(unix)]unsafe{libc::kill(-(child.id() as i32),libc::SIGTERM);std::thread::sleep(Duration::from_millis(50));libc::kill(-(child.id() as i32),libc::SIGKILL);}
    let _=child.kill();
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct PerfResult { name:String, raw:String, scaled:String, time_enabled_ns:String, time_running_ns:String, group:String }
#[cfg(target_os="linux")]
struct PerfSession(Vec<(String,i32)>);
#[cfg(not(target_os="linux"))]
struct PerfSession;
#[cfg(target_os="linux")]
fn open_perf_session(pid:u32)->Option<PerfSession>{
    const EVENTS:[(&str,u64);5]=[("context-switches",3),("cpu-migrations",4),("page-faults",2),("minor-faults",5),("major-faults",6)];
    let mut result=vec![];
    for(name,config)in EVENTS{let mut attr=[0u8;128];attr[0..4].copy_from_slice(&1u32.to_ne_bytes());attr[4..8].copy_from_slice(&128u32.to_ne_bytes());attr[8..16].copy_from_slice(&config.to_ne_bytes());attr[32..40].copy_from_slice(&3u64.to_ne_bytes());attr[40..48].copy_from_slice(&1u64.to_ne_bytes());
      let fd=unsafe{libc::syscall(libc::SYS_perf_event_open,attr.as_ptr(),pid as i32,-1,-1,8usize)as i32};if fd<0{for(_,fd)in result{unsafe{libc::close(fd);}}return None;}result.push((name.to_owned(),fd));}
    for(_,fd)in &result{unsafe{libc::ioctl(*fd,0x2403,0);libc::ioctl(*fd,0x2400,0);}}Some(PerfSession(result))
}
#[cfg(not(target_os="linux"))]
fn open_perf_session(_pid:u32)->Option<PerfSession>{None}
#[cfg(target_os="linux")]
fn finish_perf_session(session:Option<PerfSession>)->Option<Vec<PerfResult>>{let mut output=vec![];for(name,fd)in session?.0{unsafe{libc::ioctl(fd,0x2401,0);}let mut values=[0u64;3];let count=unsafe{libc::read(fd,values.as_mut_ptr().cast(),24)};unsafe{libc::close(fd);}if count!=24{return None;}let scaled=if values[2]==0{"0".into()}else{((values[0]as u128*values[1]as u128)/values[2]as u128).to_string()};output.push(PerfResult{name,raw:values[0].to_string(),scaled,time_enabled_ns:values[1].to_string(),time_running_ns:values[2].to_string(),group:"software-evidence".into()});}Some(output)}
#[cfg(not(target_os="linux"))]
fn finish_perf_session(_session:Option<PerfSession>)->Option<Vec<PerfResult>>{None}

#[cfg(windows)]
fn pin_child(pid: u32, cpus: &[usize]) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, SetProcessAffinityMask, PROCESS_SET_INFORMATION};
    if cpus.iter().any(|cpu| *cpu >= usize::BITS as usize) {
        return Err("processor-group affinity above the first group is unsupported".into());
    }
    let mask = cpus.iter().fold(0usize, |value, cpu| value | (1usize << cpu));
    let handle = unsafe { OpenProcess(PROCESS_SET_INFORMATION, 0, pid) };
    if handle.is_null() { return Err("OpenProcess for affinity failed".into()); }
    let ok = unsafe { SetProcessAffinityMask(handle, mask) != 0 };
    unsafe { CloseHandle(handle); }
    if ok { Ok(()) } else { Err("SetProcessAffinityMask failed".into()) }
}

#[cfg(target_os = "linux")]
fn pin_child(pid: u32, cpus: &[usize]) -> Result<(), String> {
    let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::CPU_ZERO(&mut set);
        for cpu in cpus { libc::CPU_SET(*cpu, &mut set); }
        if libc::sched_setaffinity(pid as libc::pid_t, std::mem::size_of::<libc::cpu_set_t>(), &set) != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}
#[cfg(target_os="linux")]
fn effective_affinity(pid:u32)->Result<Vec<usize>,String>{let mut set:libc::cpu_set_t=unsafe{std::mem::zeroed()};if unsafe{libc::sched_getaffinity(pid as i32,std::mem::size_of::<libc::cpu_set_t>(),&mut set)}!=0{return Err(std::io::Error::last_os_error().to_string());}Ok((0..libc::CPU_SETSIZE as usize).filter(|cpu|unsafe{libc::CPU_ISSET(*cpu,&set)}).collect())}
#[cfg(windows)]
fn effective_affinity(pid:u32)->Result<Vec<usize>,String>{use windows_sys::Win32::Foundation::CloseHandle;use windows_sys::Win32::System::Threading::{GetProcessAffinityMask,OpenProcess,PROCESS_QUERY_LIMITED_INFORMATION};let handle=unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,pid)};if handle.is_null(){return Err("OpenProcess affinity readback failed".into());}let(mut process_mask,mut system_mask)=(0usize,0usize);let ok=unsafe{GetProcessAffinityMask(handle,&mut process_mask,&mut system_mask)!=0};unsafe{CloseHandle(handle);}if !ok{return Err("GetProcessAffinityMask failed".into());}Ok((0..usize::BITS as usize).filter(|cpu|process_mask&(1usize<<cpu)!=0).collect())}
#[cfg(not(any(windows,target_os="linux")))]
fn effective_affinity(_pid:u32)->Result<Vec<usize>,String>{Err("affinity readback unsupported".into())}

#[cfg(not(any(windows, target_os = "linux")))]
fn pin_child(_pid: u32, _cpus: &[usize]) -> Result<(), String> {
    Err("processor affinity unsupported on this platform".into())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?; let mut bytes = vec![];
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?; Ok(sha256_bytes(&bytes))
}
#[cfg(target_os="linux")]
fn verified_executable(path:&Path,expected:&str,size:u64)->Result<(PathBuf,Option<fs::File>),String>{
    use std::os::fd::AsRawFd;use std::os::unix::fs::OpenOptionsExt;
    let mut file=OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).map_err(|e|e.to_string())?;
    if unsafe{libc::fcntl(file.as_raw_fd(),libc::F_SETFD,0)}!=0{return Err(std::io::Error::last_os_error().to_string());}
    let meta=file.metadata().map_err(|e|e.to_string())?;if !meta.is_file()||meta.len()!=size{return Err("verified descriptor metadata mismatch".into());}
    let mut bytes=vec![];file.read_to_end(&mut bytes).map_err(|e|e.to_string())?;if sha256_bytes(&bytes)!=expected{return Err("eligible binary hash mismatch".into());}
    Ok((PathBuf::from(format!("/proc/self/fd/{}",file.as_raw_fd())),Some(file)))
}
#[cfg(windows)]
fn verified_executable(path:&Path,expected:&str,size:u64)->Result<(PathBuf,Option<fs::File>),String>{
    let mut source=OpenOptions::new().read(true).open(path).map_err(|e|e.to_string())?;let meta=source.metadata().map_err(|e|e.to_string())?;
    if !meta.is_file()||meta.len()!=size{return Err("eligible binary metadata mismatch".into());}
    let mut bytes=vec![];source.read_to_end(&mut bytes).map_err(|e|e.to_string())?;if sha256_bytes(&bytes)!=expected{return Err("eligible binary hash mismatch".into());}
    let trusted=fs::canonicalize(std::env::var_os("ISA_SIM_TRUSTED_CORPUS_ROOT").ok_or("trusted corpus root is not configured")?).map_err(|e|e.to_string())?;
    let cache=trusted.join(".verified-cache");fs::create_dir_all(&cache).map_err(|e|e.to_string())?;let executable=cache.join(format!("{expected}.exe"));
    if !executable.exists(){let mut output=OpenOptions::new().create_new(true).write(true).open(&executable).map_err(|e|e.to_string())?;output.write_all(&bytes).and_then(|_|output.sync_all()).map_err(|e|e.to_string())?;}
    if sha256_file(&executable)?!=expected{return Err("verified executable cache collision".into());}Ok((executable,None))
}
#[cfg(not(any(target_os="linux",windows)))]
fn verified_executable(path:&Path,expected:&str,size:u64)->Result<(PathBuf,Option<fs::File>),String>{
    let meta=fs::metadata(path).map_err(|e|e.to_string())?;if !meta.is_file()||meta.len()!=size||sha256_file(path)?!=expected{return Err("eligible binary hash mismatch".into());}Ok((path.to_path_buf(),None))
}
fn sha256_bytes(bytes: &[u8]) -> String {
    // SHA-256 is kept internal to avoid invoking arbitrary tools.
    let mut state = Sha256::new(); state.update(bytes); state.finish()
}

fn discover_rapl(root: &Path) -> Result<Value, String> {
    if !cfg!(target_os="linux") && !cfg!(feature="test-only-fixture"){return Ok(json!({"supported":false,"reason":"RAPL powercap is Linux-only","domains":[]}));}
    let mut domains = vec![];discover_rapl_recursive(root,root,&mut domains)?;
    if domains.is_empty(){Ok(json!({"supported":false,"reason":"no readable RAPL domains","domains":[]}))}
    else{Ok(json!({"supported":true,"domains":domains}))}
}
struct RaplSnapshot{name:String,path:PathBuf,range:u64,before:u64,max_power:u64}
fn rapl_snapshots(root:&Path)->Vec<RaplSnapshot>{if !cfg!(target_os="linux"){return vec![];}let mut output=vec![];fn walk(path:&Path,out:&mut Vec<RaplSnapshot>){let Ok(items)=fs::read_dir(path)else{return};for item in items.flatten(){let child=item.path();if !child.is_dir(){continue;}let name=read_trimmed_opt(&child.join("name"));let range=read_trimmed_opt(&child.join("max_energy_range_uj")).and_then(|v|v.parse().ok());let before=read_trimmed_opt(&child.join("energy_uj")).and_then(|v|v.parse().ok());let max_power=read_trimmed_opt(&child.join("constraint_0_max_power_uw")).and_then(|v|v.parse().ok());if let(Some(name),Some(range),Some(before),Some(max_power))=(name,range,before,max_power){out.push(RaplSnapshot{name,path:child.join("energy_uj"),range,before,max_power});}walk(&child,out);}}walk(root,&mut output);output}
fn finish_rapl(snapshots:Vec<RaplSnapshot>,elapsed_ns:u64)->Vec<Value>{snapshots.into_iter().map(|item|{let after=read_trimmed_opt(&item.path).and_then(|v|v.parse::<u64>().ok());match after.and_then(|after|rapl_delta_bounded(item.before,after,item.range,elapsed_ns,item.max_power).ok().map(|(delta,wraps)|(after,delta,wraps))){Some((after,delta,wraps))=>json!({"adapter":"rapl-powercap","supported":true,"grossJoules":delta as f64/1_000_000.0,"domain":item.name,"processEnergy":false,"wrapCount":wraps,"beforeUj":item.before.to_string(),"afterUj":after.to_string(),"maxRangeUj":item.range.to_string()}),None=>json!({"adapter":"rapl-powercap","supported":false,"processEnergy":false,"domain":item.name,"reason":"RAPL read/wrap evidence unavailable"})}}).collect()}
fn discover_rapl_recursive(root:&Path,path:&Path,domains:&mut Vec<Value>)->Result<(),String>{
    for item in fs::read_dir(path).map_err(|e|e.to_string())?.flatten(){let child=item.path();if !item.file_type().map(|t|t.is_dir()).unwrap_or(false){continue;}
      if let(Some(name),Some(range))=(read_trimmed_opt(&child.join("name")),read_trimmed_opt(&child.join("max_energy_range_uj"))){let energy=child.join("energy_uj");let readable=fs::File::open(&energy).is_ok();domains.push(json!({"name":name,"scope":child.strip_prefix(root).unwrap_or(&child),"energyUj":energy,"maxRangeUj":range,"readable":readable}));}
      discover_rapl_recursive(root,&child,domains)?;
    }Ok(())
}

fn thermal_frequency(root: &Path) -> Result<Value, String> {
    if !cfg!(target_os = "linux") { return Ok(json!({"supported": false, "reason": "Linux sysfs only"})); }
    let frequency=read_trimmed_opt(&root.join("devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"));
    if frequency.is_none(){Ok(json!({"supported":false,"reason":"no validated thermal/frequency/throttle evidence"}))}
    else{Ok(json!({"supported":false,"reason":"frequency exists but thermal and throttle evidence are incomplete","frequencyKHz":frequency}))}
}
fn read_trimmed(path: &Path) -> Value { read_trimmed_opt(path).map_or(Value::Null, Value::String) }
fn read_trimmed_opt(path: &Path) -> Option<String> { fs::read_to_string(path).ok().map(|v| v.trim().to_owned()) }

struct Sha256 { state: [u32; 8], data: Vec<u8>, len: u64 }
impl Sha256 {
    fn new() -> Self { Self { state: [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], data: vec![], len: 0 } }
    fn update(&mut self, bytes: &[u8]) { self.data.extend_from_slice(bytes); self.len += bytes.len() as u64; }
    fn finish(mut self) -> String {
        let bit_len = self.len * 8; self.data.push(0x80); while self.data.len() % 64 != 56 { self.data.push(0); } self.data.extend_from_slice(&bit_len.to_be_bytes());
        for chunk in self.data.chunks(64) {
            let mut w=[0u32;64]; for (i, word) in chunk.chunks(4).enumerate(){w[i]=u32::from_be_bytes(word.try_into().unwrap());}
            for i in 16..64 { let s0=w[i-15].rotate_right(7)^w[i-15].rotate_right(18)^(w[i-15]>>3); let s1=w[i-2].rotate_right(17)^w[i-2].rotate_right(19)^(w[i-2]>>10); w[i]=w[i-16].wrapping_add(s0).wrapping_add(w[i-7]).wrapping_add(s1); }
            let mut v=self.state; for i in 0..64 { let s1=v[4].rotate_right(6)^v[4].rotate_right(11)^v[4].rotate_right(25); let ch=(v[4]&v[5])^(!v[4]&v[6]); let t1=v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]); let s0=v[0].rotate_right(2)^v[0].rotate_right(13)^v[0].rotate_right(22); let maj=(v[0]&v[1])^(v[0]&v[2])^(v[1]&v[2]); let t2=s0.wrapping_add(maj); v=[t1.wrapping_add(t2),v[0],v[1],v[2],v[3].wrapping_add(t1),v[4],v[5],v[6]]; }
            for i in 0..8 { self.state[i]=self.state[i].wrapping_add(v[i]); }
        }
        self.state.iter().map(|v| format!("{v:08x}")).collect()
    }
}
const K:[u32;64]=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
