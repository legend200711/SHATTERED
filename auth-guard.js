/**
 * auth-guard.js — Centralized Firebase Authentication for SHATTERED
 *
 * v1.2.0 — Public access update:
 *   Public visitors (unauthenticated) can browse and play music.
 *   No redirect to login.html on load — auth state is resolved and
 *   returned to the caller. The caller decides what to do with null.
 *
 * Usage:
 *   import { getShatteredAuth, signOutUser, requireAuth } from "./auth-guard.js";
 *   const { user, auth } = await getShatteredAuth();  // user may be null
 *   requireAuth();  // redirects to login if not signed in
 */

import { initializeApp, getApps }       from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  onAuthStateChanged,
  signOut,
  updateProfile,
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

/* ── Auth state promise ───────────────────────────────────────────────────── */
let _resolvedUser = null;  // null = signed out, Firebase User = signed in
let _authPromise  = null;

/**
 * Resolves the current Firebase auth state.
 * Always resolves — user will be null for unauthenticated visitors.
 * Does NOT redirect to login.html.
 */
export function getShatteredAuth() {
  if (_authPromise) return _authPromise;

  _authPromise = new Promise(resolve => {
    try {
      ensureFirebase();
    } catch (err) {
      console.error("Firebase init error in auth-guard:", err);
      // Return null user so app still boots in public mode
      resolve({ user: null, auth: null, db: null });
      return;
    }

    const unsubscribe = onAuthStateChanged(_auth, user => {
      unsubscribe();
      _resolvedUser = user ?? null;
      resolve({ user: _resolvedUser, auth: _auth, db: _db });
    });
  });

  return _authPromise;
}

/* ── Continue watching auth state changes ────────────────────────────────── */
export function watchAuthState(onChange) {
  ensureFirebase();
  return onAuthStateChanged(_auth, onChange);
}

/* ── Require sign-in — call this when a protected action is attempted ──── */
/**
 * Saves the current URL to sessionStorage and redirects to login.html.
 * Use this instead of a login wall on page load.
 */
export function requireAuth() {
  sessionStorage.setItem("shattered-redirect", window.location.href);
  window.location.replace("./login.html");
}

/* ── Sign out ─────────────────────────────────────────────────────────────── */
export async function signOutUser() {
  ensureFirebase();
  try {
    await signOut(_auth);
  } catch (_) {}
  window.location.replace("./index.html");
}

/* ── Get the currently cached user (sync, may be null) ─────────────────── */
export function getCurrentUser() {
  return _resolvedUser;
}

/* ── Firestore: upsert user profile (called from app.js after auth) ─────── */
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

/* ── Update Firebase Auth display name ───────────────────────────────────── */
/**
 * Update the Firebase Auth user's displayName.
 * This keeps `currentUser.displayName` (the Auth user object) in sync with
 * the Firestore profile's displayName field so every re-render of profileView()
 * shows the latest saved name without a separate Firestore fetch.
 */
export async function updateAuthDisplayName(user, displayName) {
  if (!user || !displayName) return;
  await updateProfile(user, { displayName });
}
