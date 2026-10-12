const CACHE="shattered-shell-v8";
const ASSETS=[
  "./",
  "./index.html",
  "./login.html",
  "./styles.css",
  "./login.css",
  "./app.js",
  "./login.js",
  "./auth-guard.js",
  "./firestore-service.js",
  "./storage-service.js",
  "./firebase-config.js",
  "./worker-config.js",
  "./manifest.webmanifest",
  "./assets/icon.svg"
];
self.addEventListener("install",e=>e.waitUntil(
  caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
));
self.addEventListener("activate",e=>e.waitUntil(
  caches.keys()
    .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
));
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  const url=new URL(e.request.url);
  // Don't intercept Firebase API calls — always go network
  if(url.hostname.endsWith(".googleapis.com")||url.hostname.endsWith(".firebaseio.com")||url.hostname.endsWith(".firebasestorage.app")){
    return;
  }
  if(url.origin!==location.origin)return;
  e.respondWith(
    caches.match(e.request).then(hit=>
      hit||fetch(e.request).then(resp=>{
        if(resp.ok){const copy=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}
        return resp;
      }).catch(()=>caches.match("./index.html"))
    )
  );
});
