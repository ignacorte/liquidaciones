// Receptor de la base económica anónima de «Liquidaciones» (Google Apps Script, en la cuenta del responsable).
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
  const fila = { id: String(f.id), aportante: aportante, recibido: new Date(), version: String(version || "").replace(/[^\w.]/g, "").slice(0, 10) };
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

function doPost(e) {
  const candado = LockService.getScriptLock();
  candado.waitLock(20000);
  try {
    const d = JSON.parse(e.postData.contents);
    const aportante = String(d.aportante || "");
    if (!/^[a-f0-9-]{32,40}$/.test(aportante)) return salida({ ok: false, error: "aportante inválido" });
    if (d.accion === "borrar") {
      // En todas las hojas (también la «Cobros» de la primera versión), de abajo hacia arriba
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
  return salida({ ok: true, servicio: "Liquidaciones · base económica anónima", version: 2, filas: filas });
}
