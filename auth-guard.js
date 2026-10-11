/**
 * auth-guard.js — Centralized Firebase Authentication guard
 *
 * Import this module at the top of the main application's script.
 * It will:
 *   1. Wait for Firebase to resolve the user's auth state.
 *   2. Redirect to login.html if the user is not authenticated.
 *   3. Expose the resolved user and auth instance via `getShatteredAuth()`.
 *   4. Provide `signOutUser()` for the sign-out button.
 *
 * Usage:
 *   import { getShatteredAuth, signOutUser } from "./auth-guard.js";
 *   const { user, auth } = await getShatteredAuth();
 */

import { initializeApp, getApps }       from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

/* ── Singleton Firebase app ───────────────────────────────────────────────── */
let _app, _auth, _db;

function ensureFirebase() {
  if (_app) return;
  const existing = getApps();
  _app  = existing.length ? existing[0] : initializeApp(firebaseConfig);
  _auth = getAuth(_app);
  _db   = getFirestore(_app);
  setPersistence(_auth, browserLocalPersistence).catch(() => {});
}

/* ── Auth guard promise ───────────────────────────────────────────────────── */
let _resolvedUser = null;
let _authPromise  = null;

export function getShatteredAuth() {
  if (_authPromise) return _authPromise;

  _authPromise = new Promise(resolve => {
    try {
      ensureFirebase();
    } catch (err) {
      console.error("Firebase init error in auth-guard:", err);
      // Redirect to login with a meaningful notice
      sessionStorage.setItem("shattered-redirect", window.location.href);
      window.location.replace("./login.html");
      return;
    }

    const unsubscribe = onAuthStateChanged(_auth, user => {
      unsubscribe(); // Only need the first resolution
      if (!user) {
        // Not authenticated — save the intended destination and send to login
        sessionStorage.setItem("shattered-redirect", window.location.href);
        window.location.replace("./login.html");
        return;
      }
      _resolvedUser = user;
      resolve({ user, auth: _auth, db: _db });
    });
  });

  return _authPromise;
}

/* ── Continue watching auth state changes (e.g. token revocation) ───────── */
export function watchAuthState(onChange) {
  ensureFirebase();
  return onAuthStateChanged(_auth, onChange);
}

/* ── Sign out ─────────────────────────────────────────────────────────────── */
export async function signOutUser() {
  ensureFirebase();
  try {
    await signOut(_auth);
  } catch (_) {}
  window.location.replace("./login.html");
}

/* ── Get the currently cached user (sync, may be null before guard resolves) */
export function getCurrentUser() {
  return _resolvedUser;
}

/* ── Firestore: upsert user profile (called from app.js after guard) ─────── */
export async function upsertUserProfile(user, extraData = {}) {
  if (!_db || !user) return;
  try {
    const ref  = doc(_db, "users", user.uid);
    const snap = await getDoc(ref);
    const now  = serverTimestamp();
    if (!snap.exists()) {
      await setDoc(ref, {
        uid:                user.uid,
        email:              user.email || "",
        displayName:        extraData.displayName || user.displayName || "",
        photoURL:           user.photoURL || "",
        bio:                "",
        createdAt:          now,
        updatedAt:          now,
        accountStatus:      "active",
        creatorPreferences: {
          defaultCreationMethod: "Prefer not to say",
          showCreationMethod:    true,
        },
      });
    } else {
      const updates = { updatedAt: now };
      if (extraData.displayName) updates.displayName = extraData.displayName;
      await setDoc(ref, updates, { merge: true });
    }
  } catch (err) {
    console.warn("Could not upsert user profile:", err);
  }
}
