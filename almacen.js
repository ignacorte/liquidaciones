"use strict";
// Datos del profesional: en el celular (IndexedDB, funciona sin señal) y copia en SU Google Drive
// (carpeta «Liquidaciones», archivo liquidaciones-datos.json). Permiso drive.file: la app solo ve los archivos que creó.
// Sincronización por registro: gana la versión con `actualizado` más reciente; lo borrado queda marcado (borrada).

const Almacen = (() => {
  const DB = "liquidaciones", STORE = "doc", CLAVE = "datos";
  const ARCHIVO = "liquidaciones-datos.json", CARPETA = "Liquidaciones";
  const COLECCIONES = ["prestaciones", "valores", "uq", "obras"];
  const vacio = () => ({ version: 1, cuenta: null, prestaciones: [], valores: [], uq: [], obras: [], ajustes: {} });
  let doc = vacio();

  const idb = () => new Promise((ok, mal) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  });
  async function leerLocal() {
    const db = await idb();
    return new Promise((ok) => {
      const r = db.transaction(STORE).objectStore(STORE).get(CLAVE);
      r.onsuccess = () => ok(r.result || vacio());
      r.onerror = () => ok(vacio());
    });
  }
  async function escribirLocal() {
    const db = await idb();
    return new Promise((ok, mal) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(doc, CLAVE);
      t.oncomplete = ok; t.onerror = () => mal(t.error);
    });
  }

  const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  async function iniciar() {
    doc = await leerLocal();
    for (const c of COLECCIONES) doc[c] ||= [];
    doc.ajustes ||= {};
    try { await navigator.storage?.persist?.(); } catch { /* el navegador decide */ }
  }

  // Guardar o borrar un registro; dispara la sincronización con Drive en segundo plano
  async function guardar(coleccion, registro) {
    const r = { ...registro, id: registro.id || nuevoId(), actualizado: Date.now() };
    const i = doc[coleccion].findIndex((x) => x.id === r.id);
    if (i >= 0) doc[coleccion][i] = r; else doc[coleccion].push(r);
    await escribirLocal();
    programarSync();
    return r;
  }
  const borrar = (coleccion, id) => {
    const r = doc[coleccion].find((x) => x.id === id);
    return r ? guardar(coleccion, { ...r, borrada: true }) : null;
  };
  async function ajuste(clave, valor) {
    doc.ajustes[clave] = { valor, actualizado: Date.now() };
    await escribirLocal();
    programarSync();
  }

  function combinar(a, b) {
    const out = { ...a, ajustes: { ...a.ajustes } };
    for (const c of COLECCIONES) {
      const m = new Map((a[c] || []).map((x) => [x.id, x]));
      for (const x of b[c] || []) if (!m.has(x.id) || (m.get(x.id).actualizado || 0) < (x.actualizado || 0)) m.set(x.id, x);
      out[c] = [...m.values()];
    }
    for (const [k, v] of Object.entries(b.ajustes || {})) if (!out.ajustes[k] || out.ajustes[k].actualizado < v.actualizado) out.ajustes[k] = v;
    return out;
  }

  // ---------- Google Drive (OAuth en el navegador, sin servidor) ----------
  const TOKEN = "liq_token";
  const token = () => {
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN) || "null");
      return t && t.vence > Date.now() + 60000 ? t.valor : null;
    } catch { return null; }
  };
  const conectado = () => !!doc.cuenta;

  function conectar() {
    if (!CONFIG.GOOGLE_CLIENT_ID) throw new Error("Falta configurar GOOGLE_CLIENT_ID en config.js");
    const estado = nuevoId();
    sessionStorage.setItem("liq_estado", estado);
    const p = new URLSearchParams({ client_id: CONFIG.GOOGLE_CLIENT_ID, redirect_uri: location.origin + location.pathname,
      response_type: "token", scope: "https://www.googleapis.com/auth/drive.file", include_granted_scopes: "true", state: estado });
    if (doc.cuenta) p.set("login_hint", doc.cuenta);
    location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + p;
  }

  // Vuelta de Google: #access_token=…&expires_in=…&state=…
  function recibirToken() {
    if (!location.hash.includes("access_token")) return false;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname);
    if (h.get("state") !== sessionStorage.getItem("liq_estado")) return false;
    try { localStorage.setItem(TOKEN, JSON.stringify({ valor: h.get("access_token"), vence: Date.now() + (+h.get("expires_in") || 3600) * 1000 })); } catch { /* sin almacenamiento */ }
    return true;
  }

  async function drive(url, opciones = {}) {
    const t = token();
    if (!t) throw Object.assign(new Error("Volvé a conectar Google Drive"), { reconectar: true });
    const r = await fetch(url, { ...opciones, headers: { Authorization: "Bearer " + t, ...(opciones.headers || {}) } });
    if (r.status === 401) { localStorage.removeItem(TOKEN); throw Object.assign(new Error("Volvé a conectar Google Drive"), { reconectar: true }); }
    if (!r.ok) throw new Error("Google Drive respondió " + r.status);
    return r;
  }
  const API = "https://www.googleapis.com/drive/v3/files", SUBIR = "https://www.googleapis.com/upload/drive/v3/files";

  async function buscar(nombre, tipo) {
    const q = `name='${nombre}' and trashed=false` + (tipo ? ` and mimeType='${tipo}'` : "");
    const r = await (await drive(`${API}?q=${encodeURIComponent(q)}&fields=files(id,modifiedTime)&spaces=drive`)).json();
    return r.files[0] || null;
  }
  async function carpeta() {
    const tipo = "application/vnd.google-apps.folder";
    const c = await buscar(CARPETA, tipo);
    if (c) return c.id;
    const r = await drive(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: CARPETA, mimeType: tipo }) });
    return (await r.json()).id;
  }
  async function subirNuevo(nombre, contenido, tipo, convertirA) {
    const meta = { name: nombre, parents: [await carpeta()], ...(convertirA ? { mimeType: convertirA } : {}) };
    const limite = "liq" + Date.now();
    const cuerpo = `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${limite}\r\nContent-Type: ${tipo}\r\n\r\n${contenido}\r\n--${limite}--`;
    const r = await drive(`${SUBIR}?uploadType=multipart&fields=id,webViewLink`, { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + limite }, body: cuerpo });
    return r.json();
  }

  let sincronizando = null, temporizador = null, alCambiar = () => {}, estadoSync = "sin conectar";
  const avisar = (e) => { estadoSync = e; alCambiar(e); };

  function programarSync() {
    clearTimeout(temporizador);
    if (conectado() && token()) temporizador = setTimeout(() => sincronizar().catch(() => {}), 2500);
    else if (conectado()) avisar("pendiente: volvé a conectar Drive");
  }

  async function sincronizar() {
    if (sincronizando) return sincronizando;
    sincronizando = (async () => {
      avisar("sincronizando…");
      try {
        if (!doc.cuenta) {
          const sobre = await (await drive("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)")).json();
          doc.cuenta = sobre.user.emailAddress;
        }
        const archivo = await buscar(ARCHIVO);
        if (archivo) {
          const remoto = await (await drive(`${API}/${archivo.id}?alt=media`)).json();
          doc = combinar(doc, remoto);
          await drive(`${SUBIR}/${archivo.id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
        } else {
          await subirNuevo(ARCHIVO, JSON.stringify(doc), "application/json");
        }
        doc.ultima_sync = Date.now();
        await escribirLocal();
        avisar("al día");
      } catch (e) {
        avisar(e.reconectar ? "pendiente: volvé a conectar Drive" : "sin conexión: se guarda en el celular");
        throw e;
      } finally { sincronizando = null; }
    })();
    return sincronizando;
  }

  // Planilla del mes como Google Sheets en la carpeta Liquidaciones (para el contador)
  async function guardarPlanilla(nombre, csv) {
    return subirNuevo(nombre, csv, "text/csv", "application/vnd.google-apps.spreadsheet");
  }

  async function desconectar() {
    localStorage.removeItem(TOKEN);
    doc = vacio();
    await escribirLocal();
  }

  return {
    iniciar, guardar, borrar, ajuste, sincronizar, conectar, recibirToken, conectado, guardarPlanilla, desconectar, combinar,
    get doc() { return doc; }, get estado() { return estadoSync; }, set alCambiar(f) { alCambiar = f; }, tieneToken: () => !!token(),
  };
})();
