/**
 * storage-service.js — Firebase Storage uploads for SHATTERED
 *
 * Handles audio file uploads with:
 *   - Owner UID in the storage path (enforced by Storage Security Rules)
 *   - Progress callbacks
 *   - MIME type and file size validation
 *   - Upload metadata attached to the storage object
 *   - Download URL retrieval after successful upload
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
const MAX_AUDIO_BYTES    = 80 * 1024 * 1024;  // 80 MB
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
    return `File is ${mb} MB. Maximum size is 80 MB. Compress or export at a lower bitrate.`;
  }
  const mime = file.type || "audio/mpeg";
  if (!ALLOWED_AUDIO_MIME.has(mime)) {
    return `File type "${mime}" is not supported. Use MP3, WAV, OGG, FLAC, or M4A.`;
  }
  return null; // valid
}

/* ── Upload audio file ───────────────────────────────────────────────────── */
/**
 * @param {File}     file        — the audio File object
 * @param {string}   trackId     — the Firestore track document ID
 * @param {string}   ownerUid    — the authenticated user's UID
 * @param {Function} onProgress  — called with (percent: 0–100)
 * @returns {Promise<string>}    — resolves to the download URL
 */
export function uploadAudioFile(file, trackId, ownerUid, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const storage = getStorageInstance();

    // Storage path: audio/{ownerUid}/{trackId}/{filename}
    // Security Rules enforce that ownerUid === request.auth.uid
    const ext      = file.name.split(".").pop().toLowerCase() || "mp3";
    const path     = `audio/${ownerUid}/${trackId}/${trackId}.${ext}`;
    const storageRef = ref(storage, path);

    const metadata = {
      contentType: file.type || "audio/mpeg",
      customMetadata: {
        ownerUid,
        trackId,
        originalName: file.name,
      },
    };

    const task = uploadBytesResumable(storageRef, file, metadata);

    task.on(
      "state_changed",
      snapshot => {
        const pct = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        onProgress(Math.round(pct));
      },
      err => {
        reject(err);
      },
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          resolve({ url, storagePath: path });
        } catch (err) {
          reject(err);
        }
      }
    );
  });
}

/* ── Delete audio from Storage ───────────────────────────────────────────── */
export async function deleteAudioFile(storagePath) {
  if (!storagePath) return;
  try {
    const storage = getStorageInstance();
    await deleteObject(ref(storage, storagePath));
  } catch (err) {
    // If the file was already gone, don't throw
    if (err.code !== "storage/object-not-found") {
      throw err;
    }
  }
}
