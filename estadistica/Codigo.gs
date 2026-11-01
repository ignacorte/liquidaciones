// Receptor de la base económica anónima de «Liquidaciones» (Google Apps Script, en la cuenta del responsable).
// Recibe filas SIN datos de pacientes y las guarda en la hoja «Cobros» de la planilla donde está este script.
// Cada fila tiene un id (huella al azar): si llega de nuevo, se actualiza (no se duplica). «borrar» quita todo lo de un aportante.
// Publicar: Implementar → Nueva implementación → Aplicación web → Ejecutar como: yo · Quién tiene acceso: cualquier usuario.
// La URL que da (…/exec) va en movil/config.js → ESTADISTICA_URL.

const HOJA = "Cobros";
const COLS = ["id", "aportante", "recibido", "especialidad", "tipo", "rol", "obra_social", "codigo_os", "codigo_aac", "complejidad",
  "abordaje", "urgencia", "mes_prestacion", "mes_cobro", "dias_cobro", "monto", "estimado", "estado", "pct", "version"];
const TEXTO = ["especialidad", "tipo", "rol", "obra_social", "codigo_os", "codigo_aac", "abordaje", "estado", "version"];
const NUMERO = ["complejidad", "dias_cobro", "monto", "estimado", "pct"];
const MAX_FILAS = 500;

function hoja() {
  const libro = SpreadsheetApp.getActiveSpreadsheet();
  let h = libro.getSheetByName(HOJA);
  if (!h) { h = libro.insertSheet(HOJA); h.appendRow(COLS); h.setFrozenRows(1); }
  return h;
}

function salida(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Solo valores cortos y de forma conocida: nada de texto libre (no puede colarse un nombre)
function limpiar(f, aportante) {
  const fila = {};
  if (!/^[a-f0-9]{16,64}$/.test(String(f.id || ""))) return null;
  fila.id = String(f.id);
  fila.aportante = aportante;
  fila.recibido = new Date();
  for (const k of TEXTO) fila[k] = String(f[k] == null ? "" : f[k]).replace(/[^\wÁÉÍÓÚÑáéíóúñü .\/+-]/g, "").slice(0, 40);
  for (const k of NUMERO) { const n = Number(f[k]); fila[k] = isFinite(n) && f[k] !== null && f[k] !== "" ? Math.round(n * 100) / 100 : ""; }
  fila.urgencia = f.urgencia ? 1 : 0;
  for (const k of ["mes_prestacion", "mes_cobro"]) fila[k] = /^\d{4}-\d{2}$/.test(String(f[k] || "")) ? String(f[k]) : "";
  return fila;
}

function doPost(e) {
  const candado = LockService.getScriptLock();
  candado.waitLock(20000);
  try {
    const d = JSON.parse(e.postData.contents);
    const aportante = String(d.aportante || "");
    if (!/^[a-f0-9-]{32,40}$/.test(aportante)) return salida({ ok: false, error: "aportante inválido" });
    const h = hoja(), datos = h.getDataRange().getValues();
    if (d.accion === "borrar") {
      // De abajo hacia arriba para que no se corran los números de fila
      let n = 0;
      for (let i = datos.length - 1; i >= 1; i--) if (datos[i][1] === aportante) { h.deleteRow(i + 1); n++; }
      return salida({ ok: true, borradas: n });
    }
    if (d.accion !== "guardar" || !Array.isArray(d.filas) || d.filas.length > MAX_FILAS) return salida({ ok: false, error: "pedido inválido" });
    const filaDe = {};
    for (let i = 1; i < datos.length; i++) filaDe[datos[i][0]] = i + 1;
    const nuevas = [];
    let actualizadas = 0;
    for (const f of d.filas) {
      const x = limpiar(f, aportante);
      if (!x) continue;
      const valores = COLS.map((k) => x[k]);
      if (filaDe[x.id]) { h.getRange(filaDe[x.id], 1, 1, COLS.length).setValues([valores]); actualizadas++; }
      else nuevas.push(valores);
    }
    if (nuevas.length) h.getRange(h.getLastRow() + 1, 1, nuevas.length, COLS.length).setValues(nuevas);
    return salida({ ok: true, nuevas: nuevas.length, actualizadas: actualizadas });
  } catch (err) {
    return salida({ ok: false, error: String(err) });
  } finally {
    candado.releaseLock();
  }
}

// Comprobar que está publicado (abrir la URL en el navegador)
function doGet() {
  return salida({ ok: true, servicio: "Liquidaciones · base económica anónima", filas: Math.max(0, hoja().getLastRow() - 1) });
}
