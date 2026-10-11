# SHATTERED — Cloudflare R2 Setup Guide

This document lists every step needed to make audio uploads work through Cloudflare R2.  
Complete these steps **before** testing uploads. Each step takes 1–2 minutes.

---

## Step 1 — Create the R2 bucket

```bash
wrangler r2 bucket create shattered-audio
```

Verify it was created:
```bash
wrangler r2 bucket list
```

You should see `shattered-audio` in the list.

---

## Step 2 — Set the Firebase project ID secret

The Worker needs your Firebase project ID to verify ID tokens. This value must be
a **secret** — not hardcoded in `wrangler.jsonc`.

```bash
wrangler secret put FIREBASE_PROJECT_ID
```

When prompted, type your Firebase project ID:
```
remix-studio-4bf8a
```

Verify:
```bash
wrangler secret list
```

---

## Step 3 — Deploy the Worker

```bash
wrangler deploy
```

The output will show your Worker URL, e.g.:
```
https://shattered-pwa.YOUR_SUBDOMAIN.workers.dev
```

Or if you are using Cloudflare Pages with a Worker (which you are):
```
https://shattered.pages.dev
```

---

## Step 4 — Confirm worker-config.js points to the right URL

Open `worker-config.js` in this project:

```js
export const workerConfig = {
  workerBaseUrl: "https://shattered.pages.dev",
};
```

If your URL is different from `https://shattered.pages.dev`, update this file and
re-deploy (commit + push).

---

## Step 5 — Add shattered.pages.dev to Firebase Auth authorized domains

Without this, sign-in popups are blocked by Firebase.

1. Go to **console.firebase.google.com**
2. Select project **remix-studio-4bf8a**
3. Left sidebar → **Authentication** → **Settings** tab → **Authorized domains**
4. Click **Add domain** → type `shattered.pages.dev` → Save

---

## Step 6 — (Optional) Enable R2 public access for faster playback

By default, audio is proxied through the Worker (`/api/media/:key`), which works
but adds latency. For better performance, enable public access on the bucket:

1. Cloudflare dashboard → **R2** → `shattered-audio` → **Settings**
2. Under **Public access**, click **Allow access**
3. Copy the public hostname shown (e.g. `pub-abc123.r2.dev`)
4. Set it as a Worker secret:

```bash
wrangler secret put BUCKET_PUBLIC_DOMAIN
# When prompted enter: pub-abc123.r2.dev
```

5. Re-deploy: `wrangler deploy`

New uploads will now receive a direct `https://pub-abc123.r2.dev/audio/...` URL
instead of the Worker proxy URL. Existing tracks already in Firestore keep their
old URLs — they still play via the Worker proxy.

---

## Step 7 — Verify the Worker is live

Test the upload endpoint directly:

```bash
curl -X OPTIONS https://shattered.pages.dev/api/upload \
  -H "Origin: https://shattered.pages.dev" \
  -v
```

You should see `204 No Content` and `Access-Control-Allow-Origin` headers.

---

## Step 8 — Push to GitHub (triggers Cloudflare Pages redeploy)

```bash
git add -A
git commit -m "feat: Cloudflare R2 storage migration"
git push origin main
```

Cloudflare Pages automatically redeploys on every push.

---

## How the upload flow works after setup

```
Browser                    Cloudflare Worker             R2 Bucket
  │                               │                          │
  ├─ sign in ─────────────────────►  (Firebase Auth issues token)
  │  ← Firebase ID token          │                          │
  │                               │                          │
  ├─ POST /api/upload ────────────►                          │
  │  Authorization: Bearer <token>│                          │
  │  multipart/form-data: audio   │                          │
  │                               ├─ verify token ──────────►│
  │                               │  (calls Google certs API)│
  │                               │                          │
  │                               ├─ BUCKET.put(key, body) ──►
  │                               │                          │
  │  ← 200 { url, storagePath } ──┤                          │
  │                               │                          │
  ├─ saveTrackMeta to Firestore ──►  (with downloadURL = url)│
  │                               │                          │
```

Public visitors play audio via:
```
GET /api/media/audio/{uid}/{trackId}.mp3
```
The Worker serves the file from R2 with `Accept-Ranges: bytes` support so
browsers can seek without downloading the entire file.

---

## What uses what

| Feature | Service |
|---|---|
| Login, registration, sessions | Firebase Auth |
| Track metadata, profiles, lyrics, posts | Firestore |
| Audio file storage | Cloudflare R2 |
| Upload API + media proxy | Cloudflare Worker |
| Static frontend files | Cloudflare Pages |
| Auth token verification (server-side) | Worker verifies Firebase JWT |

---

## Troubleshooting

**Upload says "Worker URL not configured"**  
→ Check `worker-config.js` — `workerBaseUrl` must not contain `YOUR_WORKER`.

**Upload returns 401 Unauthorized**  
→ Make sure `FIREBASE_PROJECT_ID` secret is set correctly (`wrangler secret list`).  
→ Make sure the user is signed in before uploading.

**Upload returns 500 / "FIREBASE_PROJECT_ID secret not configured"**  
→ Run `wrangler secret put FIREBASE_PROJECT_ID` and enter `remix-studio-4bf8a`.

**Audio plays but can't seek**  
→ The Worker's `/api/media/` endpoint returns `Accept-Ranges: bytes`.  
→ Ensure the R2 object's `contentType` is a real audio MIME (e.g. `audio/mpeg`), not empty.

**"shattered.pages.dev" sign-in popup is blocked**  
→ Add `shattered.pages.dev` to Firebase Console → Authentication → Authorized domains.
