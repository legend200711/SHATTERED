/**
 * worker.js — SHATTERED Cloudflare Worker
 *
 * Handles:
 *   POST /api/upload           — authenticated audio upload → R2
 *   DELETE /api/track/:trackId — authenticated full track delete: R2 + Firestore
 *   DELETE /api/media/:key     — authenticated R2-only delete (owner only)
 *   GET  /api/media/:key       — public audio streaming with Range support
 *   *                          — static asset passthrough (Cloudflare Pages assets)
 *
 * Required Worker bindings (set in wrangler.jsonc + Cloudflare dashboard):
 *   env.BUCKET               — R2 bucket binding (name: BUCKET)
 *   env.FIREBASE_PROJECT_ID  — secret: your Firebase projectId (e.g. remix-studio-4bf8a)
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

  // 3. Fetch Firebase public signing keys (JWK format — directly importable by Web Crypto)
  // Using the JWKS endpoint instead of the X.509 PEM endpoint because
  // crypto.subtle.importKey("spki") expects a raw SubjectPublicKeyInfo blob,
  // not a full X.509 certificate. The JWKS endpoint returns JWK objects that
  // crypto.subtle.importKey("jwk") can consume directly without any ASN.1 parsing.
  const jwksUrl = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
  const jwksResp = await fetch(jwksUrl);
  if (!jwksResp.ok) throw new Error("Could not fetch Firebase public keys");
  const jwks = await jwksResp.json();

  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown signing key kid: " + header.kid);

  // 4. Import the RSA public key from JWK
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
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

/* ── DELETE /api/track/:trackId ────────────────────────────────────────────── */
/**
 * Full track deletion: verifies auth, looks up the track in Firestore to
 * confirm ownership, deletes the R2 audio object, then deletes the Firestore
 * document. Ownership is established from the server-stored ownerUid — the
 * client never supplies the UID used for the ownership check.
 *
 * On partial failure the remaining step is still attempted so the caller can
 * retry. A 207 partial-success response is returned if only one step failed.
 */
async function handleDeleteTrack(request, env, origin, trackId) {
  // 1. Auth — derive caller UID from verified token
  let payload;
  try {
    payload = await requireAuth(request, env);
  } catch (err) {
    return json({ error: err.message }, err.status || 401, origin);
  }
  const callerUid = payload.sub;

  // Validate trackId — must be non-empty, no slashes
  if (!trackId || /[\/\x00]/.test(trackId)) {
    return json({ error: "Invalid track ID" }, 400, origin);
  }

  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    return json({ error: "FIREBASE_PROJECT_ID not configured" }, 500, origin);
  }

  // 2. Fetch the track document from Firestore via REST (no Admin SDK needed)
  //    This is the only source of truth for ownership — we never trust a UID
  //    supplied by the client.
  const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  // We need an access token for Firestore. Re-use the verified Firebase ID token
  // as a bearer credential for the Firestore REST API (it works for user-owned docs).
  const authHeader = request.headers.get("Authorization") || "";
  const idToken    = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let trackDoc;
  try {
    const resp = await fetch(`${fsBase}/tracks/${encodeURIComponent(trackId)}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (resp.status === 404) {
      return json({ error: "Track not found" }, 404, origin);
    }
    // Firestore returns 403 when a document does not exist AND the security rule
    // denies unauthenticated/unowned reads (non-published doc with no data →
    // rule evaluation sees no resource.data and denies). Treat this as 404
    // because the caller is already authenticated; if the doc existed and was
    // owned by the caller they would have read access.
    if (resp.status === 403) {
      return json({ error: "Track not found" }, 404, origin);
    }
    if (!resp.ok) {
      const body = await resp.text();
      return json({ error: `Firestore read error (${resp.status}): ${body.slice(0, 200)}` }, 502, origin);
    }
    trackDoc = await resp.json();
  } catch (err) {
    return json({ error: "Could not reach Firestore: " + err.message }, 502, origin);
  }

  // 3. Ownership check — compare server-stored ownerUid with verified caller UID
  const storedOwnerUid = trackDoc.fields?.ownerUid?.stringValue || "";
  if (!storedOwnerUid || storedOwnerUid !== callerUid) {
    return json({ error: "Forbidden: you do not own this track" }, 403, origin);
  }

  // 4. Delete R2 audio object
  const storagePath = trackDoc.fields?.storagePath?.stringValue || "";
  let r2Deleted   = false;
  let r2Error     = null;

  if (storagePath) {
    try {
      await env.BUCKET.delete(storagePath);
      r2Deleted = true;
    } catch (err) {
      r2Error = err.message;
      console.error("R2 delete error for", storagePath, err);
    }
  } else {
    // No storagePath recorded — nothing to delete from R2, treat as ok
    r2Deleted = true;
  }

  // 5. Delete Firestore document
  let fsDeleted = false;
  let fsError   = null;

  try {
    const delResp = await fetch(`${fsBase}/tracks/${encodeURIComponent(trackId)}`, {
      method:  "DELETE",
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (delResp.ok) {
      fsDeleted = true;
    } else {
      const body = await delResp.text();
      fsError = `Firestore delete (${delResp.status}): ${body.slice(0, 200)}`;
    }
  } catch (err) {
    fsError = err.message;
    console.error("Firestore delete error for track", trackId, err);
  }

  // 6. Also remove from local IndexedDB is client-side only — nothing to do here.
  //    The Firestore listener in the frontend will fire automatically once the
  //    document is deleted, removing the track from the live feed.

  if (r2Deleted && fsDeleted) {
    return json({ deleted: true, trackId }, 200, origin);
  }

  // Partial failure: report what succeeded and what didn't
  return json({
    deleted:    false,
    partial:    true,
    trackId,
    r2Deleted,
    fsDeleted,
    r2Error,
    fsError,
  }, 207, origin);
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

    // Full track delete (R2 + Firestore): DELETE /api/track/:trackId
    if (path.startsWith("/api/track/") && method === "DELETE") {
      const trackId = decodeURIComponent(path.slice("/api/track/".length));
      return handleDeleteTrack(request, env, origin, trackId);
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
