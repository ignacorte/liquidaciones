// Receptor de «Liquidaciones» (Google Apps Script, en la cuenta del responsable). Versión 4 (hojas con títulos en castellano).
// 1) Base económica ANÓNIMA (esta planilla). 2) Cuentas y uso (OTRA planilla, «Liquidaciones – Cuentas y uso», que se crea sola la
// primera vez): correo, especialidad, versión, último uso y cantidades, sin datos de pacientes ni montos. Están separadas para que no
// se pueda cruzar quién aportó cada fila anónima (en la base anónima la llegada se guarda solo como mes).
// Recibe filas SIN datos de pacientes y las guarda en cuatro hojas de esta planilla, separadas por especialidad:
//   «Cirugía · Facturación», «Cirugía · Liquidaciones», «Anestesia · Facturación», «Anestesia · Liquidaciones».
// Cada fila tiene un id (huella al azar): si llega de nuevo, se actualiza (no se duplica). «borrar» quita todo lo de un aportante
// en todas las hojas.
// Publicar: Implementar → Nueva implementación → Aplicación web → Ejecutar como: yo · Quién tiene acceso: cualquier usuario.
// Para actualizar sin cambiar la URL: Implementar → Administrar implementaciones → lápiz → Versión: nueva → Implementar.

// Columnas técnicas, al final de cada hoja (el id evita duplicados: si una fila llega de nuevo, se actualiza)
const TECNICAS = [["id", "ID (técnico)"], ["aportante", "Aportante (número al azar)"], ["recibido", "Recibido (mes)"], ["version", "Versión de la app"]];
// Cada tabla: nombre de la hoja y sus columnas en el orden en que se ven: [clave, tipo, título]
// (t = texto corto, n = número, $ = pesos, m = mes AAAA-MM, b = sí/no). Las fechas van SOLO por mes: con el día exacto se podría
// identificar al paciente.
const TABLAS = {
  cirugia_facturacion: { hoja: "Cirugía · Facturación", cols: [
    ["mes_prestacion", "m", "Mes de la cirugía"], ["obra_social", "t", "Obra social"], ["tipo", "t", "Tipo"], ["rol", "t", "Rol"],
    ["codigo_os", "t", "Código obra social"], ["codigo_aac", "t", "Código AAC"], ["abordaje", "t", "Vía"], ["urgencia", "b", "Urgencia"],
    ["pct", "n", "% a facturar"], ["extras", "n", "Otros procedimientos del acto"], ["estado", "t", "Estado"], ["mes_presentacion", "m", "Mes de presentación"],
    ["estimado", "$", "Estimado"], ["origen_estimado", "t", "De dónde sale el estimado"], ["cobrado", "$", "Cobrado"], ["debitado", "$", "Debitado"],
    ["dias_cobro", "n", "Días hasta cobrar"]] },
  cirugia_liquidaciones: { hoja: "Cirugía · Liquidaciones", cols: [
    ["mes_prestacion", "m", "Mes de la cirugía"], ["mes_cobro", "m", "Mes del cobro"], ["obra_social", "t", "Obra social"], ["tipo", "t", "Tipo"],
    ["rol", "t", "Rol"], ["codigo_os", "t", "Código obra social"], ["codigo_aac", "t", "Código AAC"], ["abordaje", "t", "Vía"], ["urgencia", "b", "Urgencia"],
    ["pct", "n", "% a facturar"], ["monto", "$", "Monto"], ["debito", "b", "Débito"], ["dias_cobro", "n", "Días hasta cobrar"]] },
  anestesia_facturacion: { hoja: "Anestesia · Facturación", cols: [
    ["mes_prestacion", "m", "Mes de la anestesia"], ["obra_social", "t", "Obra social"], ["tipo", "t", "Tipo"], ["complejidad", "n", "Complejidad"],
    ["recargos", "t", "Recargos"], ["edad_grupo", "t", "Edad"], ["obesidad", "b", "Obesidad mórbida"], ["suspendida", "b", "Suspendida"],
    ["extras", "n", "Otros procedimientos del acto"], ["estado", "t", "Estado"], ["mes_carga", "m", "Mes de carga en la asociación"], ["bruto", "$", "Bruto"],
    ["neto", "$", "Neto"], ["retencion_pct", "n", "Retención de la asociación (%)"], ["cobrado", "$", "Cobrado"], ["debitado", "$", "Debitado"],
    ["dias_cobro", "n", "Días hasta cobrar"]] },
  anestesia_liquidaciones: { hoja: "Anestesia · Liquidaciones", cols: [
    ["mes_prestacion", "m", "Mes de la anestesia"], ["mes_cobro", "m", "Mes del cobro"], ["obra_social", "t", "Obra social"], ["tipo", "t", "Tipo"],
    ["complejidad", "n", "Complejidad"], ["recargos", "t", "Recargos"], ["monto", "$", "Monto"], ["debito", "b", "Débito"], ["dias_cobro", "n", "Días hasta cobrar"]] },
};
const MAX_FILAS = 500;

function columnas(t) { return TABLAS[t].cols.map((c) => c[0]).concat(TECNICAS.map((c) => c[0])); }
function titulos(t) { return TABLAS[t].cols.map((c) => c[2]).concat(TECNICAS.map((c) => c[1])); }
function tipoDe(t, k) { const c = TABLAS[t].cols.find((x) => x[0] === k); return c ? c[1] : "t"; }

