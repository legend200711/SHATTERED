/**
 * login.js — SHATTERED Firebase Authentication
 *
 * Handles:
 *   - Email / password sign-in and registration
 *   - Google sign-in (popup)
 *   - Password reset email
 *   - Persistent session (localStorage)
 *   - Redirect to app on success; redirect to login if already signed in
 *   - Clear, user-friendly error messages for every Firebase Auth error code
 */

import { initializeApp }                from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

function setMsg(el, text, type = "error") {
  el.textContent = text;
  el.className   = `auth-msg ${type}`;
}
function clearMsg(el) {
  el.textContent = "";
  el.className   = "auth-msg";
}

function setLoading(btn, loading) {
  btn.disabled = loading;
  const label  = btn.dataset.label || btn.textContent;
  if (!btn.dataset.label) btn.dataset.label = label;
  btn.innerHTML = loading
    ? `<span class="spinner"></span>${btn.dataset.label}`
    : btn.dataset.label;
}

/** Convert Firebase Auth error codes to friendly sentences. */
function authError(code) {
  const map = {
    "auth/email-already-in-use":      "That email address is already registered. Try signing in instead.",
    "auth/invalid-email":             "Please enter a valid email address.",
    "auth/weak-password":             "Password must be at least 8 characters and harder to guess.",
    "auth/user-not-found":            "No account found with that email address.",
    "auth/wrong-password":            "Incorrect password. Try again or reset it below.",
    "auth/invalid-credential":        "Incorrect email or password. Check your details and try again.",
    "auth/too-many-requests":         "Too many failed attempts. Please wait a few minutes before trying again.",
    "auth/network-request-failed":    "Network error. Check your internet connection and try again.",
    "auth/popup-closed-by-user":      "Sign-in window was closed. Please try again.",
    "auth/popup-blocked":             "Pop-up was blocked by your browser. Allow pop-ups for this site and try again.",
    "auth/cancelled-popup-request":   "Another sign-in is already in progress.",
    "auth/account-exists-with-different-credential":
                                      "An account already exists with this email using a different sign-in method. Try signing in with email and password.",
    "auth/requires-recent-login":     "Please sign in again to continue.",
    "auth/user-disabled":             "This account has been disabled. Contact support if you believe this is an error.",
  };
  return map[code] || "Something went wrong. Please try again.";
}

/* ── Firebase initialisation ─────────────────────────────────────────────── */
let app, auth, db;

function detectMissingConfig() {
  const sentinel = "YOUR_API_KEY";
  return !firebaseConfig.apiKey || firebaseConfig.apiKey === sentinel;
}

if (detectMissingConfig()) {
  $("setupBanner").classList.add("visible");
} else {
  try {
    app  = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db   = getFirestore(app);
    // Persist the session across page reloads
    setPersistence(auth, browserLocalPersistence).catch(() => {});
  } catch (err) {
    console.error("Firebase init failed:", err);
    $("setupBanner").classList.add("visible");
  }
}

/* ── Redirect if already signed in ──────────────────────────────────────── */
if (auth) {
  onAuthStateChanged(auth, user => {
    if (user) {
      const dest = sessionStorage.getItem("shattered-redirect") || "./index.html";
      sessionStorage.removeItem("shattered-redirect");
      window.location.replace(dest);
    }
  });
}

/* ── Firestore: create or update user profile ────────────────────────────── */
async function upsertUserProfile(user, extraData = {}) {
  if (!db || !user) return;
  const ref     = doc(db, "users", user.uid);
  const snap    = await getDoc(ref).catch(() => null);
  const now     = serverTimestamp();

  if (!snap || !snap.exists()) {
    // New profile — write all fields
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
    // Existing profile — update only safe, non-privileged fields
    const updates = { updatedAt: now };
    if (user.photoURL && !snap.data().photoURL) updates.photoURL = user.photoURL;
    // Only update displayName if it was just set (first Google login etc.)
    if (extraData.displayName) updates.displayName = extraData.displayName;
    await setDoc(ref, updates, { merge: true });
  }
}

/* ── Tab switching ───────────────────────────────────────────────────────── */
function showTab(tabId) {
  ["Signin", "Register"].forEach(name => {
    const tab  = $(`tab${name}`);
    const form = $(`form${name}`);
    const active = name.toLowerCase() === tabId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    form.classList.toggle("active", active);
  });
  // Hide reset panel when switching tabs
  $("formReset").classList.remove("active");
}

$("tabSignin").addEventListener("click",   () => showTab("signin"));
$("tabRegister").addEventListener("click", () => showTab("register"));

