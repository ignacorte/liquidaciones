"use strict";
// Datos del profesional: en el celular (IndexedDB, funciona sin señal) y copia en SU Google Drive
// (carpeta «Liquidaciones», archivo liquidaciones-datos.json). Permiso drive.file: la app solo ve los archivos que creó.
// Sincronización por registro: gana la versión con `actualizado` más reciente; lo borrado queda marcado (borrada).
// Seguridad: en el celular todo se guarda cifrado (AES-256-GCM) con una clave derivada del PIN (PBKDF2-SHA256,
// 310.000 iteraciones). La clave vive solo en memoria mientras la app está desbloqueada; el PIN no se guarda.
// El acceso a Drive (token, 1 hora) también se guarda cifrado.
// Sesión: mientras se usa, recargar la página no vuelve a pedir el PIN (la clave, no exportable, queda en el almacenamiento
// del navegador hasta `minutosBloqueo` después del último uso); al bloquear o vencer se borra.

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
  async function idbLeer(clave) {
    const db = await idb();
    return new Promise((ok) => {
      const r = db.transaction(STORE).objectStore(STORE).get(clave);
      r.onsuccess = () => ok(r.result ?? null);
      r.onerror = () => ok(null);
    });
  }
  async function idbEscribir(pares) {
    const db = await idb();
    return new Promise((ok, mal) => {
      const t = db.transaction(STORE, "readwrite");
      for (const [k, v] of Object.entries(pares)) v === undefined ? t.objectStore(STORE).delete(k) : t.objectStore(STORE).put(v, k);
      t.oncomplete = ok; t.onerror = () => mal(t.error);
    });
  }

  // ---------- Cifrado con PIN ----------
  const ITERACIONES = 310000, PRUEBA = "liquidaciones-ok";
  let llave = null; // CryptoKey AES-GCM (no exportable) mientras está desbloqueada
  let meta = null;  // {sal, iteraciones, verificador}: datos públicos para verificar el PIN
  let minutosBloqueo = 15, ultimaSesion = 0;
  async function guardarSesion() {
    ultimaSesion = Date.now();
    await idbEscribir({ sesion: { llave, hasta: ultimaSesion + minutosBloqueo * 60e3 } });
  }
  // Uso de la app: extiende la sesión (como mucho una escritura cada 30 s)
  function tocar() { if (llave && Date.now() - ultimaSesion > 30000) guardarSesion().catch(() => {}); }

  async function derivar(pin, sal, iteraciones) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: sal, iterations: iteraciones, hash: "SHA-256" }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function cifrar(objeto, k = llave) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const datos = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify(objeto)));
    return { iv, datos };
  }
  async function descifrar(sobre, k = llave) {
    const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sobre.iv }, k, sobre.datos);
    return JSON.parse(new TextDecoder().decode(plano));
  }

  const tienePin = () => !!meta;
  const bloqueada = () => tienePin() && !llave;

  async function crearPin(pin) {
    const sal = crypto.getRandomValues(new Uint8Array(16));
    llave = await derivar(pin, sal, ITERACIONES);
    meta = { sal, iteraciones: ITERACIONES, verificador: await cifrar(PRUEBA) };
    await idbEscribir({ pin: meta });
    await escribirLocal(); // lo que hubiera sin cifrar (versión anterior) queda cifrado
    await guardarSesion();
    if (tokenMem) await guardarToken();
  }

  // Intentos fallidos: espera creciente (30 s, 1 min, 2 min…) después del quinto, también entre reinicios de la app
  async function esperaRestante() {
    const f = (await idbLeer("fallos")) || { n: 0, hasta: 0 };
    return Math.max(0, f.hasta - Date.now());
  }
  async function desbloquear(pin) {
    const espera = await esperaRestante();
    if (espera) throw new Error(`Demasiados intentos. Esperá ${Math.ceil(espera / 1000)} segundos.`);
    const k = await derivar(pin, meta.sal, meta.iteraciones);
    try {
      if ((await descifrar(meta.verificador, k)) !== PRUEBA) throw new Error();
    } catch {
      const f = (await idbLeer("fallos")) || { n: 0, hasta: 0 };
      f.n += 1;
      f.hasta = f.n >= 5 ? Date.now() + 30000 * 2 ** (f.n - 5) : 0;
      await idbEscribir({ fallos: f });
      throw new Error(f.n >= 5 ? "PIN incorrecto. Esperá antes de volver a intentar." : `PIN incorrecto (${f.n} de 5 intentos).`);
    }
    llave = k;
    await idbEscribir({ fallos: undefined });
    await guardarSesion();
    await cargar();
    const t = await idbLeer("token");
    if (t && !tokenMem) tokenMem = await descifrar(t).catch(() => null);
    else if (tokenMem) await guardarToken();
  }

  async function bloquear() {
    llave = null;
    doc = vacio();
    tokenMem = null;
    clearTimeout(temporizador);
    await idbEscribir({ sesion: undefined });
  }

  // Olvidó el PIN: se borra lo de este celular (cifrado, irrecuperable); la copia de Drive queda
  async function olvidePin() {
    await bloquear();
    meta = null;
    await idbEscribir({ [CLAVE]: undefined, pin: undefined, token: undefined, fallos: undefined, sesion: undefined, pendiente: undefined });
  }

  // ---------- Copia de seguridad (archivo cifrado con una clave propia: sirve en otro celular) ----------
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const deB64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  async function exportarCopia(clave) {
    const sal = crypto.getRandomValues(new Uint8Array(16));
    const sobre = await cifrar({ ...doc, cuenta: doc.cuenta }, await derivar(clave, sal, ITERACIONES));
    return JSON.stringify({ app: "liquidaciones", version: 1, fecha: new Date().toISOString(), iteraciones: ITERACIONES, sal: b64(sal),
      iv: b64(sobre.iv), datos: b64(new Uint8Array(sobre.datos)) });
  }
  // Restaurar: se combina con lo que hay (no se pierde nada de ninguno de los dos lados)
  async function importarCopia(texto, clave) {
    let c;
    try { c = JSON.parse(texto); } catch { throw new Error("El archivo no es una copia de Liquidaciones."); }
    if (c.app !== "liquidaciones") throw new Error("El archivo no es una copia de Liquidaciones.");
    let datos;
    try { datos = await descifrar({ iv: deB64(c.iv), datos: deB64(c.datos) }, await derivar(clave, deB64(c.sal), c.iteraciones)); }
    catch { throw new Error("Clave incorrecta para esta copia."); }
    const antes = doc.prestaciones.length;
    doc = combinar(doc, datos);
    if (!doc.cuenta && datos.cuenta) doc.cuenta = datos.cuenta;
    await escribirLocal();
    programarSync();
    return doc.prestaciones.length - antes;
  }
  async function marcarCopia() { doc.ultima_copia = Date.now(); await escribirLocal(); }

  async function cambiarPin(actual, nuevo) {
    await desbloquear(actual);
    await crearPin(nuevo);
  }

  async function leerLocal() {
    const guardado = await idbLeer(CLAVE);
    if (!guardado) return vacio();
    if (guardado.iv && guardado.datos) return descifrar(guardado);
    return guardado; // versión anterior, sin cifrar: se cifra al crear el PIN
  }
  async function escribirLocal() {
    if (bloqueada()) throw new Error("La app está bloqueada");
    await idbEscribir({ [CLAVE]: llave ? await cifrar(doc) : doc });
  }

  async function cargar() {
    doc = await leerLocal();
    for (const c of COLECCIONES) doc[c] ||= [];
    doc.ajustes ||= {};
  }

  const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // Al abrir: con PIN queda bloqueada (no se lee nada hasta desbloquear); sin PIN (primera vez) se lee lo que haya
  async function iniciar() {
    await leerMeta();
    meta = await idbLeer("pin");
    if (!meta) await cargar();
    else {
      const sesion = await idbLeer("sesion");
      if (sesion?.llave && sesion.hasta > Date.now()) {
        llave = sesion.llave;
        try {
          await cargar();
          const t = await idbLeer("token");
          if (t && !tokenMem) tokenMem = await descifrar(t).catch(() => null);
          else if (tokenMem) await guardarToken();
          await guardarSesion();
        } catch { llave = null; doc = vacio(); }
      } else if (sesion) await idbEscribir({ sesion: undefined });
    }
    try { await navigator.storage?.persist?.(); } catch { /* el navegador decide */ }
  }

  // Guardar o borrar un registro; dispara la sincronización con Drive en segundo plano
  async function guardar(coleccion, registro) {
    const r = { ...registro, id: registro.id || nuevoId(), actualizado: Date.now() };
    const i = doc[coleccion].findIndex((x) => x.id === r.id);
    if (i >= 0) doc[coleccion][i] = r; else doc[coleccion].push(r);
    cambios++;
    await escribirLocal();
    if (doc.cuenta && !pendiente) await marcarPendiente(true);
    programarSync();
    return r;
  }
  // Muchos registros de una vez (lista de valores importada): una sola escritura cifrada y una sola sincronización
  async function guardarVarios(coleccion, registros) {
    const ahora = Date.now();
    for (const registro of registros) {
      const r = { ...registro, id: registro.id || nuevoId(), actualizado: ahora };
      const i = doc[coleccion].findIndex((x) => x.id === r.id);
      if (i >= 0) doc[coleccion][i] = r; else doc[coleccion].push(r);
    }
    cambios++;
    await escribirLocal();
    if (doc.cuenta && !pendiente) await marcarPendiente(true);
    programarSync();
  }
  const borrar = (coleccion, id) => {
    const r = doc[coleccion].find((x) => x.id === id);
    return r ? guardar(coleccion, { ...r, borrada: true }) : null;
  };
  async function ajuste(clave, valor) {
    doc.ajustes[clave] = { valor, actualizado: Date.now() };
    cambios++;
    await escribirLocal();
    if (doc.cuenta && !pendiente) await marcarPendiente(true);
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
  let tokenMem = null; // {valor, vence}
  const token = () => (tokenMem && tokenMem.vence > Date.now() + 60000 ? tokenMem.valor : null);
  const guardarToken = async () => { if (llave) await idbEscribir({ token: tokenMem ? await cifrar(tokenMem) : undefined }); };
  const conectado = () => !!doc.cuenta;

  // Cuenta de Google y vencimiento del acceso: sin cifrar (no son datos de pacientes), para saber al abrir la app si hay que
  // renovar el acceso antes de pedir el PIN. El acceso de Google dura 1 hora: se renueva sin pedir nada (prompt=none)
  // mientras el profesional siga con su sesión de Google abierta en el navegador.
  let cuentaPlano = null, venceToken = 0, pendiente = false, local = false, cambios = 0; // cambios: para no perder lo hecho durante una subida
  async function leerMeta() {
    cuentaPlano = (await idbLeer("cuenta")) || null;
    local = !!(await idbLeer("local"));
    venceToken = (await idbLeer("token_vence")) || 0;
    pendiente = !!(await idbLeer("pendiente"));
  }
  const marcarPendiente = async (v) => { pendiente = v; await idbEscribir({ pendiente: v || undefined }); };

  function conectar({ silencioso = false } = {}) {
    if (!CONFIG.GOOGLE_CLIENT_ID) throw new Error("Falta configurar GOOGLE_CLIENT_ID en config.js");
    const estado = nuevoId();
    sessionStorage.setItem("liq_estado", estado);
    const p = new URLSearchParams({ client_id: CONFIG.GOOGLE_CLIENT_ID, redirect_uri: location.origin + location.pathname,
      response_type: "token", scope: "https://www.googleapis.com/auth/drive.file", include_granted_scopes: "true", state: estado });
    const cuenta = doc.cuenta || cuentaPlano;
    if (cuenta) p.set("login_hint", cuenta);
    if (silencioso) p.set("prompt", "none");
    location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + p;
  }

  // Vuelta de Google: #access_token=…&expires_in=…&state=…  (o #error=interaction_required si hay que ingresar de nuevo)
  function recibirToken() {
    if (!/access_token|error=/.test(location.hash)) return null;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname);
    if (h.get("state") !== sessionStorage.getItem("liq_estado")) return null;
    if (h.get("error")) return { error: h.get("error") };
    tokenMem = { valor: h.get("access_token"), vence: Date.now() + (+h.get("expires_in") || 3600) * 1000 }; // se guarda cifrado al desbloquear
    venceToken = tokenMem.vence;
    idbEscribir({ token_vence: venceToken }).catch(() => {});
    return { ok: true };
  }

  async function drive(url, opciones = {}) {
    const t = token();
    if (!t) throw Object.assign(new Error("Volvé a conectar Google Drive"), { reconectar: true });
    const r = await fetch(url, { ...opciones, headers: { Authorization: "Bearer " + t, ...(opciones.headers || {}) } });
    if (r.status === 401) { tokenMem = null; guardarToken(); throw Object.assign(new Error("Volvé a conectar Google Drive"), { reconectar: true }); }
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

  // Respaldo diario en el Drive: antes de la primera sincronización del día se copia el archivo de datos tal como está
  // («liquidaciones-respaldo-AAAA-MM-DD.json», últimos 30 días). Nada de lo que haga la app puede hacer perder la base.
  const RESPALDO = "liquidaciones-respaldo-";
  let respaldoDe = "";
  async function respaldoDiario(archivo) {
    const dia = new Date().toISOString().slice(0, 10);
    if (respaldoDe === dia) return;
    const nombre = `${RESPALDO}${dia}.json`;
    if (!(await buscar(nombre))) {
      await drive(`${API}/${archivo.id}/copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nombre, parents: [await carpeta()] }) });
      const limite = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      for (const f of await respaldos()) if (f.dia < limite) await drive(`${API}/${f.id}`, { method: "DELETE" }).catch(() => {});
    }
    respaldoDe = dia;
  }
  async function respaldos() {
    const q = `name contains '${RESPALDO}' and trashed=false`;
    const r = await (await drive(`${API}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive&pageSize=200`)).json();
    return (r.files || []).map((f) => ({ id: f.id, dia: (f.name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || "" })).filter((f) => f.dia).sort((a, b) => b.dia.localeCompare(a.dia));
  }
  // Recuperar de un respaldo: vuelve lo que falta o está borrado (no pisa lo que existe hoy)
  async function recuperarRespaldo(id) {
    const viejo = await (await drive(`${API}/${id}?alt=media`)).json();
    const ahora = Date.now();
    let n = 0;
    for (const col of ["prestaciones", "obras", "valores", "uq"]) {
      for (const r of viejo[col] || []) {
        if (r.borrada) continue;
        const i = doc[col].findIndex((x) => x.id === r.id);
        if (i >= 0 && !doc[col][i].borrada) continue;
        if (i >= 0) doc[col][i] = { ...r, actualizado: ahora }; else doc[col].push({ ...r, actualizado: ahora });
        n++;
      }
    }
    if (n) { cambios++; await escribirLocal(); if (doc.cuenta && !pendiente) await marcarPendiente(true); programarSync(); }
    return n;
  }

  let sincronizando = null, temporizador = null, alCambiar = () => {}, estadoSync = "sin conectar";
  const avisar = (e) => { estadoSync = e; alCambiar(e); };

  function programarSync() {
    clearTimeout(temporizador);
    if (conectado() && token()) temporizador = setTimeout(() => sincronizar().catch(() => {}), 2500);
    else if (conectado()) avisar("cambios sin subir");
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
        if (cuentaPlano !== doc.cuenta) { cuentaPlano = doc.cuenta; await idbEscribir({ cuenta: doc.cuenta }); }
        const cambiosAlEmpezar = cambios;
        const archivo = await buscar(ARCHIVO);
        if (archivo) {
          await respaldoDiario(archivo).catch(() => {});
          const remoto = await (await drive(`${API}/${archivo.id}?alt=media`)).json();
          doc = combinar(doc, remoto);
          await drive(`${SUBIR}/${archivo.id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
        } else {
          await subirNuevo(ARCHIVO, JSON.stringify(doc), "application/json");
        }
        if (planilla) await subirPlanilla(await planilla()).catch(() => {}); // si falla, queda el JSON (lo importante)
        doc.ultima_sync = Date.now();
        await escribirLocal();
        // Si hubo cambios mientras se subía, falta otra vuelta
        if (cambios === cambiosAlEmpezar) { await marcarPendiente(false); avisar("al día"); }
        else { avisar("sincronizando…"); setTimeout(() => sincronizar().catch(() => {}), 500); }
      } catch (e) {
        avisar(e.reconectar ? "cambios sin subir" : "sin conexión: se guarda en el celular");
        throw e;
      } finally { sincronizando = null; }
    })();
    return sincronizando;
  }

  // Planilla en Drive: una Hoja de cálculo de Google («Liquidaciones – planilla») con las hojas Cirugías y procedimientos,
  // Consultas y Resumen mensual. Se reemplaza entera en cada sincronización (lo borrado en la app desaparece de la planilla).
  const XLSX_TIPO = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", HOJA_TIPO = "application/vnd.google-apps.spreadsheet";
  const PLANILLA = "Liquidaciones – planilla", PLANILLA_VIEJA = "Liquidaciones.xlsx";
  let planilla = null; // función de la app que arma el Excel (ArrayBuffer)
  async function crearHoja(bytes) {
    const meta = { name: PLANILLA, mimeType: HOJA_TIPO, parents: [await carpeta()] };
    const limite = "liq" + Date.now();
    const cuerpo = new Blob([`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${limite}\r\nContent-Type: ${XLSX_TIPO}\r\n\r\n`,
      bytes, `\r\n--${limite}--`]);
    return (await drive(`${SUBIR}?uploadType=multipart&fields=id,webViewLink`, { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + limite }, body: cuerpo })).json();
  }
  async function subirPlanilla(bytes) {
    const vieja = await buscar(PLANILLA_VIEJA);
    if (vieja) await drive(`${API}/${vieja.id}`, { method: "DELETE" }).catch(() => {});
    const hoja = await buscar(PLANILLA, HOJA_TIPO);
    if (hoja) {
      // Reemplazar el contenido (Google lo convierte); si no lo acepta, crear una nueva y borrar la anterior
      try {
        await drive(`${SUBIR}/${hoja.id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": XLSX_TIPO }, body: bytes });
        return hoja;
      } catch (e) {
        if (e.reconectar) throw e;
        const nueva = await crearHoja(bytes);
        await drive(`${API}/${hoja.id}`, { method: "DELETE" }).catch(() => {});
        return nueva;
      }
    }
    return crearHoja(bytes);
  }

  // Planilla del mes como Google Sheets en la carpeta Liquidaciones (para el contador)
  async function guardarPlanilla(nombre, csv) {
    return subirNuevo(nombre, csv, "text/csv", "application/vnd.google-apps.spreadsheet");
  }

  async function desconectar() {
    await olvidePin();
    await idbEscribir({ cuenta: undefined, token_vence: undefined, local: undefined });
    doc = vacio();
  }

  return {
    iniciar, guardar, guardarVarios, borrar, respaldos, recuperarRespaldo, ajuste, tocar, exportarCopia, importarCopia, marcarCopia, subirPlanilla, tienePin, bloqueada, crearPin, desbloquear, bloquear, olvidePin, cambiarPin, esperaRestante, sincronizar, conectar, recibirToken, conectado, guardarPlanilla, desconectar, combinar,
    get doc() { return doc; }, get cuenta() { return doc.cuenta || cuentaPlano; }, get pendiente() { return pendiente; },
    get local() { return local; }, usarLocal: async () => { local = true; await idbEscribir({ local: true }); },
    accesoVencido: () => venceToken < Date.now() + 5 * 60e3, set planilla(f) { planilla = f; }, set minutosBloqueo(m) { minutosBloqueo = m; }, get estado() { return estadoSync; }, set alCambiar(f) { alCambiar = f; }, tieneToken: () => !!token(),
  };
})();
