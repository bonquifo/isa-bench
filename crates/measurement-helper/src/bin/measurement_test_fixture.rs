// Built only with the test-only-fixture feature; never part of production helper builds.
use std::io::{self, Read, Write};

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "busy".into());
    if mode == "marker-child" {
        let marker=std::env::args().nth(2).expect("marker path");
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::fs::write(marker,b"survived").unwrap();
        return;
    }
    let mut control = [0u8; 80];
    if io::stdin().read_exact(&mut control).is_err() ||
        u32::from_le_bytes(control[0..4].try_into().unwrap()) != 0x43415349 ||
        u16::from_le_bytes(control[4..6].try_into().unwrap()) != 1 {
        std::process::exit(2);
    }
    let iterations = u64::from_le_bytes(control[8..16].try_into().unwrap());
    if iterations == 0 || iterations > 10_000_000 { std::process::exit(3); }
    if mode == "signal" { std::process::abort(); }
    if mode == "timeout" { std::thread::sleep(std::time::Duration::from_secs(10)); }
    if mode == "malformed" { io::stdout().write_all(b"not-an-oracle").unwrap(); return; }
    if mode == "output" { io::stdout().write_all(&vec![b'x'; 1024 * 1024 + 1]).unwrap(); }
    if mode == "grandchild" || mode=="detached-grandchild" {
        let marker=std::env::args().nth(2).expect("marker path");
        let mut command=std::process::Command::new(std::env::current_exe().unwrap());command.args(["marker-child",&marker]);
        if mode=="detached-grandchild"{command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());#[cfg(unix)]{use std::os::unix::process::CommandExt;unsafe{command.pre_exec(||{if libc::setsid()<0{return Err(std::io::Error::last_os_error());}Ok(())});}}}
        command.spawn().unwrap();
    }
    let mut result = 0u64;
    for index in 0..iterations {
        for inner in 0..10_000u64 {
            result = result.wrapping_add(index ^ inner).rotate_left(7);
            std::hint::black_box(result);
        }
    }
    let mut output = [0u8; 112];
    output[0..4].copy_from_slice(&0x46415349u32.to_le_bytes());
    output[4..6].copy_from_slice(&1u16.to_le_bytes());
    output[8..16].copy_from_slice(&result.to_le_bytes());
    output[24..28].copy_from_slice(&0x4f415349u32.to_le_bytes());
    output[28..30].copy_from_slice(&1u16.to_le_bytes());
    output[32..40].copy_from_slice(&(if mode == "ignore" { 1 } else { iterations }).to_le_bytes());
    output[40..48].copy_from_slice(&result.to_le_bytes());
    output[48..112].copy_from_slice(&control[16..80]);
    io::stdout().write_all(&output).unwrap();
}
