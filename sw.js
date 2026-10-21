// Funciona sin señal (quirófano): la app y el lector de texto quedan guardados en el celular.
// App: se muestra lo guardado y se actualiza en segundo plano. Librerías de vendor/ (versión fija, ~11 MB): se descargan
// una sola vez, la primera vez que se lee un documento.
// Nunca se guardan respuestas de Google (datos del profesional).
const VERSION = "liquidaciones-v7";
const LIBRERIAS = "liquidaciones-libs-2"; // aparte: no se vuelve a bajar en cada actualización de la app
const APP = ["./", "index.html", "estilos.css", "config.js", "motor.js", "lector.js", "almacen.js", "app.js", "manifest.webmanifest",
  "icono.svg", "icono-192.png", "privacidad.html", "ayuda.html", "datos/aac_2026_08.json", "datos/pami_2024_02.json", "datos/obras_sociales.json", "datos/valores.json"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP))); self.skipWaiting(); });
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== LIBRERIAS).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

// Aislamiento entre orígenes (COOP/COEP): habilita varios hilos para el lector de texto. GitHub Pages no permite
// configurar encabezados, así que los agrega este service worker a las respuestas de la propia app.
function aislada(r) {
  if (!r || r.type === "opaque" || r.status === 0 || r.type === "opaqueredirect") return r;
  const h = new Headers(r.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes("/vendor/")) {
    e.respondWith(caches.match(e.request).then((g) => g || fetch(e.request).then((r) => {
      if (r.ok) { const copia = r.clone(); caches.open(LIBRERIAS).then((c) => c.put(e.request, copia)); }
      return r;
    })).then(aislada));
    return;
  }
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const guardada = await c.match(e.request, { ignoreSearch: true });
    const red = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => guardada);
    return aislada(await (guardada || red));
  }));
});
