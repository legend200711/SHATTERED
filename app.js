(() => {
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const DB_NAME = "shattered-music-v1";
let db, tracks=[], lyrics=[], collabs=[], posts=[], messages=[], notifications=[], currentTrackId=null, objectUrls=new Map(), toastTimer;
const palettes=["","purple","green","orange"];
const esc = value => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const time = sec => { if(!Number.isFinite(sec)) return "0:00"; return `${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,"0")}`; };
function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),3000);}

// ── IndexedDB (audio blobs + local-only stores) ──────────────────────────────
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{const d=req.result;["tracks","lyrics","collabs","posts","messages","notifications","profile"].forEach(n=>{if(!d.objectStoreNames.contains(n))d.createObjectStore(n,{keyPath:"id"});});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function all(store){return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);});}
function put(store,item){return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readwrite");tx.objectStore(store).put(item);tx.oncomplete=()=>resolve(item);tx.onerror=()=>reject(tx.error);});}
function remove(store,id){return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readwrite");tx.objectStore(store).delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
const uid=()=>`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;

// ── Firebase helpers ─────────────────────────────────────────────────────────
// window.__shatteredFB is set by the module script in index.html before this
// script runs (via defer). If Firebase fails to load we fall back gracefully.
let fbRef, fbSet, fbRemove, fbOnValue, fbAnalytics, fbLogEvent;

async function loadFirebaseHelpers() {
  try {
    const { ref, set, remove: fbRm, onValue } = await import(
      "https://www.gstatic.com/firebasejs/11.9.1/firebase-database.js"
    );
    fbRef      = ref;
    fbSet      = set;
    fbRemove   = fbRm;
    fbOnValue  = onValue;
    if (window.__shatteredFB) {
      fbAnalytics = window.__shatteredFB.analytics;
      fbLogEvent  = window.__shatteredFB.logEvent;
    }
    return true;
  } catch(e) {
    console.warn("Firebase unavailable, running in local-only mode.", e);
    return false;
  }
}

function rtdb() { return window.__shatteredFB && window.__shatteredFB.rtdb; }

// Write a plain-object record to Firebase (no blobs)
async function fbPut(collection, item) {
  const db_ = rtdb();
  if (!db_ || !fbRef || !fbSet) return;
  const safe = Object.fromEntries(
    Object.entries(item).filter(([,v]) => !(v instanceof Blob) && !(v instanceof File))
  );
  await fbSet(fbRef(db_, `${collection}/${item.id}`), safe);
}

// Delete a record from Firebase
async function fbDelete(collection, id) {
  const db_ = rtdb();
  if (!db_ || !fbRef || !fbRemove) return;
  await fbRemove(fbRef(db_, `${collection}/${id}`));
}

// Convert Firebase snapshot object → sorted array
function snapshotToArray(val, sortKey="createdAt") {
  if (!val) return [];
  return Object.values(val).sort((a,b) => (b[sortKey]||0) - (a[sortKey]||0));
}

// Subscribe to a Firebase collection; call cb(array) on every change
function fbSubscribe(collection, cb) {
  const db_ = rtdb();
  if (!db_ || !fbRef || !fbOnValue) return;
  fbOnValue(fbRef(db_, collection), snap => cb(snapshotToArray(snap.val())));
}

// ── Rendering / state ────────────────────────────────────────────────────────
async function refresh(){
  [messages, notifications] = await Promise.all(["messages","notifications"].map(all));
  // tracks/lyrics/collabs/posts come from Firebase listeners (or local fallback)
  renderHome(); updateCounts();
}
function updateCounts(){$("#trackCount").textContent=tracks.length;$("#creatorCount").textContent=new Set(tracks.map(t=>t.artist)).size||1;$("#notificationDot").style.display=notifications.some(n=>!n.read)?"block":"none";}
function coverMarkup(t,i=0){return `<div class="cover ${palettes[i%palettes.length]}"><div class="cover-mark">S<span>/</span></div></div>`;}
function trackCard(t,i){return `<article class="track-card">${coverMarkup(t,i)}<h3 title="${esc(t.title)}">${esc(t.title)}</h3><p>${esc(t.artist)} · ${esc(t.genre||"Independent")}</p><div class="track-meta"><small>${esc(t.origin||"Creator upload")}</small><button class="play-btn" data-play="${esc(t.id)}" aria-label="Play ${esc(t.title)}">▶</button></div></article>`;}
function renderHome(){const featured=$("#featuredTracks");if(featured)featured.innerHTML=tracks.length?tracks.slice(0,8).map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1"><b>Your next favorite could start here.</b>Be the first to share a track. Upload music to build the SHATTERED community.<br><br><button class="btn primary" data-page="upload">＋ Upload the first track</button></div>`;
const ly=$("#latestLyrics");if(ly)ly.innerHTML=lyrics.length?lyrics.slice(0,3).map(l=>`<article class="list-card"><div class="list-icon">≋</div><div><h3>${esc(l.title)}</h3><p>${esc(l.artist)} · ${esc(l.genre||"Lyrics")} · ${esc(l.body.slice(0,80))}${l.body.length>80?"…":""}</p></div></article>`).join(""):`<div class="empty-state"><b>Put your words out there.</b>Publish lyrics, drafts, and songwriting ideas.</div>`;
const co=$("#latestCollabs");if(co)co.innerHTML=collabs.length?collabs.slice(0,3).map(c=>`<article class="list-card"><div class="list-icon">✳</div><div><h3>${esc(c.title)}</h3><p>${esc(c.creator)} · ${esc(c.kind)} · ${esc(c.description.slice(0,72))}</p></div><button class="text-link" data-join="${esc(c.id)}">Connect</button></article>`).join(""):`<div class="empty-state"><b>Find your next collaborator.</b>Post an open call for vocals, production, lyrics, visuals, or co-writing.</div>`;
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
  // Analytics page_view
  if (fbLogEvent && fbAnalytics) {
    try { fbLogEvent(fbAnalytics,"page_view",{page_title:page,page_location:window.location.href}); } catch(_){}
  }
}
function homeView(){return `<section class="hero"><div class="hero-content"><div class="eyebrow"><span class="pulse"></span> INDEPENDENT MUSIC COMMUNITY</div><h1>YOUR SOUND.<br><em>YOUR RULES.</em></h1><p>A home for independent musicians and AI music creators. Share tracks, publish lyrics, find collaborators, and be discovered on your terms.</p><div class="hero-buttons"><button class="btn primary" data-page="upload">＋ Upload your music</button><button class="btn outline" data-page="music">Explore music ↗</button></div></div><div class="hero-art"><div class="orbit orbit-a"></div><div class="orbit orbit-b"></div><div class="sound-bars">${Array.from({length:15},()=>"<i></i>").join("")}</div><div class="art-core">S<span>/</span></div><div class="art-caption">BREAK THE<br>EXPECTED</div></div></section><div class="stats-strip"><div><b>${tracks.length}</b><span>TRACKS SHARED</span></div><div><b>${new Set(tracks.map(t=>t.artist)).size||1}</b><span>CREATORS</span></div><div><b>ALL</b><span>GENRES WELCOME</span></div><div><b>NO</b><span>AI MUSIC DISCRIMINATION</span></div></div><section class="section-head"><div><div class="eyebrow">FRESH FREQUENCIES</div><h2>Recently shared</h2></div><button class="text-link" data-page="music">Browse all ↗</button></section><div class="track-grid">${tracks.length?tracks.slice(0,8).map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1"><b>Your next favorite could start here.</b>Be the first to share a track.<br><br><button class="btn primary" data-page="upload">＋ Upload the first track</button></div>`}</div><div class="split-sections"><div><section class="section-head"><div><div class="eyebrow">WORDS THAT MATTER</div><h2>Latest lyrics</h2></div><button class="text-link" data-page="lyrics">View all ↗</button></section><div class="stack-list">${lyrics.length?lyrics.slice(0,3).map(l=>`<article class="list-card"><div class="list-icon">≋</div><div><h3>${esc(l.title)}</h3><p>${esc(l.artist)} · ${esc(l.body.slice(0,75))}</p></div></article>`).join(""):`<div class="empty-state"><b>Put your words out there.</b>Publish lyrics, drafts, and songwriting ideas.</div>`}</div></div><div><section class="section-head"><div><div class="eyebrow">MAKE SOMETHING TOGETHER</div><h2>Open collaborations</h2></div><button class="text-link" data-page="collab">Explore ↗</button></section><div class="stack-list">${collabs.length?collabs.slice(0,3).map(c=>`<article class="list-card"><div class="list-icon">✳</div><div><h3>${esc(c.title)}</h3><p>${esc(c.creator)} · ${esc(c.kind)} · ${esc(c.description.slice(0,72))}</p></div><button class="text-link" data-join="${esc(c.id)}">Connect</button></article>`).join(""):`<div class="empty-state"><b>Find your next collaborator.</b>Post an open call for vocals, production, lyrics, visuals, or co-writing.</div>`}</div></div></div><section class="manifesto"><div class="manifesto-symbol">S<span>/</span></div><div><div class="eyebrow">THE SHATTERED PROMISE</div><h2>Creation comes in many forms.</h2><p>We welcome music made by people, with AI, and through AI. We focus on clear credits, respect for rights, and consistent community standards—not gatekeeping based on creative method.</p></div></section>`;}
function musicView(){return `<div class="eyebrow">FIND YOUR FREQUENCY</div><h1 class="page-title">Music library</h1><p class="page-intro">Listen to tracks shared on this device. Search the library or upload a track to start your collection.</p><div class="section-head"><h2>All tracks (${tracks.length})</h2><button class="btn primary" data-page="upload">＋ Upload music</button></div><div class="track-grid">${tracks.length?tracks.map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1"><b>No tracks yet</b>Upload an audio file to start listening on this device.</div>`}</div>`;}
function uploadView(){return `<div class="eyebrow">PUT YOUR SOUND INTO THE WORLD</div><h1 class="page-title">Upload music</h1><p class="page-intro">Share finished tracks with the SHATTERED community. Track metadata is synced to the cloud — audio files are stored locally in this browser for playback.</p><form id="uploadForm" class="panel"><div class="form-grid"><div class="field"><label for="trackTitle">Track title *</label><input id="trackTitle" name="title" required maxlength="100" placeholder="Give your track a name"></div><div class="field"><label for="artist">Artist / creator name *</label><input id="artist" name="artist" required maxlength="80" placeholder="Your artist name"></div><div class="field"><label for="genre">Genre</label><input id="genre" name="genre" maxlength="60" placeholder="Electronic, rock, ambient…"></div><div class="field"><label for="origin">Creation method (optional)</label><select id="origin" name="origin"><option>Human-made</option><option>AI-assisted</option><option>AI-generated</option><option>Hybrid / collaborative</option><option>Prefer not to say</option></select></div><div class="field full"><label for="audioFile">Audio file * (MP3, WAV, OGG, M4A, FLAC if browser-supported)</label><input id="audioFile" name="audio" type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg" required><small>Large files may exceed browser storage limits. Keep a backup of your original audio.</small></div><div class="field full"><label for="trackDescription">Description / credits</label><textarea id="trackDescription" name="description" maxlength="2000" placeholder="Tell listeners about the track. Credit writers, performers, producers, and other contributors."></textarea></div><div class="field full"><label class="check-row"><input type="checkbox" id="rightsCheck" required> I have the rights or permissions needed to upload and share this audio, and I have credited collaborators appropriately.</label></div><div class="field full"><button class="btn primary">＋ Upload track</button></div></div></form>`;}
function lyricsView(){return `<div class="eyebrow">THE WORDS BEHIND THE SOUND</div><h1 class="page-title">Lyrics & writing</h1><p class="page-intro">Publish lyrics, drafts, and ideas. Be transparent about co-writing and respect others' copyrighted work.</p><form id="lyricsForm" class="panel"><div class="form-grid"><div class="field"><label>Title *</label><input name="title" required maxlength="100" placeholder="Song or lyric title"></div><div class="field"><label>Creator *</label><input name="artist" required maxlength="80" placeholder="Artist name"></div><div class="field"><label>Genre / mood</label><input name="genre" maxlength="60" placeholder="Optional"></div><div class="field full"><label>Lyrics *</label><textarea name="body" required maxlength="20000" placeholder="Write or paste your lyrics here…"></textarea></div><div class="field full"><button class="btn primary">Publish lyrics</button></div></div></form><div class="section-head"><h2>Community lyrics (${lyrics.length})</h2></div><div class="stack-list">${lyrics.length?lyrics.map(l=>`<article class="panel"><div class="eyebrow">${esc(l.genre||"LYRICS")}</div><h2>${esc(l.title)}</h2><p class="page-intro">By ${esc(l.artist)}</p><pre style="white-space:pre-wrap;font:inherit;font-size:13px;line-height:1.8;color:#d4dbe4">${esc(l.body)}</pre><button class="text-link" data-delete-lyrics="${esc(l.id)}">Delete from community</button></article>`).join(""):`<div class="empty-state"><b>No lyrics shared yet</b>Publish the first lyric sheet above.</div>`}</div>`;}
function collabView(){return `<div class="eyebrow">FIND YOUR PEOPLE</div><h1 class="page-title">Collab hub</h1><p class="page-intro">Looking for a producer, vocalist, songwriter, visual artist, or someone to experiment with? Post an open collaboration call.</p><form id="collabForm" class="panel"><div class="form-grid"><div class="field"><label>Project title *</label><input name="title" required maxlength="100" placeholder="What are you making?"></div><div class="field"><label>Creator name *</label><input name="creator" required maxlength="80" placeholder="Your name"></div><div class="field"><label>Looking for *</label><select name="kind"><option>Producer</option><option>Vocalist</option><option>Songwriter / lyricist</option><option>Instrumentalist</option><option>Video / visual artist</option><option>Mixing / mastering</option><option>Open collaboration</option></select></div><div class="field full"><label>Description *</label><textarea name="description" required maxlength="2000" placeholder="Describe the sound, what you need, and how people can connect. Do not post private contact information."></textarea></div><div class="field full"><button class="btn primary">Post collaboration call</button></div></div></form><div class="section-head"><h2>Open calls (${collabs.length})</h2></div><div class="stack-list">${collabs.length?collabs.map(c=>`<article class="panel"><div class="eyebrow">${esc(c.kind)}</div><h3>${esc(c.title)}</h3><p class="page-intro">Posted by ${esc(c.creator)}</p><p>${esc(c.description)}</p><button class="btn outline" data-join="${esc(c.id)}">I'm interested</button> <button class="text-link" data-delete-collab="${esc(c.id)}">Delete</button></article>`).join(""):`<div class="empty-state"><b>No open calls yet</b>Start a project and invite the community.</div>`}</div>`;}
function feedView(){return `<div class="eyebrow">WHAT THE COMMUNITY IS MAKING</div><h1 class="page-title">Community feed</h1><p class="page-intro">Share an update, a release note, a creative question, or a collaboration idea.</p><form id="postForm" class="panel"><div class="field"><label>Creator name</label><input name="author" maxlength="80" placeholder="Your artist name" required></div><div class="field" style="margin-top:12px"><label>What's happening? *</label><textarea name="body" maxlength="2000" required placeholder="Share something with the community…"></textarea></div><button class="btn primary" style="margin-top:12px">Publish post</button></form><div id="feedPosts">${posts.length?posts.map(postMarkup).join(""):`<div class="empty-state"><b>The feed is yours to start.</b>Posts are synced to the community in real time.</div>`}</div>`;}
function postMarkup(p){return `<article class="feed-post"><header><div class="avatar">${esc(p.author.slice(0,3).toUpperCase())}</div><div><b>${esc(p.author)}</b><small>${new Date(p.createdAt).toLocaleString()}</small></div></header><p>${esc(p.body)}</p><div class="post-actions"><button data-like="${esc(p.id)}">♡ ${p.likes||0} likes</button><button data-delete-post="${esc(p.id)}">Delete</button></div></article>`;}
function profileView(){const saved=JSON.parse(localStorage.getItem("shattered-profile")||'{"name":"Your Artist Name","bio":"Independent creator. Breaking the expected."}');return `<div class="eyebrow">YOUR CREATOR IDENTITY</div><h1 class="page-title">My profile</h1><div class="profile-banner"><div class="profile-big">${esc(saved.name.slice(0,1).toUpperCase())}</div><div><h2>${esc(saved.name)}</h2><p>${esc(saved.bio)}</p><p style="margin-top:9px">${tracks.length} tracks · ${lyrics.length} lyric sheets</p></div></div><form id="profileForm" class="panel"><h2>Edit your profile</h2><div class="form-grid"><div class="field"><label>Artist / creator name</label><input name="name" required maxlength="80" value="${esc(saved.name)}"></div><div class="field full"><label>Bio</label><textarea name="bio" maxlength="500">${esc(saved.bio)}</textarea></div><div class="field full"><button class="btn primary">Save profile on this device</button></div></div></form><div class="panel"><h3>Your music</h3><div class="track-grid">${tracks.length?tracks.map(trackCard).join(""):`<p class="page-intro">Your uploaded tracks will appear here.</p>`}</div></div><div class="panel"><h3>Privacy & storage</h3><p class="page-intro">Track metadata, lyrics, collabs, and posts sync to the community cloud in real time. Audio files are stored only in this browser. Export your text data at any time.</p><button class="btn outline" id="exportData">Export my text data</button> <button class="btn outline" id="clearData">Clear all local SHATTERED data</button></div>`;}
function videosView(){return `<div class="eyebrow">VISUALS MEET SOUND</div><h1 class="page-title">Music videos</h1><p class="page-intro">Share finished music videos, including AI-generated visuals. SHATTERED's policy is not to provide fake-singer lip-sync generation that presents a fictional person as actually singing.</p><div class="panel"><h2>Video sharing status</h2><p class="page-intro">This initial build supports audio uploads. Video upload and cloud playback are not connected yet; video files are large and need dedicated storage and streaming delivery before public launch.</p><button class="btn primary" data-page="upload">Upload a track instead</button></div><div class="empty-state"><b>Video library is a planned module</b>Next implementation: MP4/WebM uploads, video metadata, poster images, playback, and moderation controls.</div>`;}
function messagesView(){return `<div class="eyebrow">DIRECT CONNECTIONS</div><h1 class="page-title">Messages</h1><p class="page-intro">A local interface preview for private and group conversations. Messages are not sent to other users in this starter build.</p><div class="panel"><h2>Local message pad</h2><div class="field"><label>Conversation label</label><input id="conversationLabel" placeholder="e.g. New collab idea"></div><div class="field" style="margin-top:12px"><label>Message</label><textarea id="messageBody" placeholder="Write a draft message…"></textarea></div><button class="btn primary" id="saveMessage" style="margin-top:12px">Save draft locally</button></div><div class="stack-list">${messages.length?messages.map(m=>`<article class="list-card"><div class="list-icon">✉</div><div><h3>${esc(m.label)}</h3><p>${esc(m.body)} · ${new Date(m.createdAt).toLocaleString()}</p></div><button class="text-link" data-delete-message="${esc(m.id)}">Delete</button></article>`).join(""):`<div class="empty-state">Your locally saved drafts will appear here.</div>`}</div>`;}
function notificationsView(){return `<div class="eyebrow">STAY IN THE LOOP</div><h1 class="page-title">Notifications</h1><p class="page-intro">Local notifications are created when you publish content on this device. Multi-user notifications need a connected backend.</p><div class="stack-list">${notifications.length?notifications.map(n=>`<article class="list-card"><div class="list-icon">♧</div><div><h3>${esc(n.title)}</h3><p>${esc(n.body)} · ${new Date(n.createdAt).toLocaleString()}</p></div><button class="text-link" data-read="${esc(n.id)}">${n.read?"Read":"Mark read"}</button></article>`).join(""):`<div class="empty-state">No notifications yet.</div>`}<button class="btn outline" id="markAllRead">Mark all as read</button></div>`;}

function addNotice(title,body){return put("notifications",{id:uid(),title,body,createdAt:Date.now(),read:false});}

function bindForms(){
  const uf=$("#uploadForm");
  if(uf)uf.onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(uf),file=f.get("audio");
    if(!file||!file.size)return toast("Choose an audio file first.");
    if(file.size>80*1024*1024)return toast("This starter limits audio uploads to 80 MB. Use a smaller file.");
    try{
      const id=uid();
      const meta={id,title:f.get("title").trim(),artist:f.get("artist").trim(),genre:f.get("genre").trim(),origin:f.get("origin"),description:f.get("description").trim(),fileName:file.name,mime:file.type||"audio/mpeg",createdAt:Date.now()};
      // Store blob locally for playback
      await put("tracks",{...meta,blob:file});
      // Sync metadata (no blob) to Firebase
      await fbPut("tracks",meta);
      await addNotice("Track uploaded",`${meta.title} was shared with the community.`);
      await refresh();
      toast("Track shared with the community.");
      setPage("music");
    }catch(err){console.error(err);toast("Could not save the file. Browser storage may be full.");}
  };

  const lf=$("#lyricsForm");
  if(lf)lf.onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(lf);
    const item={id:uid(),title:f.get("title").trim(),artist:f.get("artist").trim(),genre:f.get("genre").trim(),body:f.get("body").trim(),createdAt:Date.now()};
    await fbPut("lyrics",item);
    await addNotice("Lyrics published",`${item.title} was shared with the community.`);
    toast("Lyrics published to the community.");
    setPage("lyrics");
  };

  const cf=$("#collabForm");
  if(cf)cf.onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(cf);
    const item={id:uid(),title:f.get("title").trim(),creator:f.get("creator").trim(),kind:f.get("kind"),description:f.get("description").trim(),createdAt:Date.now()};
    await fbPut("collabs",item);
    await addNotice("Collaboration posted",`${item.title} is now in the community collab hub.`);
    toast("Collaboration call posted to the community.");
    setPage("collab");
  };

  const pf=$("#postForm");
  if(pf)pf.onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(pf);
    const item={id:uid(),author:f.get("author").trim(),body:f.get("body").trim(),likes:0,createdAt:Date.now()};
    await fbPut("posts",item);
    await addNotice("Post published","Your community update was shared.");
    toast("Post shared with the community.");
    setPage("feed");
  };

  const prof=$("#profileForm");
  if(prof)prof.onsubmit=e=>{e.preventDefault();const f=new FormData(prof);localStorage.setItem("shattered-profile",JSON.stringify({name:f.get("name").trim(),bio:f.get("bio").trim()}));toast("Profile saved on this device.");setPage("profile");};
}

