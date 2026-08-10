use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, process};

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("usage: frondose-updater-verifier <public-key-base64> <archive> <signature>".into());
    }
    let public_key = PublicKey::from_base64(&args[0]).map_err(|error| error.to_string())?;
    let archive = fs::read(&args[1]).map_err(|error| error.to_string())?;
    let encoded_signature = fs::read_to_string(&args[2]).map_err(|error| error.to_string())?;
    let signature_bytes = STANDARD
        .decode(encoded_signature.trim())
        .map_err(|error| error.to_string())?;
    let signature_text = String::from_utf8(signature_bytes).map_err(|error| error.to_string())?;
    let signature = Signature::decode(&signature_text).map_err(|error| error.to_string())?;
    public_key
        .verify(&archive, &signature, false)
        .map_err(|error| error.to_string())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("frondose-updater-verifier: {error}");
        process::exit(1);
    }
}
