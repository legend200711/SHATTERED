# SHATTERED PWA — starter build

An original, mobile-first music community PWA concept built around SHATTERED's mission: independent musicians and AI music creators can share and promote music without discrimination based on how it was created.

## Run locally

Service workers and installability generally require HTTPS or localhost. Do not open `index.html` directly from a `file://` URL.

With Python installed, from this folder run:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080` in a modern browser. On a phone, deploy the folder to an HTTPS static host (Cloudflare Pages is one option) and open the hosted URL. Use the browser menu to install/add to home screen.

## Implemented in this starter

- Responsive desktop and mobile interface, original SHATTERED branding
- Installable PWA manifest, SVG icon, service worker shell cache
- Local IndexedDB persistence for audio files, lyrics, collaboration calls, community posts, message drafts, and notifications
- Direct audio upload into this browser's local database, metadata and creator-method fields
- Audio playback with play/pause, previous/next, and seek controls
- Lyrics publishing and deletion
- Collaboration-call publishing and local interest marker
- Community feed publishing, local likes, and deletion
- Local creator profile editing
- Text-data export and local-data reset
- Search over track metadata
- Escaped user-generated text and basic upload size limit

## Important limitations — not yet a production multi-user service

This is a functional local-first prototype, not a deployed multi-user music network. Content is stored in the current browser/device and does **not** automatically become public or sync to other users. Local message drafts are not delivered to anyone. There is no real login, cross-user database, cloud media storage, video upload/playback, server-side moderation, copyright reporting workflow, push notifications, or production admin console.

The browser stores audio blobs in IndexedDB, so storage quotas vary by device and browser. Clearing site data may remove local uploads. Exported JSON currently contains text metadata only, not the audio files. Keep backups of originals.

## Production architecture recommended

Before public launch, connect:
1. Authentication and per-user access control.
2. Object storage for audio, artwork, and finished videos, with upload validation and signed URLs.
3. A database for users, tracks, lyrics, posts, comments, likes, follows, collaboration requests, messages, and notifications.
4. Server-side authorization and rules; never trust client-only role checks.
5. Real-time delivery for private/group messaging and notifications.
6. Moderation, reporting, copyright takedown, blocking, spam/abuse prevention, and transparent AI/creator-credit fields.
7. Media processing and streaming delivery; do not serve large video files directly from the application server.
8. Automated tests, accessibility checks, backups, monitoring, rate limits, and privacy/data deletion flows.

Cloudflare Pages can host the static PWA, but Pages alone does not provide the complete database, user authentication, media storage, or real-time messaging backend. Choose and configure those services before describing the platform as public and multi-user.

## SHATTERED creator policy direction

Welcome human-made, AI-assisted, AI-generated, and hybrid music under consistent rules. Require uploaders to have permission to share their files, respect other creators' rights, credit contributors, and avoid impersonation or deceptive claims. The platform does not generate fake-singer lip-sync videos that pretend a fictional person is actually singing; creators may upload finished music videos and AI visuals once video support is implemented.
