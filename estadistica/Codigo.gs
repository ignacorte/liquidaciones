// Receptor de «Liquidaciones» (Google Apps Script, en la cuenta del responsable). Versión 3.
// 1) Base económica ANÓNIMA (esta planilla). 2) Cuentas y uso (OTRA planilla, «Liquidaciones – Cuentas y uso», que se crea sola la
// primera vez): correo, especialidad, versión, último uso y cantidades, sin datos de pacientes ni montos. Están separadas para que no
// se pueda cruzar quién aportó cada fila anónima (en la base anónima la llegada se guarda solo como mes).
// Recibe filas SIN datos de pacientes y las guarda en cuatro hojas de esta planilla, separadas por especialidad:
//   «Cirugía · Facturación», «Cirugía · Liquidaciones», «Anestesia · Facturación», «Anestesia · Liquidaciones».
// Cada fila tiene un id (huella al azar): si llega de nuevo, se actualiza (no se duplica). «borrar» quita todo lo de un aportante
// en todas las hojas.
// Publicar: Implementar → Nueva implementación → Aplicación web → Ejecutar como: yo · Quién tiene acceso: cualquier usuario.
// Para actualizar sin cambiar la URL: Implementar → Administrar implementaciones → lápiz → Versión: nueva → Implementar.

const COMUNES = ["id", "aportante", "recibido", "version"];
// Cada tabla: nombre de la hoja y sus columnas (t = texto corto, n = número, m = mes AAAA-MM, b = sí/no)
const TABLAS = {
  cirugia_facturacion: { hoja: "Cirugía · Facturación", cols: {
    obra_social: "t", tipo: "t", rol: "t", codigo_os: "t", codigo_aac: "t", abordaje: "t", urgencia: "b", pct: "n", extras: "n",
    mes_prestacion: "m", estado: "t", estimado: "n", origen_estimado: "t", mes_presentacion: "m", cobrado: "n", debitado: "n", dias_cobro: "n" } },
  cirugia_liquidaciones: { hoja: "Cirugía · Liquidaciones", cols: {
    obra_social: "t", tipo: "t", rol: "t", codigo_os: "t", codigo_aac: "t", abordaje: "t", urgencia: "b", pct: "n",
    mes_prestacion: "m", mes_cobro: "m", dias_cobro: "n", monto: "n", debito: "b" } },
  anestesia_facturacion: { hoja: "Anestesia · Facturación", cols: {
    obra_social: "t", tipo: "t", complejidad: "n", recargos: "t", edad_grupo: "t", obesidad: "b", suspendida: "b", extras: "n",
    mes_prestacion: "m", estado: "t", bruto: "n", neto: "n", retencion_pct: "n", mes_carga: "m", cobrado: "n", debitado: "n", dias_cobro: "n" } },
  anestesia_liquidaciones: { hoja: "Anestesia · Liquidaciones", cols: {
    obra_social: "t", tipo: "t", complejidad: "n", recargos: "t", mes_prestacion: "m", mes_cobro: "m", dias_cobro: "n", monto: "n", debito: "b" } },
};
const MAX_FILAS = 500;

function columnas(t) { return COMUNES.concat(Object.keys(TABLAS[t].cols)); }

function hoja(t) {
  const libro = SpreadsheetApp.getActiveSpreadsheet(), nombre = TABLAS[t].hoja;
  let h = libro.getSheetByName(nombre);
  if (!h) { h = libro.insertSheet(nombre); h.appendRow(columnas(t)); h.setFrozenRows(1); h.getRange(1, 1, 1, columnas(t).length).setFontWeight("bold"); }
  return h;
}

