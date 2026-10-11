/**
 * app.js — SHATTERED PWA main application
 *
 * v1.3.0 — Cloudflare R2 storage migration
 *
 * Audio storage: Firebase Storage removed → Cloudflare R2 via Worker API.
 *   - Uploads go to POST /api/upload on the Cloudflare Worker.
 *   - The Worker verifies the Firebase ID token server-side.
 *   - R2 credentials never reach the browser.
 *   - Real XHR upload progress replaces the Firebase SDK's snapshot events.
 *   - Audio is served via /api/media/:key with HTTP Range support for seeking.
 *
 * Everything else is unchanged:
 *   - Firebase Auth for identity (email/password + Google)
 *   - Firestore for track metadata, profiles, lyrics, collabs, posts
 *   - Public music listening without login
 *
 * Public visitors (no account) can:
 *   - Browse the music library and discovery pages
 *   - Play published tracks
 *   - Read lyrics, collab calls, and community posts
 *   - Search for tracks and creators
 *
 * An account is required only for:
 *   - Uploading / publishing music
 *   - Managing an artist profile
 *   - Posting to the community feed
 *   - Publishing lyrics or collab calls
 *   - Deleting own content
 *   - Messaging (future)
 *
 * When a guest tries a gated feature, showAuthGate() explains why
 * and offers a direct link to login.html — no hard redirect.
 */

import {
  getShatteredAuth,
  signOutUser,
  upsertUserProfile,
  watchAuthState,
  requireAuth,
  updateAuthDisplayName,
} from "./auth-guard.js";
import {
  subscribeCollection,
  saveTrackMeta,
  deleteTrack,
  saveLyrics,
  deleteLyrics,
  saveCollab,
  deleteCollab,
  savePost,
  deletePost,
  likePost,
  updateOwnProfile,
  getUserProfile,
} from "./firestore-service.js";
import {
  validateAudioFile,
  uploadAudioFile,
  deleteAudioFile,
  translateStorageError,
} from "./storage-service.js";

"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const DB_NAME = "shattered-music-v1";
let db, tracks=[], lyrics=[], collabs=[], posts=[], messages=[], notifications=[], currentTrackId=null, objectUrls=new Map(), toastTimer;
let currentUser = null;   // Firebase Auth user, null for public visitors
let firestoreUnsubscribes = [];

/**
 * profileCache — holds the latest saved profile values for the signed-in user.
 * Populated by loadProfileCache() which reads the Firestore users/{uid} document.
 * profileView() reads from here so it always shows the persisted values, not
 * the potentially-stale Firebase Auth user object or localStorage.
 *
 * null = not yet loaded; {} = loaded (may have empty strings for new accounts)
 */
let profileCache = null;

/**
 * uploadState — tracks an active upload so Firestore snapshot callbacks
 * cannot destroy the upload UI by calling setPage()/renderHome().
 *
 * Fields while active:
 *   cancel       {Function}  — cancels the Storage task
 *   trackId      {string}    — the pending track document ID
 *   storagePath  {string|null} — set after Storage upload succeeds; used for
 *                              cleanup if Firestore write then fails
 */
let uploadState = null; // null = no upload in progress
const palettes=["","purple","green","orange"];
const esc = value => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const time = sec => { if(!Number.isFinite(sec)) return "0:00"; return `${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,"0")}`; };
function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),3800);}

// ── IndexedDB (local-only stores for messages/notifications) ────────────────
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{const d=req.result;["tracks","lyrics","collabs","posts","messages","notifications","profile"].forEach(n=>{if(!d.objectStoreNames.contains(n))d.createObjectStore(n,{keyPath:"id"});});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function all(store){return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);});}
function put(store,item){return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readwrite");tx.objectStore(store).put(item);tx.oncomplete=()=>resolve(item);tx.onerror=()=>reject(tx.error);});}
function remove(store,id){return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readwrite");tx.objectStore(store).delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
const uid=()=>`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;

// ── Profile cache ────────────────────────────────────────────────────────────
/**
 * Load the signed-in user's Firestore profile into profileCache.
 * Falls back gracefully: if Firestore is unavailable the cache is seeded from
 * the Firebase Auth user object and localStorage so the UI still shows something.
 *
 * Calling this again always does a fresh Firestore fetch so the profile page
 * reflects changes made from another device/browser.
 */
async function loadProfileCache() {
  if (!currentUser) { profileCache = null; return; }

  // Seed immediately from Auth + localStorage so profileView() can render
  // without waiting for the network — will be overwritten on success.
  profileCache = {
    displayName: currentUser.displayName || currentUser.email?.split("@")[0] || "Creator",
    bio:         localStorage.getItem(`shattered-bio-${currentUser.uid}`) || "",
  };

  try {
    const remote = await getUserProfile(currentUser.uid);
    if (remote) {
      // Prefer Firestore values; fall back to Auth / localStorage for empty strings
      profileCache.displayName = remote.displayName || profileCache.displayName;
      profileCache.bio         = remote.bio         ?? profileCache.bio;
      // Keep localStorage in sync so the old code path still works as a fallback
      localStorage.setItem(`shattered-bio-${currentUser.uid}`, profileCache.bio);
    }
  } catch (err) {
    // Network / permission error — keep the seed values already set above
    console.warn("Could not load Firestore profile:", err);
  }
}

// ── Auth gate modal ──────────────────────────────────────────────────────────
/**
 * Show a non-blocking modal explaining why the visitor needs an account
 * for this particular feature. Never blocks public listening.
 */
function showAuthGate(featureDescription) {
  // Remove any existing gate modal
  const existing = $("#authGateModal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "authGateModal";
  overlay.className = "auth-gate-overlay";
  overlay.innerHTML = `
    <div class="auth-gate-box" role="dialog" aria-modal="true" aria-labelledby="authGateTitle">
      <div class="auth-gate-icon">S<span>/</span></div>
      <h2 id="authGateTitle">Account needed</h2>
      <p>${esc(featureDescription)}</p>
      <p class="auth-gate-note">Listening to music is always free — no account required.</p>
      <div class="auth-gate-actions">
        <a href="./login.html" class="btn primary">Sign in or create account</a>
        <button class="btn outline" id="authGateDismiss">Continue as guest</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", e => {
    if (e.target === overlay || e.target.id === "authGateDismiss") overlay.remove();
  });
  document.addEventListener("keydown", function esc(e){
    if(e.key==="Escape"){overlay.remove();document.removeEventListener("keydown",esc);}
  });

  // Focus the dialog
  const box = overlay.querySelector(".auth-gate-box");
  if (box) box.focus?.();
}