async function playTrack(id){
  const t=tracks.find(x=>x.id===id);
  if(!t)return;
  const audio=$("#audio");
  if(currentTrackId===id&&!audio.paused){audio.pause();$("#togglePlay").textContent="▶";return;}
  // Try local blob first; track may only have metadata if uploaded on another device
  if(!t.blob){
    toast("Audio file is not available on this device. Upload the track here to play it.");
    return;
  }
  if(!objectUrls.has(id))objectUrls.set(id,URL.createObjectURL(t.blob));
  audio.src=objectUrls.get(id);
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
function downloadData(){const payload={exportedAt:new Date().toISOString(),lyrics,collabs,posts,messages,profile:localStorage.getItem("shattered-profile")};const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="shattered-local-export.json";a.click();URL.revokeObjectURL(a.href);toast("Text data export created.");}

document.addEventListener("click",async e=>{
  const p=e.target.closest("[data-page]");if(p){e.preventDefault();setPage(p.dataset.page);return;}
  const play=e.target.closest("[data-play]");if(play){playTrack(play.dataset.play);return;}
  const join=e.target.closest("[data-join]");if(join){const c=collabs.find(x=>x.id===join.dataset.join);if(c){await addNotice("Collaboration interest",`You marked interest in "${c.title}". This is only saved locally; no creator was contacted.`);toast("Interest saved locally. Messaging needs a connected backend.");}return;}
  const dl=e.target.closest("[data-delete-lyrics]");if(dl){await fbDelete("lyrics",dl.dataset.deleteLyrics);toast("Lyrics deleted from community.");return;}
  const dc=e.target.closest("[data-delete-collab]");if(dc){await fbDelete("collabs",dc.dataset.deleteCollab);toast("Collaboration call deleted.");return;}
  const dp=e.target.closest("[data-delete-post]");if(dp){await fbDelete("posts",dp.dataset.deletePost);toast("Post deleted.");return;}
  const like=e.target.closest("[data-like]");if(like){
    const post=posts.find(x=>x.id===like.dataset.like);
    if(post){post.likes=(post.likes||0)+1;await fbPut("posts",post);}
    return;
  }
  const dm=e.target.closest("[data-delete-message]");if(dm){await remove("messages",dm.dataset.deleteMessage);await refresh();setPage("messages");return;}
  const rd=e.target.closest("[data-read]");if(rd){const n=notifications.find(x=>x.id===rd.dataset.read);if(n){n.read=true;await put("notifications",n);await refresh();setPage("notifications");}return;}
});

document.addEventListener("submit",e=>{if(["uploadForm","lyricsForm","collabForm","postForm","profileForm"].includes(e.target.id))bindForms();});

document.addEventListener("click",async e=>{
  if(e.target.id==="saveMessage"){const label=$("#conversationLabel").value.trim(),body=$("#messageBody").value.trim();if(!label||!body)return toast("Enter a conversation label and message.");await put("messages",{id:uid(),label,body,createdAt:Date.now()});await addNotice("Draft saved",`Message draft for ${label} was saved locally.`);await refresh();setPage("messages");toast("Draft saved locally.");}
  if(e.target.id==="markAllRead"){for(const n of notifications){n.read=true;await put("notifications",n);}await refresh();setPage("notifications");toast("Notifications marked as read.");}
  if(e.target.id==="exportData")downloadData();
  if(e.target.id==="clearData"){if(confirm("Delete all local SHATTERED tracks, lyrics, posts, messages, collaboration calls, and notifications from this browser? This cannot be undone.")){for(const name of ["tracks","lyrics","collabs","posts","messages","notifications"]){const tx=db.transaction(name,"readwrite");tx.objectStore(name).clear();}localStorage.removeItem("shattered-profile");setTimeout(async()=>{await refresh();setPage("home");toast("Local SHATTERED data cleared.");},100);}}
});

$("#globalSearch").addEventListener("input",e=>{const q=e.target.value.trim().toLowerCase();if(!q)return;setPage("music");const filtered=tracks.filter(t=>[t.title,t.artist,t.genre,t.description,t.origin].join(" ").toLowerCase().includes(q));const grid=$("#main .track-grid");if(grid)grid.innerHTML=filtered.length?filtered.map(trackCard).join(""):`<div class="empty-state" style="grid-column:1/-1">No tracks match "${esc(q)}".</div>`;});
$("#profileShortcut").onclick=()=>setPage("profile");
$("#togglePlay").onclick=()=>{const a=$("#audio");if(!a.src)return;if(a.paused)a.play();else a.pause();$("#togglePlay").textContent=a.paused?"▶":"Ⅱ";};
$("#prevTrack").onclick=()=>nextTrack(-1);$("#nextTrack").onclick=()=>nextTrack(1);$("#closePlayer").onclick=()=>{$("#audio").pause();$("#player").hidden=true;};
$("#audio").addEventListener("timeupdate",()=>{const a=$("#audio");$("#currentTime").textContent=time(a.currentTime);$("#duration").textContent=time(a.duration);$("#seek").value=a.duration?a.currentTime/a.duration*100:0;});
$("#audio").addEventListener("loadedmetadata",()=>$("#duration").textContent=time($("#audio").duration));
$("#audio").addEventListener("play",()=>$("#togglePlay").textContent="Ⅱ");
$("#audio").addEventListener("pause",()=>$("#togglePlay").textContent="▶");
$("#seek").addEventListener("input",e=>{const a=$("#audio");if(a.duration)a.currentTime=a.duration*(Number(e.target.value)/100);});

// ── Boot ─────────────────────────────────────────────────────────────────────
async function init(){
  if(!("indexedDB" in window)){toast("This browser does not support local storage features.");return;}
  try{
    db = await openDB();
    // Load local-only stores immediately
    [messages, notifications] = await Promise.all(["messages","notifications"].map(all));
    // Load audio blobs from local IndexedDB (merged with Firebase metadata below)
    const localTracks = await all("tracks");
    const blobMap = new Map(localTracks.map(t=>[t.id, t.blob]));

    // Load Firebase helpers and subscribe to live community data
    const fbOk = await loadFirebaseHelpers();
    if (fbOk) {
      // Tracks: merge Firebase metadata with local blobs
      fbSubscribe("tracks", remoteArr => {
        tracks = remoteArr.map(t => ({ ...t, blob: blobMap.get(t.id) || null }));
        renderHome(); updateCounts();
      });
      fbSubscribe("lyrics",  arr => { lyrics  = arr; renderHome(); updateCounts(); });
      fbSubscribe("collabs", arr => { collabs = arr; renderHome(); updateCounts(); });
      fbSubscribe("posts",   arr => { posts   = arr; });
    } else {
      // Offline fallback: use whatever is in IndexedDB
      tracks  = localTracks;
      lyrics  = await all("lyrics");
      collabs = await all("collabs");
      posts   = await all("posts");
      tracks.sort((a,b)=>b.createdAt-a.createdAt);
      lyrics.sort((a,b)=>b.createdAt-a.createdAt);
      collabs.sort((a,b)=>b.createdAt-a.createdAt);
      posts.sort((a,b)=>b.createdAt-a.createdAt);
    }

    renderHome(); updateCounts(); bindForms();

    if("serviceWorker" in navigator&&location.protocol!=="file:")
      navigator.serviceWorker.register("./sw.js").catch(err=>console.warn("PWA offline cache unavailable",err));
  }catch(e){console.error(e);toast("Could not initialize local storage.");}
}
init();
})();