function salida(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Solo valores cortos y de forma conocida: nada de texto libre (no puede colarse un nombre)
function limpiar(t, f, aportante, version) {
  if (!/^[a-f0-9]{16,64}$/.test(String(f.id || ""))) return null;
  const fila = { id: String(f.id), aportante: aportante, recibido: Utilities.formatDate(new Date(), "GMT-3", "yyyy-MM"), version: String(version || "").replace(/[^\w.]/g, "").slice(0, 10) };
  const cols = TABLAS[t].cols;
  for (const k in cols) {
    const v = f[k];
    if (cols[k] === "t") fila[k] = String(v == null ? "" : v).replace(/[^\wÁÉÍÓÚÑáéíóúñü .\/+-]/g, "").slice(0, 40);
    else if (cols[k] === "n") { const n = Number(v); fila[k] = v !== null && v !== "" && v !== undefined && isFinite(n) ? Math.round(n * 100) / 100 : ""; }
    else if (cols[k] === "m") fila[k] = /^\d{4}-\d{2}$/.test(String(v || "")) ? String(v) : "";
    else fila[k] = v ? 1 : 0;
  }
  return fila;
}

// ---------- Cuentas y uso (planilla aparte) ----------
// Columnas que escribe la app; «estado» (activo / suspendido) y «mensaje» las escribe el administrador a mano y no se pisan.
const CUENTAS_COLS = ["cuenta", "especialidad", "admin", "dispositivo", "version", "primer_uso", "ultimo_uso", "prestaciones", "cirugias_mes",
  "consultas_mes", "liquidaciones", "ultima_carga", "drive", "comparte", "terminos", "estado", "mensaje"];
const ADMIN_COLS = ["estado", "mensaje"];
function libroCuentas() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty("CUENTAS_ID");
  if (id) { try { return SpreadsheetApp.openById(id); } catch (err) { id = null; } }
  const libro = SpreadsheetApp.create("Liquidaciones – Cuentas y uso");
  const h = libro.getSheets()[0];
  h.setName("Cuentas"); h.appendRow(CUENTAS_COLS); h.setFrozenRows(1); h.getRange(1, 1, 1, CUENTAS_COLS.length).setFontWeight("bold");
  h.getRange(1, CUENTAS_COLS.indexOf("estado") + 1).setNote("Escribí «suspendido» para que esa cuenta no pueda usar la app (sus datos siguen en su Drive). Vacío = activo.");
  h.getRange(1, CUENTAS_COLS.indexOf("mensaje") + 1).setNote("Texto que la app le muestra a esa cuenta la próxima vez que entra.");
  props.setProperty("CUENTAS_ID", libro.getId());
  return libro;
}
function registrarUso(d) {
  const correo = String(d.cuenta || "").toLowerCase().trim();
  const dispositivo = String(d.dispositivo || "").replace(/[^a-f0-9-]/g, "").slice(0, 40);
  const clave = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(correo) ? correo.slice(0, 80) : dispositivo ? "sin cuenta · " + dispositivo.slice(0, 8) : "";
  if (!clave) return { ok: false, error: "cuenta inválida" };
  const h = libroCuentas().getSheetByName("Cuentas"), datos = h.getDataRange().getValues();
  const col = (k) => CUENTAS_COLS.indexOf(k);
  const ahora = new Date(), num = (v) => (isFinite(Number(v)) ? Number(v) : "");
  const corto = (v) => String(v == null ? "" : v).replace(/[^\wÁÉÍÓÚÑáéíóúñü .\/+-]/g, "").slice(0, 30);
  const fila = { cuenta: clave, especialidad: corto(d.especialidad), admin: d.admin ? "sí" : "", dispositivo: corto(d.plataforma), version: corto(d.version),
    ultimo_uso: ahora, prestaciones: num(d.prestaciones), cirugias_mes: num(d.cirugias_mes), consultas_mes: num(d.consultas_mes),
    liquidaciones: num(d.liquidaciones), ultima_carga: /^\d{4}-\d{2}-\d{2}$/.test(String(d.ultima_carga || "")) ? String(d.ultima_carga) : "",
    drive: d.drive ? "sí" : "no", comparte: d.comparte ? "sí" : "no", terminos: num(d.terminos) };
  let i = 1;
  while (i < datos.length && datos[i][0] !== clave) i++;
  if (i < datos.length) {
    for (const k of ADMIN_COLS) fila[k] = datos[i][col(k)];
    fila.primer_uso = datos[i][col("primer_uso")] || ahora;
    h.getRange(i + 1, 1, 1, CUENTAS_COLS.length).setValues([CUENTAS_COLS.map((k) => fila[k] ?? "")]);
  } else {
    fila.primer_uso = ahora; fila.estado = ""; fila.mensaje = "";
    h.appendRow(CUENTAS_COLS.map((k) => fila[k] ?? ""));
  }
  return { ok: true, estado: String(fila.estado || "activo").toLowerCase().trim() || "activo", mensaje: String(fila.mensaje || "") };
}

