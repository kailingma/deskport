//! Signing and URLs of the hub and agent protocol (docs/protocol.md).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};

pub const PROTOCOL: u32 = 1;
pub const SUBPROTOCOL: &str = "deskport.1";
pub const PREFIX: &str = "/agent/v1/";

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn b64d(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD.decode(s)
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("no randomness from the system");
    b
}

pub fn public_key(seed: &[u8; 32]) -> String {
    b64(SigningKey::from_bytes(seed).verifying_key().as_bytes())
}

/// The four signature headers for an upgrade to `path_and_query`.
pub fn sign_upgrade(id: &str, seed: &[u8; 32], path_and_query: &str, now_ms: u128) -> Vec<(&'static str, String)> {
    let time = now_ms.to_string();
    let nonce = b64(&random::<16>());
    let msg = format!("deskport-agent-1\n{path_and_query}\n{time}\n{nonce}");
    let sig = SigningKey::from_bytes(seed).sign(msg.as_bytes());
    vec![
        ("Deskport-Agent", id.to_string()),
        ("Deskport-Time", time),
        ("Deskport-Nonce", nonce),
        ("Deskport-Signature", b64(&sig.to_bytes())),
    ]
}

/// ws:// or wss:// URL of a path on the hub whose base URL is http(s)://...
pub fn ws_url(hub: &str, path: &str) -> String {
    let base = hub.trim_end_matches('/');
    let base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{base}{path}")
}

pub fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn signature_verifies_over_the_documented_string() {
        let seed = random::<32>();
        let h = sign_upgrade("pc", &seed, "/agent/v1/control", 1234);
        let get = |k: &str| h.iter().find(|(n, _)| *n == k).unwrap().1.clone();
        assert_eq!(get("Deskport-Agent"), "pc");
        assert_eq!(get("Deskport-Time"), "1234");
        let msg = format!("deskport-agent-1\n/agent/v1/control\n1234\n{}", get("Deskport-Nonce"));
        let key = VerifyingKey::from_bytes(&b64d(&public_key(&seed)).unwrap().try_into().unwrap()).unwrap();
        let sig = Signature::from_slice(&b64d(&get("Deskport-Signature")).unwrap()).unwrap();
        assert!(key.verify(msg.as_bytes(), &sig).is_ok());
    }

    #[test]
    fn ws_urls() {
        assert_eq!(ws_url("https://hub.test/", "/agent/v1/control"), "wss://hub.test/agent/v1/control");
        assert_eq!(ws_url("http://127.0.0.1:7900", "/x"), "ws://127.0.0.1:7900/x");
    }
}