// ── Header: update for auth state ────────────────────────────────────────────
function updateHeader(user) {
  // Remove the loading state so the nav becomes visible.
  // This runs once auth is resolved (signed in OR confirmed signed out).
  document.body.removeAttribute("data-auth-state");

  const guestActions  = $("#guestActions");
  const profileWrap   = $("#profileMenuWrap");
  const sidebarSignin = $("#sidebarSignin");
  if (user) {
    if (guestActions)   guestActions.hidden   = true;
    if (profileWrap)    profileWrap.hidden     = false;
    if (sidebarSignin)  sidebarSignin.hidden   = true;
    updateProfileMenu(user);
  } else {
    if (guestActions)   guestActions.hidden   = false;
    if (profileWrap)    profileWrap.hidden     = true;
    if (sidebarSignin)  sidebarSignin.hidden   = false;
  }

  // Show/hide CREATOR TOOLS section for signed-in users
  $$(".sidebar-creator").forEach(el => { el.hidden = !user; });
}

function updateProfileMenu(user) {
  if (!user) return;
  const name  = user.displayName || user.email?.split("@")[0] || "Creator";
  const abbr  = name.slice(0,3).toUpperCase();
  const btn   = $("#profileAvatarBtn");
  if (btn) { btn.textContent = abbr; btn.setAttribute("aria-label", `Account menu — ${name}`); }
  const dName = $("#profileDropdownName");
  const dMail = $("#profileDropdownEmail");
  if (dName) dName.textContent = name;
  if (dMail) dMail.textContent = user.email || "";
}

function bindProfileMenu() {
  const btn      = $("#profileAvatarBtn");
  const dropdown = $("#profileDropdown");
  if (!btn || !dropdown) return;

  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = !dropdown.hidden;
    dropdown.hidden = open;
    btn.setAttribute("aria-expanded", String(!open));
  });

  document.addEventListener("click", e => {
    if (!dropdown.hidden && !dropdown.contains(e.target) && e.target !== btn) {
      dropdown.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
  });

  const signOutBtn = $("#signOutBtn");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      toast("Signing out…");
      await signOutUser();
    });
  }
}

// ── Rendering / state ────────────────────────────────────────────────────────
async function refresh(){
  [messages, notifications] = await Promise.all(["messages","notifications"].map(all));
  renderHome(); updateCounts();
}
function updateCounts(){
  const tc=$("#trackCount");if(tc)tc.textContent=tracks.length;
  const cc=$("#creatorCount");if(cc)cc.textContent=new Set(tracks.map(t=>t.artist)).size||1;
  const nd=$("#notificationDot");if(nd)nd.style.display=notifications.some(n=>!n.read)?"block":"none";
}
function coverMarkup(t,i=0){return `<div class="cover ${palettes[i%palettes.length]}"><div class="cover-mark">S<span>/</span></div></div>`;}
function trackCard(t,i){return `<article class="track-card">${coverMarkup(t,i)}<h3 title="${esc(t.title)}">${esc(t.title)}</h3><p>${esc(t.artist)} · ${esc(t.genre||"Independent")}</p><div class="track-meta"><small>${esc(t.origin||"Creator upload")}</small><button class="play-btn" data-play="${esc(t.id)}" aria-label="Play ${esc(t.title)}">▶</button></div></article>`;}

function renderHome(){
  const featured=$("#featuredTracks");
  if(featured)featured.innerHTML=tracks.length?tracks.slice(0,8).map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1"><b>Your next favorite could start here.</b>${currentUser?'Be the first to share a track. Upload music to build the SHATTERED community.<br><br><button class="btn primary" data-page="upload">＋ Upload the first track</button>':'Be the first to share a track. <a href="./login.html" class="text-link">Create an account</a> to upload music.</div>'}</div>`;
  const ly=$("#latestLyrics");if(ly)ly.innerHTML=lyrics.length?lyrics.slice(0,3).map(l=>`<article class="list-card"><div class="list-icon">≋</div><div><h3>${esc(l.title)}</h3><p>${esc(l.artist)} · ${esc(l.genre||"Lyrics")} · ${esc(l.body?.slice(0,80))}${(l.body?.length||0)>80?"…":""}</p></div></article>`).join(""):`<div class="empty-state"><b>Put your words out there.</b>Publish lyrics, drafts, and songwriting ideas.</div>`;
  const co=$("#latestCollabs");if(co)co.innerHTML=collabs.length?collabs.slice(0,3).map(c=>`<article class="list-card"><div class="list-icon">✳</div><div><h3>${esc(c.title)}</h3><p>${esc(c.creator)} · ${esc(c.kind)} · ${esc(c.description?.slice(0,72))}</p></div><button class="text-link" data-join="${esc(c.id)}">Connect</button></article>`).join(""):`<div class="empty-state"><b>Find your next collaborator.</b>Post an open call for vocals, production, lyrics, visuals, or co-writing.</div>`;
}

// ── Upload overlay (survives Firestore-triggered re-renders) ─────────────────
/**
 * Show a full-page upload progress overlay that is attached directly to
 * document.body — NOT inside #main. This means Firestore snapshot callbacks
 * that call renderHome() / setPage() cannot destroy it mid-upload.
 */
function showUploadOverlay({ title, artist }) {
  removeUploadOverlay();
  const div = document.createElement("div");
  div.id = "uploadOverlay";
  div.className = "upload-overlay";
  div.innerHTML = `
    <div class="upload-overlay-box">
      <div class="upload-overlay-brand">S<span>/</span></div>
      <h2 class="upload-overlay-title">Uploading track</h2>
      <p class="upload-overlay-track">${esc(title)} <span class="upload-overlay-sep">·</span> ${esc(artist)}</p>
      <div class="upload-overlay-status" id="uploadStatus">Preparing upload…</div>
      <div class="progress-bar-wrap upload-overlay-bar">
        <div class="progress-bar" id="uploadOverlayBar" style="width:0%"></div>
      </div>
      <div class="upload-overlay-pct" id="uploadOverlayPct">0%</div>
      <div class="upload-overlay-actions">
        <button class="btn outline upload-cancel-btn" id="uploadCancelBtn">✕ Cancel upload</button>
      </div>
      <div class="upload-overlay-error" id="uploadOverlayError" hidden></div>
    </div>`;
  document.body.appendChild(div);
}

function removeUploadOverlay() {
  const el = document.getElementById("uploadOverlay");
  if (el) el.remove();
}

function setUploadStatus(msg) {
  const el = document.getElementById("uploadStatus");
  if (el) el.textContent = msg;
}

function setUploadProgress(pct) {
  const bar = document.getElementById("uploadOverlayBar");
  const lbl = document.getElementById("uploadOverlayPct");
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (lbl) lbl.textContent = Math.max(0, Math.min(100, pct)) + "%";
}

function showUploadError(msg, onRetry) {
  const errEl = document.getElementById("uploadOverlayError");
  if (errEl) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  const statusEl = document.getElementById("uploadStatus");
  if (statusEl) { statusEl.textContent = "Upload failed"; statusEl.classList.add("upload-status-error"); }
  const cancelBtn = document.getElementById("uploadCancelBtn");
  if (cancelBtn) {
    cancelBtn.textContent = "✕ Dismiss";
    if (onRetry) {
      // Add a retry button next to cancel
      const retryBtn = document.createElement("button");
      retryBtn.className = "btn primary";
      retryBtn.textContent = "↺ Retry";
      retryBtn.onclick = () => { removeUploadOverlay(); onRetry(); };
      cancelBtn.parentNode.insertBefore(retryBtn, cancelBtn);
    }
  }
}

