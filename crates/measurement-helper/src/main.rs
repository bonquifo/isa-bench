use measurement_helper::{Request, handle};
use serde_json::json;
use std::io::{self, Read};

fn main() {
    let mut input = Vec::new();
    if let Err(error) = io::stdin().take(1024 * 1024).read_to_end(&mut input) {
        emit_error(&format!("read request: {error}"));
        return;
    }
    if input.len() >= 1024 * 1024 {
        emit_error("request exceeds protocol limit");
        return;
    }
    let request: Request = match serde_json::from_slice(&input) {
        Ok(value) => value,
        Err(error) => {
            emit_error(&format!("invalid request: {error}"));
            return;
        }
    };
    match handle(request) {
        Ok(value) => println!("{}", json!({"ok": true, "value": value})),
        Err(error) => emit_error(&error),
    }
}

fn emit_error(error: &str) {
    println!("{}", json!({"ok": false, "error": error}));
    std::process::exit(1);
}
