# SHATTERED PWA — v1.2.0 Public Access

An original, mobile-first music community PWA. Independent musicians and AI music creators can share and promote music without discrimination based on how it was created.

**No account is required to browse and listen.** Visitors can discover, search, and play published tracks without signing in. An account is only needed to upload music, manage an artist profile, or participate in community features.

---

## What's new in v1.2.0

- **Public listening** — anyone can visit SHATTERED and play published tracks without creating an account or logging in
- **Visible music player** — play/pause, track title, artist name, and playback progress are always visible when a track is playing
- **Public music library** — the discover page, music library, lyrics, collab hub, and community feed are fully accessible without authentication
- **Smart auth gating** — identity-requiring features (upload, profile, messaging, commenting) show a clear modal explaining why an account is needed, with a direct link to sign in. No hard redirect, no login wall
- **Inline sign-in prompts** — gated pages show a friendly "sign in or create account" panel instead of a blank page
- **Guest header** — unauthenticated visitors see "Sign in" and "Join free" buttons in the topbar instead of the profile avatar
- **Public Firestore rules** — tracks, lyrics, collabs, posts, and user profiles are readable by unauthenticated requests; writes still require authentication and ownership
- **Public Storage rules** — published audio files and profile photos are readable without authentication; writes are still owner-gated
- **Sidebar sign-in CTA** — guests see a prompt inviting them to create an account in the sidebar
- **Post-sign-out redirect** — signing out now returns to the homepage (public mode) rather than login.html

### Earlier additions (v1.1.0)

- Firebase Authentication — email/password, Google sign-in, password reset
- Persistent sessions — `browserLocalPersistence`
- Firestore user profiles created on first sign-in
- Firebase Storage audio uploads with progress indicator
- Firestore real-time listeners for tracks, lyrics, collabs, and posts
- Ownership controls on delete (client + Firestore Security Rules)
- Profile dropdown with account name, email, quick links, and sign-out

---

## Quick start (local development)

Service workers and installability require HTTPS or `localhost`. Do not open `index.html` from a `file://` URL.

```bash
python -m http.server 8080
# Open http://localhost:8080
# Public browsing works immediately (no login needed).
# Open http://localhost:8080/login.html to create an artist account.
```

Or use any static HTTPS host (see [DEPLOYMENT.md](./DEPLOYMENT.md)).

---

## Firebase setup (required before uploads work)

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
- Your deployment domain (e.g. `shattered.pages.dev` or `legend200711.github.io`)
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

**Key rule changes in v1.2.0:** Public (unauthenticated) reads are now allowed on `tracks` (published only), `lyrics`, `collabs`, `posts`, and `users`. Writes still require authentication and ownership.

### 6. Enable Firebase Storage

Firebase Console → Build → Storage → Get started

Deploy storage rules:

```bash
firebase deploy --only storage
```

Or copy `storage.rules` into the Storage rules editor.

**Key rule changes in v1.2.0:** `allow read: if true` on `audio/` and `profilePhotos/` paths so public visitors can stream tracks without signing in.

### 7. Verify your setup

#### Public visitor test (signed-out browser)
1. Open a private/incognito window and navigate to `http://localhost:8080`
2. You should see the SHATTERED homepage and music library without any login prompt
3. If any tracks have been uploaded, click ▶ on a track — it should play immediately
4. Clicking "Upload music", "My profile", or "Messages" should show an "Account needed" modal, not a login redirect

#### Artist upload test
1. Sign in at `/login.html` with a test account
2. Upload a track — you should see the progress bar reach 100% and be redirected to the music library
3. Open a second private/incognito window (signed out) and navigate to the music library
4. The uploaded track should appear and play without sign-in

---

## Security model

| Action | Unauthenticated visitor | Authenticated user |
|---|---|---|
| Browse music library | ✅ | ✅ |
| Play published tracks | ✅ | ✅ |
| Read lyrics / collabs / feed | ✅ | ✅ |
| View artist profiles | ✅ | ✅ |
| Upload music | ❌ → auth gate | ✅ (own content only) |
| Publish lyrics / collab calls | ❌ → auth gate | ✅ (own content only) |
| Post to community feed | ❌ → auth gate | ✅ |
| Delete own content | ❌ → auth gate | ✅ (own content only) |
| Edit / delete other people's content | ❌ | ❌ (enforced by Security Rules) |
| Read private messages | ❌ | ✅ (participants only) |
| Read draft / private tracks | ❌ | ✅ (owner only) |
| Firestore / Storage writes | ❌ (never) | ✅ (own data, gated by rules) |

---

## Project structure

```
├── index.html          Main application shell (public access, no login wall)
├── login.html          Authentication screen (for artists creating accounts)
├── app.js              Main application — ES module, public + gated modes
├── login.js            Firebase Auth logic for login.html
├── auth-guard.js       Auth state resolver — resolves null for guests
├── firestore-service.js Firestore read/write operations
├── storage-service.js  Firebase Storage audio upload
├── firebase-config.js  Shared Firebase client config (edit this)
├── styles.css          Main application styles
├── login.css           Authentication screen styles
├── sw.js               Service worker (PWA offline cache, v3)
├── manifest.webmanifest PWA install manifest
├── firestore.rules     Firestore Security Rules (public read for published content)
├── storage.rules       Firebase Storage Security Rules (public audio read)
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

- **Public access** — browse, search, and play published music without an account
- **Music player** — always-visible play/pause, track info, artist name, progress bar
- Installable PWA manifest, SVG icon, service worker (v3)
- Firebase Authentication: email/password, Google sign-in, password reset
- Persistent sessions (survives page refresh)
- Smart auth gate: explains per-feature why an account is needed — no blanket login wall
- Firestore user profiles created on first sign-in
- Profile dropdown: name, email, navigate to profile, sign out
- Firestore real-time listeners for tracks, lyrics, collabs, and posts
- Firebase Storage audio uploads with progress bar
- Playback via local blob (uploader's device) or download URL (all users including guests)
- Ownership checks on delete (client + server rules)
- Creator method disclosure on every track
- Lyrics publishing and deletion (owner only)
- Collaboration hub publishing and deletion (owner only)
- Community feed with likes and deletion (owner only)
- Local message drafts (IndexedDB, requires account)
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
- **Favorites / following** — saving favorite tracks or following artists requires an account (not yet built).

## SHATTERED creator policy direction

Welcome human-made, AI-assisted, AI-generated, and hybrid music under consistent rules. Require uploaders to have permission to share their files, respect other creators' rights, credit contributors, and avoid impersonation or deceptive claims. The platform does not generate fake-singer lip-sync videos that pretend a fictional person is actually singing; creators may upload finished music videos and AI visuals once video support is implemented.
