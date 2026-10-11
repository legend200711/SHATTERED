/**
 * storage-service.js — Firebase Storage uploads for SHATTERED
 *
 * v1.2.1 — Upload reliability fixes:
 *   - Stall detection: if no progress for STALL_MS milliseconds the task is
 *     cancelled and the caller receives a typed "storage/upload-stalled" error.
 *   - Cancel support: uploadAudioFile() returns { promise, cancel } so the
 *     UI can provide a Cancel button.
 *   - NaN-safe progress: guards against snapshot.totalBytes === 0 on the
 *     first event (which made Math.round(0/0) = NaN → bar stuck at 0 %).
 *   - Normalised content-type: always sends a real MIME string to Storage,
 *     even when file.type is empty, so the Storage Security Rule MIME check
 *     never rejects a valid audio file.
 *   - Friendly error classification: translateStorageError() converts every
 *     known Firebase Storage error code into a human-readable sentence.
 */

import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-storage.js";
import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import { firebaseConfig }         from "./firebase-config.js";

/* ── Constants ───────────────────────────────────────────────────────────── */
const MAX_AUDIO_BYTES = 80 * 1024 * 1024; // 80 MB

// How long (ms) to wait without any progress before declaring a stall.
const STALL_MS = 30_000; // 30 seconds

const ALLOWED_AUDIO_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/webm",
]);

// Extension → MIME fallback table used when file.type is empty or generic.
const EXT_MIME = {
  mp3:  "audio/mpeg",
  wav:  "audio/wav",
  ogg:  "audio/ogg",
  flac: "audio/flac",
  m4a:  "audio/mp4",
  aac:  "audio/aac",
  webm: "audio/webm",
};

/* ── Singleton Storage instance ──────────────────────────────────────────── */
let _storage = null;

function getStorageInstance() {
  if (_storage) return _storage;
  const apps = getApps();
  const app  = apps.length ? apps[0] : initializeApp(firebaseConfig);
  _storage = getStorage(app);
  return _storage;
}

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

/**
 * Resolve the best content-type string for a File.
 * Prefers file.type; falls back to extension lookup; falls back to audio/mpeg.
 * This guarantees the Storage Security Rule's contentType.matches() always
 * receives a non-empty string that represents the actual audio format.
 */
export function resolveContentType(file) {
  if (file.type && ALLOWED_AUDIO_MIME.has(file.type)) return file.type;
  const ext = (file.name || "").split(".").pop().toLowerCase();
  return EXT_MIME[ext] || file.type || "audio/mpeg";
}

/* ── Human-readable error translation ───────────────────────────────────── */
export function translateStorageError(err) {
  const code = err?.code || "";
  const messages = {
    "storage/unauthorized":
      "Permission denied. Make sure you are signed in and that your account is active.",
    "storage/canceled":
      "Upload was cancelled.",
    "storage/upload-stalled":
      "Upload stalled — no progress for 30 seconds. Check your connection and try again.",
    "storage/unknown":
      "An unknown storage error occurred. Check your internet connection.",
    "storage/object-not-found":
      "File not found in storage.",
    "storage/bucket-not-found":
      "Storage bucket not found. Check firebase-config.js storageBucket value.",
    "storage/project-not-found":
      "Firebase project not found. Check firebase-config.js projectId value.",
    "storage/quota-exceeded":
      "Storage quota exceeded for this project.",
    "storage/unauthenticated":
      "You must be signed in to upload files.",
    "storage/retry-limit-exceeded":
      "Upload failed after too many retries. Check your connection.",
    "storage/invalid-checksum":
      "File was corrupted during upload. Please try again.",
    "storage/server-file-wrong-size":
      "The file on the server has the wrong size. Please try again.",
    "storage/no-default-bucket":
      "No storage bucket is configured. Check firebase-config.js.",
  };
  return messages[code] || `Upload error (${code || "unknown"}). Please try again.`;
}

/* ── Upload audio file ───────────────────────────────────────────────────── */
/**
 * Start a resumable audio upload to Firebase Storage.
 *
 * @param {File}     file        — the audio File object
 * @param {string}   trackId     — the Firestore track document ID
 * @param {string}   ownerUid    — the authenticated user's UID
 * @param {Function} onProgress  — called with (percent: 0–100, bytesTransferred, totalBytes)
 *
 * @returns {{ promise: Promise<{url, storagePath}>, cancel: () => void }}
 *   promise  — resolves to { url, storagePath } on success
 *   cancel() — cancels the upload task (rejects promise with storage/canceled)
 */
export function uploadAudioFile(file, trackId, ownerUid, onProgress = () => {}) {
  let task = null;
  let stallTimer = null;
  let lastBytesTransferred = -1;

  function clearStallTimer() {
    if (stallTimer !== null) { clearTimeout(stallTimer); stallTimer = null; }
  }

  function resetStallTimer(reject) {
    clearStallTimer();
    stallTimer = setTimeout(() => {
      // No progress for STALL_MS — cancel and report stall
      if (task) task.cancel();
      const stallErr = new Error("Upload stalled — no progress detected.");
      stallErr.code  = "storage/upload-stalled";
      reject(stallErr);
    }, STALL_MS);
  }

  const promise = new Promise((resolve, reject) => {
    let storage;
    try {
      storage = getStorageInstance();
    } catch (initErr) {
      reject(initErr);
      return;
    }

    const contentType = resolveContentType(file);
    const ext         = (file.name || "track").split(".").pop().toLowerCase() || "mp3";
    const path        = `audio/${ownerUid}/${trackId}/${trackId}.${ext}`;
    const storageRef  = ref(storage, path);

    const metadata = {
      contentType,
      customMetadata: {
        ownerUid,
        trackId,
        originalName: file.name,
      },
    };

    task = uploadBytesResumable(storageRef, file, metadata);

    // Start the stall timer as soon as the task is created.
    resetStallTimer(reject);

    task.on(
      "state_changed",

      // ── Progress snapshot ──────────────────────────────────────────────
      snapshot => {
        const transferred = snapshot.bytesTransferred;
        const total       = snapshot.totalBytes;

        // Detect real forward progress to reset the stall timer.
        if (transferred > lastBytesTransferred) {
          lastBytesTransferred = transferred;
          resetStallTimer(reject);
        }

        // Guard: totalBytes may be 0 on the very first snapshot event
        // (before the server acknowledges the resumable session).
        // Use file.size as a fallback so the denominator is never 0.
        const denominator = total > 0 ? total : file.size > 0 ? file.size : 1;
        const pct         = Math.min(100, Math.round((transferred / denominator) * 100));

        onProgress(pct, transferred, total);
      },

      // ── Error ─────────────────────────────────────────────────────────
      err => {
        clearStallTimer();
        reject(err);
      },

      // ── Complete ──────────────────────────────────────────────────────
      async () => {
        clearStallTimer();
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          resolve({ url, storagePath: path });
        } catch (dlErr) {
          reject(dlErr);
        }
      }
    );
  });

  return {
    promise,
    cancel: () => { clearStallTimer(); if (task) task.cancel(); },
  };
}

/* ── Delete audio from Storage ───────────────────────────────────────────── */
export async function deleteAudioFile(storagePath) {
  if (!storagePath) return;
  try {
    const storage = getStorageInstance();
    await deleteObject(ref(storage, storagePath));
  } catch (err) {
    if (err.code !== "storage/object-not-found") throw err;
  }
}
