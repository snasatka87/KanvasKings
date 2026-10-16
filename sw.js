const SHELL_CACHE = "door-knocks-shell-v6";
const RUNTIME_CACHE = "door-knocks-runtime-v1";
const TILE_CACHE = "door-knocks-tiles-v1";
const APP_SHELL = ["./", "./index.html", "./company-access.html", "./company-access.js", "./supabase-client.js", "./supabase-config.js", "./styles.css", "./app.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => ![SHELL_CACHE, RUNTIME_CACHE, TILE_CACHE].includes(key)).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match("./index.html"))));
    return;
  }
  if (url.hostname.endsWith("arcgisonline.com") || url.hostname.endsWith("basemaps.cartocdn.com") || url.hostname.endsWith("tile.openstreetmap.org")) {
    event.respondWith(caches.open(TILE_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then(async (response) => {
        if (response.ok || response.type === "opaque") {
          await cache.put(request, response.clone());
          const keys = await cache.keys();
          if (keys.length > 250) await cache.delete(keys[0]);
        }
        return response;
      });
      return cached || network.catch(() => Response.error());
    }));
    return;
  }
  if (["unpkg.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) {
    event.respondWith(caches.open(RUNTIME_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then((response) => {
        if (response.ok || response.type === "opaque") cache.put(request, response.clone());
        return response;
      });
      return cached || network.catch(() => Response.error());
    }));
  }
});