function setPage(page){
  // If an upload is in progress, block navigation to the upload page
  // (Firestore listeners call setPage when they re-render) but allow
  // navigating away from upload to other pages if the user explicitly
  // chooses to leave. The overlay stays visible.
  const main=$("#main");
  $$("[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  $$(".mobile-nav button").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const views={home:homeView,music:musicView,videos:videosView,lyrics:lyricsView,collab:collabView,feed:feedView,messages:messagesView,notifications:notificationsView,upload:uploadView,profile:profileView};

  // When navigating to the profile page, invalidate the cache so that the
  // latest Firestore values are fetched. profileView() handles the async load
  // by showing a brief "Loading…" state and re-rendering when data arrives.
  if (page === "profile" && currentUser) profileCache = null;

  main.innerHTML=(views[page]||homeView)();
  bindForms();
  main.focus({preventScroll:true});
  window.scrollTo({top:0,behavior:"smooth"});
  const dd = $("#profileDropdown");
  if (dd) { dd.hidden = true; const ab = $("#profileAvatarBtn"); if(ab) ab.setAttribute("aria-expanded","false"); }
}

// ── Page views ────────────────────────────────────────────────────────────────

function homeView(){
  const uploadCTA = currentUser
    ? `<button class="btn primary" data-page="upload">＋ Upload your music</button>`
    : `<a href="./login.html" class="btn primary">＋ Share your music</a>`;
  return `<section class="hero"><div class="hero-content"><div class="eyebrow"><span class="pulse"></span> INDEPENDENT MUSIC COMMUNITY</div><h1>YOUR SOUND.<br><em>YOUR RULES.</em></h1><p>A home for independent musicians and AI music creators. Listen free — no account needed. Share tracks, publish lyrics, find collaborators, and be discovered on your terms.</p><div class="hero-buttons">${uploadCTA}<button class="btn outline" data-page="music">Explore music ↗</button></div></div><div class="hero-art"><div class="orbit orbit-a"></div><div class="orbit orbit-b"></div><div class="sound-bars">${Array.from({length:15},()=>"<i></i>").join("")}</div><div class="art-core">S<span>/</span></div><div class="art-caption">BREAK THE<br>EXPECTED</div></div></section><div class="stats-strip"><div><b>${tracks.length}</b><span>TRACKS SHARED</span></div><div><b>${new Set(tracks.map(t=>t.artist)).size||1}</b><span>CREATORS</span></div><div><b>ALL</b><span>GENRES WELCOME</span></div><div><b>NO</b><span>AI MUSIC DISCRIMINATION</span></div></div><section class="section-head"><div><div class="eyebrow">FRESH FREQUENCIES</div><h2>Recently shared</h2></div><button class="text-link" data-page="music">Browse all ↗</button></section><div class="track-grid">${tracks.length?tracks.slice(0,8).map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1"><b>Your next favorite could start here.</b>Be the first to share a track.</div>`}</div><div class="split-sections"><div><section class="section-head"><div><div class="eyebrow">WORDS THAT MATTER</div><h2>Latest lyrics</h2></div><button class="text-link" data-page="lyrics">View all ↗</button></section><div class="stack-list">${lyrics.length?lyrics.slice(0,3).map(l=>`<article class="list-card"><div class="list-icon">≋</div><div><h3>${esc(l.title)}</h3><p>${esc(l.artist)} · ${esc(l.body?.slice(0,75))}</p></div></article>`).join(""):`<div class="empty-state"><b>No lyrics yet.</b></div>`}</div></div><div><section class="section-head"><div><div class="eyebrow">MAKE SOMETHING TOGETHER</div><h2>Open collaborations</h2></div><button class="text-link" data-page="collab">Explore ↗</button></section><div class="stack-list">${collabs.length?collabs.slice(0,3).map(c=>`<article class="list-card"><div class="list-icon">✳</div><div><h3>${esc(c.title)}</h3><p>${esc(c.creator)} · ${esc(c.kind)}</p></div><button class="text-link" data-join="${esc(c.id)}">Connect</button></article>`).join(""):`<div class="empty-state"><b>No open calls yet.</b></div>`}</div></div></div><section class="manifesto"><div class="manifesto-symbol">S<span>/</span></div><div><div class="eyebrow">THE SHATTERED PROMISE</div><h2>Creation comes in many forms.</h2><p>We welcome music made by people, with AI, and through AI. We focus on clear credits, respect for rights, and consistent community standards—not gatekeeping based on creative method.</p></div></section>`;
}

function musicView(){
  const uploadBtn = currentUser
    ? `<button class="btn primary" data-page="upload">＋ Upload music</button>`
    : `<a href="./login.html" class="btn primary">＋ Share music</a>`;
  return `<div class="eyebrow">FIND YOUR FREQUENCY</div><h1 class="page-title">Music library</h1><p class="page-intro">Listen to tracks shared by the community. No account needed to play. ${currentUser?'Upload your own track above.':'<a href="./login.html" class="text-link">Create an account</a> to upload your own tracks.'}</p><div class="section-head"><h2>All tracks (${tracks.length})</h2>${uploadBtn}</div><div class="track-grid">${tracks.length?tracks.map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1"><b>No tracks yet</b>Upload an audio file to start the SHATTERED music library.</div>`}</div>`;
}

function uploadView(){
  if (!currentUser) {
    return `<div class="eyebrow">PUT YOUR SOUND INTO THE WORLD</div><h1 class="page-title">Upload music</h1>
    <div class="panel auth-required-panel">
      <div class="auth-gate-icon">S<span>/</span></div>
      <h2>Create a free account to upload music</h2>
      <p>Uploading and publishing music requires a SHATTERED account. Listening to music is always free and never requires sign-in.</p>
      <div class="hero-buttons">
        <a href="./login.html" class="btn primary">Sign in or create account</a>
        <button class="btn outline" data-page="music">Browse music instead</button>
      </div>
    </div>`;
  }
  const defaultArtist = esc(currentUser?.displayName || currentUser?.email?.split("@")[0] || "");
  return `<div class="eyebrow">PUT YOUR SOUND INTO THE WORLD</div><h1 class="page-title">Upload music</h1><p class="page-intro">Share finished tracks with the SHATTERED community. Track metadata is stored in the cloud. Audio files are uploaded to cloud storage for playback by all users.</p><form id="uploadForm" class="panel"><div class="form-grid"><div class="field"><label for="trackTitle">Track title *</label><input id="trackTitle" name="title" required maxlength="100" placeholder="Give your track a name"></div><div class="field"><label for="artist">Artist / creator name *</label><input id="artist" name="artist" required maxlength="80" placeholder="Your artist name" value="${defaultArtist}"></div><div class="field"><label for="genre">Genre</label><input id="genre" name="genre" maxlength="60" placeholder="Electronic, rock, ambient…"></div><div class="field"><label for="origin">Creation method</label><select id="origin" name="origin"><option>Human-made</option><option>AI-assisted</option><option>AI-generated</option><option>Hybrid / collaborative</option><option>Prefer not to say</option></select></div><div class="field full"><label for="audioFile">Audio file * (MP3, WAV, OGG, M4A, FLAC)</label><input id="audioFile" name="audio" type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg" required><small>Maximum 80 MB. Keep a backup of your original audio files.</small></div><div class="field full" id="uploadProgressWrap" hidden><label>Upload progress</label><div class="progress-bar-wrap"><div class="progress-bar" id="uploadProgressBar" style="width:0%"></div></div><small id="uploadProgressLabel">0%</small></div><div class="field full"><label for="trackDescription">Description / credits</label><textarea id="trackDescription" name="description" maxlength="2000" placeholder="Tell listeners about the track. Credit writers, performers, producers, and contributors."></textarea></div><div class="field full"><label class="check-row"><input type="checkbox" id="rightsCheck" required> I have the right to share this audio and I accept responsibility for its content.</label></div><div class="field full"><button class="btn primary" id="uploadBtn">＋ Share track</button></div></div></form>`;
}

function lyricsView(){
  const form = currentUser
    ? `<form id="lyricsForm" class="panel"><div class="form-grid"><div class="field"><label>Title *</label><input name="title" required maxlength="100" placeholder="Song or lyric title"></div><div class="field"><label>Creator *</label><input name="artist" required maxlength="80" placeholder="Artist name" value="${esc(currentUser?.displayName||"")}"></div><div class="field"><label>Genre / mood</label><input name="genre" maxlength="60" placeholder="Optional"></div><div class="field full"><label>Lyrics *</label><textarea name="body" required maxlength="20000" placeholder="Write or paste your lyrics here…"></textarea></div><div class="field full"><button class="btn primary">Publish lyrics</button></div></div></form>`
    : `<div class="panel auth-required-panel"><div class="auth-gate-icon">S<span>/</span></div><h2>Sign in to publish lyrics</h2><p>Publishing lyrics requires a SHATTERED account. You can read all published lyrics below without signing in.</p><a href="./login.html" class="btn primary">Sign in or create account</a></div>`;
  return `<div class="eyebrow">THE WORDS BEHIND THE SOUND</div><h1 class="page-title">Lyrics & writing</h1><p class="page-intro">Published lyrics, drafts, and ideas from the SHATTERED community.</p>${form}<div class="section-head"><h2>Community lyrics (${lyrics.length})</h2></div><div class="stack-list">${lyrics.length?lyrics.map(l=>`<article class="panel"><div class="eyebrow">${esc(l.genre||"LYRICS")}</div><h2>${esc(l.title)}</h2><p class="page-intro">By ${esc(l.artist)}</p><pre style="white-space:pre-wrap;font:inherit;font-size:13px;line-height:1.8;color:#d4dbe4">${esc(l.body)}</pre>${l.ownerUid===currentUser?.uid?`<button class="text-link" data-delete-lyrics="${esc(l.id)}">Delete</button>`:""}</article>`).join(""):`<div class="empty-state"><b>No lyrics shared yet.</b>Publish the first lyric sheet above.</div>`}</div>`;
}

function collabView(){
  const form = currentUser
    ? `<form id="collabForm" class="panel"><div class="form-grid"><div class="field"><label>Project title *</label><input name="title" required maxlength="100" placeholder="What are you making?"></div><div class="field"><label>Creator name *</label><input name="creator" required maxlength="80" placeholder="Your name" value="${esc(currentUser?.displayName||"")}"></div><div class="field"><label>Looking for *</label><select name="kind"><option>Producer</option><option>Vocalist</option><option>Songwriter / lyricist</option><option>Instrumentalist</option><option>Video / visual artist</option><option>Mixing / mastering</option><option>Open collaboration</option></select></div><div class="field full"><label>Description *</label><textarea name="description" required maxlength="2000" placeholder="Describe the sound, what you need, and how people can connect. Do not post private contact information."></textarea></div><div class="field full"><button class="btn primary">Post collaboration call</button></div></div></form>`
    : `<div class="panel auth-required-panel"><div class="auth-gate-icon">S<span>/</span></div><h2>Sign in to post a collaboration call</h2><p>Posting collaboration calls requires a SHATTERED account. You can browse all open calls below without signing in.</p><a href="./login.html" class="btn primary">Sign in or create account</a></div>`;
  return `<div class="eyebrow">FIND YOUR PEOPLE</div><h1 class="page-title">Collab hub</h1><p class="page-intro">Looking for a producer, vocalist, songwriter, visual artist, or someone to experiment with? Post an open collaboration call.</p>${form}<div class="section-head"><h2>Open calls (${collabs.length})</h2></div><div class="stack-list">${collabs.length?collabs.map(c=>`<article class="panel"><div class="eyebrow">${esc(c.kind)}</div><h3>${esc(c.title)}</h3><p class="page-intro">Posted by ${esc(c.creator)}</p><p>${esc(c.description)}</p><button class="btn outline" data-join="${esc(c.id)}">I'm interested</button> ${c.ownerUid===currentUser?.uid?`<button class="text-link" data-delete-collab="${esc(c.id)}">Delete</button>`:""}</article>`).join(""):`<div class="empty-state"><b>No open calls yet.</b>Start a project and invite the community.</div>`}</div>`;
}

function feedView(){
  const form = currentUser
    ? `<form id="postForm" class="panel"><div class="field"><label>What's on your mind? *</label><textarea name="body" maxlength="2000" required placeholder="Share something with the community…"></textarea></div><button class="btn primary" style="margin-top:12px">Publish post</button></form>`
    : `<div class="panel auth-required-panel"><div class="auth-gate-icon">S<span>/</span></div><h2>Sign in to post to the community feed</h2><p>Posting to the feed requires a SHATTERED account. You can read all community posts without signing in.</p><a href="./login.html" class="btn primary">Sign in or create account</a></div>`;
  return `<div class="eyebrow">WHAT THE COMMUNITY IS MAKING</div><h1 class="page-title">Community feed</h1><p class="page-intro">Share an update, a release note, a creative question, or a collaboration idea.</p>${form}<div id="feedPosts">${posts.length?posts.map(postMarkup).join(""):`<div class="empty-state"><b>The feed is yours to start.</b>Posts are visible to the whole SHATTERED community.</div>`}</div>`;
}

function postMarkup(p){return `<article class="feed-post"><header><div class="avatar">${esc((p.author||"?").slice(0,3).toUpperCase())}</div><div><b>${esc(p.author||"Unknown")}</b><small>${p.createdAt?.seconds?new Date(p.createdAt.seconds*1000).toLocaleString():(p.createdAt?new Date(p.createdAt).toLocaleString():"")}</small></div></header><p>${esc(p.body)}</p><div class="post-actions"><button data-like="${esc(p.id)}">♡ ${p.likes||0} likes</button>${p.ownerUid===currentUser?.uid?`<button data-delete-post="${esc(p.id)}">Delete</button>`:""}</div></article>`;}

function profileView(){
  if (!currentUser) {
    return `<div class="eyebrow">YOUR CREATOR IDENTITY</div><h1 class="page-title">My profile</h1>
    <div class="panel auth-required-panel">
      <div class="auth-gate-icon">S<span>/</span></div>
      <h2>Sign in to manage your profile</h2>
      <p>A SHATTERED artist profile lets you manage your uploaded tracks, publish lyrics, and be discovered by the community.</p>
      <div class="hero-buttons">
        <a href="./login.html" class="btn primary">Sign in or create account</a>
        <button class="btn outline" data-page="music">Browse music instead</button>
      </div>
    </div>`;
  }

  // Use profileCache (sourced from Firestore) so saved values are always shown.
  // If the cache hasn't been loaded yet, trigger a background load and re-render;
  // the UI will show a brief "Loading…" state for new page visits.
  if (!profileCache) {
    loadProfileCache().then(() => {
      // Re-render only if we're still on the profile page
      const activePage = $$("[data-page].active")[0]?.dataset.page;
      if (activePage === "profile") setPage("profile");
    });
    return `<div class="eyebrow">YOUR CREATOR IDENTITY</div><h1 class="page-title">My profile</h1><div class="panel" style="text-align:center;padding:32px"><p style="color:var(--muted)">Loading profile…</p></div>`;
  }

  // Read display values from profileCache (Firestore-backed)
  const name     = profileCache.displayName || "Creator";
  const bio      = profileCache.bio || "";
  const email    = currentUser?.email || "";
  const myTracks = tracks.filter(t => t.ownerUid === currentUser?.uid);
  const myLyrics = lyrics.filter(l => l.ownerUid === currentUser?.uid);
  return `<div class="eyebrow">YOUR CREATOR IDENTITY</div><h1 class="page-title">My profile</h1><div class="profile-banner"><div class="profile-big">${esc(name.slice(0,1).toUpperCase())}</div><div><h2 id="profileBannerName">${esc(name)}</h2><p style="color:var(--muted);font-size:13px">${esc(email)}</p><p id="profileBannerBio">${esc(bio)}</p><p style="margin-top:9px">${myTracks.length} tracks · ${myLyrics.length} lyric sheets</p></div></div><form id="profileForm" class="panel"><h2>Edit your profile</h2><div class="form-grid"><div class="field"><label>Artist / creator name</label><input id="profileNameInput" name="name" required maxlength="80" value="${esc(name)}"></div><div class="field full"><label>Bio</label><textarea id="profileBioInput" name="bio" maxlength="500">${esc(bio)}</textarea></div><div class="field full" id="profileSaveError" style="color:#ff7070;font-size:13px;display:none"></div><div class="field full"><button class="btn primary" id="profileSaveBtn">Save profile</button></div></div></form><div class="panel"><h3>Your music</h3><div class="track-grid">${myTracks.length?myTracks.map(trackCard).join(""):`<p class="page-intro">Your uploaded tracks will appear here.</p>`}</div></div><div class="panel"><h3>Privacy & storage</h3><p class="page-intro">Track metadata, lyrics, collabs, and posts are stored in the SHATTERED community cloud. Audio is uploaded to secure cloud storage. Export your text data at any time.</p><button class="btn outline" id="exportData">Export my text data</button> <button class="btn outline" id="clearData">Clear local data</button></div>`;
}

function videosView(){return `<div class="eyebrow">VISUALS MEET SOUND</div><h1 class="page-title">Music videos</h1><p class="page-intro">Share finished music videos, including AI-generated visuals. SHATTERED's policy is not to provide fake-singer lip-sync generation that presents a fictional person as actually singing.</p><div class="panel"><h2>Video sharing status</h2><p class="page-intro">This build supports audio uploads. Video upload and cloud playback require dedicated storage and streaming delivery. Implementation is planned.</p><button class="btn primary" data-page="upload">Upload a track instead</button></div><div class="empty-state"><b>Video library is a planned module.</b>Next: MP4/WebM uploads, video metadata, poster images, playback, and moderation controls.</div>`;}

function messagesView(){
  if (!currentUser) {
    return `<div class="eyebrow">DIRECT CONNECTIONS</div><h1 class="page-title">Messages</h1>
    <div class="panel auth-required-panel">
      <div class="auth-gate-icon">S<span>/</span></div>
      <h2>Sign in to use messages</h2>
      <p>Direct messaging and group chats require a SHATTERED account to protect members' privacy.</p>
      <a href="./login.html" class="btn primary">Sign in or create account</a>
    </div>`;
  }
  return `<div class="eyebrow">DIRECT CONNECTIONS</div><h1 class="page-title">Messages</h1><p class="page-intro">A local message pad for drafts and notes. Real-time private messaging requires a deployed backend with Firestore conversation membership rules.</p><div class="panel"><h2>Local message pad</h2><div class="field"><label>Conversation label</label><input id="conversationLabel" placeholder="e.g. New collab idea"></div><div class="field" style="margin-top:12px"><label>Message draft</label><textarea id="messageBody" placeholder="Write a draft message…"></textarea></div><button class="btn primary" id="saveMessage" style="margin-top:12px">Save draft locally</button></div><div class="stack-list">${messages.length?messages.map(m=>`<article class="list-card"><div class="list-icon">✉</div><div><h3>${esc(m.label)}</h3><p>${esc(m.body)} · ${new Date(m.createdAt).toLocaleString()}</p></div><button class="text-link" data-delete-message="${esc(m.id)}">Delete</button></article>`).join(""):`<div class="empty-state">Your locally saved drafts will appear here.</div>`}</div>`;
}

function notificationsView(){
  if (!currentUser) {
    return `<div class="eyebrow">STAY IN THE LOOP</div><h1 class="page-title">Notifications</h1>
    <div class="panel auth-required-panel">
      <div class="auth-gate-icon">S<span>/</span></div>
      <h2>Sign in to receive notifications</h2>
      <p>Notifications about your uploads, profile activity, and community interactions require a SHATTERED account.</p>
      <a href="./login.html" class="btn primary">Sign in or create account</a>
    </div>`;
  }
  return `<div class="eyebrow">STAY IN THE LOOP</div><h1 class="page-title">Notifications</h1><p class="page-intro">Local notifications are created when you publish content. Push notifications require a deployed messaging backend.</p><div class="stack-list">${notifications.length?notifications.map(n=>`<article class="list-card"><div class="list-icon">♧</div><div><h3>${esc(n.title)}</h3><p>${esc(n.body)} · ${new Date(n.createdAt).toLocaleString()}</p></div><button class="text-link" data-read="${esc(n.id)}">${n.read?"Read":"Mark read"}</button></article>`).join(""):`<div class="empty-state">No notifications yet.</div>`}<button class="btn outline" id="markAllRead">Mark all as read</button></div>`;
}

function addNotice(title,body){return put("notifications",{id:uid(),title,body,createdAt:Date.now(),read:false});}

// ── Form bindings ────────────────────────────────────────────────────────────
function bindForms(){
  const uf=$("#uploadForm");
  if(uf)uf.onsubmit=async e=>{
    e.preventDefault();
    if (!currentUser) { showAuthGate("Uploading music requires a SHATTERED account."); return; }

    // Prevent duplicate submissions while an upload is already running
    if (uploadState) { toast("An upload is already in progress."); return; }

    const f    = new FormData(uf);
    const file = f.get("audio");

    // Client-side file validation
    const validationErr = validateAudioFile(file);
    if (validationErr) { toast(validationErr); return; }

    const titleVal  = f.get("title")?.trim()  || "";
    const artistVal = f.get("artist")?.trim() || "";
    if (!titleVal)  { toast("Enter a track title."); return; }
    if (!artistVal) { toast("Enter an artist name."); return; }

    const trackId = uid();
    const meta = {
      id:              trackId,
      title:           titleVal,
      artist:          artistVal,
      genre:           f.get("genre")?.trim() || "",
      origin:          f.get("origin") || "Human-made",
      description:     f.get("description")?.trim() || "",
      fileName:        file.name,
      mime:            file.type || "audio/mpeg",
      fileSize:        file.size,
      ownerUid:        currentUser.uid,
      artistDisplayName: currentUser.displayName || currentUser.email?.split("@")[0] || "",
    };

    // Show the body-level upload overlay (immune to DOM re-renders in #main)
    showUploadOverlay({ title: meta.title, artist: meta.artist });
    setUploadStatus("Preparing upload…");
    setUploadProgress(0);

    // Bind the Cancel button — set before we launch the upload
    const bindCancelBtn = () => {
      const btn = document.getElementById("uploadCancelBtn");
      if (btn) btn.onclick = () => {
        if (uploadState?.cancel) uploadState.cancel();
        uploadState = null;
        removeUploadOverlay();
        toast("Upload cancelled.");
      };
    };
    bindCancelBtn();

    // ── 1. Upload audio to Firebase Storage ──────────────────────────────
    const { promise: storagePromise, cancel: cancelStorage } = uploadAudioFile(
      file, trackId, currentUser.uid,
      pct => {
        setUploadProgress(pct);
        if (pct < 100) {
          setUploadStatus(`Uploading… ${pct}%`);
        }
      }
    );

    // Register active state so Firestore listeners know not to interfere
    uploadState = { cancel: cancelStorage, trackId, storagePath: null };
    // Re-bind cancel now that uploadState is set
    bindCancelBtn();

    let storageResult = null;
    try {
      storageResult = await storagePromise;
      // Record storagePath so we can clean up if Firestore write fails
      uploadState.storagePath = storageResult.storagePath;
      setUploadProgress(100);
      setUploadStatus("Saving track details…");
    } catch (storageErr) {
      console.error("Storage upload error:", storageErr);
      uploadState = null;
      const userMsg = translateStorageError(storageErr);
      // Offer retry only for non-permission errors (permission errors need
      // the user to fix their account first)
      const canRetry = storageErr.code !== "storage/unauthorized"
                    && storageErr.code !== "storage/unauthenticated";
      showUploadError(userMsg, canRetry ? () => {
        // Re-submit the form programmatically with the same file
        uf.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      } : null);
      return;
    }

    // ── 2. Save blob locally for instant playback on this device ─────────
    try {
      await put("tracks", { ...meta, blob: file });
    } catch (_) {
      // Local storage failure is non-fatal — cloud copy is the source of truth
    }

    // ── 3. Save metadata to Firestore ─────────────────────────────────────
    const firestoreMeta = {
      ...meta,
      storagePath:       storageResult.storagePath,
      downloadURL:       storageResult.url,
      publicationStatus: "published",
    };

    try {
      await saveTrackMeta(firestoreMeta, currentUser.uid);
    } catch (firestoreErr) {
      console.error("Firestore write error:", firestoreErr);
      // Firestore write failed AFTER the audio was stored.
      // Attempt to delete the orphan Storage file to keep things consistent.
      try { await deleteAudioFile(storageResult.storagePath); } catch (_) {}
      uploadState = null;
      showUploadError(
        "Track details could not be saved (Firestore error). " +
        "The audio file has been removed to avoid duplicates. Please try again.",
        () => {
          uf.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
      );
      return;
    }

    // ── 4. Success ────────────────────────────────────────────────────────
    uploadState = null;
    await addNotice("Track uploaded", `${meta.title} was shared with the community.`);
    setUploadStatus("Upload complete!");
    setUploadProgress(100);
    setTimeout(() => {
      removeUploadOverlay();
      toast(`"${meta.title}" is now live in the music library.`);
      setPage("music");
    }, 1200);
  };

  const lf=$("#lyricsForm");
  if(lf)lf.onsubmit=async e=>{
    e.preventDefault();
    if (!currentUser) { showAuthGate("Publishing lyrics requires a SHATTERED account."); return; }
    const f=new FormData(lf);
    const item={id:uid(),title:f.get("title").trim(),artist:f.get("artist").trim(),genre:f.get("genre").trim(),body:f.get("body").trim(),createdAt:Date.now()};
    await saveLyrics(item, currentUser.uid);
    await addNotice("Lyrics published",`${item.title} was shared with the community.`);
    toast("Lyrics published to the community.");
    setPage("lyrics");
  };

  const cf=$("#collabForm");
  if(cf)cf.onsubmit=async e=>{
    e.preventDefault();
    if (!currentUser) { showAuthGate("Posting collaboration calls requires a SHATTERED account."); return; }
    const f=new FormData(cf);
    const item={id:uid(),title:f.get("title").trim(),creator:f.get("creator").trim(),kind:f.get("kind"),description:f.get("description").trim(),createdAt:Date.now()};
    await saveCollab(item, currentUser.uid);
    await addNotice("Collaboration posted",`${item.title} is now in the community collab hub.`);
    toast("Collaboration call posted to the community.");
    setPage("collab");
  };

  const pf=$("#postForm");
  if(pf)pf.onsubmit=async e=>{
    e.preventDefault();
    if (!currentUser) { showAuthGate("Posting to the community feed requires a SHATTERED account."); return; }
    const f=new FormData(pf);
    const author = currentUser.displayName || currentUser.email?.split("@")[0] || "Creator";
    const item={id:uid(),author,body:f.get("body").trim(),likes:0,ownerUid:currentUser.uid,createdAt:Date.now()};
    await savePost(item, currentUser.uid);
    await addNotice("Post published","Your community update was shared.");
    toast("Post shared with the community.");
    setPage("feed");
  };

  const prof=$("#profileForm");
  if(prof)prof.onsubmit=async e=>{
    e.preventDefault();
    if (!currentUser) return;
    const f    = new FormData(prof);
    const name = f.get("name").trim();
    const bio  = f.get("bio").trim();

    if (!name) { toast("Enter an artist / creator name."); return; }

    // Disable the save button and hide any previous error while saving
    const saveBtn  = document.getElementById("profileSaveBtn");
    const errorDiv = document.getElementById("profileSaveError");
    if (saveBtn)  { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    if (errorDiv) { errorDiv.style.display = "none"; errorDiv.textContent = ""; }

    try {
      // ── 1. Write to Firestore (source of truth) ──────────────────────────
      await updateOwnProfile(currentUser.uid, { displayName: name, bio });

      // ── 2. Update Firebase Auth display name so currentUser.displayName
      //        stays in sync — this is what auth-guard and the header read.
      await updateAuthDisplayName(currentUser, name);

      // ── 3. Update the in-memory cache so profileView() immediately
      //        renders the new values without another Firestore round-trip.
      profileCache = { ...(profileCache || {}), displayName: name, bio };

      // ── 4. Keep localStorage in sync for offline/fallback reads.
      localStorage.setItem(`shattered-bio-${currentUser.uid}`, bio);

      // ── 5. Update the header avatar abbreviation (name may have changed).
      updateProfileMenu(currentUser);

      // ── 6. Update the banner and form values in-place (no page destroy).
      //        This avoids losing scroll position and immediately reflects the
      //        saved values without a full setPage() re-render.
      const bannerName = document.getElementById("profileBannerName");
      const bannerBio  = document.getElementById("profileBannerBio");
      if (bannerName) bannerName.textContent = name;
      if (bannerBio)  bannerBio.textContent  = bio;

      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save profile"; }
      toast("Profile saved.");
    } catch (err) {
      // ── Save failed — surface the real error, preserve the form values ──
      console.error("Profile save error:", err);
      const msg = err?.code === "permission-denied"
        ? "Save failed: permission denied. Make sure you are signed in and try again."
        : `Save failed: ${err?.message || "unknown error"}. Your edits have not been lost.`;
      if (errorDiv) { errorDiv.textContent = msg; errorDiv.style.display = ""; }
      if (saveBtn)  { saveBtn.disabled = false; saveBtn.textContent = "Save profile"; }
      // Do NOT toast "saved" — do NOT call setPage — the form stays open with the user's edits intact.
    }
  };
}

// ── Audio playback ───────────────────────────────────────────────────────────
// Public visitors can play any track with a downloadURL — no sign-in needed.
async function playTrack(id){
  const t=tracks.find(x=>x.id===id);
  if(!t)return;
  const audio=$("#audio");
  if(currentTrackId===id&&!audio.paused){audio.pause();$("#togglePlay").textContent="▶";return;}

  // Prefer local blob (uploader on same device); fall back to Firebase Storage download URL
  if(t.blob){
    if(!objectUrls.has(id))objectUrls.set(id,URL.createObjectURL(t.blob));
    audio.src=objectUrls.get(id);
  } else if (t.downloadURL) {
    audio.src = t.downloadURL;
  } else {
    toast("Audio is not yet available for streaming. The owner may still be uploading.");
    return;
  }

  currentTrackId=id;
  $("#player").hidden=false;
  $("#playerTitle").textContent=t.title;
  $("#playerArtist").textContent=t.artist;
  $("#playerCover").textContent="S/";
  await audio.play().catch(()=>toast("Playback could not start. Try selecting the track again."));
  $("#togglePlay").textContent=audio.paused?"▶":"Ⅱ";
}
function findIndex(){return tracks.findIndex(t=>t.id===currentTrackId);}
function nextTrack(dir){if(!tracks.length)return;let i=findIndex();i=(i+dir+tracks.length)%tracks.length;playTrack(tracks[i].id);}

function downloadData(){
  const payload={exportedAt:new Date().toISOString(),lyrics,collabs,posts,messages};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="shattered-local-export.json";a.click();URL.revokeObjectURL(a.href);toast("Text data exported.");
}

// ── Global click delegation ──────────────────────────────────────────────────
document.addEventListener("click",async e=>{
  const p=e.target.closest("[data-page]");if(p){e.preventDefault();setPage(p.dataset.page);return;}
  const play=e.target.closest("[data-play]");if(play){playTrack(play.dataset.play);return;}
  const join=e.target.closest("[data-join]");if(join){
    if (!currentUser) {
      showAuthGate("Expressing interest in a collaboration requires a SHATTERED account so that other creators can identify and reach you.");
      return;
    }
    const c=collabs.find(x=>x.id===join.dataset.join);
    if(c){await addNotice("Collaboration interest",`You marked interest in "${c.title}". Direct messaging needs a connected backend.`);toast("Interest noted. Connect via direct message when messaging is live.");}
    return;
  }
  const dl=e.target.closest("[data-delete-lyrics]");
  if(dl){
    if(!currentUser){showAuthGate("Deleting content requires a SHATTERED account.");return;}
    const item=lyrics.find(x=>x.id===dl.dataset.deleteLyrics);
    if(item&&item.ownerUid!==currentUser.uid){toast("You can only delete your own lyrics.");return;}
    try{await deleteLyrics(dl.dataset.deleteLyrics);toast("Lyrics deleted.");}catch(err){toast("Could not delete — check permissions.");}
    return;
  }
  const dc=e.target.closest("[data-delete-collab]");
  if(dc){
    if(!currentUser){showAuthGate("Deleting content requires a SHATTERED account.");return;}
    const item=collabs.find(x=>x.id===dc.dataset.deleteCollab);
    if(item&&item.ownerUid!==currentUser.uid){toast("You can only delete your own posts.");return;}
    try{await deleteCollab(dc.dataset.deleteCollab);toast("Collaboration call deleted.");}catch(err){toast("Could not delete — check permissions.");}
    return;
  }
  const dp=e.target.closest("[data-delete-post]");
  if(dp){
    if(!currentUser){showAuthGate("Deleting content requires a SHATTERED account.");return;}
    const item=posts.find(x=>x.id===dp.dataset.deletePost);
    if(item&&item.ownerUid!==currentUser.uid){toast("You can only delete your own posts.");return;}
    try{await deletePost(dp.dataset.deletePost);toast("Post deleted.");}catch(err){toast("Could not delete — check permissions.");}
    return;
  }
  const like=e.target.closest("[data-like]");
  if(like){
    try{await likePost(like.dataset.like);}catch(_){}
    return;
  }
  const dm=e.target.closest("[data-delete-message]");
  if(dm){await remove("messages",dm.dataset.deleteMessage);await refresh();setPage("messages");return;}
  const rd=e.target.closest("[data-read]");
  if(rd){const n=notifications.find(x=>x.id===rd.dataset.read);if(n){n.read=true;await put("notifications",n);await refresh();setPage("notifications");}return;}
});

document.addEventListener("click",async e=>{
  if(e.target.id==="saveMessage"){
    if (!currentUser) { showAuthGate("Saving messages requires a SHATTERED account."); return; }
    const label=$("#conversationLabel")?.value.trim();
    const body=$("#messageBody")?.value.trim();
    if(!label||!body)return toast("Enter a label and message.");
    await put("messages",{id:uid(),label,body,createdAt:Date.now()});
    await addNotice("Draft saved",`Message draft for "${label}" saved locally.`);
    await refresh();setPage("messages");toast("Draft saved locally.");
  }
  if(e.target.id==="markAllRead"){for(const n of notifications){n.read=true;await put("notifications",n);}await refresh();setPage("notifications");toast("Notifications marked as read.");}
  if(e.target.id==="exportData")downloadData();
  if(e.target.id==="clearData"){
    if(confirm("Clear all local SHATTERED data from this browser? Cloud content is not affected. This cannot be undone.")){
      for(const name of ["tracks","messages","notifications"]){const tx=db.transaction(name,"readwrite");tx.objectStore(name).clear();}
      setTimeout(async()=>{await refresh();setPage("home");toast("Local data cleared.");},100);
    }
  }
});

// ── Search ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const gs = $("#globalSearch");
  if (gs) {
    gs.addEventListener("input", e => {
      const q=e.target.value.trim().toLowerCase();
      if(!q)return;
      setPage("music");
      const filtered=tracks.filter(t=>[t.title,t.artist,t.genre,t.description,t.origin].join(" ").toLowerCase().includes(q));
      const grid=$("#main .track-grid");
      if(grid)grid.innerHTML=filtered.length?filtered.map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1">No tracks match "${esc(q)}".</div>`;
    });
  }
});

// ── Audio player controls ────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const tp = $("#togglePlay"); if(tp) tp.addEventListener("click",()=>{const a=$("#audio");if(!a.src)return;if(a.paused)a.play();else a.pause();tp.textContent=a.paused?"▶":"Ⅱ";});
  const pt = $("#prevTrack");  if(pt) pt.addEventListener("click",()=>nextTrack(-1));
  const nt = $("#nextTrack");  if(nt) nt.addEventListener("click",()=>nextTrack(1));
  const cp = $("#closePlayer");if(cp) cp.addEventListener("click",()=>{$("#audio")?.pause();const pl=$("#player");if(pl)pl.hidden=true;});
  const au = $("#audio");
  if(au){
    au.addEventListener("timeupdate",()=>{const a=au;const ct=$("#currentTime");const du=$("#duration");const sk=$("#seek");if(ct)ct.textContent=time(a.currentTime);if(du)du.textContent=time(a.duration);if(sk)sk.value=a.duration?a.currentTime/a.duration*100:0;});
    au.addEventListener("loadedmetadata",()=>{const du=$("#duration");if(du)du.textContent=time(au.duration);});
    au.addEventListener("play",()=>{const tp2=$("#togglePlay");if(tp2)tp2.textContent="Ⅱ";});
    au.addEventListener("pause",()=>{const tp2=$("#togglePlay");if(tp2)tp2.textContent="▶";});
  }
  const sk = $("#seek"); if(sk) sk.addEventListener("input",e=>{const a=$("#audio");if(a&&a.duration)a.currentTime=a.duration*(Number(e.target.value)/100);});
});