/* ── Password strength indicator ─────────────────────────────────────────── */
$("regPassword").addEventListener("input", () => {
  const val  = $("regPassword").value;
  const bar  = $("pwBar");
  let score  = 0;
  if (val.length >= 8)   score++;
  if (val.length >= 12)  score++;
  if (/[A-Z]/.test(val)) score++;
  if (/[0-9]/.test(val)) score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;
  const pct    = (score / 5) * 100;
  const colors = ["#ff5858","#ff9933","#ffd700","#7dff7d","#b5ff38"];
  bar.style.width      = pct + "%";
  bar.style.background = colors[score - 1] || "transparent";
});

/* ── Sign-in form ────────────────────────────────────────────────────────── */
$("signinForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!auth) return;
  const msgEl = $("signinMsg");
  const btn   = $("signinBtn");
  clearMsg(msgEl);

  const email    = $("signinEmail").value.trim();
  const password = $("signinPassword").value;
  if (!email || !password) {
    setMsg(msgEl, "Please enter your email and password.");
    return;
  }

  setLoading(btn, true);
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await upsertUserProfile(cred.user);
    // onAuthStateChanged will handle the redirect
  } catch (err) {
    setMsg(msgEl, authError(err.code));
    setLoading(btn, false);
  }
});

/* ── Registration form ───────────────────────────────────────────────────── */
$("registerForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!auth) return;
  const msgEl = $("registerMsg");
  const btn   = $("registerBtn");
  clearMsg(msgEl);

  const displayName = $("regDisplayName").value.trim();
  const email       = $("regEmail").value.trim();
  const password    = $("regPassword").value;
  const confirm     = $("regConfirm").value;

  if (!displayName) { setMsg(msgEl, "Enter your creator / artist name."); return; }
  if (!email)        { setMsg(msgEl, "Enter your email address."); return; }
  if (password.length < 8) { setMsg(msgEl, "Password must be at least 8 characters."); return; }
  if (password !== confirm) { setMsg(msgEl, "Passwords do not match."); return; }

  setLoading(btn, true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    // Set the display name on the Auth profile
    await updateProfile(cred.user, { displayName });
    // Write Firestore profile
    await upsertUserProfile(cred.user, { displayName });
    // onAuthStateChanged will handle the redirect
  } catch (err) {
    setMsg(msgEl, authError(err.code));
    setLoading(btn, false);
  }
});

/* ── Google sign-in ──────────────────────────────────────────────────────── */
async function googleSignIn() {
  if (!auth) return;
  const provider = new GoogleAuthProvider();
  provider.addScope("profile");
  provider.addScope("email");

  // Determine which message element to target
  const isRegisterTab = $("formRegister").classList.contains("active");
  const msgEl         = isRegisterTab ? $("registerMsg") : $("signinMsg");
  const btnId         = isRegisterTab ? "googleRegisterBtn" : "googleSigninBtn";
  const btn           = $(btnId);

  clearMsg(msgEl);
  setLoading(btn, true);

  try {
    const cred = await signInWithPopup(auth, provider);
    await upsertUserProfile(cred.user, {
      displayName: cred.user.displayName || "",
    });
    // onAuthStateChanged will handle the redirect
  } catch (err) {
    setMsg(msgEl, authError(err.code));
    setLoading(btn, false);
  }
}

$("googleSigninBtn").addEventListener("click",   googleSignIn);
$("googleRegisterBtn").addEventListener("click", googleSignIn);

/* ── Password reset ──────────────────────────────────────────────────────── */
$("showResetBtn").addEventListener("click", () => {
  $("formSignin").classList.remove("active");
  $("formReset").classList.add("active");
  clearMsg($("resetMsg"));
  $("resetEmail").value = $("signinEmail").value; // pre-fill if available
});

$("backToSigninBtn").addEventListener("click", () => {
  $("formReset").classList.remove("active");
  $("formSignin").classList.add("active");
});

$("resetForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!auth) return;
  const msgEl = $("resetMsg");
  const btn   = $("resetBtn");
  clearMsg(msgEl);

  const email = $("resetEmail").value.trim();
  if (!email) { setMsg(msgEl, "Enter your email address."); return; }

  setLoading(btn, true);
  try {
    await sendPasswordResetEmail(auth, email);
    setMsg(msgEl,
      "Reset email sent. Check your inbox (and spam folder). " +
      "The link expires in 1 hour.",
      "success"
    );
    setLoading(btn, false);
  } catch (err) {
    setMsg(msgEl, authError(err.code));
    setLoading(btn, false);
  }
});
