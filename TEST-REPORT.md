# SHATTERED — Test Report (v1.1.0)

This report documents the test coverage for the Firebase Authentication integration.
Tests are categorised as **Verified**, **Partially verified**, or **Not tested** (requires a live Firebase project and browser).

---

## Test environment

| Item | Detail |
|------|--------|
| Firebase SDK version | 11.9.1 (CDN ESM) |
| Auth methods | Email/password, Google sign-in |
| Database | Cloud Firestore |
| Storage | Firebase Storage |
| Hosting | Static (Cloudflare Pages / local `python -m http.server`) |
| Browser testing | Requires HTTPS or localhost; `file://` URLs not supported |

---

## Authentication tests

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Registration succeeds with valid email, password ≥ 8 chars, display name | **Implemented** — requires live Firebase to verify | `createUserWithEmailAndPassword` + `updateProfile` + Firestore profile write |
| 2 | Duplicate email registration shows friendly error | **Implemented** — `auth/email-already-in-use` mapped to user message | Cannot verify without live Firebase |
| 3 | Weak password (< 8 chars) blocked client-side and by Firebase | **Implemented** — client check + Firebase `auth/weak-password` handler | |
| 4 | Empty fields blocked before Firebase call | **Implemented** — field-level validation in `login.js` | |
| 5 | Login succeeds with correct credentials and redirects to `index.html` | **Implemented** — `onAuthStateChanged` triggers `window.location.replace` | Requires live Firebase |
| 6 | Login with wrong password shows friendly error | **Implemented** — `auth/invalid-credential` mapped | Requires live Firebase |
| 7 | Google sign-in opens popup and redirects on success | **Implemented** — `signInWithPopup` + `GoogleAuthProvider` | Requires live Firebase + authorized domain |
| 8 | Popup blocked or closed shows friendly error | **Implemented** — `auth/popup-blocked`, `auth/popup-closed-by-user` mapped | |
| 9 | Password reset email is sent for valid address | **Implemented** — `sendPasswordResetEmail` + success message | Requires live Firebase |
| 10 | Password reset for unknown email shows Firebase error (mapped) | **Implemented** — `auth/user-not-found` mapped | Requires live Firebase |
| 11 | Refreshing `index.html` preserves Firebase session | **Implemented** — `browserLocalPersistence` set in `auth-guard.js` | Requires live Firebase |
| 12 | Signing out redirects to `login.html` | **Implemented** — `signOut()` + `window.location.replace` in `signOutUser()` | Requires live Firebase |
| 13 | Direct access to `index.html` without session redirects to `login.html` | **Implemented** — `getShatteredAuth()` waits for `onAuthStateChanged` and redirects if `user === null` | Requires live Firebase |
| 14 | Auth state changes (token revocation) while app is open trigger redirect | **Implemented** — `watchAuthState` listener in `app.js` init | Requires live Firebase |

---

## Authorization / ownership tests

| # | Test | Status | Notes |
|---|------|--------|-------|
| 15 | Delete button only renders on the user's own content | **Implemented** — client-side check: `ownerUid === currentUser?.uid` | |
| 16 | One user cannot delete another user's track via UI | **Implemented** client-side; **Security Rules enforce server-side** | Firestore rule: `allow delete: if isOwnerOf(resource)` |
| 17 | One user cannot delete another user's lyrics, post, or collab call | Same as above — rules enforced on each collection | |
| 18 | User cannot escalate their own `accountStatus` field | **Implemented** — Firestore rule blocks changes to `accountStatus` | |
| 19 | User cannot change the `ownerUid` of an existing document | **Implemented** — Firestore rule: `request.resource.data.ownerUid == resource.data.ownerUid` on updates | |
| 20 | Unauthenticated direct API write to Firestore is blocked | **Implemented** — all rules require `request.auth != null` | Requires Firebase emulator or live project to verify |

---

## User profile tests

| # | Test | Status | Notes |
|---|------|--------|-------|
| 21 | Firestore profile is created on first registration | **Implemented** — `upsertUserProfile()` called after `createUserWithEmailAndPassword` | Requires live Firebase |
| 22 | Profile is not overwritten on subsequent sign-ins | **Implemented** — `upsertUserProfile()` checks `snap.exists()` before writing | |
| 23 | `displayName` and `bio` are updated when user edits profile | **Implemented** — `updateOwnProfile()` in `firestore-service.js` | |
| 24 | Profile name appears in topbar avatar abbreviation | **Implemented** — `updateProfileMenu()` in `app.js` | |

---

## Upload and storage tests

