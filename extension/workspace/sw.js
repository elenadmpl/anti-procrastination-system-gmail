const CACHE='orbit-shell-v1';
const SHELL=['./','index.html','style.css','core.js','app.js','icon.svg','icon-192.png','icon-512.png','manifest.webmanifest','vendor/tesseract.min.js','vendor/worker.min.js','vendor/tesseract-core-lstm.wasm.js','vendor/lang/eng.traineddata.gz'];
self.addEventListener('install',ev=>{ev.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',ev=>ev.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',ev=>{
 const u=new URL(ev.request.url);if(ev.request.method!=='GET'||u.origin!==location.origin||u.pathname.endsWith('private-review.json'))return;
 ev.respondWith(caches.match(ev.request).then(r=>r||fetch(ev.request)));
});
