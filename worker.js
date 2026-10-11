/**
 * worker.js — SHATTERED Cloudflare Worker
 *
 * Handles:
 *   POST /api/upload          — authenticated audio upload → R2
 *   DELETE /api/media/:key    — authenticated delete from R2 (owner only)
 *   GET  /api/media/:key      — public audio streaming with Range support
 *   GET  /api/tracks          — public list of published tracks from R2 metadata
 *   *                         — static asset passthrough (Cloudflare Pages assets)
 *
 * Required Worker bindings (set in wrangler.jsonc + Cloudflare dashboard):
 *   env.BUCKET          — R2 bucket binding (name: BUCKET)
 *   env.FIREBASE_PROJECT_ID — secret: your Firebase projectId (e.g. remix-studio-4bf8a)
 *
 * All R2 credentials stay server-side — never exposed to the browser.
 * Firebase Auth is used for identity: the browser sends its Firebase ID token
 * in the Authorization header; this Worker verifies it server-side.
 */

/* ── Constants ────────────────────────────────────────────────────────────── */
const MAX_AUDIO_BYTES = 80 * 1024 * 1024; // 80 MB

const ALLOWED_AUDIO_MIME = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/ogg", "audio/flac", "audio/x-flac",
  "audio/mp4", "audio/x-m4a", "audio/aac", "audio/webm",
]);

/* ── CORS headers ─────────────────────────────────────────────────────────── */
function corsHeaders(origin) {
  const allowed = [
    "https://shattered.pages.dev",
    "https://shattered-pwa.pages.dev",
    "https://legend200711.github.io",
    "http://localhost:5000",
    "http://localhost:8080",
    "http://localhost",
  ];
  const ao = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin":  ao,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Track-Id, X-Owner-Uid, X-Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}

function cors(response, origin) {
  const r = new Response(response.body, response);
  const h = corsHeaders(origin);
  Object.entries(h).forEach(([k, v]) => r.headers.set(k, v));
  return r;
}

function json(data, status = 200, origin = "") {
  const r = new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
  return r;
}

/* ── Firebase ID token verification ──────────────────────────────────────── */
/**
 * Verify a Firebase ID token without the Admin SDK.
 * Uses Firebase's public certificate endpoint to fetch RSA public keys,
 * then validates the JWT signature, expiry, audience, and issuer.
 *
 * Returns the decoded payload (including uid = payload.sub) or throws.
 */
async function verifyFirebaseToken(idToken, projectId) {
  // 1. Decode header + payload (no verification yet)
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");

  function b64url(s) {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + (4 - s.length % 4) % 4, "="));
  }

  const header  = JSON.parse(b64url(parts[0]));
  const payload = JSON.parse(b64url(parts[1]));

  // 2. Basic claims validation
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now)       throw new Error("Token expired");
  if (payload.iat > now + 60)  throw new Error("Token issued in the future");
  if (payload.aud !== projectId) throw new Error("Token audience mismatch");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Token issuer mismatch");
  if (!payload.sub)            throw new Error("Token missing subject");

  // 3. Fetch Firebase public signing certs
  const certsUrl = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
  const certsResp = await fetch(certsUrl);
  if (!certsResp.ok) throw new Error("Could not fetch Firebase public certs");
  const certs = await certsResp.json();

  const certPem = certs[header.kid];
  if (!certPem) throw new Error("Unknown signing key kid: " + header.kid);

  // 4. Import the RSA public key from PEM
  const pemBody = certPem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const certDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey(
    "spki",
    certDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  // 5. Verify signature
  // b64url() already decodes the base64url to raw bytes (as a Latin-1 string via atob).
  // Do NOT call atob() again on the result — that would double-decode the signature bytes
  // and produce garbage, causing crypto.subtle.verify to always return false.
  const signingInput = `${parts[0]}.${parts[1]}`;
  const sigBytes     = Uint8Array.from(b64url(parts[2]), c => c.charCodeAt(0));
  const dataBytes    = new TextEncoder().encode(signingInput);

  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, sigBytes, dataBytes);
  if (!valid) throw new Error("Invalid token signature");

  return payload; // payload.sub is the Firebase UID
}

/* ── Auth middleware ──────────────────────────────────────────────────────── */
async function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) throw Object.assign(new Error("Missing Authorization header"), { status: 401 });

  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw Object.assign(new Error("FIREBASE_PROJECT_ID secret not configured"), { status: 500 });

  try {
    const payload = await verifyFirebaseToken(token, projectId);
    return payload; // { sub: uid, email, ... }
  } catch (err) {
    throw Object.assign(new Error("Unauthorized: " + err.message), { status: 401 });
  }
}

/* ── R2 key helpers ───────────────────────────────────────────────────────── */
function audioKey(ownerUid, trackId, ext) {
  return `audio/${ownerUid}/${trackId}.${ext}`;
}

