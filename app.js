/**
 * app.js — SHATTERED PWA main application
 *
 * ES Module. Requires Firebase Auth via auth-guard.js.
 * Replaces direct RTDB usage with Firestore (firestore-service.js).
 * Audio blobs stay in local IndexedDB for instant playback.
 * Cloud upload path uses storage-service.js.
 */

import { getShatteredAuth, signOutUser, upsertUserProfile, watchAuthState } from "./auth-guard.js";
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
} from "./storage-service.js";

"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const DB_NAME = "shattered-music-v1";
let db, tracks=[], lyrics=[], collabs=[], posts=[], messages=[], notifications=[], currentTrackId=null, objectUrls=new Map(), toastTimer;
let currentUser = null;   // Firebase Auth user, set by auth guard
let firestoreUnsubscribes = [];
const palettes=["","purple","green","orange"];
const esc = value => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const time = sec => { if(!Number.isFinite(sec)) return "0:00"; return `${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,"0")}`; };
function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),3800);}

// ── IndexedDB (audio blobs + local-only stores) ─────────────────────────────
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{const d=req.result;["tracks","lyrics","collabs","posts","messages","notifications","profile"].forEach(n=>{if(!d.objectStoreNames.contains(n))d.createObjectStore(n,{keyPath:"id"});});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function all(store){return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);});}
function put(store,item){return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readwrite");tx.objectStore(store).put(item);tx.oncomplete=()=>resolve(item);tx.onerror=()=>reject(tx.error);});}
function remove(store,id){return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readwrite");tx.objectStore(store).delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
const uid=()=>`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;

// ── Profile menu ────────────────────────────────────────────────────────────
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

  // Close when clicking outside
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
  if(featured)featured.innerHTML=tracks.length?tracks.slice(0,8).map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1"><b>Your next favorite could start here.</b>Be the first to share a track. Upload music to build the SHATTERED community.<br><br><button class="btn primary" data-page="upload">＋ Upload the first track</button></div>`;
  const ly=$("#latestLyrics");if(ly)ly.innerHTML=lyrics.length?lyrics.slice(0,3).map(l=>`<article class="list-card"><div class="list-icon">≋</div><div><h3>${esc(l.title)}</h3><p>${esc(l.artist)} · ${esc(l.genre||"Lyrics")} · ${esc(l.body?.slice(0,80))}${(l.body?.length||0)>80?"…":""}</p></div></article>`).join(""):`<div class="empty-state"><b>Put your words out there.</b>Publish lyrics, drafts, and songwriting ideas.</div>`;
  const co=$("#latestCollabs");if(co)co.innerHTML=collabs.length?collabs.slice(0,3).map(c=>`<article class="list-card"><div class="list-icon">✳</div><div><h3>${esc(c.title)}</h3><p>${esc(c.creator)} · ${esc(c.kind)} · ${esc(c.description?.slice(0,72))}</p></div><button class="text-link" data-join="${esc(c.id)}">Connect</button></article>`).join(""):`<div class="empty-state"><b>Find your next collaborator.</b>Post an open call for vocals, production, lyrics, visuals, or co-writing.</div>`;
}

function setPage(page){
  const main=$("#main");
  $$("[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  $$(".mobile-nav button").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const views={home:homeView,music:musicView,videos:videosView,lyrics:lyricsView,collab:collabView,feed:feedView,messages:messagesView,notifications:notificationsView,upload:uploadView,profile:profileView};
  main.innerHTML=(views[page]||homeView)();
  bindForms();
  main.focus({preventScroll:true});
  window.scrollTo({top:0,behavior:"smooth"});
  // Close profile dropdown if open
  const dd = $("#profileDropdown");
  if (dd) { dd.hidden = true; const ab = $("#profileAvatarBtn"); if(ab) ab.setAttribute("aria-expanded","false"); }
}

function homeView(){return `<section class="hero"><div class="hero-content"><div class="eyebrow"><span class="pulse"></span> INDEPENDENT MUSIC COMMUNITY</div><h1>YOUR SOUND.<br><em>YOUR RULES.</em></h1><p>A home for independent musicians and AI music creators. Share tracks, publish lyrics, find collaborators, and be discovered on your terms.</p><div class="hero-buttons"><button class="btn primary" data-page="upload">＋ Upload your music</button><button class="btn outline" data-page="music">Explore music ↗</button></div></div><div class="hero-art"><div class="orbit orbit-a"></div><div class="orbit orbit-b"></div><div class="sound-bars">${Array.from({length:15},()=>"<i></i>").join("")}</div><div class="art-core">S<span>/</span></div><div class="art-caption">BREAK THE<br>EXPECTED</div></div></section><div class="stats-strip"><div><b>${tracks.length}</b><span>TRACKS SHARED</span></div><div><b>${new Set(tracks.map(t=>t.artist)).size||1}</b><span>CREATORS</span></div><div><b>ALL</b><span>GENRES WELCOME</span></div><div><b>NO</b><span>AI MUSIC DISCRIMINATION</span></div></div><section class="section-head"><div><div class="eyebrow">FRESH FREQUENCIES</div><h2>Recently shared</h2></div><button class="text-link" data-page="music">Browse all ↗</button></section><div class="track-grid">${tracks.length?tracks.slice(0,8).map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1"><b>Your next favorite could start here.</b>Be the first to share a track.<br><br><button class="btn primary" data-page="upload">＋ Upload the first track</button></div>`}</div><div class="split-sections"><div><section class="section-head"><div><div class="eyebrow">WORDS THAT MATTER</div><h2>Latest lyrics</h2></div><button class="text-link" data-page="lyrics">View all ↗</button></section><div class="stack-list">${lyrics.length?lyrics.slice(0,3).map(l=>`<article class="list-card"><div class="list-icon">≋</div><div><h3>${esc(l.title)}</h3><p>${esc(l.artist)} · ${esc(l.body?.slice(0,75))}</p></div></article>`).join(""):`<div class="empty-state"><b>Put your words out there.</b>Publish lyrics and songwriting ideas.</div>`}</div></div><div><section class="section-head"><div><div class="eyebrow">MAKE SOMETHING TOGETHER</div><h2>Open collaborations</h2></div><button class="text-link" data-page="collab">Explore ↗</button></section><div class="stack-list">${collabs.length?collabs.slice(0,3).map(c=>`<article class="list-card"><div class="list-icon">✳</div><div><h3>${esc(c.title)}</h3><p>${esc(c.creator)} · ${esc(c.kind)}</p></div><button class="text-link" data-join="${esc(c.id)}">Connect</button></article>`).join(""):`<div class="empty-state"><b>Find your next collaborator.</b>Post an open call to connect with producers, vocalists, and visual artists.</div>`}</div></div></div><section class="manifesto"><div class="manifesto-symbol">S<span>/</span></div><div><div class="eyebrow">THE SHATTERED PROMISE</div><h2>Creation comes in many forms.</h2><p>We welcome music made by people, with AI, and through AI. We focus on clear credits, respect for rights, and consistent community standards—not gatekeeping based on creative method.</p></div></section>`;}

function musicView(){return `<div class="eyebrow">FIND YOUR FREQUENCY</div><h1 class="page-title">Music library</h1><p class="page-intro">Listen to tracks shared by the community. Search the library or upload your own track.</p><div class="section-head"><h2>All tracks (${tracks.length})</h2><button class="btn primary" data-page="upload">＋ Upload music</button></div><div class="track-grid">${tracks.length?tracks.map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1"><b>No tracks yet</b>Upload an audio file to start the SHATTERED music library.</div>`}</div>`;}

function uploadView(){
  const defaultArtist = esc(currentUser?.displayName || currentUser?.email?.split("@")[0] || "");
  return `<div class="eyebrow">PUT YOUR SOUND INTO THE WORLD</div><h1 class="page-title">Upload music</h1><p class="page-intro">Share finished tracks with the SHATTERED community. Track metadata is stored in the cloud. Audio files are uploaded to cloud storage for playback by all users.</p><form id="uploadForm" class="panel"><div class="form-grid"><div class="field"><label for="trackTitle">Track title *</label><input id="trackTitle" name="title" required maxlength="100" placeholder="Give your track a name"></div><div class="field"><label for="artist">Artist / creator name *</label><input id="artist" name="artist" required maxlength="80" placeholder="Your artist name" value="${defaultArtist}"></div><div class="field"><label for="genre">Genre</label><input id="genre" name="genre" maxlength="60" placeholder="Electronic, rock, ambient…"></div><div class="field"><label for="origin">Creation method</label><select id="origin" name="origin"><option>Human-made</option><option>AI-assisted</option><option>AI-generated</option><option>Hybrid / collaborative</option><option>Prefer not to say</option></select></div><div class="field full"><label for="audioFile">Audio file * (MP3, WAV, OGG, M4A, FLAC)</label><input id="audioFile" name="audio" type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg" required><small>Maximum 80 MB. Keep a backup of your original audio files.</small></div><div class="field full" id="uploadProgressWrap" hidden><label>Upload progress</label><div class="progress-bar-wrap"><div class="progress-bar" id="uploadProgressBar" style="width:0%"></div></div><small id="uploadProgressLabel">0%</small></div><div class="field full"><label for="trackDescription">Description / credits</label><textarea id="trackDescription" name="description" maxlength="2000" placeholder="Tell listeners about the track. Credit writers, performers, producers, and contributors."></textarea></div><div class="field full"><label class="check-row"><input type="checkbox" id="rightsCheck" required> I have the rights or permissions needed to upload and share this audio, and I have credited collaborators appropriately.</label></div><div class="field full"><button class="btn primary" id="uploadBtn">＋ Share track</button></div></div></form>`;
}

function lyricsView(){return `<div class="eyebrow">THE WORDS BEHIND THE SOUND</div><h1 class="page-title">Lyrics & writing</h1><p class="page-intro">Publish lyrics, drafts, and ideas. Be transparent about co-writing and respect others' copyrighted work.</p><form id="lyricsForm" class="panel"><div class="form-grid"><div class="field"><label>Title *</label><input name="title" required maxlength="100" placeholder="Song or lyric title"></div><div class="field"><label>Creator *</label><input name="artist" required maxlength="80" placeholder="Artist name" value="${esc(currentUser?.displayName||"")}"></div><div class="field"><label>Genre / mood</label><input name="genre" maxlength="60" placeholder="Optional"></div><div class="field full"><label>Lyrics *</label><textarea name="body" required maxlength="20000" placeholder="Write or paste your lyrics here…"></textarea></div><div class="field full"><button class="btn primary">Publish lyrics</button></div></div></form><div class="section-head"><h2>Community lyrics (${lyrics.length})</h2></div><div class="stack-list">${lyrics.length?lyrics.map(l=>`<article class="panel"><div class="eyebrow">${esc(l.genre||"LYRICS")}</div><h2>${esc(l.title)}</h2><p class="page-intro">By ${esc(l.artist)}</p><pre style="white-space:pre-wrap;font:inherit;font-size:13px;line-height:1.8;color:#d4dbe4">${esc(l.body)}</pre>${l.ownerUid===currentUser?.uid?`<button class="text-link" data-delete-lyrics="${esc(l.id)}">Delete</button>`:""}</article>`).join(""):`<div class="empty-state"><b>No lyrics shared yet.</b>Publish the first lyric sheet above.</div>`}</div>`;}

function collabView(){return `<div class="eyebrow">FIND YOUR PEOPLE</div><h1 class="page-title">Collab hub</h1><p class="page-intro">Looking for a producer, vocalist, songwriter, visual artist, or someone to experiment with? Post an open collaboration call.</p><form id="collabForm" class="panel"><div class="form-grid"><div class="field"><label>Project title *</label><input name="title" required maxlength="100" placeholder="What are you making?"></div><div class="field"><label>Creator name *</label><input name="creator" required maxlength="80" placeholder="Your name" value="${esc(currentUser?.displayName||"")}"></div><div class="field"><label>Looking for *</label><select name="kind"><option>Producer</option><option>Vocalist</option><option>Songwriter / lyricist</option><option>Instrumentalist</option><option>Video / visual artist</option><option>Mixing / mastering</option><option>Open collaboration</option></select></div><div class="field full"><label>Description *</label><textarea name="description" required maxlength="2000" placeholder="Describe the sound, what you need, and how people can connect. Do not post private contact information."></textarea></div><div class="field full"><button class="btn primary">Post collaboration call</button></div></div></form><div class="section-head"><h2>Open calls (${collabs.length})</h2></div><div class="stack-list">${collabs.length?collabs.map(c=>`<article class="panel"><div class="eyebrow">${esc(c.kind)}</div><h3>${esc(c.title)}</h3><p class="page-intro">Posted by ${esc(c.creator)}</p><p>${esc(c.description)}</p><button class="btn outline" data-join="${esc(c.id)}">I'm interested</button> ${c.ownerUid===currentUser?.uid?`<button class="text-link" data-delete-collab="${esc(c.id)}">Delete</button>`:""}</article>`).join(""):`<div class="empty-state"><b>No open calls yet.</b>Start a project and invite the community.</div>`}</div>`;}

function feedView(){return `<div class="eyebrow">WHAT THE COMMUNITY IS MAKING</div><h1 class="page-title">Community feed</h1><p class="page-intro">Share an update, a release note, a creative question, or a collaboration idea.</p><form id="postForm" class="panel"><div class="field"><label>What's on your mind? *</label><textarea name="body" maxlength="2000" required placeholder="Share something with the community…"></textarea></div><button class="btn primary" style="margin-top:12px">Publish post</button></form><div id="feedPosts">${posts.length?posts.map(postMarkup).join(""):`<div class="empty-state"><b>The feed is yours to start.</b>Posts are visible to the whole SHATTERED community.</div>`}</div>`;}

function postMarkup(p){return `<article class="feed-post"><header><div class="avatar">${esc((p.author||"?").slice(0,3).toUpperCase())}</div><div><b>${esc(p.author||"Unknown")}</b><small>${p.createdAt?.seconds?new Date(p.createdAt.seconds*1000).toLocaleString():(p.createdAt?new Date(p.createdAt).toLocaleString():"")}</small></div></header><p>${esc(p.body)}</p><div class="post-actions"><button data-like="${esc(p.id)}">♡ ${p.likes||0} likes</button>${p.ownerUid===currentUser?.uid?`<button data-delete-post="${esc(p.id)}">Delete</button>`:""}</div></article>`;}

function profileView(){
  const name = currentUser?.displayName || currentUser?.email?.split("@")[0] || "Creator";
  const email = currentUser?.email || "";
  const savedBio = localStorage.getItem(`shattered-bio-${currentUser?.uid}`) || "Independent creator. Breaking the expected.";
  const myTracks = tracks.filter(t => t.ownerUid === currentUser?.uid);
  const myLyrics = lyrics.filter(l => l.ownerUid === currentUser?.uid);
  return `<div class="eyebrow">YOUR CREATOR IDENTITY</div><h1 class="page-title">My profile</h1><div class="profile-banner"><div class="profile-big">${esc(name.slice(0,1).toUpperCase())}</div><div><h2>${esc(name)}</h2><p style="color:var(--muted);font-size:13px">${esc(email)}</p><p>${esc(savedBio)}</p><p style="margin-top:9px">${myTracks.length} tracks · ${myLyrics.length} lyric sheets</p></div></div><form id="profileForm" class="panel"><h2>Edit your profile</h2><div class="form-grid"><div class="field"><label>Artist / creator name</label><input name="name" required maxlength="80" value="${esc(name)}"></div><div class="field full"><label>Bio</label><textarea name="bio" maxlength="500">${esc(savedBio)}</textarea></div><div class="field full"><button class="btn primary">Save profile</button></div></div></form><div class="panel"><h3>Your music</h3><div class="track-grid">${myTracks.length?myTracks.map(trackCard).join(""):`<p class="page-intro">Your uploaded tracks will appear here.</p>`}</div></div><div class="panel"><h3>Privacy & storage</h3><p class="page-intro">Track metadata, lyrics, collabs, and posts are stored in the SHATTERED community cloud. Audio is uploaded to secure cloud storage. Export your text data at any time.</p><button class="btn outline" id="exportData">Export my text data</button> <button class="btn outline" id="clearData">Clear local data</button></div>`;
}

function videosView(){return `<div class="eyebrow">VISUALS MEET SOUND</div><h1 class="page-title">Music videos</h1><p class="page-intro">Share finished music videos, including AI-generated visuals. SHATTERED's policy is not to provide fake-singer lip-sync generation that presents a fictional person as actually singing.</p><div class="panel"><h2>Video sharing status</h2><p class="page-intro">This build supports audio uploads. Video upload and cloud playback require dedicated storage and streaming delivery. Implementation is planned.</p><button class="btn primary" data-page="upload">Upload a track instead</button></div><div class="empty-state"><b>Video library is a planned module.</b>Next: MP4/WebM uploads, video metadata, poster images, playback, and moderation controls.</div>`;}

function messagesView(){return `<div class="eyebrow">DIRECT CONNECTIONS</div><h1 class="page-title">Messages</h1><p class="page-intro">A local message pad for drafts and notes. Real-time private messaging requires a deployed backend with Firestore conversation membership rules.</p><div class="panel"><h2>Local message pad</h2><div class="field"><label>Conversation label</label><input id="conversationLabel" placeholder="e.g. New collab idea"></div><div class="field" style="margin-top:12px"><label>Message draft</label><textarea id="messageBody" placeholder="Write a draft message…"></textarea></div><button class="btn primary" id="saveMessage" style="margin-top:12px">Save draft locally</button></div><div class="stack-list">${messages.length?messages.map(m=>`<article class="list-card"><div class="list-icon">✉</div><div><h3>${esc(m.label)}</h3><p>${esc(m.body)} · ${new Date(m.createdAt).toLocaleString()}</p></div><button class="text-link" data-delete-message="${esc(m.id)}">Delete</button></article>`).join(""):`<div class="empty-state">Your locally saved drafts will appear here.</div>`}</div>`;}

function notificationsView(){return `<div class="eyebrow">STAY IN THE LOOP</div><h1 class="page-title">Notifications</h1><p class="page-intro">Local notifications are created when you publish content. Push notifications require a deployed messaging backend.</p><div class="stack-list">${notifications.length?notifications.map(n=>`<article class="list-card"><div class="list-icon">♧</div><div><h3>${esc(n.title)}</h3><p>${esc(n.body)} · ${new Date(n.createdAt).toLocaleString()}</p></div><button class="text-link" data-read="${esc(n.id)}">${n.read?"Read":"Mark read"}</button></article>`).join(""):`<div class="empty-state">No notifications yet.</div>`}<button class="btn outline" id="markAllRead">Mark all as read</button></div>`;}

function addNotice(title,body){return put("notifications",{id:uid(),title,body,createdAt:Date.now(),read:false});}

// ── Form bindings ────────────────────────────────────────────────────────────
function bindForms(){
  const uf=$("#uploadForm");
  if(uf)uf.onsubmit=async e=>{
    e.preventDefault();
    if (!currentUser) { toast("Sign in to upload music."); return; }
    const f=new FormData(uf);
    const file=f.get("audio");

    // Validate
    const err = validateAudioFile(file);
    if (err) return toast(err);

    const btn = $("#uploadBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Uploading…"; }

    try{
      const trackId=uid();
      const meta={
        id:trackId,
        title:f.get("title").trim(),
        artist:f.get("artist").trim(),
        genre:f.get("genre").trim(),
        origin:f.get("origin"),
        description:f.get("description").trim(),
        fileName:file.name,
        mime:file.type||"audio/mpeg",
        fileSize:file.size,
        ownerUid:currentUser.uid,
      };

      // Show progress bar
      const pw = $("#uploadProgressWrap");
      const pb = $("#uploadProgressBar");
      const pl = $("#uploadProgressLabel");
      if (pw) pw.hidden = false;

      // 1. Upload audio to Firebase Storage
      let storageResult = null;
      try {
        storageResult = await uploadAudioFile(file, trackId, currentUser.uid, pct => {
          if (pb) pb.style.width = pct + "%";
          if (pl) pl.textContent = pct + "%";
        });
      } catch (storageErr) {
        console.error("Storage upload failed:", storageErr);
        toast("Audio upload failed. Check your connection and try again.");
        if (btn) { btn.disabled = false; btn.textContent = "＋ Share track"; }
        if (pw) pw.hidden = true;
        return;
      }

      // 2. Save blob locally for immediate playback on this device
      await put("tracks",{...meta, blob:file});

      // 3. Save metadata to Firestore (no blob)
      const firestoreMeta = {
        ...meta,
        storagePath: storageResult.storagePath,
        downloadURL: storageResult.url,
      };
      await saveTrackMeta(firestoreMeta, currentUser.uid);

      await addNotice("Track uploaded",`${meta.title} was shared with the community.`);
      toast("Track shared with the community.");
      setPage("music");
    }catch(err){
      console.error(err);
      toast("Could not save the file. Check storage permissions and try again.");
      if (btn) { btn.disabled = false; btn.textContent = "＋ Share track"; }
    }
  };

  const lf=$("#lyricsForm");
  if(lf)lf.onsubmit=async e=>{
    e.preventDefault();
    if (!currentUser) { toast("Sign in to publish lyrics."); return; }
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
    if (!currentUser) { toast("Sign in to post collaboration calls."); return; }
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
    if (!currentUser) { toast("Sign in to post to the community feed."); return; }
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
    const f=new FormData(prof);
    const name = f.get("name").trim();
    const bio  = f.get("bio").trim();
    localStorage.setItem(`shattered-bio-${currentUser.uid}`, bio);
    try {
      await updateOwnProfile(currentUser.uid, { displayName: name, bio });
      toast("Profile saved.");
    } catch(err) {
      toast("Profile saved locally. Cloud sync failed — check connection.");
    }
    setPage("profile");
  };
}

// ── Audio playback ───────────────────────────────────────────────────────────
async function playTrack(id){
  const t=tracks.find(x=>x.id===id);
  if(!t)return;
  const audio=$("#audio");
  if(currentTrackId===id&&!audio.paused){audio.pause();$("#togglePlay").textContent="▶";return;}

  // Prefer local blob; fall back to Firebase Storage download URL
  if(t.blob){
    if(!objectUrls.has(id))objectUrls.set(id,URL.createObjectURL(t.blob));
    audio.src=objectUrls.get(id);
  } else if (t.downloadURL) {
    audio.src = t.downloadURL;
  } else {
    toast("Audio file is not available. Try uploading it from this device.");
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
    const c=collabs.find(x=>x.id===join.dataset.join);
    if(c){await addNotice("Collaboration interest",`You marked interest in "${c.title}". Direct messaging needs a connected backend.`);toast("Interest noted. Connect via direct message when messaging is live.");}
    return;
  }
  const dl=e.target.closest("[data-delete-lyrics]");
  if(dl){
    if(!currentUser){toast("Sign in to delete content.");return;}
    const item=lyrics.find(x=>x.id===dl.dataset.deleteLyrics);
    if(item&&item.ownerUid!==currentUser.uid){toast("You can only delete your own lyrics.");return;}
    try{await deleteLyrics(dl.dataset.deleteLyrics);toast("Lyrics deleted.");}catch(err){toast("Could not delete — check permissions.");}
    return;
  }
  const dc=e.target.closest("[data-delete-collab]");
  if(dc){
    if(!currentUser){toast("Sign in to delete content.");return;}
    const item=collabs.find(x=>x.id===dc.dataset.deleteCollab);
    if(item&&item.ownerUid!==currentUser.uid){toast("You can only delete your own posts.");return;}
    try{await deleteCollab(dc.dataset.deleteCollab);toast("Collaboration call deleted.");}catch(err){toast("Could not delete — check permissions.");}
    return;
  }
  const dp=e.target.closest("[data-delete-post]");
  if(dp){
    if(!currentUser){toast("Sign in to delete content.");return;}
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
    [messages, notifications] = await Promise.all(["messages","notifications"].map(all));
    const localTracks = await all("tracks");
    const blobMap = new Map(localTracks.map(t=>[t.id, t.blob]));

    // ── Authenticate via guard (redirects to login.html if not signed in) ──
    let authResult;
    try {
      authResult = await getShatteredAuth();
    } catch (authErr) {
      // Guard will have redirected; this path is only reached in rare edge cases
      console.error("Auth guard error:", authErr);
      return;
    }
    currentUser = authResult.user;

    // Update profile menu with user details
    updateProfileMenu(currentUser);
    bindProfileMenu();

    // Ensure Firestore profile exists
    await upsertUserProfile(currentUser);

    // Watch for sign-out while app is open
    watchAuthState(user => {
      if (!user) {
        window.location.replace("./login.html");
      }
    });

    // ── Subscribe to Firestore collections ─────────────────────────────────
    firestoreUnsubscribes.push(
      subscribeCollection("tracks", remoteArr => {
        tracks = remoteArr.map(t => ({ ...t, blob: blobMap.get(t.id) || null }));
        renderHome(); updateCounts();
      }),
      subscribeCollection("lyrics",  arr => { lyrics  = arr; renderHome(); }),
      subscribeCollection("collabs", arr => { collabs = arr; renderHome(); }),
      subscribeCollection("posts",   arr => { posts   = arr; })
    );

    renderHome(); updateCounts(); bindForms();

    if("serviceWorker" in navigator && location.protocol !== "file:")
      navigator.serviceWorker.register("./sw.js").catch(err=>console.warn("PWA offline cache unavailable",err));

  }catch(e){console.error(e);toast("Could not initialize. Check console for details.");}
}

init();
