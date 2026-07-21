/**
 * crypto.js
 * Client-side encryption engine built on the Web Crypto API.
 *
 * - Key derivation: PBKDF2 (SHA-256, 600,000 iterations) from the user's
 *   master password + a random salt.
 * - Payload encryption: AES-256-GCM.
 *
 * The derived CryptoKey is held only in memory (module-scope variable) for
 * the lifetime of the tab/session. It is never written to IndexedDB,
 * localStorage, sessionStorage, or any network request.
 */

const CryptoEngine = (() => {
  const PBKDF2_ITERATIONS = 600000;
  const SALT_STORAGE_KEY = 'rolodex_kdf_salt_v1'; // salt is NOT secret, safe to persist
  const VERIFIER_STORAGE_KEY = 'rolodex_verifier_v1'; // used to confirm password correctness

  let liveKey = null; // volatile, RAM-only CryptoKey

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function b64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function getOrCreateSalt() {
    let saltB64 = localStorage.getItem(SALT_STORAGE_KEY);
    if (saltB64) return b64ToBuf(saltB64);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    localStorage.setItem(SALT_STORAGE_KEY, bufToB64(salt.buffer));
    return salt.buffer;
  }

  function hasExistingVault() {
    return !!localStorage.getItem(VERIFIER_STORAGE_KEY);
  }

  async function deriveKey(password) {
    const enc = new TextEncoder();
    const salt = getOrCreateSalt();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false, // not extractable — cannot be exported out of the CryptoKey
      ['encrypt', 'decrypt']
    );
    return key;
  }

  async function encryptPayload(key, plainObject) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const data = enc.encode(JSON.stringify(plainObject));
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return {
      v: 1,
      iv: bufToB64(iv.buffer),
      data: bufToB64(cipherBuf),
    };
  }

  async function decryptPayload(key, envelope) {
    const iv = new Uint8Array(b64ToBuf(envelope.iv));
    const cipherBuf = b64ToBuf(envelope.data);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBuf);
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plainBuf));
  }

  /**
   * Sets up the vault the first time a master password is chosen:
   * derives the key, encrypts a known verifier string, and stores only the
   * (non-secret) envelope so future unlock attempts can be validated
   * without ever persisting the password or the key itself.
   */
  async function initializeVault(password) {
    const key = await deriveKey(password);
    const envelope = await encryptPayload(key, { check: 'rolodex-ok' });
    localStorage.setItem(VERIFIER_STORAGE_KEY, JSON.stringify(envelope));
    liveKey = key;
    return key;
  }

  /**
   * Attempts to unlock an existing vault with the supplied password.
   * Returns true/false; throws only on unexpected errors.
   */
  async function unlockVault(password) {
    const raw = localStorage.getItem(VERIFIER_STORAGE_KEY);
    if (!raw) throw new Error('No vault initialized');
    const envelope = JSON.parse(raw);
    const key = await deriveKey(password);
    try {
      const result = await decryptPayload(key, envelope);
      if (result && result.check === 'rolodex-ok') {
        liveKey = key;
        return true;
      }
      return false;
    } catch (e) {
      // GCM auth tag failure -> wrong password
      return false;
    }
  }

  function getLiveKey() {
    return liveKey;
  }

  function lock() {
    liveKey = null;
  }

  function isUnlocked() {
    return !!liveKey;
  }

  async function encrypt(plainObject) {
    if (!liveKey) throw new Error('Vault is locked');
    return encryptPayload(liveKey, plainObject);
  }

  async function decrypt(envelope) {
    if (!liveKey) throw new Error('Vault is locked');
    return decryptPayload(liveKey, envelope);
  }

  return {
    hasExistingVault,
    initializeVault,
    unlockVault,
    getLiveKey,
    lock,
    isUnlocked,
    encrypt,
    decrypt,
  };
})();