function doPost(e) {
  const candado = LockService.getScriptLock();
  candado.waitLock(20000);
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.accion === "uso") return salida(registrarUso(d));
    const aportante = String(d.aportante || "");
    if (!/^[a-f0-9-]{32,40}$/.test(aportante)) return salida({ ok: false, error: "aportante inválido" });
    if (d.accion === "borrar") {
      // En todas las hojas de la base anónima (también la «Cobros» de la primera versión), de abajo hacia arriba; las cuentas no
      let n = 0;
      for (const h of SpreadsheetApp.getActiveSpreadsheet().getSheets()) {
        const datos = h.getDataRange().getValues(), col = datos[0] ? datos[0].indexOf("aportante") : -1;
        if (col < 0) continue;
        for (let i = datos.length - 1; i >= 1; i--) if (datos[i][col] === aportante) { h.deleteRow(i + 1); n++; }
      }
      return salida({ ok: true, borradas: n });
    }
    const t = String(d.tabla || "");
    if (d.accion !== "guardar" || !TABLAS[t] || !Array.isArray(d.filas) || d.filas.length > MAX_FILAS) return salida({ ok: false, error: "pedido inválido" });
    const h = hoja(t), cols = columnas(t), datos = h.getDataRange().getValues();
    const filaDe = {};
    for (let i = 1; i < datos.length; i++) filaDe[datos[i][0]] = i + 1;
    const nuevas = [];
    let actualizadas = 0;
    for (const f of d.filas) {
      const x = limpiar(t, f, aportante, d.version);
      if (!x) continue;
      const valores = cols.map((k) => x[k]);
      if (filaDe[x.id]) { h.getRange(filaDe[x.id], 1, 1, cols.length).setValues([valores]); actualizadas++; }
      else nuevas.push(valores);
    }
    if (nuevas.length) h.getRange(h.getLastRow() + 1, 1, nuevas.length, cols.length).setValues(nuevas);
    return salida({ ok: true, tabla: t, nuevas: nuevas.length, actualizadas: actualizadas });
  } catch (err) {
    return salida({ ok: false, error: String(err) });
  } finally {
    candado.releaseLock();
  }
}

// Comprobar que está publicado (abrir la URL en el navegador): filas de cada tabla
function doGet() {
  const filas = {};
  for (const t in TABLAS) {
    const h = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABLAS[t].hoja);
    filas[t] = h ? Math.max(0, h.getLastRow() - 1) : 0;
  }
  // Para el panel del administrador en la app: solo totales (nunca correos)
  let cuentas = { total: 0, activas_7_dias: 0, suspendidas: 0 }, cuentasUrl = "";
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty("CUENTAS_ID")) {
    const libro = libroCuentas(), datos = libro.getSheetByName("Cuentas").getDataRange().getValues(), hace7 = Date.now() - 7 * 864e5;
    const col = (k) => CUENTAS_COLS.indexOf(k);
    for (let i = 1; i < datos.length; i++) {
      cuentas.total++;
      if (new Date(datos[i][col("ultimo_uso")]).getTime() >= hace7) cuentas.activas_7_dias++;
      if (String(datos[i][col("estado")]).toLowerCase().trim() === "suspendido") cuentas.suspendidas++;
    }
    cuentasUrl = libro.getUrl();
  }
  return salida({ ok: true, servicio: "Liquidaciones · base económica anónima", version: 3, filas: filas, cuentas: cuentas, cuentas_url: cuentasUrl });
}