// ── Boot ─────────────────────────────────────────────────────────────────────
async function init(){
  if(!("indexedDB" in window)){toast("This browser does not support local storage features.");return;}
  try{
    db = await openDB();

    // Load local-only stores
    [messages, notifications] = await Promise.all(["messages","notifications"].map(all));
    const localTracks = await all("tracks");
    const blobMap = new Map(localTracks.map(t=>[t.id, t.blob]));

    // ── Resolve Firebase auth — public visitors get null user ──────────────
    // getShatteredAuth() resolves once with the current user (or null).
    // We do NOT call watchAuthState here yet — see below.
    let authResult;
    try {
      authResult = await getShatteredAuth();
    } catch (authErr) {
      console.error("Auth resolution error:", authErr);
      authResult = { user: null };
    }
    currentUser = authResult.user;

    // Update header — this clears the loading state and shows the correct nav
    updateHeader(currentUser);
    bindProfileMenu();

    if (currentUser) {
      // Signed-in: upsert Firestore profile (creates if new, updates timestamps)
      await upsertUserProfile(currentUser);
      // Pre-load the profile cache so the profile page renders instantly
      await loadProfileCache();
    }

    // ── Subscribe to published Firestore collections (public read) ─────────
    firestoreUnsubscribes.push(
      subscribeCollection("tracks", remoteArr => {
        // Only show published tracks in the public catalog
        tracks = remoteArr
          .filter(t => t.publicationStatus === "published")
          .map(t => ({ ...t, blob: blobMap.get(t.id) || null }));
        // Don't re-render while an upload overlay is active (the overlay
        // is attached to document.body and is safe, but renderHome() would
        // replace #main content the user might be reading)
        renderHome(); updateCounts();
      }),
      subscribeCollection("lyrics",  arr => { lyrics  = arr; renderHome(); }),
      subscribeCollection("collabs", arr => { collabs = arr; renderHome(); }),
      subscribeCollection("posts",   arr => { posts   = arr; })
    );

    renderHome(); updateCounts(); bindForms();

    // Watch for sign-in / sign-out events AFTER the initial render.
    // watchAuthState fires immediately (Firebase always fires onAuthStateChanged
    // upon subscription), so we skip the initial fire if the user hasn't changed.
    // This prevents an unwanted double setPage() call on every page load.
    let _authWatchInitialized = false;
    watchAuthState(user => {
      const newUser = user ?? null;

      // Skip the immediate fire if auth state hasn't changed since boot
      if (!_authWatchInitialized) {
        _authWatchInitialized = true;
        const sameUser = (newUser?.uid ?? null) === (currentUser?.uid ?? null);
        if (sameUser) return; // No change — initial fire, nothing to do
      }

      const prevUid = currentUser?.uid ?? null;
      currentUser = newUser;
      // Clear profileCache when the user changes (sign-in, sign-out, or
      // account switch) so profileView() fetches fresh data for the new user.
      profileCache = null;
      updateHeader(currentUser);

      // Re-render current page to reflect auth change (sign-in or sign-out).
      // Do NOT navigate away if an upload overlay is active — the user should
      // not lose their upload progress because they signed in from another tab.
      if (!uploadState) {
        const activePage = $$("[data-page].active")[0]?.dataset.page || "home";
        setPage(activePage);
      } else {
        // Auth changed during an active upload. If the user signed out,
        // cancel the in-progress upload to avoid a permission error.
        if (!newUser && prevUid) {
          if (uploadState.cancel) uploadState.cancel();
          uploadState = null;
          removeUploadOverlay();
          toast("You were signed out. Upload cancelled.");
        }
      }
    });

    if("serviceWorker" in navigator && location.protocol !== "file:")
      navigator.serviceWorker.register("./sw.js").catch(err=>console.warn("PWA offline cache unavailable",err));

  }catch(e){console.error(e);toast("Could not initialize. Check console for details.");}
}

init();
