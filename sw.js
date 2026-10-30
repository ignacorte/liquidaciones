// Funciona sin señal (quirófano): la app y el lector de texto quedan guardados en el celular.
// App: con conexión, siempre la versión publicada (la copia guardada es solo para cuando no hay señal). Librerías de
// vendor/ (versión fija, ~27 MB): se descargan una sola vez, la primera vez que se lee un documento.
// Nunca se guardan respuestas de Google (datos del profesional).
const VERSION = "liquidaciones-v54"; // igual que VERSION_APP en app.js
const LIBRERIAS = "liquidaciones-libs-2"; // aparte: no se vuelve a bajar en cada actualización de la app
const APP = ["./", "index.html", "estilos.css", "config.js", "motor.js", "lector.js", "importar.js", "almacen.js", "app.js", "manifest.webmanifest",
  "icono.svg", "icono-192.png", "privacidad.html", "ayuda.html", "datos/aac_2026_08.json", "datos/pami_2024_02.json", "datos/obras_sociales.json", "datos/valores.json", "datos/pami_nomenclador_2026_10.json", "datos/pami_unidades.json", "datos/anestesia_nomenclador_2019.json"];

// cache: "reload": directo del servidor (GitHub Pages deja los archivos 10 min en la caché del navegador y se guardaba
// la versión anterior con el nombre de la nueva)
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP.map((u) => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});
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
  // Primero la red (revalidando con el servidor); sin señal o si tarda más de 4 s, la copia guardada
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const guardada = await c.match(e.request, { ignoreSearch: true });
    // (una navegación no admite opciones: se pide de nuevo por su dirección)
    const pedido = e.request.mode === "navigate" ? new Request(e.request.url, { cache: "no-cache" }) : new Request(e.request, { cache: "no-cache" });
    const red = fetch(pedido).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    const espera = guardada ? new Promise((ok) => setTimeout(() => ok(null), 4000)) : null;
    try {
      const r = await (espera ? Promise.race([red, espera]) : red);
      return aislada(r || guardada);
    } catch {
      return aislada(guardada || Response.error());
    }
  }));
});
