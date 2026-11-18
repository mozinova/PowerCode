//! Extensions' `SecretStorage` (tokens of sign-ins, API keys): kept in a file
//! encrypted with AES-256-GCM, whose key lives in the OS credential store
//! (Windows Credential Manager, macOS Keychain, Secret Service on Linux), like
//! VS Code's `safeStorage`. The file avoids the credential stores' size limits.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::error::{err, CmdResult};

const SERVICE: &str = "PowerCode";
const KEY_NAME: &str = "secret-storage-key";
const NONCE_LEN: usize = 12;

/// Serialises reads and writes of the secrets file.
#[derive(Default)]
pub struct Secrets(Mutex<()>);

/// The encryption key from the OS credential store, created on first use.
fn key() -> Result<Key<Aes256Gcm>, String> {
    let entry = keyring::Entry::new(SERVICE, KEY_NAME).map_err(err)?;
    match entry.get_password() {
        Ok(stored) => {
            let bytes = STANDARD.decode(stored).map_err(err)?;
            if bytes.len() != 32 {
                return Err("The secret storage key is damaged.".into());
            }
            Ok(*Key::<Aes256Gcm>::from_slice(&bytes))
        }
        Err(keyring::Error::NoEntry) => {
            let key = Aes256Gcm::generate_key(OsRng);
            entry.set_password(&STANDARD.encode(key)).map_err(err)?;
            Ok(key)
        }
        Err(e) => Err(format!("The system credential store is not available: {e}")),
    }
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(err)?.join("secrets.bin"))
}

fn encrypt(key: &Key<Aes256Gcm>, plain: &[u8]) -> Result<Vec<u8>, String> {
    let nonce = Aes256Gcm::generate_nonce(OsRng);
    let mut out = nonce.to_vec();
    out.extend(Aes256Gcm::new(key).encrypt(&nonce, plain).map_err(err)?);
    Ok(out)
}

fn decrypt(key: &Key<Aes256Gcm>, data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < NONCE_LEN {
        return Err("The secrets file is damaged.".into());
    }
    let (nonce, cipher) = data.split_at(NONCE_LEN);
    Aes256Gcm::new(key)
        .decrypt(Nonce::from_slice(nonce), cipher)
        .map_err(|_| "The secrets file cannot be decrypted (was the stored key changed?).".to_string())
}

fn load(app: &AppHandle, key: &Key<Aes256Gcm>) -> Result<BTreeMap<String, String>, String> {
    match std::fs::read(file(app)?) {
        Ok(data) => serde_json::from_slice(&decrypt(key, &data)?).map_err(err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(err(e)),
    }
}

fn save(app: &AppHandle, key: &Key<Aes256Gcm>, secrets: &BTreeMap<String, String>) -> Result<(), String> {
    let path = file(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let data = encrypt(key, &serde_json::to_vec(secrets).map_err(err)?)?;
    // Written aside then moved, so a crash never leaves half a file.
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, data).map_err(err)?;
    std::fs::rename(&temp, &path).map_err(err)
}

#[tauri::command(async)]
pub fn secrets_get(app: AppHandle, state: State<'_, Secrets>, key: String) -> CmdResult<Option<String>> {
    let _guard = state.0.lock().map_err(err)?;
    let secret_key = self::key()?;
    Ok(load(&app, &secret_key)?.remove(&key))
}

#[tauri::command(async)]
pub fn secrets_set(app: AppHandle, state: State<'_, Secrets>, key: String, value: String) -> CmdResult<()> {
    let _guard = state.0.lock().map_err(err)?;
    let secret_key = self::key()?;
    let mut secrets = load(&app, &secret_key)?;
    secrets.insert(key, value);
    Ok(save(&app, &secret_key, &secrets)?)
}

#[tauri::command(async)]
pub fn secrets_delete(app: AppHandle, state: State<'_, Secrets>, key: String) -> CmdResult<()> {
    let _guard = state.0.lock().map_err(err)?;
    let secret_key = self::key()?;
    let mut secrets = load(&app, &secret_key)?;
    if secrets.remove(&key).is_some() {
        save(&app, &secret_key, &secrets)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_data_round_trips_and_detects_tampering() {
        let key = Aes256Gcm::generate_key(OsRng);
        let mut data = encrypt(&key, b"{\"token\":\"abc\"}").unwrap();
        assert_eq!(decrypt(&key, &data).unwrap(), b"{\"token\":\"abc\"}");
        let last = data.len() - 1;
        data[last] ^= 1;
        assert!(decrypt(&key, &data).is_err());
        assert!(decrypt(&Aes256Gcm::generate_key(OsRng), &encrypt(&key, b"x").unwrap()).is_err());
    }

    #[test]
    #[ignore = "uses the OS credential store"]
    fn the_credential_store_keeps_a_key() {
        let entry = keyring::Entry::new("PowerCode-test", "probe").unwrap();
        let key = STANDARD.encode(Aes256Gcm::generate_key(OsRng));
        entry.set_password(&key).unwrap();
        assert_eq!(entry.get_password().unwrap(), key);
        entry.delete_credential().unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }
}
