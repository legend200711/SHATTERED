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
let _persistenceReady = null;   // Promise that resolves once persistence is set

/**
 * Initialise Firebase and set localStorage persistence.
 * Returns a Promise that resolves once persistence is configured so that
 * onAuthStateChanged will see the correct restored session on the first fire.
 *
 * IMPORTANT: setPersistence() must resolve BEFORE registering onAuthStateChanged.
 * If we fire onAuthStateChanged before persistence is set, the first callback
 * may return null even when a valid session is stored in localStorage, because
 * the Firebase Auth internal state machine hasn't finished loading it yet.
 */
function ensureFirebase() {
  if (_persistenceReady) return _persistenceReady;

  _persistenceReady = (async () => {
    try {
      const existing = getApps();
      _app  = existing.length ? existing[0] : initializeApp(firebaseConfig);
      _auth = getAuth(_app);
      _db   = getFirestore(_app);
      // Await persistence — this MUST complete before we call onAuthStateChanged
      // so that Firebase has fully loaded the stored session token from
      // localStorage before we read auth state.
      await setPersistence(_auth, browserLocalPersistence);
    } catch (err) {
      console.warn("Firebase init or persistence error:", err);
      // Non-fatal: continue without persistence (session won't survive refresh
      // in this case, but the app will still work for the current page load).
    }
  })();

  return _persistenceReady;
}

/* ── Auth state promise ───────────────────────────────────────────────────── */
let _resolvedUser = null;  // null = signed out, Firebase User = signed in
let _authPromise  = null;

/**
 * Resolves the current Firebase auth state.
 * Always resolves — user will be null for unauthenticated visitors.
 * Does NOT redirect to login.html.
 *
 * Waits for persistence to be configured before registering onAuthStateChanged
 * to ensure the stored session is loaded before we read auth state.
 */
export function getShatteredAuth() {
  if (_authPromise) return _authPromise;

  _authPromise = (async () => {
    try {
      await ensureFirebase();
    } catch (err) {
      console.error("Firebase init error in auth-guard:", err);
      return { user: null, auth: null, db: null };
    }

    // Now that persistence is set, register the one-shot auth state listener.
    // Firebase will fire this once with the restored session (or null if none).
    return new Promise(resolve => {
      const unsubscribe = onAuthStateChanged(_auth, user => {
        unsubscribe();
        _resolvedUser = user ?? null;
        resolve({ user: _resolvedUser, auth: _auth, db: _db });
      });
    });
  })();

  return _authPromise;
}

/* ── Continue watching auth state changes ────────────────────────────────── */
export function watchAuthState(onChange) {
  // ensureFirebase() now returns a Promise; await it so _auth is always defined
  // before we register the persistent listener.
  ensureFirebase().then(() => {
    onAuthStateChanged(_auth, onChange);
  }).catch(() => {
    // Firebase unavailable — fire once with null so callers settle cleanly
    onChange(null);
  });
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
  try {
    await ensureFirebase();
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
