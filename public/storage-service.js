/**
 * storage-service.js — R2 audio uploads via the SHATTERED Cloudflare Worker
 *
 * Replaces Firebase Storage. Audio files are uploaded to the Cloudflare Worker
 * at /api/upload, which stores them in an R2 bucket server-side.
 *
 * The browser never touches R2 credentials. Authentication uses the Firebase
 * ID token sent in the Authorization header — the Worker verifies it.
 *
 * Progress is reported via XMLHttpRequest upload.onprogress so the progress
 * bar reflects real transferred bytes, not a simulation.
 */

import { getShatteredAuth } from "./auth-guard.js";
import { workerConfig }     from "./worker-config.js";

/* ── Constants ───────────────────────────────────────────────────────────── */
const MAX_AUDIO_BYTES = 80 * 1024 * 1024; // 80 MB

const ALLOWED_AUDIO_MIME = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/ogg", "audio/flac", "audio/x-flac",
  "audio/mp4", "audio/x-m4a", "audio/aac", "audio/webm",
]);

const EXT_MIME = {
  mp3:  "audio/mpeg",
  wav:  "audio/wav",
  ogg:  "audio/ogg",
  flac: "audio/flac",
  m4a:  "audio/mp4",
  aac:  "audio/aac",
  webm: "audio/webm",
};

/* ── Validation ──────────────────────────────────────────────────────────── */
export function validateAudioFile(file) {
  if (!file || !file.size) return "Please choose an audio file.";
  if (file.size > MAX_AUDIO_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `File is ${mb} MB — maximum is 80 MB. Compress or export at a lower bitrate.`;
  }
  const mime = resolveContentType(file);
  if (!ALLOWED_AUDIO_MIME.has(mime)) {
    return `File type "${file.type || file.name.split(".").pop()}" is not supported. Use MP3, WAV, OGG, FLAC, or M4A.`;
  }
  return null; // valid
}

export function resolveContentType(file) {
  if (file.type && ALLOWED_AUDIO_MIME.has(file.type)) return file.type;
  const ext = (file.name || "").split(".").pop().toLowerCase();
  return EXT_MIME[ext] || file.type || "audio/mpeg";
}

/* ── Human-readable error translation ───────────────────────────────────── */
export function translateStorageError(err) {
  const code = err?.code || "";
  const status = err?.status || 0;
  if (code === "not-signed-in") {
    return "You are not signed in. Please sign in and try again.";
  }
  if (code === "token-refresh-failed") {
    return "Could not refresh your sign-in token. Sign out and back in, then try again.";
  }
  if (status === 401 || code === "unauthorized") {
    return "Upload authorisation failed. Sign out and back in, then try again.";
  }
  if (status === 413 || code === "too-large") {
    return err.message || "File is too large. Maximum is 80 MB.";
  }
  if (status === 415 || code === "unsupported-type") {
    return err.message || "File type not supported. Use MP3, WAV, OGG, FLAC, or M4A.";
  }
  if (code === "upload-cancelled") {
    return "Upload was cancelled.";
  }
  if (code === "upload-stalled") {
    return "Upload stalled — no progress for 30 seconds. Check your connection and try again.";
  }
  if (code === "network-error") {
    return "Network error during upload. Check your internet connection and try again.";
  }
  if (code === "worker-not-configured") {
    return "Upload API is not configured. See SETUP.md to deploy the Cloudflare Worker.";
  }
  return err.message || "Upload error. Please try again.";
}

/* ── Get Firebase ID token ───────────────────────────────────────────────── */
async function getIdToken() {
  const { auth } = await getShatteredAuth();
  if (!auth?.currentUser) {
    const err = new Error("Not signed in");
    err.code = "not-signed-in";
    throw err;
  }
  try {
    // Force a token refresh so we never send a near-expiry token to the Worker.
    return await auth.currentUser.getIdToken(true);
  } catch (refreshErr) {
    // Propagate the original Firebase error message but mark it as a
    // token-refresh failure so the UI shows a targeted message rather than
    // the generic "permission denied" that previously surfaced here.
    const err = new Error(refreshErr?.message || "Token refresh failed");
    err.code = "token-refresh-failed";
    throw err;
  }
}

/* ── Upload audio file ───────────────────────────────────────────────────── */
/**
 * Upload an audio file to R2 via the Cloudflare Worker API.
 *
 * @param {File}     file       — the audio File object
 * @param {string}   trackId    — the track ID (used as part of the R2 key)
 * @param {string}   ownerUid   — the authenticated user's UID (for server verification)
 * @param {Function} onProgress — called with (percent: 0–100, bytesTransferred, totalBytes)
 *
 * @returns {{ promise: Promise<{url, storagePath}>, cancel: () => void }}
 */
