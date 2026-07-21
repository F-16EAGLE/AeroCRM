/**
 * gdrive.js
 * Google OAuth (GIS token client) + Drive v3 sync against the hidden
 * `appDataFolder`, which is only ever visible to this app — not to the
 * user's normal Drive UI, and not to other apps.
 *
 * Everything written to Drive is the already-encrypted envelope produced by
 * crypto.js. Google never sees plaintext.
 *
 * NOTE: Replace GOOGLE_CLIENT_ID below with your own OAuth 2.0 Web Client ID
 * from https://console.cloud.google.com/apis/credentials (Authorized
 * JavaScript origin = the GitHub Pages URL this app is hosted at).
 */

const GoogleDrive = (() => {
  const GOOGLE_CLIENT_ID = '819054758887-dj9fhr71ci4e7jl8m6laf6ep4n1qabhh.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
  const BACKUP_FILENAME = 'crm_encrypted_backup.json';

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let cachedFileId = null;

  function isConfigured() {
    return GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith('YOUR_');
  }

  function isSignedIn() {
    return !!accessToken && Date.now() < tokenExpiresAt;
  }

  function initTokenClient() {
    if (tokenClient || typeof google === 'undefined') return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: () => {}, // overridden per-call below
    });
    return tokenClient;
  }

  /** Triggers the Google sign-in popup; resolves once a token is granted. */
  function signIn() {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) {
        reject(new Error('Google Client ID not configured. Set GOOGLE_CLIENT_ID in gdrive.js.'));
        return;
      }
      if (typeof google === 'undefined') {
        reject(new Error('Google Identity Services script has not loaded yet.'));
        return;
      }
      const client = initTokenClient();
      client.callback = (resp) => {
        if (resp.error) {
          reject(new Error(resp.error));
          return;
        }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3500 * 1000);
        resolve(accessToken);
      };
      client.requestAccessToken({ prompt: isSignedIn() ? '' : 'consent' });
    });
  }

  function signOut() {
    if (accessToken && typeof google !== 'undefined') {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiresAt = 0;
    cachedFileId = null;
  }

  async function ensureToken() {
    if (isSignedIn()) return accessToken;
    return signIn();
  }

  async function apiFetch(url, options = {}) {
    const token = await ensureToken();
    const resp = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Drive API error ${resp.status}: ${text}`);
    }
    return resp;
  }

  /** Finds the backup file's fileId inside appDataFolder, if it exists. */
  async function findBackupFileId() {
    if (cachedFileId) return cachedFileId;
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name='${BACKUP_FILENAME}' and trashed=false`,
      fields: 'files(id,name,modifiedTime)',
    });
    const resp = await apiFetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
    const json = await resp.json();
    if (json.files && json.files.length > 0) {
      cachedFileId = json.files[0].id;
      return cachedFileId;
    }
    return null;
  }

  /** Uploads (create or update) the encrypted backup envelope. */
  async function uploadBackup(envelopeObject) {
    const fileId = await findBackupFileId();
    const body = JSON.stringify(envelopeObject);
    const metadata = { name: BACKUP_FILENAME, mimeType: 'application/json' };

    if (fileId) {
      await apiFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }
      );
      return fileId;
    }

    const boundary = 'rolodex_boundary_' + Math.random().toString(36).slice(2);
    const multipartBody =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ ...metadata, parents: ['appDataFolder'] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      body +
      `\r\n--${boundary}--`;

    const resp = await apiFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody,
      }
    );
    const json = await resp.json();
    cachedFileId = json.id;
    return json.id;
  }

  /** Downloads and JSON-parses the encrypted backup envelope, or null if none exists. */
  async function downloadBackup() {
    const fileId = await findBackupFileId();
    if (!fileId) return null;
    const resp = await apiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return resp.json();
  }

  return {
    isConfigured,
    isSignedIn,
    signIn,
    signOut,
    uploadBackup,
    downloadBackup,
  };
})();