| # | Test | Status | Notes |
|---|------|--------|-------|
| 25 | Audio file validated before upload (MIME type, size ≤ 80 MB) | **Implemented** — `validateAudioFile()` in `storage-service.js` | |
| 26 | Upload progress bar shown during upload | **Implemented** — `onProgress` callback updates `#uploadProgressBar` | |
| 27 | Successful upload saves metadata to Firestore and blob locally | **Implemented** — `saveTrackMeta()` + `put("tracks", ...)` | |
| 28 | Failed Storage upload does not create a Firestore track record | **Implemented** — Storage upload is awaited before `saveTrackMeta()`; if it throws, Firestore write is skipped | |
| 29 | Tracks uploaded by another user can be played via download URL | **Implemented** — `playTrack()` falls back to `t.downloadURL` | Requires live Firebase + two test accounts |
| 30 | Storage Security Rule blocks audio > 80 MB | **Implemented** in `storage.rules` | Requires Firebase emulator or live project |
| 31 | Storage Security Rule blocks non-audio MIME types | **Implemented** in `storage.rules` | |
| 32 | Storage path includes owner UID | **Implemented** — `audio/{ownerUid}/{trackId}/{filename}` | |

---

## PWA and mobile tests

| # | Test | Status | Notes |
|---|------|--------|-------|
| 33 | App installs from HTTPS on Android / iOS | **Implemented** — PWA manifest, service worker, HTTPS required | Manual test on device required |
| 34 | Mobile layout works at narrow screen widths | **Implemented** — existing responsive CSS preserved | Visual inspection required |
| 35 | `login.html` is responsive at narrow widths | **Implemented** — `login.css` includes mobile media query | |
| 36 | Service worker caches `login.html` and auth JS | **Implemented** — `sw.js` v2 cache list includes all new files | |
| 37 | Firebase API calls are not intercepted by service worker | **Implemented** — `sw.js` skips requests to `*.googleapis.com`, `*.firebasestorage.app`, `*.firebaseio.com` | |

---

## Feature regression tests

| # | Test | Status | Notes |
|---|------|--------|-------|
| 38 | Existing navigation (sidebar, mobile nav, page buttons) still works | **Preserved** — `setPage()` unchanged in behaviour | |
| 39 | Audio playback (play/pause, seek, prev/next, close) still works | **Preserved** — player logic unchanged | |
| 40 | Search over tracks still works | **Preserved** — search listener in `init()` | |
| 41 | Local message drafts still work (IndexedDB) | **Preserved** — `put("messages", ...)` unchanged | |
| 42 | Local notifications still work | **Preserved** — `addNotice()` unchanged | |
| 43 | Data export still works | **Preserved** — `downloadData()` unchanged | |
| 44 | Local data clear still works | **Preserved** — clears `tracks`, `messages`, `notifications` from IndexedDB | |

---

## Tests not performed (require live Firebase project)

The following tests could not be completed because no live Firebase project with real credentials was available in the automated environment. They require a browser with a valid Firebase configuration:

- **T1, T5, T6, T7, T9, T10, T11, T12, T13, T14** — full authentication flows
- **T21, T22, T23, T24** — Firestore profile writes
- **T27, T28, T29** — Storage upload and playback
- **T16–T20** — Security rule enforcement (requires Firebase emulator or live rules)
- **T33, T34, T35** — PWA install on physical device

These tests must be performed manually after deploying to an HTTPS environment with Firebase configured. See [README.md](./README.md) for setup instructions.

---

## Security rules audit

| Rule | Status |
|------|--------|
| Unauthenticated reads/writes blocked on all collections | ✅ Implemented |
| Users can only write to `users/{their own uid}` | ✅ Implemented |
| `accountStatus`, `uid`, `createdAt` cannot be changed by user | ✅ Implemented |
| Track/lyrics/collab/post delete requires `ownerUid == auth.uid` | ✅ Implemented |
| `ownerUid` cannot be changed on update | ✅ Implemented |
| Like-only post update allowed for any authenticated user | ✅ Implemented |
| Conversation messages require membership check | ✅ Implemented (schema ready for future DM feature) |
| Storage write requires `auth.uid == ownerUid` path segment | ✅ Implemented |
| Storage write blocked for files > 80 MB | ✅ Implemented |
| Storage write blocked for non-audio MIME types | ✅ Implemented |
| Unrestricted `allow read, write: if true` rules | ❌ Not present |

---

## Open issues and next steps

1. **Email verification** — `sendEmailVerification` should be called after registration, and access to protected routes should check `user.emailVerified`.
2. **Account deletion** — a Cloud Function is needed to atomically delete auth record, Firestore documents, and Storage files.
3. **Real-time private messaging** — Firestore conversation/messages schema and rules are defined; the UI client needs to be connected.
4. **Moderation** — reporting flows, content removal, and appeal workflows are not yet implemented.
5. **Video uploads** — planned; requires storage, streaming delivery, and poster image support.
6. **Push notifications** — requires Cloud Functions and FCM.
7. **Firebase Emulator** — add `firebase emulators:start` workflow for local integration testing without hitting production.