export function uploadAudioFile(file, trackId, ownerUid, onProgress = () => {}) {
  const STALL_MS = 30_000;
  let xhr = null;
  let stallTimer = null;
  let cancelled = false;

  function clearStall() {
    if (stallTimer !== null) { clearTimeout(stallTimer); stallTimer = null; }
  }

  function resetStall(reject) {
    clearStall();
    stallTimer = setTimeout(() => {
      if (xhr) xhr.abort();
      const err = new Error("Upload stalled — no progress for 30 seconds.");
      err.code = "upload-stalled";
      reject(err);
    }, STALL_MS);
  }

  const promise = new Promise(async (resolve, reject) => {
    // Check Worker URL is configured
    const workerBase = workerConfig.workerBaseUrl;
    if (!workerBase || workerBase.includes("YOUR_WORKER")) {
      const err = new Error("Worker URL not configured. See SETUP.md.");
      err.code = "worker-not-configured";
      return reject(err);
    }

    // Get Firebase ID token for server-side auth
    let idToken;
    try {
      idToken = await getIdToken();
    } catch (authErr) {
      authErr.code = authErr.code || "unauthorized";
      return reject(authErr);
    }

    if (cancelled) {
      const err = new Error("Upload was cancelled.");
      err.code = "upload-cancelled";
      return reject(err);
    }

    // Build multipart form
    const form = new FormData();
    form.append("audio",   file);
    form.append("trackId", trackId);

    // Use XHR for real upload progress (fetch() does not expose upload progress)
    xhr = new XMLHttpRequest();
    xhr.open("POST", `${workerBase}/api/upload`, true);
    xhr.setRequestHeader("Authorization", `Bearer ${idToken}`);

    // ── Progress ──────────────────────────────────────────────────────────
    xhr.upload.onprogress = evt => {
      if (evt.lengthComputable && evt.loaded > 0) {
        resetStall(reject);
        const pct = Math.min(100, Math.round((evt.loaded / evt.total) * 100));
        onProgress(pct, evt.loaded, evt.total);
      }
    };

    xhr.upload.onloadstart = () => {
      resetStall(reject);
      onProgress(0, 0, file.size);
    };

    // ── Complete ──────────────────────────────────────────────────────────
    xhr.onload = () => {
      clearStall();
      if (cancelled) {
        const err = new Error("Upload was cancelled.");
        err.code = "upload-cancelled";
        return reject(err);
      }

      let body;
      try {
        body = JSON.parse(xhr.responseText);
      } catch (_) {
        const err = new Error(`Server returned invalid JSON (HTTP ${xhr.status})`);
        err.status = xhr.status;
        return reject(err);
      }

      if (xhr.status === 200 && body.url && body.storagePath) {
        onProgress(100, file.size, file.size);
        return resolve({ url: body.url, storagePath: body.storagePath });
      }

      // Server returned an error body
      const err = new Error(body.error || `Upload failed (HTTP ${xhr.status})`);
      err.status = xhr.status;
      if (xhr.status === 401) err.code = "unauthorized";
      if (xhr.status === 413) err.code = "too-large";
      if (xhr.status === 415) err.code = "unsupported-type";
      reject(err);
    };

    // ── Network error ─────────────────────────────────────────────────────
    xhr.onerror = () => {
      clearStall();
      const err = new Error("Network error during upload.");
      err.code = "network-error";
      reject(err);
    };

    // ── Abort (cancelled by caller) ───────────────────────────────────────
    xhr.onabort = () => {
      clearStall();
      if (!cancelled) {
        // Aborted externally (e.g. by stall timer already handled above)
        const err = new Error("Upload was cancelled.");
        err.code = "upload-cancelled";
        reject(err);
      }
    };

    xhr.send(form);
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      clearStall();
      if (xhr && xhr.readyState !== XMLHttpRequest.DONE) {
        xhr.abort();
      }
    },
  };
}

/* ── Delete audio from R2 (R2-only, used for best-effort cleanup) ─────────── */
export async function deleteAudioFile(storagePath) {
  if (!storagePath) return;

  const workerBase = workerConfig.workerBaseUrl;
  if (!workerBase || workerBase.includes("YOUR_WORKER")) return;

  let idToken;
  try {
    idToken = await getIdToken();
  } catch (_) {
    return; // Not signed in — can't delete, best-effort only
  }

  try {
    await fetch(`${workerBase}/api/media/${encodeURIComponent(storagePath)}`, {
      method:  "DELETE",
      headers: { Authorization: `Bearer ${idToken}` },
    });
  } catch (_) {
    // Best-effort; caller handles retry if needed
  }
}

/* ── Delete a full track (R2 + Firestore) via Worker ─────────────────────── */
/**
 * Calls DELETE /api/track/:trackId on the Worker.
 *
 * The Worker verifies the caller's identity server-side, reads the Firestore
 * document to check ownerUid, deletes the R2 audio file, then deletes the
 * Firestore document. Ownership is never trusted from the client.
 *
 * @returns {Promise<{deleted: boolean, partial?: boolean, r2Deleted?: boolean,
 *                    fsDeleted?: boolean, r2Error?: string, fsError?: string}>}
 * @throws  on network error or HTTP 4xx (auth / permission / not-found)
 */
export async function deleteTrackFromWorker(trackId) {
  const workerBase = workerConfig.workerBaseUrl;
  if (!workerBase || workerBase.includes("YOUR_WORKER")) {
    const err = new Error("Worker URL not configured. See SETUP.md.");
    err.code = "worker-not-configured";
    throw err;
  }

  const idToken = await getIdToken(); // throws if not signed in

  const resp = await fetch(`${workerBase}/api/track/${encodeURIComponent(trackId)}`, {
    method:  "DELETE",
    headers: { Authorization: `Bearer ${idToken}` },
  });

  let body;
  try {
    body = await resp.json();
  } catch (_) {
    const err = new Error(`Server returned invalid JSON (HTTP ${resp.status})`);
    err.status = resp.status;
    throw err;
  }

  if (resp.status === 401 || resp.status === 403) {
    const err = new Error(body.error || "Permission denied");
    err.status = resp.status;
    err.code   = resp.status === 403 ? "forbidden" : "unauthorized";
    throw err;
  }

  if (resp.status === 404) {
    const err = new Error(body.error || "Track not found");
    err.status = 404;
    err.code   = "not-found";
    throw err;
  }

  if (resp.status === 200) {
    return { deleted: true };
  }

  if (resp.status === 207) {
    // Partial success — at least one step failed
    return { ...body, deleted: false, partial: true };
  }

  // Any other non-2xx status
  const err = new Error(body.error || `Delete failed (HTTP ${resp.status})`);
  err.status = resp.status;
  throw err;
}
