# SHATTERED — Cloudflare Pages Deployment Guide

## Prerequisites

- A Cloudflare account (free tier is sufficient)
- The Firebase project configured as described in [README.md](./README.md)
- Git installed locally

---

## Deployment method A — Cloudflare Pages (Git-connected, recommended)

### 1. Push your code to a Git host

```bash
git remote add origin https://github.com/YOUR_USERNAME/shattered-pwa.git
git push -u origin master
```

### 2. Create a Cloudflare Pages project

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Go to **Workers & Pages → Create → Pages → Connect to Git**.
3. Select your repository.
4. Set the build configuration:
   - **Build command:** _(leave empty — this is a static site, no build step needed)_
   - **Build output directory:** `/` (the project root)
5. Click **Save and Deploy**.

Cloudflare Pages will assign a URL such as `shattered-pwa.pages.dev`.

### 3. Add your Pages domain to Firebase

Firebase Console → Authentication → Settings → Authorized domains → Add domain

Add:
- `shattered-pwa.pages.dev`
- Any custom domain you configure in Cloudflare

### 4. Handle client-side routing

The PWA uses `login.html` and `index.html` at the root. No SPA rewrites are needed for a two-page app. Both pages are served directly as static files.

If you add a custom domain with redirects, ensure `login.html` is reachable without auth and `index.html` is the guarded app shell.

---

## Deployment method B — Wrangler CLI (Cloudflare Workers + Static Assets)

The project includes `wrangler.jsonc` and `worker.js` for deployment via Wrangler.

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Deploy

```bash
wrangler deploy
```

This deploys the static assets and the passthrough Worker defined in `worker.js`.

### 3. Set your Workers domain as an authorized Firebase domain

Same as step 3 above — add `your-worker.workers.dev` to Firebase authorized domains.

---

## Deployment method C — Direct upload (no CLI)

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages → Upload assets**.
2. Drag and drop the project folder or zip it and upload.
3. Add the resulting domain to Firebase authorized domains.

---

## Environment variables and secrets

**Do not** store Firebase credentials as Cloudflare environment variables. The Firebase web client config (`firebase-config.js`) contains public identifiers, not secrets — it is safe in source code.

**Do not** commit service-account keys or admin SDK credentials. If you add Cloud Functions, keep those credentials in Google Secret Manager or Firebase environment config, never in frontend files.

---

## HTTPS

Cloudflare Pages serves all projects over HTTPS automatically. Firebase Authentication requires HTTPS (except `localhost`). No additional TLS configuration is needed.

---

## Service worker scope

The service worker (`sw.js`) is registered at `./sw.js` with scope `./`. This works correctly when the app is served from the root of the Pages domain. If you deploy to a subdirectory, update the `scope` in `manifest.webmanifest` and the registration call in `app.js`.

---

## Checklist before going public

- [ ] Firebase Authentication enabled with email/password and (optionally) Google
- [ ] Cloudflare Pages domain added to Firebase authorized domains
- [ ] Firestore Security Rules deployed (`firebase deploy --only firestore:rules`)
- [ ] Firestore indexes deployed (`firebase deploy --only firestore:indexes`)
- [ ] Storage Security Rules deployed (`firebase deploy --only storage`)
- [ ] `firebase-config.js` contains real project credentials (not placeholders)
- [ ] No service-account keys committed to source control
- [ ] Service worker cache version bumped after any asset changes (`sw.js` → `CACHE` constant)
- [ ] PWA manifest `start_url` resolves correctly over HTTPS
- [ ] Test: register, sign in, upload a track, sign out, sign in again from a second browser
- [ ] Test: one user cannot delete another user's content
- [ ] Test: direct navigation to `index.html` when unauthenticated redirects to `login.html`
- [ ] Test: app installs correctly from HTTPS on mobile

---

## Custom domain (optional)

1. Cloudflare dashboard → Pages project → Custom domains → Set up a custom domain.
2. Follow the DNS instructions (CNAME or Cloudflare-managed nameservers).
3. Add the custom domain to Firebase authorized domains.

---

## Notes

- Cloudflare Pages alone provides static hosting. It does **not** provide the Firebase database, authentication, or media storage. Those services run on Google's infrastructure and are configured separately in the Firebase Console.
- Audio files are served from Firebase Storage, not from Cloudflare Pages. Firebase Storage has its own CDN and access controls.
- If you later add a custom server-side API (e.g., for moderation or Cloud Functions), host those separately and call them from the frontend via HTTPS.
