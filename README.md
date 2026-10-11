# SHATTERED PWA — v1.1.0 Firebase Login

An original, mobile-first music community PWA built around SHATTERED's mission: independent musicians and AI music creators can share and promote music without discrimination based on how it was created.

---

## What's new in v1.1.0

- **Firebase Authentication** — email/password registration and sign-in, Google sign-in, password reset
- **Persistent sessions** — `browserLocalPersistence` keeps users signed in across page reloads
- **Auth guard** — `auth-guard.js` blocks unauthenticated access to the main app and redirects to `login.html`
- **User profiles in Firestore** — each account gets a `users/{uid}` document with display name, bio, and preferences
- **Firestore data layer** — tracks, lyrics, collabs, and posts now use Cloud Firestore instead of Realtime Database
- **Firebase Storage uploads** — audio files are uploaded to Storage (`audio/{uid}/{trackId}/`) with a progress indicator; all users can stream tracks via download URL
- **Ownership controls** — delete buttons only appear on your own content; Firestore Security Rules enforce ownership server-side
- **Profile dropdown** — click the avatar in the top bar for account name, email, quick links, and sign-out
- **Security rules** — production-ready Firestore and Storage rules with ownership, size limits, and type enforcement
- **Updated service worker** — caches all new auth assets; Firebase API calls are never intercepted

---

## Quick start (local development)

Service workers and installability require HTTPS or `localhost`. Do not open `index.html` from a `file://` URL.

```bash
python -m http.server 8080
# Then open http://localhost:8080/login.html
```

Or use any static HTTPS host (see [DEPLOYMENT.md](./DEPLOYMENT.md)).

---

## Firebase setup (required before login works)

### 1. Create a Firebase project

1. Go to [Firebase Console](https://console.firebase.google.com/) and create a project named **SHATTERED** (or use an existing one).
2. Register a **Web app** inside the project.

### 2. Copy your config

Open `firebase-config.js` and replace the placeholder values with your project's config:

```js
export const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};
```

> These are **client-side** identifiers. They are safe to include in frontend code. **Never** add service-account keys or admin credentials to frontend files.

### 3. Enable Authentication

Firebase Console → Build → Authentication → Get started

Enable:
- **Email/Password** (required)
- **Google** (optional but recommended)

### 4. Add authorized domains

Firebase Console → Authentication → Settings → Authorized domains

Add:
- `localhost`
- Your Cloudflare Pages domain (e.g. `shattered.pages.dev`)
- Any custom domain you configure

### 5. Create the Firestore database

Firebase Console → Build → Firestore Database → Create database

- Choose **production mode** (the project ships with security rules)
- Select a region close to your users

Deploy security rules from the project root:

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules,firestore:indexes
```

Or copy the rules manually from `firestore.rules` into the Firebase Console rules editor.

### 6. Enable Firebase Storage

Firebase Console → Build → Storage → Get started

Deploy storage rules:

```bash
firebase deploy --only storage
```

Or copy `storage.rules` into the Storage rules editor.

### 7. Verify your setup

Open `http://localhost:8080/login.html`, create an account, and confirm you are redirected to the main app.

---

## Project structure

```
├── index.html          Main application shell (requires auth)
├── login.html          Authentication screen
├── app.js              Main application — ES module, uses auth-guard.js
├── login.js            Firebase Auth logic for login.html
├── auth-guard.js       Centralized auth state guard
├── firestore-service.js Firestore read/write operations
├── storage-service.js  Firebase Storage audio upload
├── firebase-config.js  Shared Firebase client config (edit this)
├── styles.css          Main application styles
├── login.css           Authentication screen styles
├── sw.js               Service worker (PWA offline cache)
├── manifest.webmanifest PWA install manifest
├── firestore.rules     Firestore Security Rules
├── storage.rules       Firebase Storage Security Rules
├── firestore.indexes.json Composite index definitions
├── firebase.json       Firebase project config (hosting, rules)
├── .firebaserc         Firebase project alias
├── worker.js           Cloudflare Worker passthrough (for wrangler)
├── wrangler.jsonc      Cloudflare Pages / Worker config
├── DEPLOYMENT.md       Cloudflare Pages deployment guide
└── TEST-REPORT.md      Test coverage report
```

---

## Implemented features

- Installable PWA manifest, SVG icon, updated service worker
- Firebase Authentication: email/password, Google sign-in, password reset
- Persistent sessions (survives page refresh)
- Auth guard: unauthenticated access redirects to login
- Firestore user profiles created on first sign-in
- Profile dropdown: name, email, navigate to profile, sign out
- Firestore real-time listeners for tracks, lyrics, collabs, and posts
- Firebase Storage audio uploads with progress bar
- Playback via local blob (uploader's device) or download URL (all other users)
- Ownership checks on delete (client + server rules)
- Upload progress indicator
- Creator method disclosure on every track
- Lyrics publishing and deletion (owner only)
- Collaboration hub publishing and deletion (owner only)
- Community feed with likes and deletion (owner only)
- Local message drafts (IndexedDB)
- Local notifications
- Track and creator search
- Profile editing (synced to Firestore)
- Text data export

## Known limitations / planned work

- **Private messaging** is not yet real-time multi-user. Local drafts are saved to IndexedDB only. Full DM requires Firestore conversation membership rules (schema is present in `firestore.rules`).
- **Video upload** is planned. Storage and streaming delivery infrastructure is needed before public launch.
- **Push notifications** require a Cloud Functions backend and FCM setup.
- **Moderation tools** (reporting, takedowns, spam prevention) are not yet implemented.
- **Email verification** is not yet enforced. Add `sendEmailVerification` and check `user.emailVerified` before granting full access.
- **Account deletion** requires a Cloud Function to delete Storage files, Firestore documents, and the Auth record in one atomic operation.

## SHATTERED creator policy direction

Welcome human-made, AI-assisted, AI-generated, and hybrid music under consistent rules. Require uploaders to have permission to share their files, respect other creators' rights, credit contributors, and avoid impersonation or deceptive claims. The platform does not generate fake-singer lip-sync videos that pretend a fictional person is actually singing; creators may upload finished music videos and AI visuals once video support is implemented.