/* ── POST /api/upload ─────────────────────────────────────────────────────── */
async function handleUpload(request, env, origin) {
  // 1. Auth
  let payload;
  try {
    payload = await requireAuth(request, env);
  } catch (err) {
    return json({ error: err.message }, err.status || 401, origin);
  }
  const ownerUid = payload.sub;

  // 2. Parse multipart form
  let formData;
  try {
    formData = await request.formData();
  } catch (_) {
    return json({ error: "Invalid multipart body" }, 400, origin);
  }

  const file    = formData.get("audio");
  const trackId = formData.get("trackId");

  if (!file || typeof file === "string") {
    return json({ error: "No audio file in upload" }, 400, origin);
  }
  if (!trackId) {
    return json({ error: "Missing trackId field" }, 400, origin);
  }

  // 3. Validate
  if (file.size > MAX_AUDIO_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return json({ error: `File is ${mb} MB — maximum is 80 MB.` }, 413, origin);
  }

  const contentType = file.type || "audio/mpeg";
  // Normalise: strip parameters like "; codecs=..."
  const mimeBase = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_AUDIO_MIME.has(mimeBase)) {
    return json({ error: `File type "${mimeBase}" is not supported. Use MP3, WAV, OGG, FLAC, or M4A.` }, 415, origin);
  }

  // 4. Derive storage key
  const ext = (file.name || "track").split(".").pop().toLowerCase() || "mp3";
  const key = audioKey(ownerUid, trackId, ext);

  // 5. Upload to R2
  try {
    const arrayBuffer = await file.arrayBuffer();
    await env.BUCKET.put(key, arrayBuffer, {
      httpMetadata: { contentType: mimeBase },
      customMetadata: {
        ownerUid,
        trackId,
        originalName: file.name || "",
      },
    });
  } catch (err) {
    console.error("R2 put error:", err);
    return json({ error: "Storage error: " + err.message }, 502, origin);
  }

  // 6. Build public URL
  // If BUCKET_PUBLIC_DOMAIN is set (e.g. pub-xxx.r2.dev or custom domain),
  // construct a direct URL. Otherwise use the /api/media/ proxy.
  let url;
  if (env.BUCKET_PUBLIC_DOMAIN) {
    url = `https://${env.BUCKET_PUBLIC_DOMAIN}/${key}`;
  } else {
    // Fallback: serve via this Worker's own /api/media/ endpoint
    const workerBase = new URL(request.url).origin;
    url = `${workerBase}/api/media/${encodeURIComponent(key)}`;
  }

  return json({ url, storagePath: key }, 200, origin);
}

/* ── DELETE /api/media/:key ───────────────────────────────────────────────── */
async function handleDelete(request, env, origin, key) {
  // Auth
  let payload;
  try {
    payload = await requireAuth(request, env);
  } catch (err) {
    return json({ error: err.message }, err.status || 401, origin);
  }

  // Ownership check: key must start with audio/{ownerUid}/
  const ownerUid = payload.sub;
  if (!key.startsWith(`audio/${ownerUid}/`)) {
    return json({ error: "Forbidden: you do not own this file" }, 403, origin);
  }

  try {
    await env.BUCKET.delete(key);
    return json({ deleted: true }, 200, origin);
  } catch (err) {
    return json({ error: "Delete error: " + err.message }, 502, origin);
  }
}

/* ── GET /api/media/:key ─────────────────────────────────────────────────── */
/**
 * Proxy audio from R2 with full HTTP Range support so browsers can seek.
 * All files in the bucket are considered public once they are published —
 * the Worker serves them without auth, matching the "public listening"
 * requirement. Unpublished tracks should not have their key advertised in
 * the frontend at all (Firestore only returns published track URLs).
 */
async function handleMedia(request, env, origin, key) {
  const rangeHeader = request.headers.get("Range");

  let object;
  try {
    if (rangeHeader) {
      object = await env.BUCKET.get(key, { range: rangeHeader });
    } else {
      object = await env.BUCKET.get(key);
    }
  } catch (err) {
    return json({ error: "Storage error" }, 502, origin);
  }

  if (!object) {
    return json({ error: "Not found" }, 404, origin);
  }

  const status = rangeHeader ? 206 : 200;
  const headers = new Headers({
    "Content-Type":  object.httpMetadata?.contentType || "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ...corsHeaders(origin),
  });

  if (object.range) {
    const { offset, length } = object.range;
    const total = object.size;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${total}`);
    headers.set("Content-Length", String(length));
  } else {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, { status, headers });
}

/* ── Main fetch handler ───────────────────────────────────────────────────── */
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const origin = request.headers.get("Origin") || "";
    const method = request.method.toUpperCase();

    // Preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // API routes
    if (path === "/api/upload" && method === "POST") {
      return handleUpload(request, env, origin);
    }

    if (path.startsWith("/api/media/") && method === "DELETE") {
      const key = decodeURIComponent(path.slice("/api/media/".length));
      return handleDelete(request, env, origin, key);
    }

    if (path.startsWith("/api/media/") && method === "GET") {
      const key = decodeURIComponent(path.slice("/api/media/".length));
      return handleMedia(request, env, origin, key);
    }

    // Static assets (Cloudflare Pages / Worker Assets)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