// La hoja con los títulos y formatos de esta versión; si es de una versión anterior (otros títulos u orden), se reacomoda
// conservando todas sus filas
function hoja(t) {
  const libro = SpreadsheetApp.getActiveSpreadsheet(), nombre = TABLAS[t].hoja, cols = columnas(t), tits = titulos(t);
  let h = libro.getSheetByName(nombre);
  if (!h) h = libro.insertSheet(nombre);
  const datos = h.getLastRow() ? h.getDataRange().getValues() : [];
  const cabecera = datos.length ? datos[0].map(String) : [];
  if (cabecera.join("|") !== tits.join("|")) {
    // Cada columna vieja se reconoce por su clave (versión 2-3) o por su título
    const deCol = cabecera.map((c) => { const i = cols.indexOf(c) >= 0 ? cols.indexOf(c) : tits.indexOf(c); return i; });
    const filas = datos.slice(1).filter((f) => f.some((v) => v !== "")).map((f) => {
      const x = cols.map(() => "");
      f.forEach((v, j) => { if (deCol[j] >= 0) x[deCol[j]] = v; });
      return x.map((v, k) => {
        const tipo = tipoDe(t, cols[k]);
        // Meses que la planilla había convertido en fecha completa → «AAAA-MM»
        if (v instanceof Date && (tipo === "m" || cols[k] === "recibido")) return Utilities.formatDate(v, "GMT-3", "yyyy-MM");
        if (tipo === "b" && (v === 1 || v === 0 || v === "1" || v === "0" || v === true || v === false)) return Number(v) ? "sí" : "no";
        return v;
      });
    });
    h.clear();
    h.getRange(1, 1, 1, tits.length).setValues([tits]).setFontWeight("bold").setBackground("#1f3a5f").setFontColor("#ffffff").setWrap(true);
    h.setFrozenRows(1);
    formatos(t, h);
    if (filas.length) h.getRange(2, 1, filas.length, cols.length).setValues(filas);
    // Lo técnico, en gris
    h.getRange(1, cols.length - TECNICAS.length + 1, Math.max(1, filas.length + 1), TECNICAS.length).setFontColor("#8a94a0");
    h.getRange(1, cols.length - TECNICAS.length + 1, 1, TECNICAS.length).setBackground("#dde3ea");
  }
  return h;
}
// Meses como texto (si no, la planilla los convierte en una fecha completa), pesos con separador de miles
function formatos(t, h) {
  const cols = columnas(t), filas = h.getMaxRows();
  cols.forEach((k, i) => {
    const tipo = tipoDe(t, k), r = h.getRange(1, i + 1, filas, 1);
    if (tipo === "m" || k === "recibido" || k === "id" || k === "aportante" || k === "version" || tipo === "t") r.setNumberFormat("@");
    else if (tipo === "$") r.setNumberFormat("$ #,##0");
  });
}

function salida(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Solo valores cortos y de forma conocida: nada de texto libre (no puede colarse un nombre)
function limpiar(t, f, aportante, version) {
  if (!/^[a-f0-9]{16,64}$/.test(String(f.id || ""))) return null;
  const fila = { id: String(f.id), aportante: aportante, recibido: Utilities.formatDate(new Date(), "GMT-3", "yyyy-MM"),
    version: String(version || "").replace(/[^\w.]/g, "").slice(0, 10) };
  for (const [k, tipo] of TABLAS[t].cols) {
    const v = f[k];
    if (tipo === "t") fila[k] = String(v == null ? "" : v).replace(/[^\wÁÉÍÓÚÑáéíóúñü .\/+-]/g, "").slice(0, 40);
    else if (tipo === "n" || tipo === "$") { const n = Number(v); fila[k] = v !== null && v !== "" && v !== undefined && isFinite(n) ? Math.round(n * 100) / 100 : ""; }
    else if (tipo === "m") fila[k] = /^\d{4}-\d{2}$/.test(String(v || "")) ? String(v) : "";
    else fila[k] = v ? "sí" : "no";
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
        const datos = h.getDataRange().getValues(), cab = datos[0] || [];
        const col = cab.indexOf("aportante") >= 0 ? cab.indexOf("aportante") : cab.indexOf(TECNICAS[1][1]);
        if (col < 0) continue;
        for (let i = datos.length - 1; i >= 1; i--) if (datos[i][col] === aportante) { h.deleteRow(i + 1); n++; }
      }
      return salida({ ok: true, borradas: n });
    }
    const t = String(d.tabla || "");
    if (d.accion !== "guardar" || !TABLAS[t] || !Array.isArray(d.filas) || d.filas.length > MAX_FILAS) return salida({ ok: false, error: "pedido inválido" });
    const h = hoja(t), cols = columnas(t), datos = h.getDataRange().getValues();
    const filaDe = {}, colId = cols.indexOf("id");
    for (let i = 1; i < datos.length; i++) filaDe[datos[i][colId]] = i + 1;
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

// Comprobar que está publicado (abrir la URL en el navegador): filas de cada tabla. También reacomoda las hojas de versiones
// anteriores (títulos en castellano, lo técnico al final, meses como texto)
function doGet() {
  const filas = {};
  for (const t in TABLAS) {
    const h = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABLAS[t].hoja) ? hoja(t) : null;
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
  return salida({ ok: true, servicio: "Liquidaciones · base económica anónima", version: 4, filas: filas, cuentas: cuentas, cuentas_url: cuentasUrl });
}
