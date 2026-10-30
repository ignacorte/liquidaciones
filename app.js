"use strict";
// Liquidaciones (celular, sin servidor). Vistas: inicio, cargar, prestaciones, cobros, valores.
// Cálculo: motor.js · Lectura de documentos: lector.js · Datos y Google Drive: almacen.js

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pesos = (n) => (n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString("es-AR"));
// En tablas de varias columnas, en el celular: montos abreviados para que entren («$1,7 M», «$945 mil»); el exacto al tocar
const pesosCorto = (n) => {
  if (n == null || isNaN(n) || window.innerWidth >= 520 || Math.abs(n) < 100000) return pesos(n);
  return Math.abs(n) >= 1e6 ? "$" + (n / 1e6).toLocaleString("es-AR", { maximumFractionDigits: n >= 1e7 ? 1 : 2 }) + " M" : "$" + Math.round(n / 1000).toLocaleString("es-AR") + " mil";
};
const celdaPesos = (n) => `<td class="n" title="${pesos(n)}">${pesosCorto(n)}</td>`;
const fechaCorta = (iso) => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(2, 4) : "");
const hoy = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
// Fechas en los formularios: texto dd/mm/aaaa (el campo de fecha del navegador muestra mes/día si está en inglés)
const fechaLarga = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const campoFecha = (nombre, iso) => `<input name="${nombre}" data-fecha inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" value="${esc(fechaLarga(iso))}">`;

// «21/10/2026», «21/10/26», «21-10-2026» o «2026-10-21» → «2026-10-21» (null si no es una fecha posible)
function fechaDeTexto(t) {
  let m = (t || "").trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/);
  let y, mes, d;
  if (m) { d = +m[1]; mes = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; }
  else if ((m = (t || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/))) { y = +m[1]; mes = +m[2]; d = +m[3]; }
  else return null;
  const f = new Date(Date.UTC(y, mes - 1, d));
  if (f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== d || y < 2000) return null; // 31/02 no existe
  return f.toISOString().slice(0, 10);
}
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const nombreMes = (m) => (m === "vencido" ? "Vencido" : MESES[+m.slice(5, 7) - 1] + " " + m.slice(0, 4));
const TIPOS = { consulta: "Consulta", cirugia: "Cirugía", endoscopia: "Endoscopía", practica: "Práctica" };
const ENDOSCOPIAS = { alta: "Alta", baja: "Baja", ambas: "Alta y baja" };
// Especialidad: cambia cómo se valúa y se sigue cada prestación (anestesiología: complejidad, documentación y la asociación)
const ESPECIALIDADES = { cirugia: "Cirugía", anestesia: "Anestesiología" };
const esAnestesia = () => ajuste("especialidad", "cirugia") === "anestesia";
const ETIQUETAS = {
  cirugia: { tipos: { ...TIPOS }, estados: { pendiente: "Sin presentar", presentada: "Presentada", cobrada: "Cobrada", debitada: "Debitada" } },
  anestesia: { tipos: { cirugia: "Anestesiología", endoscopia: "Anestesiología fuera de quirófano", practica: "Dolor / práctica", consulta: "Consulta preanestésica" },
               estados: { pendiente: "Sin cargar", presentada: "Cargada", cobrada: "Liquidada", debitada: "Debitada" } },
};
const EDADES = { "": "—", neonato: "Neonato (hasta 30 días) +50 %", lactante: "1 mes a 3 años +40 %", nino: "3 a 14 años +30 %", mayor70: "70 años o más +30 %" };
const VIAS = { misma: "Misma vía (50 %)", distinta: "Otra vía o bilateral (75 %)" };
// Documentación que pide la asociación para cargar la anestesia: foja quirúrgica, foja de anestesia y autorización de la
// obra social. Cada una: su casilla, sus archivos en el Drive y la carpeta donde van.
// Todo en «Liquidaciones › Anestesiología › Pacientes › <año>», una carpeta por paciente («2026-10-21 – GOMEZ, ANA MARIA – Ref 0001»)
const RUTA_DOCS = ["Anestesiología", "Documentos"]; // donde estaban hasta la v58 (se pasan a «Pacientes/año»)
// Drive, ordenado igual en las dos ramas: «<Rama>/Pacientes/<año>/<fecha – PACIENTE – …>», «<Rama>/Liquidaciones cobradas/<año>»,
// «<Rama>/Listados de consultas/<año>» y «<Rama>/Planillas cargadas». Nombres que empiezan con la fecha (se ordenan solos).
const RAMA_DRIVE = (p) => ((p?.especialidad || ajuste("especialidad", "cirugia")) === "anestesia" ? "Anestesiología" : "Cirugía");
const rutaPaciente = (p) => [RAMA_DRIVE(p), "Pacientes", (p.fecha || hoy()).slice(0, 4)];
// Otros documentos del paciente (las dos ramas): el parte quirúrgico y las fotos con sus datos
const DOCS_EXTRA = {
  parte: { campo: "doc_parte", lista: "parte_archivos", nombre: "Parte quirúrgico", archivo: "Parte quirúrgico" },
  datos: { campo: "doc_datos", lista: "datos_archivos", nombre: "Datos del paciente", archivo: "Datos del paciente" },
};
const DOC_TODOS = () => ({ ...DOCS, ...DOCS_EXTRA });
const DOCS = {
  quirurgica: { campo: "doc_foja", lista: "foja_archivos", nombre: "Foja quirúrgica", corto: "foja quirúrgica", archivo: "Foja quirúrgica", ruta: RUTA_DOCS },
  anestesia: { campo: "doc_foja_anestesia", lista: "foja_anestesia_archivos", nombre: "Foja de anestesia", corto: "foja de anestesia", archivo: "Foja de anestesia", ruta: RUTA_DOCS },
  autorizacion: { campo: "doc_autorizacion", lista: "autorizacion_archivos", nombre: "Autorización de la obra social", corto: "autorización", archivo: "Autorización", ruta: RUTA_DOCS },
};
const docFaltante = (p) => (p.tipo === "consulta" ? [] : Object.values(DOCS).filter((x) => !p[x.campo]).map((x) => x.corto));
const SI_NO = { "": "—", si: "Sí", no: "No" };
const ESTADOS = { pendiente: "Sin presentar", presentada: "Presentada", cobrada: "Cobrada", debitada: "Debitada" };
const CAMPOS = ["fecha", "hora", "tipo", "atencion", "paciente", "dni", "afiliado", "obra_social", "obra_social_texto", "institucion", "procedimiento",
  "diagnostico", "abordaje", "urgencia", "rol", "pct", "pct_modulo", "codigo_aac", "codigo_os", "valor_manual", "estado", "fecha_presentacion",
  "fecha_cobro", "monto_cobrado", "origen", "notas", "endoscopia", "ciego", "polipectomia", "observaciones", "extras",
  "complejidad", "edad_grupo", "feriado", "obesidad", "suspendida", "doc_foja", "doc_autorizacion", "especialidad", "foja_archivos",
  "doc_foja_anestesia", "foja_anestesia_archivos", "autorizacion_archivos", "nro_circuito", "nro_ref", "carpeta_docs", "motivo_debito", "cobro_lineas", "solo_registro", "liquidacion",
  "doc_parte", "parte_archivos", "doc_datos", "datos_archivos", "procedimiento_estimado", "revisar_cobro", "codigo_os_manual"];

// Endoscopía: el procedimiento se escribe solo a partir del tipo (si no se escribió otro)
function textoEndoscopia(p) {
  const base = { alta: "Videoendoscopía digestiva alta", baja: "Videocolonoscopía", ambas: "Videoendoscopía digestiva alta + videocolonoscopía" }[p.endoscopia];
  return base ? base + (p.polipectomia === "si" ? " con polipectomía" : "") : "";
}
const esTextoAutomatico = (t) => !t || /^Videoendoscop|^Videocolonosc/.test(t);

// Procedimientos: datos del paciente obligatorios (para facturar y para el registro)
function faltantes(p) {
  if (p.tipo === "consulta" || p.origen === "liquidacion" || (p.origen === "planilla" && p.estado === "cobrada")) return [];
  const f = [];
  if (!(p.paciente || "").trim()) f.push("nombre y apellido");
  // Planilla vieja (cargada desde Excel): se guarda aunque falten DNI, afiliado u obra social reconocida (se completan después;
  // la obra social sin reconocer queda en «Para hacer»)
  const vieja = p.origen === "planilla";
  if (!(p.dni || "").trim() && !vieja) f.push("DNI");
  if (!p.obra_social && !vieja) f.push("obra social");
  if (!(p.afiliado || "").trim() && p.obra_social !== "PARTICULAR" && !vieja) f.push("n.º de afiliado");
  if (p.tipo === "endoscopia" && !p.endoscopia && !vieja) f.push("tipo de endoscopía");
  return f;
}
const modoRegistro = () => ajuste("modo", "completo") === "registro";

const estado = { vista: "inicio", seleccion: new Set(), base: null };

function aviso(texto) {
  const t = $("#toast");
  t.textContent = texto; t.hidden = false;
  clearTimeout(aviso.t); aviso.t = setTimeout(() => (t.hidden = true), 3500);
}
const mes = () => $("#mes").value;

// ---------- Datos: base (investigación incluida en la app) + lo que cargó el profesional ----------

async function cargarBase() {
  const [os, valores] = await Promise.all(["datos/obras_sociales.json", "datos/valores.json"].map((f) => fetch(f).then((r) => r.json())));
  estado.base = { obras: os.obras_sociales.concat(valores.payers_extra.map((p) => ({ nombre: p.name, categoria: p.category, alias: p.aliases,
      dias_pago: 60, dia_presentacion: 18, notas: p.notes }))),
    valores: valores.fees.map((f, i) => ({ id: "base-" + i, base: true, obra_social: f.payer, codigo: String(f.code), descripcion: f.description,
      monto: f.amount, vigencia: f.valid_from.slice(0, 7) + "-01", tipo: f.kind || "honorario", codigo_aac: f.aac_code, fuente: f.source, confianza: f.confianza })),
    uq: valores.uq_aac.map((u) => ({ valor: u.valor, vigencia: u.vigencia.slice(0, 7) + "-01", fuente: u.fuente, base: true })) };
}

function datos(rama) {
  const d = Almacen.doc, vivos = (l) => l.filter((x) => !x.borrada);
  const propias = new Map(vivos(d.obras).map((o) => [o.nombre, o]));
  // Una obra social editada por el médico conserva también los alias de la base (los nuevos alias llegan con las actualizaciones)
  const aliasBase = new Map(estado.base.obras.map((o) => [o.nombre, o.alias || ""]));
  const obras = estado.base.obras.filter((o) => !propias.has(o.nombre)).concat([...propias.values()])
    .map((o) => ({ activa: true, ...o, alias: [...new Set([o.alias, aliasBase.get(o.nombre)].join(",").split(",").map((x) => x.trim()).filter(Boolean))].join(", ") }));
  const valoresPropios = vivos(d.valores);
  const clave = (v) => v.obra_social + "|" + String(v.codigo).replace(/[.\-\s]/g, "") + "|" + v.vigencia;
  const tapados = new Set(valoresPropios.map(clave));
  const esp = rama || ajuste("especialidad", "cirugia");
  const deLaRama = (v) => (esp === "anestesia") === String(v.codigo || "").startsWith("ANE-");
  return { obras, especialidad: esp, pct_asociacion: Number(ajuste("pct_asociacion", 0)) || 0, pct_modulo_general: Number(ajuste("pct_modulo_general", 0)) || 0,
           liq_anterior: { hasta: ajuste("liq_anterior_hasta", "2025-12-31"), pct: Number(ajuste("liq_anterior_pct", 70)) || 0 }, valores: estado.base.valores.filter((v) => !tapados.has(clave(v))).concat(valoresPropios).filter(deLaRama),
           uq: estado.base.uq.concat(vivos(d.uq)), prestaciones: vivos(d.prestaciones).filter((p) => (p.especialidad || "cirugia") === esp) };
}
const ajuste = (k, porDefecto) => Almacen.doc.ajustes[k]?.valor ?? porDefecto;

async function guardarPrestacion(p) {
  for (const [campo, nombre] of [["fecha", "Fecha"], ["fecha_presentacion", "Presentada el"], ["fecha_cobro", "Cobrada el"]]) {
    if ((campo === "fecha" || p[campo]) && !/^\d{4}-\d{2}-\d{2}$/.test(p[campo] || ""))
      throw new Error(`${nombre}: «${String(p[campo] || "").replace("invalida:", "")}» no es una fecha válida (escribila como día/mes/año, por ejemplo 21/10/2026)`);
  }
  if (!(p.paciente || "").trim()) throw new Error("Falta el nombre del paciente");
  const limpio = { id: p.id };
  for (const k of CAMPOS) limpio[k] = p[k] ?? null;
  // Los enlaces del Drive los maneja la sincronización: guardar una ficha abierta antes de que suba el documento no los pisa
  const guardada = p.id && Almacen.doc.prestaciones.find((x) => x.id === p.id);
  if (guardada) for (const k of ["carpeta_docs", ...Object.values(DOC_TODOS()).map((x) => x.lista)]) if (guardada[k]) limpio[k] = guardada[k];
  limpio.extras = limpio.tipo === "consulta" ? [] : (p.extras || []).filter((x) => (x.procedimiento || "").trim()).map(({ sugerencias, valor, ...x }) => x);
  limpio.especialidad ||= ajuste("especialidad", "cirugia"); // cada prestación queda en su especialidad
  if (limpio.especialidad === "anestesia" && !limpio.nro_ref) limpio.nro_ref = proximaRef();
  limpio.estado ||= "pendiente"; limpio.tipo ||= "consulta"; limpio.rol ||= "cirujano"; if (limpio.pct == null || limpio.pct === "") limpio.pct = 100; limpio.origen ||= "manual";
  return (enLote ? Almacen.guardarEnMemoria : Almacen.guardar)("prestaciones", Motor.completar(datos(), limpio));
}
// Muchas prestaciones de una vez: se guardan en memoria y se escriben (cifradas) una sola vez al final
let enLote = false;
async function guardarEnLote(fn) {
  if (enLote) return fn();
  enLote = true;
  try { return await fn(); } finally { enLote = false; await Almacen.confirmar(); }
}

// N° de referencia de cada anestesia (0001, 0002…): va en el nombre de sus documentos para encontrarlos rápido
const proximaRef = () => Math.max(0, ...Almacen.doc.prestaciones.map((p) => Number(p.nro_ref) || 0)) + 1;
const refTexto = (p) => (p.nro_ref ? String(p.nro_ref).padStart(4, "0") : "");
// Las anestesias cargadas antes de tener número reciben el suyo (por fecha), una vez
let numeradas = false;
async function numerarAnestesias() {
  if (numeradas) return;
  numeradas = true;
  const sin = Almacen.doc.prestaciones.filter((p) => p.especialidad === "anestesia" && !p.nro_ref && !p.borrada)
    .sort((a, b) => (a.fecha + (a.hora || "")).localeCompare(b.fecha + (b.hora || "")));
  if (!sin.length) return;
  let n = proximaRef();
  await Almacen.guardarVarios("prestaciones", sin.map((p) => ({ ...p, nro_ref: n++ })));
  refrescar();
}

// ---------- Navegación ----------

const TITULOS = { inicio: "Inicio", cargar: "Cargar", prestaciones: "Prestaciones", cobros: "Cobros", analisis: "Análisis", valores: "Valores", bienvenida: "Liquidaciones", pin: "Liquidaciones" };

function ir(vista) {
  // Al entrar a Cargar con el acceso de Google por vencer (menos de 20 min), se renueva antes de empezar a cargar fotos
  if (vista === "cargar" && estado.vista !== "cargar" && Almacen.doc.cuenta && Almacen.tieneToken() && Almacen.venceEn() < 20 * 60e3 && !Almacen.bloqueada() && renovarAcceso()) return;
  estado.vista = vista;
  $$("main > section").forEach((s) => (s.hidden = s.id !== "v-" + vista));
  $$("nav.abajo button").forEach((b) => b.classList.toggle("activa", b.dataset.vista === vista));
  const afuera = ["bienvenida", "pin"].includes(vista);
  $("nav.abajo").hidden = afuera;
  $("#bloquear").hidden = afuera;
  $("#cambiar-rama").hidden = afuera;
  $("#titulo").textContent = TITULOS[vista];
  $("#mes").hidden = !["inicio", "prestaciones", "valores"].includes(vista);
  ({ inicio: verInicio, prestaciones: verPrestaciones, cobros: verCobros, analisis: verAnalisis, valores: verValores }[vista] || (() => {}))();
}
const refrescar = () => {
  if (esAnestesia() && !Almacen.bloqueada()) numerarAnestesias().then(() => Almacen.doc.cuenta && migrarCarpetas()).catch(() => {});
  ir(estado.vista);
};

// ---------- Inicio ----------

function avisoCopia() {
  const d = Almacen.doc, dias = d.ultima_copia ? (Date.now() - d.ultima_copia) / 864e5 : Infinity;
  const mostrar = !d.cuenta && d.prestaciones.length > 0 && dias > 7;
  $("#sin-copia").hidden = !mostrar;
  if (mostrar) $("#sin-copia").innerHTML = 'Tus datos están <b>solo en este celular</b>. Conectá Google Drive o descargá una copia en <a href="#" data-ir="valores">Valores → Copia de seguridad</a>.';
}

function verInicio() {
  avisoCopia();
  verCircuito();
  if (modoRegistro()) return verInicioRegistro();
  const inflacion = +ajuste("inflacion_mensual", 0);
  const r = Motor.resumen(datos(), mes(), hoy(), inflacion), t = r.totales;
  const kpi = (titulo, valor, clase = "") => `<div class="kpi ${clase}"><small>${titulo}</small><b>${valor}</b></div>`;
  $("#kpis").innerHTML = kpi("Facturado estimado", pesos(t.estimado)) + kpi("Cobrado (de lo hecho en el mes)", pesos(t.cobrado), "verde") +
    kpi("Falta cobrar", pesos(t.pendiente)) + kpi("Vencido", pesos(t.vencido), t.vencido ? "rojo" : "") +
    kpi(esAnestesia() ? "Consultas preanestésicas" : "Consultas", t.consultas) + kpi(esAnestesia() ? "Anestesiologías" : "Cirugías", t.cirugias) + kpi("Prestaciones", t.n) +
    kpi(`Pérdida por demora (${inflacion} %/mes)`, pesos(t.perdida_inflacion), t.perdida_inflacion ? "rojo" : "");
  const debitado = datos().prestaciones.filter((p) => p.fecha.slice(0, 7) === mes() && p.estado === "debitada")
    .reduce((s, p) => s + Math.max(0, (p.valor_estimado || 0) - (p.monto_cobrado || 0)), 0);
  $("#kpis").innerHTML += kpi("Debitado", pesos(debitado), debitado ? "rojo" : "");
  verParaHacer();
  verEvolucion();
  // Días reales de cobro por obra social (de lo ya cobrado, todos los meses)
  const plazos = Object.fromEntries(Motor.plazosReales(datos()).map((x) => [x.obra_social, x.dias]));
  const max = Math.max(1, ...r.por_obra_social.map((o) => o.estimado));
  $("#por-os").innerHTML = r.por_obra_social.length ? `<table><tr><th>Obra social</th><th class="n">#</th><th class="n">Estimado</th><th class="n">Cobrado</th><th class="n">Falta</th><th class="n">Días cobro</th></tr>` +
    r.por_obra_social.map((o) => `<tr data-os="${esc(o.obra_social)}"><td>${esc(o.obra_social)}<div class="barra"><i style="width:${(100 * o.estimado) / max}%"></i></div></td>
      <td class="n">${o.n}</td>${celdaPesos(o.estimado)}${celdaPesos(o.cobrado)}${celdaPesos(o.pendiente)}<td class="n">${plazos[o.obra_social] ?? "—"}</td></tr>`).join("") + "</table>"
    : `<p class="ayuda">Sin prestaciones en ${nombreMes(mes())}. Cargá el listado del día o un parte desde «Cargar».</p>`;
  $("#por-paciente").innerHTML = r.por_paciente.length ? `<table><tr><th>Paciente</th><th class="n">#</th><th class="n">Estimado</th><th class="n">Cobrado</th></tr>` +
    r.por_paciente.map((p) => `<tr><td>${esc(p.paciente)}<div class="ayuda" style="margin:0">${esc(p.obra_social)}</div></td>
      <td class="n">${p.n}</td>${celdaPesos(p.estimado)}${celdaPesos(p.cobrado)}</tr>`).join("") + "</table>" : "";
}

// Alertas: lo que conviene resolver (de todos los meses). Tocar una lleva a la lista ya filtrada.
function verParaHacer() {
  const lista = datos().prestaciones.filter((p) => !p.solo_registro), h = hoy();
  const viejas = (p) => p.estado === "pendiente" && (Date.parse(h) - Date.parse(p.fecha)) / 864e5 > 30;
  const items = [
    ["vencida", "", `Cobros vencidos (más tiempo del que suele pagar la obra social)`, lista.filter((p) => Motor.vencida(p, h))],
    ...(esAnestesia() ? [["falta_doc", "", "Falta documentación (no se pueden cargar)", lista.filter((p) => p.estado === "pendiente" && docFaltante(p).length)],
      ["para_cargar", "", "Listas para cargar en la asociación", lista.filter((p) => p.estado === "pendiente" && !docFaltante(p).length)]]
      : [["pendiente", "", "Sin presentar hace más de 30 días", lista.filter(viejas)]]),
    ["", "-", "Obra social sin reconocer", lista.filter((p) => !p.obra_social && p.tipo !== "consulta")],
    ["debitada", "", "Debitadas sin motivo anotado", lista.filter((p) => p.estado === "debitada" && !p.motivo_debito)],
    ["revisar", "", "Cobros para revisar (no figuran en su liquidación)", lista.filter((p) => p.revisar_cobro)],
  ].filter((x) => x[3].length);
  $("#para-hacer-card").hidden = modoRegistro();
  $("#para-hacer").innerHTML = !items.length ? `<p class="ayuda">✓ Nada pendiente: no hay cobros vencidos, documentación faltante ni débitos sin motivo.</p>` : `<table>${items.map(([est, os, t, l], i) => `<tr data-hacer="${i}"><td>${t}</td><td class="n">${l.length}</td>
    <td class="n economia">${pesos(l.reduce((s, p) => s + (p.valor_estimado || 0), 0))}</td></tr>`).join("")}</table>`;
  $$("#para-hacer tr[data-hacer]").forEach((tr) => tr.addEventListener("click", () => {
    const [est, os] = items[+tr.dataset.hacer];
    $("#f-estado").value = est; $("#f-os").value = os; $("#f-tipo").value = ""; $("#f-q").value = ""; $("#f-periodo").value = "todos";
    ir("prestaciones");
  }));
}

// Evolución: estimado, cobrado, falta y debitado de los últimos 6 meses (hasta el mes elegido)
function verEvolucion() {
  const [y, m] = mes().split("-").map(Number), d = datos();
  const meses = Array.from({ length: 6 }, (_, i) => { const f = new Date(y, m - 1 - (5 - i), 1); return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, "0")}`; });
  $("#evolucion").innerHTML = `<table><tr><th>Mes</th><th class="n">Estimado</th><th class="n">Cobrado</th><th class="n">Falta</th><th class="n">Debitado</th></tr>` +
    meses.map((k) => {
      const t = Motor.resumen(d, k, hoy(), 0).totales;
      const deb = d.prestaciones.filter((p) => p.fecha.slice(0, 7) === k && p.estado === "debitada").reduce((s, p) => s + Math.max(0, (p.valor_estimado || 0) - (p.monto_cobrado || 0)), 0);
      return `<tr><td>${nombreMes(k)}</td>${celdaPesos(t.estimado)}${celdaPesos(t.cobrado)}${celdaPesos(t.pendiente)}${deb ? celdaPesos(deb) : '<td class="n">—</td>'}</tr>`;
    }).join("") + "</table>";
}

// Anestesiología: en qué paso está cada anestesia (documentación → carga en la asociación → liquidación), de todos los meses
function verCircuito() {
  if (!esAnestesia()) return;
  const lista = datos().prestaciones.filter((p) => !p.solo_registro && (p.tipo !== "consulta" || p.estado !== "cobrada"));
  const pasos = [
    ["Falta documentación (fojas o autorización)", "falta_doc", lista.filter((p) => p.estado === "pendiente" && docFaltante(p).length)],
    ["Listas para cargar", "para_cargar", lista.filter((p) => p.estado === "pendiente" && !docFaltante(p).length)],
    ["Cargadas, sin liquidar", "presentada", lista.filter((p) => p.estado === "presentada")],
  ];
  $("#circuito").innerHTML = `<table><tr><th>Paso</th><th class="n">#</th><th class="n">Neto estimado</th></tr>` +
    pasos.map(([t, k, l]) => `<tr data-paso="${k}"><td>${t}</td><td class="n">${l.length}</td><td class="n">${pesos(l.reduce((s, p) => s + (p.valor_estimado || 0), 0))}</td></tr>`).join("") +
    "</table><p class=\"ayuda\">Tocá un paso para ver los pacientes.</p>";
}

// Registro de procedimientos: cuántos por tipo, obra social y paciente (sin montos)
function verInicioRegistro() {
  const filas = datos().prestaciones.filter((p) => p.fecha.slice(0, 7) === mes());
  const contar = (f) => filas.filter(f).length;
  const kpi = (titulo, valor) => `<div class="kpi"><small>${titulo}</small><b>${valor}</b></div>`;
  $("#kpis").innerHTML = kpi("Procedimientos", contar((p) => p.tipo !== "consulta")) + kpi("Endoscopías", contar((p) => p.tipo === "endoscopia")) +
    kpi("Cirugías", contar((p) => p.tipo === "cirugia")) + kpi("Polipectomías", contar((p) => p.polipectomia === "si"));
  const porOS = {};
  for (const p of filas) porOS[p.obra_social || "Sin obra social"] = (porOS[p.obra_social || "Sin obra social"] || 0) + 1;
  $("#por-os").innerHTML = filas.length ? `<table><tr><th>Obra social</th><th class="n">#</th></tr>` +
    Object.entries(porOS).sort((a, b) => b[1] - a[1]).map(([o, n]) => `<tr data-os="${esc(o)}"><td>${esc(o)}</td><td class="n">${n}</td></tr>`).join("") + "</table>"
    : `<p class="ayuda">Sin procedimientos en ${nombreMes(mes())}. Cargá un parte desde «Cargar».</p>`;
  $("#por-paciente").innerHTML = filas.length ? `<table><tr><th>Paciente</th><th>Procedimiento</th></tr>` +
    filas.sort((a, b) => b.fecha.localeCompare(a.fecha)).map((p) => `<tr><td>${esc(p.paciente)}<div class="ayuda" style="margin:0">${fechaCorta(p.fecha)} · ${esc(p.obra_social || "")}</div></td>
      <td>${esc(procedimientosDe(p))}${p.tipo === "endoscopia" && p.ciego ? `<div class="ayuda" style="margin:0">Ciego: ${SI_NO[p.ciego]}</div>` : ""}</td></tr>`).join("") + "</table>" : "";
}

function aplicarModo() {
  document.body.classList.toggle("modo-registro", modoRegistro());
  $("#modo").value = ajuste("modo", "completo");
  const anest = esAnestesia(), et = ETIQUETAS[anest ? "anestesia" : "cirugia"];
  document.body.classList.toggle("modo-anestesia", anest);
  Object.assign(TIPOS, et.tipos); Object.assign(ESTADOS, et.estados);
  $("#especialidad").value = anest ? "anestesia" : "cirugia";
  $("#cambiar-rama").textContent = "⇄ " + (anest ? "Anestesiología" : "Cirugía");
  $("#especialidad-texto").textContent = "Especialidad: " + ESPECIALIDADES[anest ? "anestesia" : "cirugia"];
  $("[data-marcar=presentada]").textContent = anest ? "Cargadas" : "Presentadas";
  $("[data-marcar=cobrada]").textContent = anest ? "Liquidadas" : "Cobradas";
  $("#titulo-presentar").textContent = anest ? "Para cargar" : "Para presentar";
  const elegido = $("#f-estado").value;
  $("#f-estado").innerHTML = '<option value="">Todos</option><option value="a_cobrar">A cobrar</option><option value="vencida">Vencidas</option>' +
    (anest ? '<option value="falta_doc">Falta documentación</option><option value="para_cargar">Listas para cargar</option>' : "") +
    Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $("#f-estado").value = [...$("#f-estado").options].some((o) => o.value === elegido) ? elegido : "";
}

// Administrador: pasar de cirugía a anestesiología o al revés (cada rama con sus prestaciones; no se toca la otra)
async function cambiarRama(rama) {
  if (!(await esAdmin())) return;
  await Almacen.ajuste("especialidad", rama);
  aplicarModo();
  await recalcularPendientes();
  aviso("Rama: " + ESPECIALIDADES[rama]);
  refrescar();
}

// Administrador: su cuenta de Google figura (como huella SHA-256) en CONFIG.ADMINS_SHA256
async function esAdmin() {
  const cuenta = (Almacen.doc.cuenta || "").trim().toLowerCase();
  if (!cuenta || !crypto.subtle) return false;
  if (estado.admin?.cuenta === cuenta) return estado.admin.es;
  const huella = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cuenta)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  estado.admin = { cuenta, es: (CONFIG.ADMINS_SHA256 || []).includes(huella) };
  return estado.admin.es;
}

// Especialidad: se elige una sola vez, la primera. El administrador después cambia de camino con «⇄» (entra en el último usado)
async function preguntarEspecialidad() {
  const admin = await esAdmin();
  document.body.classList.toggle("admin", admin);
  if (Almacen.doc.ajustes.especialidad || $("#dlg").open || estado.caminoElegido) return;
  const dlg = $("#dlg"), cuerpo = $("#dlg-cuerpo");
  cuerpo._actual = null;
  cuerpo.innerHTML = admin ? `<h2>¿Qué camino seguís?</h2>
    <p class="ayuda">Sos administrador: podés entrar como cirujano o como anestesiólogo. Cada camino tiene sus propias prestaciones.
      Para cambiar después, tocá el botón «⇄» de arriba.</p>
    <div class="fila"><button class="boton" data-especialidad="cirugia">Cirugía</button><button class="boton" data-especialidad="anestesia">Anestesiología</button></div>
    <div class="fila"><button class="boton chico secundario" data-cerrar-sesion>🔒 Cerrar sesión</button></div>`
    : `<h2>¿Cuál es tu especialidad?</h2>
    <p class="ayuda">La app se adapta a cómo se liquida cada una. En anestesiología: complejidad del nomenclador de anestesiólogos,
      documentación (foja quirúrgica, foja de anestesia y autorización) y carga en la asociación. <b>Se elige una sola vez.</b></p>
    <div class="fila"><button class="boton" data-especialidad="cirugia">Cirugía</button><button class="boton" data-especialidad="anestesia">Anestesiología</button></div>`;
  cuerpo.onclick = async (ev) => {
    if (ev.target.closest("[data-volver]")) { estado.caminoElegido = false; dlg.close(); return preguntarEspecialidad(); }
    if (ev.target.closest("[data-cerrar-sesion]")) { dlg.close(); return bloquearYa(); }
    const b = ev.target.closest("[data-especialidad], [data-confirmar-especialidad]");
    if (!b) return;
    // Colegas: se confirma (no se puede cambiar después)
    if (!admin && b.dataset.especialidad) {
      cuerpo.innerHTML = `<h2>${ESPECIALIDADES[b.dataset.especialidad]}</h2><p class="ayuda">¿Confirmás tu especialidad? No se puede cambiar después.</p>
        <div class="fila"><button class="boton" data-confirmar-especialidad="${b.dataset.especialidad}">Sí, confirmar</button>
        <button class="boton secundario" data-volver>Volver</button></div>`;
      return;
    }
    estado.caminoElegido = true;
    await Almacen.ajuste("especialidad", b.dataset.especialidad || b.dataset.confirmarEspecialidad);
    dlg.close();
    aplicarModo();
    await recalcularPendientes();
    refrescar();
  };
  dlg.showModal();
}

// ---------- Formulario de prestación ----------

function opcionesOS(actual) {
  const nombres = datos().obras.filter((o) => o.activa || o.nombre === actual).map((o) => o.nombre);
  return `<option value="">— elegir —</option>` + nombres.map((n) => `<option ${n === actual ? "selected" : ""}>${esc(n)}</option>`).join("");
}

function opcionesCodigo(p) {
  const lista = [...(p.sugerencias?.aac || [])];
  if (p.codigo_aac && p.codigo_aac !== "CONSULTA" && !lista.some((c) => c.code === p.codigo_aac)) {
    const info = Motor.infoCodigo("AAC", p.codigo_aac);
    lista.unshift({ code: p.codigo_aac, name: info ? info.name : "(elegido)", uq: info?.uq });
  }
  return `<option value="">— sin código —</option>` + lista.map((c) =>
    `<option value="${esc(c.code)}" ${c.code === p.codigo_aac ? "selected" : ""}>${esc(c.code)} · ${esc(c.name.slice(0, 60))}${c.uq ? " (" + c.uq + " UQ)" : ""}</option>`).join("");
}

function camposPrestacion(p, completo) {
  const sel = (nombre, opciones, actual) => `<select name="${nombre}">${Object.entries(opciones).map(([k, v]) => `<option value="${k}" ${k === actual ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  const quir = p.tipo !== "consulta";
  return `
  <div class="grid">
    <label>Fecha${campoFecha("fecha", p.fecha)}</label>
    <label>Tipo${sel("tipo", TIPOS, p.tipo)}</label>
    <label class="ancho">Paciente<input name="paciente" value="${esc(p.paciente)}" required></label>
    <label>Obra social<select name="obra_social">${opcionesOS(p.obra_social)}</select></label>
    <label>N.º de afiliado<input name="afiliado" value="${esc(p.afiliado)}"></label>
    ${quir ? `<label>DNI<input name="dni" value="${esc(p.dni)}" inputmode="numeric"></label>` : ""}
    ${p.obra_social_texto && p.obra_social_texto !== p.obra_social ? `<p class="ayuda ancho" style="margin-top:-6px">Leído: «${esc(p.obra_social_texto.slice(0, 80))}»</p>` : ""}
    ${p.tipo === "endoscopia" && !esAnestesia() ? `
    <label>Endoscopía${sel("endoscopia", { "": "— elegir —", ...ENDOSCOPIAS }, p.endoscopia || "")}</label>
    ${["baja", "ambas"].includes(p.endoscopia) ? `<label>¿Llegó a ciego?${sel("ciego", SI_NO, p.ciego || "")}</label>` : ""}
    <label>¿Polipectomía?${sel("polipectomia", SI_NO, p.polipectomia || "")}</label>
    <label class="ancho">Observaciones<textarea name="observaciones" rows="2" placeholder="Detalles importantes: várices, úlceras, clips, ligadura, biopsias…">${esc(p.observaciones)}</textarea></label>` : ""}
    ${quir && esAnestesia() ? camposAnestesia(p) : quir ? `
    <label class="ancho">Procedimiento${p.procedimiento_estimado ? ' <span class="chip vencida">probable: confirmalo</span>' : ""}<input name="procedimiento" value="${esc(p.procedimiento)}"></label>
    ${itemsModulo(p.codigo_os).length > 1 ? `<label class="ancho">¿Cuál del módulo PAMI ${esc(p.codigo_os)}?<select data-modulo-item>
      <option value="">— elegir la cirugía —</option>${itemsModulo(p.codigo_os).map((it) => `<option value="${esc(nombreItem(it))}" ${nombreItem(it) === p.procedimiento ? "selected" : ""}>${esc(nombreItem(it))}</option>`).join("")}</select></label>` : ""}
    <label class="ancho economia">Código AAC<select name="codigo_aac">${opcionesCodigo(p)}</select></label>
    <div class="ancho fila economia" style="margin-top:-4px"><button type="button" class="boton chico secundario" data-buscar-codigo>Buscar otro código</button></div>
    ${camposExtras(p)}
    <label>Abordaje${sel("abordaje", { "": "—", laparoscopica: "Laparoscópica", convencional: "Convencional", robotica: "Robótica", percutanea: "Percutánea", endoscopica: "Endoscópica" }, p.abordaje || "")}</label>
    <label>Rol${sel("rol", { cirujano: "Cirujano", ayudante: "Ayudante" }, p.rol || "cirujano")}</label>
    <label class="economia">% a facturar<input type="number" name="pct" value="${p.pct ?? 100}" min="0" max="100"></label>
    ${p.tipo === "consulta" ? "" : `<label class="economia">% del módulo para vos<input type="number" name="pct_modulo" value="${p.pct_modulo ?? ""}" min="0" max="100" step="0.1" placeholder="si paga por módulo"></label>`}
    ${campoCodigoOS(p)}
    <label class="check"><input type="checkbox" name="urgencia" ${p.urgencia ? "checked" : ""}> Urgencia</label>` : ""}
    ${quir && completo ? documentosPaciente(p) : ""}
    ${completo ? `
    ${quir && esAnestesia() ? "" : `<label>Hora<input type="time" name="hora" value="${esc(p.hora)}"></label>`}
    ${quir ? "" : `<label>DNI<input name="dni" value="${esc(p.dni)}" inputmode="numeric"></label>`}
    ${quir && esAnestesia() ? "" : `<label>Institución<input name="institucion" value="${esc(p.institucion)}"></label>`}
    ${p.solo_registro || p.origen === "planilla" ? `<label class="check economia ancho"><input type="checkbox" name="solo_registro" ${p.solo_registro ? "checked" : ""}> Solo registro (planilla vieja: sin valor ni cobro esperado)</label>` : ""}
    <label class="economia">Valor a mano ($)<input type="number" name="valor_manual" value="${p.valor_manual ?? ""}" placeholder="vacío = estimado"></label>
    <label class="economia">Estado${sel("estado", ESTADOS, p.estado || "pendiente")}</label>
    <label class="economia">${esAnestesia() ? "Cargada el" : "Presentada el"}${campoFecha("fecha_presentacion", p.estado === "pendiente" ? "" : p.fecha_presentacion)}</label>
    <label class="economia">${esAnestesia() ? "Liquidada el" : "Cobrada el"}${campoFecha("fecha_cobro", p.fecha_cobro)}</label>
    <label class="economia">${esAnestesia() ? "Monto liquidado, neto ($)" : "Monto cobrado ($)"}<input type="number" name="monto_cobrado" value="${p.monto_cobrado ?? ""}"></label>
    ${p.estado === "debitada" || p.motivo_debito ? `<label class="economia ancho">Motivo del débito<input name="motivo_debito" value="${esc(p.motivo_debito)}" placeholder="p. ej. falta autorización, código mal facturado"></label>` : ""}
    <label class="ancho">Notas<textarea name="notas" rows="2">${esc(p.notas)}</textarea></label>` : ""}
  </div>
  ${faltantes(p).length ? `<div class="alerta" style="margin:4px 0">Falta: ${faltantes(p).join(", ")}</div>` : ""}
  ${esAnestesia() && docFaltante(p).length ? `<div class="alerta" style="margin:4px 0">Documentación pendiente: ${docFaltante(p).join(", ")} (sin eso no se puede cargar en la asociación)</div>` : ""}
  <div class="valor economia"><b>${pesos(p.valor_estimado)}</b> <span class="ayuda">${esAnestesia() && p.valor_bruto ? `neto · bruto a cargar ${pesos(p.valor_bruto)} ` : ""}· cobro estimado ${fechaCorta(p.fecha_cobro_estimada)}</span>
    <div class="origen">${esc(p.valor_origen)}</div></div>`;
}

// Anestesia: complejidad (con las prácticas del nomenclador que coinciden), recargos y documentación
function camposAnestesia(p) {
  const sel = (nombre, opciones, actual) => `<select name="${nombre}">${Object.entries(opciones).map(([k, v]) => `<option value="${k}" ${String(k) === String(actual ?? "") ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  const complejidades = { "": "— elegir —", ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, `Complejidad ${i + 1}`])) };
  const sug = (p.sugerencias?.anest || []).slice(0, 4);
  const marca = (k, texto) => `<label class="check"><input type="checkbox" name="${k}" ${p[k] ? "checked" : ""}> ${texto}</label>`;
  return `
    <label class="ancho">Procedimiento<input name="procedimiento" value="${esc(p.procedimiento)}"></label>
    <label>Complejidad${sel("complejidad", complejidades, p.complejidad)}</label>
    <label>Hora<input type="time" name="hora" value="${esc(p.hora)}"></label>
    ${sug.length ? `<div class="ancho" style="margin-top:-4px"><div class="ayuda" style="margin:0 0 4px">Según el nomenclador de anestesiólogos (tocá para usar):</div>
      ${sug.map((c) => `<button type="button" class="boton chico secundario" style="margin:0 4px 4px 0" data-complejidad="${c.complejidad}">${c.complejidad} · ${esc(c.name.slice(0, 55))}</button>`).join("")}</div>` : ""}
    <div class="ancho fila" style="margin-top:-4px"><button type="button" class="boton chico secundario" data-buscar-anest>Buscar en el nomenclador de anestesiólogos</button></div>
    <div class="ancho" style="margin:4px 0 8px">
      <div class="ayuda" style="margin:0 0 4px">${(p.extras || []).length ? "Otras intervenciones en el mismo acto" : ""}</div>
      ${(p.extras || []).map((x, i) => `<div style="border:1px solid var(--borde);border-radius:8px;padding:6px;margin-bottom:6px">
        <div class="fila" style="margin:0;flex-wrap:nowrap"><input name="extra_proc_${i}" value="${esc(x.procedimiento)}" placeholder="Procedimiento">
        <button type="button" class="boton chico peligro" data-quitar-extra="${i}" aria-label="Quitar">✕</button></div>
        <div class="fila" style="margin:4px 0 0;flex-wrap:nowrap">${sel(`extra_comp_${i}`, complejidades, x.complejidad)}${sel(`extra_via_${i}`, VIAS, x.via || "misma")}</div></div>`).join("")}
      <button type="button" class="boton chico secundario" data-agregar-extra>+ Agregar otra intervención (mismo acto)</button></div>
    <label>Edad del paciente${sel("edad_grupo", EDADES, p.edad_grupo || "")}</label>
    <label>Institución / lugar<input name="institucion" value="${esc(p.institucion)}"></label>
    <label>N° de circuito<input name="nro_circuito" value="${esc(p.nro_circuito)}" inputmode="numeric" placeholder="el de la asociación"></label>
    ${p.nro_ref ? `<p class="ancho ayuda" style="margin:0">Referencia: <b>Ref. ${refTexto(p)}</b> (va en el nombre de sus PDF en el Drive)${p.carpeta_docs?.link ? ` · <a href="${esc(p.carpeta_docs.link)}" target="_blank" rel="noopener">📁 Abrir la carpeta del paciente</a>` : ""}</p>` : ""}
    ${marca("feriado", "Feriado (+50 %)" + (Motor.feriadoNacional(p.fecha) ? " · es feriado nacional" : ""))}
    ${marca("obesidad", "Obesidad mórbida (+2 complejidades)")}
    ${marca("suspendida", "Operación suspendida (complejidad 1)")}
    <div class="ancho ayuda" style="margin:6px 0 0"><b>Documentación</b></div>
    ${Object.entries(DOCS).map(([clase, x]) => documento(p, clase, x, marca)).join("")}
    <p class="ancho ayuda" style="margin:0">Nocturno (20 a 7 h, +35 %) y fin de semana (sábado 13 h a lunes 7 h, +50 %) salen de la fecha y la hora.</p>`;
}

// Documentos del paciente que no son de la asociación (cirugía: parte quirúrgico y datos; anestesia: datos) y la carpeta
function documentosPaciente(p) {
  const clases = esAnestesia() ? ["datos"] : ["parte", "datos"];
  return `<div class="ancho ayuda" style="margin:8px 0 0"><b>Documentos en el Drive</b>${p.carpeta_docs?.link ? ` · <a href="${esc(p.carpeta_docs.link)}" target="_blank" rel="noopener">📁 Abrir la carpeta del paciente</a>` : ""}</div>` +
    clases.map((c) => documento(p, c, DOCS_EXTRA[c], null)).join("");
}

// Un documento de la anestesia: casilla, archivos por guardar, enlaces al Drive y botón para adjuntar fotos o PDF
function documento(p, clase, x, marca) {
  const nuevos = documentosDe(p)[clase] || [], enDrive = p[x.lista] || [];
  return `${marca ? marca(x.campo, x.nombre) : `<div class="ancho ayuda" style="margin:4px 0 0"><b>${x.nombre}</b></div>`}
    <div class="ancho" data-doc="${clase}">
      ${nuevos.length ? `<p class="ayuda" style="margin:0">📄 ${(p._fotos || []).some((f) => f.clase === clase && f.reconocida) ? `Reconocida: es la ${x.corto}` : x.nombre} (${nuevos.length === 1 ? "1 foto" : nuevos.length + " fotos o páginas"} → un PDF): al guardar va a tu Drive › Liquidaciones › ${rutaPaciente(p).join(" › ")} › ${esc(nombreCarpeta(p))}${enDrive.length ? " y reemplaza al anterior" : ""}.</p>` : ""}
      ${enDrive.length ? `<p class="ayuda" style="margin:0">En tu Drive: ${enDrive.map((a, i) => `<a href="${esc(a.link)}" target="_blank" rel="noopener">ver${enDrive.length > 1 ? " " + (i + 1) : ""}</a>`).join(" · ")}</p>` : ""}
      <label class="boton chico secundario" style="margin:2px 0 6px">📎 ${nuevos.length || enDrive.length ? "Agregar otra foto" : "Adjuntar (foto o PDF)"}<input type="file" accept="image/*,application/pdf" multiple hidden data-adjuntar-doc="${clase}"></label>
      <button type="button" class="boton chico secundario" style="margin:2px 0 6px" data-camara="[data-adjuntar-doc=${clase}]">📷 Varias seguidas</button>
    </div>`;
}

const procedimientosDe = (p) => [p.procedimiento || TIPOS[p.tipo], ...(p.extras || []).map((x) => x.procedimiento)].filter(Boolean).join(" + ");
const codigosDe = (p, campo) => [p[campo], ...(p.extras || []).map((x) => x[campo])].filter(Boolean).join(" + ");

// Código de la obra social. PAMI: lista con los códigos sugeridos del nomenclador oficial (con sus unidades) y búsqueda;
// se puede cargar cualquier código aunque no esté en el nomenclador. Otras obras sociales: texto libre.
function campoCodigoOS(p) {
  if (p.obra_social !== "PAMI") return `<label>Código obra social<input name="codigo_os" value="${esc(p.codigo_os)}"></label>`;
  const lista = [...(p.sugerencias?.pami || [])];
  if (p.codigo_os && !lista.some((c) => c.code === p.codigo_os)) {
    const info = Motor.catalogos.PAMI_NOM?.codes.find((c) => c.code === p.codigo_os);
    lista.unshift(info ? { code: info.code, name: info.name, h: info.h, tipo: info.tipo, modulo: info.modulo } : { code: p.codigo_os, name: "(no figura en el nomenclador PAMI)" });
  }
  const opcion = (c) => `<option value="${esc(c.code)}" ${c.code === p.codigo_os ? "selected" : ""}>${esc(c.code)} · ${esc((c.name || "").slice(0, 60))}${c.h ? ` (${c.h} u.${/MODULADA/.test(c.tipo || "") ? " módulo" : ""})` : ""}</option>`;
  return `<label class="ancho">Código PAMI<select name="codigo_os"><option value="">— sin código —</option>${lista.map(opcion).join("")}</select></label>
    <div class="ancho fila" style="margin-top:-4px"><button type="button" class="boton chico secundario" data-buscar-pami>Buscar código PAMI</button></div>`;
}

// Otros procedimientos del mismo acto: cada uno con su código (el valor va al % de operación múltiple)
function camposExtras(p) {
  const lista = p.extras || [];
  return `<div class="ancho" style="margin:4px 0 8px">
    <div class="ayuda" style="margin:0 0 4px">${lista.length ? "Otros procedimientos del mismo acto" : ""}</div>` +
    lista.map((x, i) => `<div style="border:1px solid var(--borde);border-radius:8px;padding:6px;margin-bottom:6px">
      <div class="fila" style="margin:0;flex-wrap:nowrap"><input name="extra_proc_${i}" value="${esc(x.procedimiento)}" placeholder="Procedimiento">
      <button type="button" class="boton chico peligro" data-quitar-extra="${i}" aria-label="Quitar">✕</button></div>
      <select name="extra_cod_${i}" class="economia" style="margin-top:4px">${opcionesCodigo({ codigo_aac: x.codigo_aac, sugerencias: x.sugerencias })}</select>
      ${x.codigo_os ? `<div class="ayuda" style="margin:2px 0 0">Código obra social: ${esc(x.codigo_os)}</div>` : ""}</div>`).join("") +
    `<button type="button" class="boton chico secundario" data-agregar-extra>+ Agregar otro procedimiento (mismo acto)</button></div>`;
}

function leerCampos(el, base) {
  const p = { ...base };
  $$("input[name], select[name], textarea[name]", el).forEach((c) => {
    if (c.type === "checkbox") p[c.name] = c.checked;
    else if (c.hasAttribute("data-fecha")) p[c.name] = c.value.trim() === "" ? null : fechaDeTexto(c.value) || "invalida:" + c.value.trim();
    else if (c.type === "number") p[c.name] = c.value === "" ? null : Number(c.value);
    else p[c.name] = c.value === "" ? null : c.value;
  });
  // Campos de los otros procedimientos del acto → p.extras (conservando lo que no está en pantalla, como el código de la obra social)
  const extras = [];
  for (const k of Object.keys(p)) {
    const m = k.match(/^extra_(proc|cod|comp|via)_(\d+)$/);
    if (!m) continue;
    const i = +m[2];
    extras[i] ||= { ...(base.extras?.[i] || {}) };
    if (m[1] === "proc") extras[i].procedimiento = p[k] || "";
    else if (m[1] === "comp") extras[i].complejidad = p[k] ? Number(p[k]) : null;
    else if (m[1] === "via") extras[i].via = p[k] || "misma";
    else extras[i].codigo_aac = p[k];
    delete p[k];
  }
  if (extras.length || base.extras) p.extras = extras.filter(Boolean);
  if (p.estado === "pendiente" && p.fecha_presentacion) p.estado = "presentada";
  if (p.tipo === "endoscopia") {
    if (!["baja", "ambas"].includes(p.endoscopia)) p.ciego = null;
    if (esTextoAutomatico(p.procedimiento)) p.procedimiento = textoEndoscopia(p) || p.procedimiento;
  }
  return p;
}

// Re-estimar al cambiar algo que cambia el valor (obra social, código, rol…)
function enlazarEstimacion(el, obtener, guardar) {
  const recalcular = (cambio) => {
    const p = obtener();
    if (!p) return; // el diálogo muestra otra cosa (obra social, valor)
    if (cambio === "procedimiento") p.procedimiento_estimado = false; // lo escribió el médico
    if (["procedimiento", "tipo", "abordaje"].includes(cambio)) { p.codigo_aac = null; if (cambio !== "abordaje") p.complejidad = null; }
    if (cambio === "fecha") p.feriado = null; // otra fecha: el feriado vuelve a salir del calendario
    const extra = /^extra_proc_(\d+)$/.exec(cambio || "");
    if (extra && p.extras?.[+extra[1]]) { p.extras[+extra[1]].codigo_aac = null; p.extras[+extra[1]].complejidad = null; } // cambió el texto: volver a sugerir
    if (cambio === "obra_social" && !p.codigo_os_manual) p.codigo_os = null; // el código escrito a mano no se pierde
    if (!p.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(p.fecha)) return; // fecha a medio escribir
    const e = Motor.estimar(datos(), { ...p, fecha_presentacion: p.estado === "pendiente" ? null : p.fecha_presentacion });
    guardar({ ...p, ...e, sugerencias: e.sugerencias || p.sugerencias });
  };
  el.addEventListener("change", async (ev) => {
    if (ev.target.matches("[data-adjuntar-doc]") && ev.target.files.length && obtener()) {
      const clase = ev.target.dataset.adjuntarDoc, x = DOC_TODOS()[clase], archivos = [...ev.target.files], p = obtener();
      ev.target.value = "";
      guardar({ ...p, ...(DOCS[clase] ? { [x.campo]: true } : {}), _docs: { ...(p._docs || {}), [clase]: [...(p._docs?.[clase] || []), ...archivos] } });
      aviso(`${x.nombre}: ${archivos.length === 1 ? "agregada" : archivos.length + " fotos agregadas"}. Se guarda en tu Drive al tocar Guardar.`);
      return;
    }
    if (ev.target.matches("[data-modulo-item]") && ev.target.value && obtener()) {
      const p = obtener(); p.procedimiento = ev.target.value; p.procedimiento_estimado = false; guardar(p); return recalcular("procedimiento");
    }
    if (!ev.target.name || ["notas", "dni", "afiliado", "hora", "institucion", "nro_circuito", "motivo_debito", "estado", "monto_cobrado", "paciente", "ciego", "observaciones"].includes(ev.target.name)) return;
    if (ev.target.name === "codigo_os") { const p = obtener(); if (p) { p.codigo_os_manual = true; guardar(p); } }
    if (["endoscopia", "polipectomia"].includes(ev.target.name) && esTextoAutomatico(obtener()?.procedimiento)) {
      const p = obtener(); p.procedimiento = textoEndoscopia(p); guardar(p); return recalcular("procedimiento");
    }
    recalcular(ev.target.name);
  });
  el.addEventListener("click", (ev) => {
    const agregar = ev.target.closest("[data-agregar-extra]"), quitar = ev.target.closest("[data-quitar-extra]");
    if ((agregar || quitar) && obtener()) {
      const p = obtener();
      p.extras = [...(p.extras || [])];
      if (agregar) p.extras.push({ procedimiento: "", codigo_aac: null, via: "misma" });
      else p.extras.splice(+quitar.dataset.quitarExtra, 1);
      guardar(p);
      if (quitar) recalcular("extras");
      return;
    }
    const elegida = ev.target.closest("[data-complejidad]");
    if (elegida && obtener()) { const p = obtener(); p.complejidad = +elegida.dataset.complejidad; guardar(p); recalcular("complejidad"); return; }
    if (ev.target.matches("[data-buscar-anest]") && obtener()) {
      const q = prompt("Buscar en el nomenclador de anestesiólogos (palabras):", obtener().procedimiento || "");
      if (!q) return;
      const res = Motor.buscar("ANEST", q, 8).map((c) => ({ code: c.code, name: c.name, complejidad: c.complejidad, subgrupo: c.subgrupo }));
      if (!res.length) return aviso("Sin resultados en el nomenclador de anestesiólogos");
      const p = obtener();
      p.sugerencias = { ...(p.sugerencias || {}), anest: res };
      p.complejidad = res[0].complejidad;
      guardar(p);
      recalcular("complejidad");
      if (res.length > 1) aviso(`${res.length} resultados: tocá la práctica que corresponde.`);
      return;
    }
    if (ev.target.matches("[data-buscar-pami]") && obtener()) {
      const q = prompt("Buscar en el nomenclador PAMI (palabras o código):", obtener().procedimiento || "");
      if (!q) return;
      const p = obtener();
      let res = Motor.buscar("PAMI_NOM", q).map((c) => ({ code: c.code, name: c.name, h: c.h, tipo: c.tipo, modulo: c.modulo }));
      // Un código que no está en el nomenclador (p. ej. de otra normativa) también se puede cargar
      if (!res.length && /^\d{4,8}$/.test(q.trim())) res = [{ code: q.trim(), name: "(no figura en el nomenclador PAMI)" }];
      if (!res.length) return aviso("Sin resultados en el nomenclador PAMI");
      p.sugerencias = { ...(p.sugerencias || {}), pami: res };
      p.codigo_os = res[0].code;
      p.codigo_os_manual = true;
      guardar(p);
      recalcular("codigo_os");
      if (res.length > 1) aviso(`${res.length} resultados: elegí el código en la lista «Código PAMI».`);
      return;
    }
    if (!ev.target.matches("[data-buscar-codigo]") || !obtener()) return;
    const q = prompt("Buscar en el nomenclador AAC (palabras o código):", obtener().procedimiento || "");
    if (!q) return;
    const res = Motor.buscar("AAC", q).map((c) => ({ code: c.code, name: c.name, uq: c.uq }));
    if (!res.length) return aviso("Sin resultados");
    const p = obtener();
    p.sugerencias = { ...(p.sugerencias || {}), aac: res };
    p.codigo_aac = res[0].code;
    guardar(p);
    recalcular("codigo_aac");
  });
}

// ---------- Cargar ----------

let filasRevision = [];

// Lo último leído, para sumarle fotos o páginas de a una (la cámara del celular saca una por vez)
let ultimaLectura = null;

async function leer(tipo, archivos, textoPegado) {
  ultimaLectura = textoPegado == null && archivos?.length ? { tipo, archivos } : null;
  $("#cargar-botones").hidden = true; $("#leyendo").hidden = false;
  const avance = (t) => ($("#leyendo-texto").textContent = t);
  const partes = [];
  try {
    const texto = textoPegado ?? await Lector.textoDe(archivos, avance, { partes });
    const d = datos();
    const filas = Lector.aPrestaciones(tipo, texto, { obraSocial: (t) => Motor.obraSocialCanonica(d, t), medico: ajuste("apellido", ""),
      pctMultiple: Motor.catalogos.AAC.rules.multiple_same_approach_pct });
    if (!filas.length || !filas.some((f) => f.paciente || f.procedimiento)) throw Object.assign(new Error("No se reconocieron pacientes: revisá el texto leído y completá a mano."), { texto });
    $("#texto-leido").textContent = texto;
    if (tipo === "parte" && Lector.esEstudio(texto)) {
      filas.forEach((f) => Object.assign(f, { incluir: false, estudio: true }));
      aviso("Parece el informe de un estudio (TAC, ecografía…), no un procedimiento: quedó destildado.");
    }
    if (tipo === "parte" && !esAnestesia() && !ajuste("apellido", "")) aviso("Cargá tu apellido en Valores → Mi cuenta para saber si fuiste cirujano o ayudante.");
    // Varios códigos en el parte («180116 310009»): el principal es el quirúrgico (módulo, después práctica quirúrgica);
    // los demás (p. ej. la ecografía) van como otros procedimientos del mismo acto, con su nombre del nomenclador
    if (tipo === "parte") for (const f of filas) {
      const cods = [...new Set(f.codigos_os || [])];
      delete f.codigos_os;
      if (cods.length < 2 || esAnestesia()) continue;
      const info = (c) => Motor.catalogos.PAMI_NOM?.codes.find((x) => x.code === c);
      const peso = (c) => (/MODULADA/.test(info(c)?.tipo || "") ? 3 : /QUIRURGICA/.test(info(c)?.tipo || "") ? 2 : info(c) ? 1 : 0);
      const [principal, ...resto] = [...cods].sort((a, b) => peso(b) - peso(a));
      f.codigo_os = principal;
      f.codigo_os_manual = true;
      f.extras = [...(f.extras || []), ...resto.map((c) => ({ procedimiento: info(c)?.name || "Código " + c, codigo_os: c }))];
    }
    if (tipo === "parte" && filas.length > 1) {
      // Un mismo acto: una sola prestación; el procedimiento de mayor valor es el principal (100 %), los demás van como
      // «otros procedimientos del mismo acto» (al % de operación múltiple)
      const lleno = (f) => Motor.estimar(d, { ...f, pct: 100, fecha: f.fecha || hoy() }).valor_estimado || 0;
      // Empate (p. ej. el mismo módulo para los dos): decide el valor de referencia de la AAC de cada procedimiento
      const referencia = (f) => Motor.estimar(d, { ...f, pct: 100, codigo_os: null, obra_social: null, obra_social_texto: "", fecha: f.fecha || hoy() }).valor_estimado || 0;
      filas.sort((a, b) => lleno(b) - lleno(a) || referencia(b) - referencia(a));
      const [principal, ...resto] = filas;
      principal.pct = 100;
      principal.extras = [...(principal.extras || []), ...resto.map((f) => ({ procedimiento: f.procedimiento, codigo_aac: null, codigo_os: f.codigo_os || null }))];
      filas.splice(0, filas.length, principal);
    }
    // Cirugía: las fotos o el PDF del parte se guardan (un PDF) en la carpeta del paciente
    if (tipo === "parte" && !esAnestesia() && archivos?.length && filas.length === 1) filas[0]._docs = { parte: [...archivos] };
    // Anestesiología: cada foto se reconoce por separado (foja quirúrgica, foja de anestesia o autorización); lo reconocido
    // cuenta como presentado y el archivo se guarda en el Drive. Con un solo paciente leído (lo normal: las fotos de un acto).
    // Lo que no se reconoce queda para elegir en la revisión («¿Qué es esta foto?»): nada se guarda sin que se sepa qué es.
    if (tipo === "parte" && esAnestesia() && archivos?.length && filas.length === 1) {
      const f = filas[0];
      // Puntaje de cada foto para cada documento; se asigna de mayor a menor: cada documento a su mejor foto y cada foto
      // a un solo documento. Las demás quedan como «solo datos del paciente» (se leyeron, pero no se guardan).
      const pares = archivos.flatMap((a, i) => Object.entries(Lector.puntajeDocumento(partes[i] ?? (archivos.length === 1 ? texto : ""), f))
        .filter(([, n]) => n > 0).map(([clase, n]) => ({ i, clase, n }))).sort((a, b) => b.n - a.n);
      const clases = archivos.map(() => "");
      for (const x of pares) if (!clases[x.i] && !clases.includes(x.clase)) clases[x.i] = x.clase;
      f._fotos = archivos.map((a, i) => ({ archivo: a, clase: clases[i], reconocida: !!clases[i] }));
      for (const c of clases) if (c) f[DOCS[c].campo] = true;
      const rec = clases.filter(Boolean), datosSolo = clases.filter((c) => !c).length;
      aviso((rec.length ? "Reconocí: " + rec.map((c) => DOCS[c].corto).join(", ") + "." : "No reconocí fojas ni autorización: elegilas abajo en «Fotos cargadas».") +
        (datosSolo && rec.length ? ` ${datosSolo === 1 ? "Otra foto quedó" : datosSolo + " fotos quedaron"} solo para datos del paciente.` : ""));
    }
    const conFecha = filas.map((f) => ({ ...f, fecha: f.fecha || hoy(), fecha_leida: !!f.fecha }));
    if (marcarRepetidas(conFecha)) aviso("Hay cirugías que ya estaban cargadas (mismo paciente y día): quedaron destildadas.");
    mostrarRevision(conFecha.map((f) => ({ ...f, ...Motor.estimar(d, f) })),
      tipo === "parte" ? "Parte quirúrgico" : "Listado" + (filas[0].fecha ? " del " + fechaCorta(filas[0].fecha) : ""));
  } catch (e) {
    aviso(e.message);
    if (e.texto !== undefined && !e.capturaApp) {
      $("#texto-leido").textContent = e.texto;
      mostrarRevision([{ fecha: hoy(), tipo: tipo === "parte" ? "cirugia" : "consulta", paciente: "", rol: "cirujano", pct: 100, incluir: true, origen: "manual",
        ...(tipo === "parte" && esAnestesia() && archivos?.length ? { _fotos: archivos.map((a) => ({ archivo: a, clase: "", reconocida: false })) } : {}),
        ...(tipo === "parte" && !esAnestesia() && archivos?.length ? { _docs: { parte: [...archivos] } } : {}) }], "Completar a mano");
    } else $("#cargar-botones").hidden = false;
  } finally { $("#leyendo").hidden = true; }
}

// Planilla de Excel/CSV con cirugías o anestesias previas (de cada rama): una fila por prestación; las columnas se reconocen por el encabezado
// (sirve la planilla exportada por la app). Solo paciente, datos y cirugía: los montos no se usan. Pasa por la misma revisión que las fotos.
const COLUMNAS_PLANILLA = [
  ["fecha_cobro", /fecha.*(cobr|pag|liquid)|(cobrad|liquidad|pagad)[ao] el/], ["fecha", /^(fecha|dia)\b/],
  ["monto_cobrado", /^(monto |importe )?(cobrado|liquidado|pagado|percibido)/], ["complejidad", /complejidad/], ["nro_circuito", /circuito/],
  ["afiliado", /afiliado|credencial|carnet|socio/],
  ["obra_social_texto", /obra|soc(ial)?\b|cobertura|prepaga|financ|mutual|^o\.? ?s\.?\b|^os[ _]/],
  ["paciente", /paciente|apellido y nombre|nombre y apellido|apellido, nombre/], ["apellido", /apellido/], ["nombres", /nombre/], ["dni", /\bdni\b|documento/],
  ["codigo_os", /codigo (obra social|os)/], ["procedimiento", /procedimiento|cirugia|practica|operacion|intervencion/],
  ["institucion", /institucion|clinica|sanatorio|lugar|centro/], ["tipo", /^tipo$/], ["rol", /^rol$|funcion/], ["notas", /^notas?$|observ|comentario/]];

// ---------- Cirugía de un código de la liquidación ----------
// La liquidación solo trae el código y una descripción cortada («MODULO 4 DE»). Con el código: si el módulo de PAMI incluye
// una sola cirugía, es esa; si incluye varias, la más probable según las cirugías que el médico ya hizo (marcada «probable»,
// se elige en la ficha entre las del módulo); si no hay lista, el nombre completo del nomenclador.
const itemsModulo = (codigo) => Motor.catalogos.PAMI?.codes?.find((c) => c.code === String(codigo || ""))?.items || [];
const nombreItem = (t) => { const x = String(t).split(/\.\s|,\s*(?:incluye|como único|para (?:el )?tratamiento)|\s+incluye\s/i)[0].trim(); return x.length > 90 ? x.slice(0, 90).replace(/\s+\S*$/, "") + "…" : x; };
const capitalizar = (t) => String(t || "").toLowerCase().replace(/^./, (c) => c.toUpperCase());
function procedimientoDeCodigo(codigo, descripcion, paciente = "", fecha = "") {
  const items = itemsModulo(codigo);
  if (items.length === 1) return { procedimiento: nombreItem(items[0]), estimado: false };
  const palabras = (t) => new Set(Motor.plano(t).split(/[^a-z]+/).filter((w) => w.length >= 6));
  // El mismo paciente en la lista propia (planilla, partes, cargas a mano): su cirugía más cercana (hasta 90 días), compatible
  // con las del módulo si el código es de un módulo
  if (paciente && fecha) {
    // Con tantos días de margen, los errores de tipeo se toleran solo si la liquidación trae nombre y apellido
    const conNombre = !!claveNombre(paciente).nom;
    const delModulo = new Set(items.flatMap((it) => [...palabras(nombreItem(it))]));
    const suya = datos().prestaciones.filter((p) => p.tipo !== "consulta" && p.origen !== "liquidacion" && p.procedimiento && !procedimientoCortado(p) &&
      mismoPaciente(p.paciente, paciente, conNombre) && diasEntre(p.fecha, fecha) <= 90 && (!items.length || [...palabras(p.procedimiento)].some((w) => delModulo.has(w))))
      .sort((a, b) => diasEntre(a.fecha, fecha) - diasEntre(b.fecha, fecha))[0];
    if (suya) return { procedimiento: suya.procedimiento, estimado: true, segun: suya.fecha };
  }
  if (items.length > 1) {
    // La más probable: la del módulo que más se parece a las cirugías propias cargadas (no de liquidaciones)
    const propias = datos().prestaciones.filter((p) => p.tipo !== "consulta" && p.origen !== "liquidacion" && p.procedimiento).map((p) => palabras(p.procedimiento));
    // Cuántas palabras comparte cada cirugía del módulo con las propias (así «hernioplastía umbilical» gana a «hernioplastía inguinal»)
    const puntaje = items.map((it) => { const w = [...palabras(nombreItem(it))]; return propias.reduce((t, pp) => t + w.filter((x) => pp.has(x)).length, 0); });
    const max = Math.max(...puntaje);
    if (max > 0 && puntaje.filter((x) => x === max).length === 1) return { procedimiento: nombreItem(items[puntaje.indexOf(max)]), estimado: true };
  }
  const nom = Motor.catalogos.PAMI_NOM?.codes?.find((c) => c.code === String(codigo || ""));
  if (nom) return { procedimiento: capitalizar(nom.name), estimado: false };
  // Código del nomenclador nacional («13010200» = 13.01.02): el nombre de la AAC, solo si coincide con lo que dice la liquidación
  const n = String(codigo || "").match(/^(\d{2})(\d{2})(\d{2})(?:\d{2})?$/), aac = n && Motor.catalogos.AAC?.codes?.find((c) => c.code === `${n[1]}.${n[2]}.${n[3]}`);
  const inicio = Motor.plano(descripcion).split(/[^a-z]+/).filter((w) => w.length >= 4).slice(0, 2);
  if (aac && inicio.length && inicio.every((w) => Motor.plano(aac.name).includes(w))) return { procedimiento: aac.name, estimado: false };
  return { procedimiento: descripcion ? `${capitalizar(descripcion.replace(/\s+(de|del|o|y)$/i, ""))}… (código ${codigo})` : `Código ${codigo}`, estimado: false };
}
// Lo que quedó con la descripción cortada de la liquidación («MODULO 4 DE», «ESCISION DE», «VIDEOCOLECISTECTO»)
const procedimientoCortado = (p) => p.origen === "liquidacion" && p.tipo !== "consulta" && !!p.procedimiento && !/[a-zñáéíóú]/.test(p.procedimiento) && p.procedimiento.length <= 20;

// Misma cirugía: mismo día y mismo paciente (por DNI si ambos lo tienen; si no, por apellido y nombre). Una cirugía con
// varios procedimientos es un solo acto: los demás van como «otros procedimientos» de esa misma cirugía.
function mismaCirugia(a, b) {
  if (a.tipo === "consulta" || b.tipo === "consulta" || a.fecha !== b.fecha || (a.id && a.id === b.id)) return false;
  const dni = (x) => String(x.dni || "").replace(/\D/g, "");
  if (dni(a) && dni(b)) return dni(a) === dni(b);
  const fichas = (n) => Motor.plano(n || "").replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  return mismoPaciente(a.paciente || "", b.paciente || "") || (!!fichas(a.paciente) && fichas(a.paciente) === fichas(b.paciente)); // «Juan Pérez» = «PÉREZ, JUAN»
}
const cirugiaRepetida = (f, otras = []) => [...datos().prestaciones, ...otras].find((p) => p !== f && mismaCirugia(p, f));

// Revisión: las ya cargadas (o repetidas dentro de lo leído) quedan destildadas y marcadas
function marcarRepetidas(filas) {
  let n = 0;
  filas.forEach((f, i) => { if (!f._fotos && cirugiaRepetida(f, filas.slice(0, i))) { f.repetida = true; f.incluir = false; n++; } });
  return n;
}

const MESES_PLANILLA = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
function fechaPlanilla(v) {
  if (typeof v === "string" && /^\s*\d{5}(\.\d+)?\s*$/.test(v)) v = Number(v); // número de serie de Excel guardado como texto
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  const t = Motor.plano(String(v ?? "")).trim();
  // Solo fechas que existen; si el mes pasa de 12 y el día no, estaba escrita mes/día (Excel en inglés)
  const armar = (y, mo, d) => {
    y = +y < 100 ? 2000 + +y : +y; mo = +mo; d = +d;
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];
    const f = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return y > 1990 && y < 2100 && !isNaN(Date.parse(f)) && new Date(f).toISOString().slice(0, 10) === f ? f : "";
  };
  let m = t.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  if (m) return armar(m[1], m[2], m[3]);
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (m) return armar(m[3], m[2], m[1]);
  m = t.match(/^(\d{1,2})[\s\/.-]*(?:de\s+)?([a-z]{3})[a-z]*\.?[\s\/.-]*(?:de\s+)?(\d{2,4})/); // «12-mar-25», «3 de marzo de 2025»
  if (m && MESES_PLANILLA[m[2]]) return armar(m[3], MESES_PLANILLA[m[2]], m[1]);
  return "";
}

let planillaLeida = null; // el Excel leído: al guardar va a «<Rama>/Planillas cargadas»
async function leerPlanilla(archivos) {
  if (!archivos.length) return;
  ultimaLectura = null; planillaLeida = archivos;
  $("#cargar-botones").hidden = true; $("#leyendo").hidden = false; $("#leyendo-texto").textContent = "Leyendo la planilla…";
  try {
    const d = datos(), filas = [];
    for (const a of archivos) {
      let col = null;
      for (const fila of (await Importador.leer(a, null, { textoCSV: true })).filas) {
        const enc = fila.map((c) => Motor.plano(String(c ?? "")).trim());
        // Encabezado (puede haber uno por hoja): la fila con al menos 2 columnas reconocidas, entre ellas el paciente
        const mapa = {};
        enc.forEach((h, j) => { const c = h && COLUMNAS_PLANILLA.find(([k, re]) => !(k in mapa) && re.test(h)); if (c) mapa[c[0]] = j; });
        if (("paciente" in mapa || "apellido" in mapa) && Object.keys(mapa).length >= 2) { col = mapa; continue; }
        if (!col) continue;
        const v = (k) => (k in col ? String(fila[col[k]] ?? "").trim() : "");
        // Sin columna de obra social con título reconocible: la celda de la fila que nombra una obra social conocida
        const osCelda = () => fila.map((c, j) => (Object.values(col).includes(j) ? null : Motor.obraSocialCanonica(d, String(c ?? "")) && String(c).trim())).find(Boolean) || "";
        // Apellido y nombre en columnas separadas (o «Paciente» con solo el apellido y «Nombre» aparte): «APELLIDO, NOMBRE»
        const ap = v("paciente") || v("apellido"), nom = v("nombres");
        const paciente = nom && !Motor.plano(ap).includes(Motor.plano(nom)) ? `${ap}, ${nom}` : ap;
        if (!paciente && !v("procedimiento")) continue;
        const tipoT = Motor.plano(v("tipo"));
        const tipo = /consulta/.test(tipoT) ? "consulta" : /endoscop|fuera de quirofano/.test(tipoT) ? "endoscopia" : /practica|dolor/.test(tipoT) ? "practica" : "cirugia";
        const f = { fecha: fechaPlanilla(col.fecha != null ? fila[col.fecha] : "") || hoy(), tipo, paciente, dni: v("dni").replace(/\D/g, ""),
          afiliado: v("afiliado"), obra_social_texto: v("obra_social_texto") || osCelda(), obra_social: Motor.obraSocialCanonica(d, v("obra_social_texto") || osCelda()),
          procedimiento: v("procedimiento"), institucion: v("institucion"), codigo_os: v("codigo_os").split(/[\s,]+/)[0] || null,
          rol: /ayud/.test(Motor.plano(v("rol"))) ? "ayudante" : "cirujano", pct: 100, notas: v("notas"), origen: "planilla", incluir: true,
          complejidad: parseInt(v("complejidad"), 10) || null, nro_circuito: v("nro_circuito") || null }; // De la planilla se toman solo el paciente, sus datos y la cirugía: los montos y cobros no (regla del usuario)
        f.fecha_leida = col.fecha != null && !!fechaPlanilla(fila[col.fecha]);
        f.solo_registro = true; // planilla: solo registro (sin valor ni cobro); se puede destildar en la ficha
        if (!f.fecha_leida) f.incluir = false; // sin fecha legible no se guarda con la de hoy: se corrige en la revisión
        filas.push(f);
      }
    }
    if (!filas.length) throw new Error("No encontré cirugías ni anestesias en la planilla: tiene que tener una fila de encabezados con «Paciente» (y Fecha, Obra social, Procedimiento…).");
    $("#texto-leido").textContent = "";
    // Obras sociales que la app no conoce: se ofrece agregarlas (con el nombre como figura en la planilla)
    const nuevasOS = [...new Set(filas.filter((f) => !f.obra_social && f.obra_social_texto).map((f) => f.obra_social_texto.replace(/^\s*\d+\s*-\s*/, "").trim().toUpperCase()))];
    if (nuevasOS.length && confirm(`Estas obras sociales no están en la app:\n\n${nuevasOS.join("\n")}\n\n¿Agregarlas? (después podés completar sus datos en Valores → Obras sociales)`)) {
      for (const nombre of nuevasOS) await Almacen.guardar("obras", { nombre, alias: "", dia_presentacion: 18, dias_pago: 60, id: "os-" + nombre });
      const d2 = datos();
      for (const f of filas) if (!f.obra_social && f.obra_social_texto) f.obra_social = Motor.obraSocialCanonica(d2, f.obra_social_texto);
      $("#f-os").innerHTML = '<option value="">Todas</option>' + d2.obras.map((o) => `<option>${esc(o.nombre)}</option>`).join("") + '<option value="-">Sin reconocer</option>';
    }
    const sinOS = [...new Set(filas.filter((f) => !f.obra_social).map((f) => f.obra_social_texto || "(vacía)"))];
    const rep = marcarRepetidas(filas);
    mostrarRevision(filas.map((f) => ({ ...f, ...Motor.estimar(datos(), f) })), "Planilla");
    aviso([rep ? `${rep} ya ${rep === 1 ? "estaba cargada" : "estaban cargadas"} (mismo paciente y día): quedaron destildadas.` : "",
      sinOS.length ? `Obras sociales sin reconocer: ${sinOS.slice(0, 6).join(", ")}${sinOS.length > 6 ? "…" : ""}. Elegila en cada fila o agregá ese nombre como alias en Valores → Obras sociales.` : ""]
      .filter(Boolean).join(" ") || `${filas.length} ${esAnestesia() ? "anestesias" : "cirugías"} leídas.`);
  } catch (e) {
    aviso(e.message); $("#cargar-botones").hidden = false;
  } finally { $("#leyendo").hidden = true; }
}

function mostrarRevision(filas, titulo) {
  filasRevision = filas;
  $("#revision").hidden = false;
  $("#agregar-foto").hidden = !ultimaLectura;
  $("#agregar-foto-n").textContent = ultimaLectura ? `${ultimaLectura.archivos.length} ${ultimaLectura.archivos.length === 1 ? "foto" : "fotos o páginas"} leídas` : "";
  $("#revision-titulo").textContent = titulo + ` (${filas.length})`;
  const cont = $("#revision-filas");
  cont.innerHTML = "";
  filas.forEach((f, i) => {
    const div = document.createElement("div");
    const pintar = () => {
      const x = filasRevision[i];
      div.className = "revision" + (x.incluir ? "" : " apagada");
      div.innerHTML = (x._fotos ? fotosCargadas(x) : "") + `<label class="check"><input type="checkbox" data-incluir ${x.incluir ? "checked" : ""}>
        <b>${esc(x.paciente || "Paciente " + (i + 1))}</b>${x.ausente ? ' <span class="chip vencida">ausente</span>' : ""}${x.estudio ? ' <span class="chip vencida">informe de estudio</span>' : ""}${x.repetida ? ' <span class="chip vencida">ya cargada</span>' : ""}${fechaDudosa(x) ? ' <span class="chip vencida">revisá la fecha</span>' : ""}</label>` +
        camposPrestacion(x, false);
    };
    pintar();
    div.addEventListener("change", (ev) => {
      if (ev.target.matches("[data-incluir]")) { filasRevision[i].incluir = ev.target.checked; div.classList.toggle("apagada", !ev.target.checked); }
      else if (ev.target.matches("[data-foto-clase]")) {
        // Un solo archivo por documento: si otra foto era ese documento, pasa a «solo datos»
        const x = leerCampos(div, filasRevision[i]), clase = ev.target.value, k = +ev.target.dataset.fotoClase, antes = x._fotos[k].clase;
        x._fotos = x._fotos.map((y, j) => (j === k ? { ...y, clase, reconocida: false } : clase && y.clase === clase ? { ...y, clase: "", reconocida: false } : y));
        if (clase) x[DOCS[clase].campo] = true;
        if (antes && !documentosDe(x)[antes]) x[DOCS[antes].campo] = false;
        filasRevision[i] = x; pintar();
      } else {
        filasRevision[i] = leerCampos(div, filasRevision[i]);
        if (ev.target.name === "fecha") filasRevision[i].fecha_leida = true;
      }
    }, true);
    enlazarEstimacion(div, () => leerCampos(div, filasRevision[i]), (p) => { filasRevision[i] = { ...filasRevision[i], ...p }; pintar(); });
    cont.appendChild(div);
  });
}

// Anestesiología: cada foto leída con lo que es (reconocido o elegido); se guarda en su carpeta del Drive al tocar Guardar
function fotosCargadas(x) {
  const opciones = { "": "Solo datos del paciente (no se guarda)", ...Object.fromEntries(Object.entries(DOCS).map(([k, d]) => [k, d.nombre])) };
  return `<div class="ancho" style="margin-bottom:8px"><div class="ayuda" style="margin:0 0 4px"><b>Fotos cargadas</b> · la mejor para cada documento se guarda en PDF en tu Drive (una sola por documento)</div>
    ${x._fotos.map((f, k) => `<div class="fila" style="margin:0 0 4px;flex-wrap:nowrap;align-items:center">
      ${f.archivo.type?.startsWith("image/") ? `<img src="${URL.createObjectURL(f.archivo)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:6px">` : "<span>📄</span>"}
      <select data-foto-clase="${k}">${Object.entries(opciones).map(([v, t]) => `<option value="${v}" ${v === f.clase ? "selected" : ""}>${t}</option>`).join("")}</select>
      ${f.reconocida ? '<span class="ayuda" style="margin:0">reconocida</span>' : ""}</div>`).join("")}</div>`;
}
// Archivos por guardar de una prestación: los adjuntados con el botón de cada documento y las fotos leídas con su clase
const documentosDe = (f) => {
  const docs = Object.fromEntries(Object.entries(f._docs || {}).map(([k, v]) => [k, [...v]]));
  for (const x of f._fotos || []) (docs[x.clase || "datos"] ||= []).push(x.archivo);
  return docs;
};

// Fecha no leída (se puso la de hoy) o de hace más de un año: casi siempre es otra fecha del documento
const fechaDudosa = (x) => !x.fecha_leida || Math.abs(Date.now() - Date.parse(x.fecha)) > 366 * 864e5;

function cerrarRevision() { ultimaLectura = null; planillaLeida = null; $("#agregar-foto").hidden = true; conciliacion = null; $("#guardar-lote").textContent = "Guardar"; $("#revision").hidden = true; $("#cargar-botones").hidden = false; filasRevision = []; }

// Documentos del paciente → Drive («Liquidaciones/<Rama>/Pacientes/<año>/<carpeta del paciente>»), ligados a la prestación.
// Quedan cifrados en el celular y se suben en la sincronización (también si al guardar no había señal o el acceso de Google
// estaba vencido). Devuelve cuántos archivos quedaron por subir.
const limpioDrive = (t) => String(t || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
// Carpeta del paciente: «2026-10-21 – GOMEZ, ANA MARIA – Colecistectomía» (cirugía) o «… – Ref 0012 – Circuito 4521» (anestesia)
const nombreCarpeta = (p) => [p.fecha, limpioDrive(p.paciente) || "paciente",
  p.especialidad === "anestesia" ? [p.nro_ref && "Ref " + refTexto(p), p.nro_circuito && "Circuito " + limpioDrive(p.nro_circuito)].filter(Boolean).join(" – ")
    : limpioDrive(p.procedimiento).slice(0, 50)].filter(Boolean).join(" – ");
// «2026-10-21 – GOMEZ, ANA MARIA – Foja quirúrgica.pdf» (en anestesia también la Ref, para buscarla rápido)
function nombreDocumento(p, x, n, ext) {
  return [p.fecha, limpioDrive(p.paciente) || "paciente", p.especialidad === "anestesia" && p.nro_ref && "Ref " + refTexto(p), x.archivo]
    .filter(Boolean).join(" – ") + (n ? ` (${n})` : "") + ext;
}
// Lo que el buscador del Drive encuentra en cada documento (además del nombre)
const descripcionDrive = (p) => [p.paciente, p.dni && "DNI " + p.dni, p.obra_social || p.obra_social_texto, p.afiliado && "Afiliado " + p.afiliado,
  p.procedimiento, p.nro_ref && "Ref " + refTexto(p), p.nro_circuito && "Circuito " + p.nro_circuito, p.fecha].filter(Boolean).join(" · ");
// Si cambian el paciente, la fecha o el n° de circuito, los documentos ya subidos se renombran en el Drive
async function renombrarDocumentos(p) {
  let n = 0;
  for (const x of Object.values(DOC_TODOS())) {
    const lista = p[x.lista] || [];
    for (const [i, a] of lista.entries()) {
      const ext = (a.nombre.match(/(?: \(\d+\))?(\.[a-z0-9]+)$/i) || [, ""])[1];
      const nuevo = nombreDocumento(p, x, lista.length > 1 ? i + 1 : 0, ext);
      if (a.id && nuevo !== a.nombre) { await Almacen.encolarRenombre(p.id, x.lista, a.id, nuevo); n++; }
    }
  }
  if (p.carpeta_docs?.id && p.carpeta_docs.nombre !== nombreCarpeta(p)) { await Almacen.encolarRenombre(p.id, "carpeta_docs", p.carpeta_docs.id, nombreCarpeta(p)); n++; }
  if (n && Almacen.tieneToken()) Almacen.sincronizar().then(refrescar).catch(() => {});
}
// Los documentos subidos antes (en «Fojas» / «Autorizaciones») pasan a la carpeta de su paciente, sin borrar nada. Una vez.
let carpetasMigradas = false;
async function migrarCarpetas() {
  if (carpetasMigradas) return;
  carpetasMigradas = true;
  for (const p of Almacen.doc.prestaciones) {
    if (p.borrada || p.carpeta_docs?.id || p.especialidad !== "anestesia") continue;
    for (const x of Object.values(DOCS)) for (const a of p[x.lista] || []) if (a.id) await Almacen.encolarMover(p.id, a.id, rutaPaciente(p), nombreCarpeta(p));
  }
}
// v59: las carpetas de pacientes de «Anestesiología/Documentos» pasan a «Anestesiología/Pacientes/<año>» con el nombre
// nuevo (empieza con la fecha), y sus documentos se renombran. Nada se borra. Una vez.
async function ordenarDrive() {
  if (ajuste("drive_ordenado_v59", false) || !Almacen.doc.cuenta) return;
  for (const p of Almacen.doc.prestaciones) {
    if (p.borrada || !p.carpeta_docs?.id) continue;
    await Almacen.encolarMover(p.id, p.carpeta_docs.id, rutaPaciente(p), null, { aRuta: true });
    await renombrarDocumentos(p);
  }
  await Almacen.ajuste("drive_ordenado_v59", true);
}
async function guardarDocumentos(p, docs) {
  let n = 0;
  for (const [clase, archivos] of Object.entries(docs || {})) {
    const x = DOC_TODOS()[clase];
    if (!x || !archivos.length) continue;
    // Siempre un solo PDF por documento (las fotos y páginas juntas); reemplaza al que hubiera en el Drive
    const pdf = await aPDF(archivos);
    const ext = pdf.type === "application/pdf" ? ".pdf" : (pdf.name.match(/\.[a-z0-9]+$/i) || [".jpg"])[0];
    await Almacen.encolarAdjunto(p.id, nombreDocumento(p, x, 0, ext), pdf, rutaPaciente(p), { campo: x.campo, lista: x.lista, reemplaza: true,
      subcarpeta: nombreCarpeta(p), descripcion: descripcionDrive(p) });
    n++;
  }
  if (n) informarSubida();
  return n;
}
// Lo que no es de un paciente: el listado de consultas del día (fotos → un PDF) y la planilla Excel cargada
async function guardarArchivosDeCarga(fecha) {
  let n = 0;
  if (ultimaLectura?.tipo === "listado" && ultimaLectura.archivos?.length) {
    const pdf = await aPDF(ultimaLectura.archivos);
    await Almacen.encolarAdjunto(null, `${fecha} – Listado de consultas${pdf.type === "application/pdf" ? ".pdf" : ".jpg"}`, pdf,
      [RAMA_DRIVE(), "Listados de consultas", fecha.slice(0, 4)], { descripcion: `Listado de consultas del ${fechaCorta(fecha)}` });
    n++;
  }
  for (const a of planillaLeida || []) {
    await Almacen.encolarAdjunto(null, `${hoy()} – ${limpioDrive(a.name)}`, a, [RAMA_DRIVE(), "Planillas cargadas"], { descripcion: `Planilla cargada el ${fechaCorta(hoy())}` });
    n++;
  }
  if (n) informarSubida();
  return n;
}
// El PDF de la liquidación: «<Rama>/Liquidaciones cobradas/<año>/2025-08-28 – Liquidación L 0000-00168460 – $2.410.143.pdf»
async function guardarPDFsLiquidacion(liq, porArchivo = []) {
  const guardados = ajuste("liq_archivos", {}), hechos = new Set();
  let n = 0;
  for (const { archivo, liq: l } of porArchivo) {
    const lista = (l.liquidaciones || []).filter((x) => x.numero);
    const nums = lista.map((x) => Lector.numeroLiq(x.numero) || x.numero);
    const clave = nums.slice().sort().join(",");
    // Sin número, o el mismo PDF dos veces, o ya guardado antes: no se vuelve a subir
    if (!nums.length || hechos.has(clave) || nums.every((x) => guardados[x])) continue;
    hechos.add(clave);
    const emision = lista.map((x) => x.emision).filter(Boolean).sort().pop() || hoy();
    const nombre = `${emision} – ${nums.length > 1 ? "Liquidaciones " : "Liquidación "}${limpioDrive(nums.join(", "))} – ${pesos(lista.reduce((t, x) => t + (x.total || 0), 0))}`;
    const pdf = archivo.type === "application/pdf" ? archivo : await aPDF([archivo]);
    await Almacen.encolarAdjunto(null, nombre + (pdf.type === "application/pdf" ? ".pdf" : ".jpg"), pdf, [RAMA_DRIVE(), "Liquidaciones cobradas", emision.slice(0, 4)],
      { descripcion: [liq.empresa, ...nums.map((x) => "Liquidación " + x), "emitida " + fechaCorta(emision)].filter(Boolean).join(" · "), liquidaciones: nums });
    n++;
  }
  if (n) informarSubida();
}

// ---------- PDF ----------
// Fotos (y páginas de PDF) → un PDF con una página por imagen (JPEG dentro del PDF, sin librerías). Un único PDF se deja
// como está. Si una foto no se puede abrir (formato raro), se guarda el archivo original para no perderlo.
async function aPDF(archivos) {
  if (archivos.length === 1 && archivos[0].type === "application/pdf") return archivos[0];
  const imagenes = [];
  try {
    for (const a of archivos) {
      const lienzos = a.type === "application/pdf" ? await Lector.lienzosPDF(a) : [await lienzoDeImagen(a)];
      for (const c of lienzos) {
        const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
        imagenes.push({ ancho: c.width, alto: c.height, datos: new Uint8Array(await blob.arrayBuffer()) });
      }
    }
  } catch { return archivos[0]; }
  return new File([pdfDeImagenes(imagenes)], "documento.pdf", { type: "application/pdf" });
}
async function lienzoDeImagen(archivo, maximo = 2400) {
  const img = await createImageBitmap(archivo, { imageOrientation: "from-image" });
  const k = Math.min(1, maximo / Math.max(img.width, img.height)), c = document.createElement("canvas");
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
function pdfDeImagenes(imagenes) {
  const enc = new TextEncoder(), partes = [], desde = [];
  let largo = 0;
  const poner = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; partes.push(b); largo += b.length; };
  const objeto = (n, ...cuerpo) => { desde[n] = largo; poner(`${n} 0 obj\n`); cuerpo.forEach(poner); poner("\nendobj\n"); };
  const total = 2 + 3 * imagenes.length;
  poner("%PDF-1.4\n");
  objeto(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objeto(2, `<< /Type /Pages /Count ${imagenes.length} /Kids [${imagenes.map((_, i) => `${3 + 3 * i} 0 R`).join(" ")}] >>`);
  imagenes.forEach((im, i) => {
    const pag = 3 + 3 * i, ancho = 595, alto = Math.round(595 * im.alto / im.ancho), dibujo = `q ${ancho} 0 0 ${alto} 0 0 cm /Im0 Do Q`;
    objeto(pag, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ancho} ${alto}] /Resources << /XObject << /Im0 ${pag + 2} 0 R >> >> /Contents ${pag + 1} 0 R >>`);
    objeto(pag + 1, `<< /Length ${dibujo.length} >>\nstream\n${dibujo}\nendstream`);
    objeto(pag + 2, `<< /Type /XObject /Subtype /Image /Width ${im.ancho} /Height ${im.alto} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.datos.length} >>\nstream\n`,
      im.datos, "\nendstream");
  });
  const xref = largo;
  poner(`xref\n0 ${total + 1}\n0000000000 65535 f \n` + desde.slice(1).map((d) => String(d).padStart(10, "0") + " 00000 n \n").join(""));
  poner(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(partes, { type: "application/pdf" });
}

// Después de guardar documentos: sube y dice claramente si llegaron al Drive o por qué no (quedan en el celular)
async function informarSubida() {
  if (!Almacen.doc.cuenta) return; // sin Google Drive conectado: quedan en el celular hasta conectarlo
  await new Promise((ok) => setTimeout(ok, 600)); // que se cierre la revisión o la ficha
  if (!Almacen.tieneToken()) {
    // Acceso de Google vencido: se renueva solo (va y vuelve enseguida) y al volver se suben
    if (renovarAcceso()) return;
    return setTimeout(() => aviso("Los documentos quedaron guardados en el celular. Para subirlos al Drive, tocá «Subir a Drive» arriba (se venció el acceso de Google)."), 3000);
  }
  try { await Almacen.sincronizar(); } catch {}
  refrescar();
  const quedan = await Almacen.adjuntosPendientes();
  aviso(quedan ? `No se pudo subir ${quedan === 1 ? "1 documento" : quedan + " documentos"} al Drive: ${Almacen.errorAdjuntos || Almacen.estado}. Quedan en el celular y se reintenta solo.`
    : `✓ Documentos subidos a tu Drive (Liquidaciones › ${RAMA_DRIVE()})`);
}

async function guardarLote() {
  if (conciliacion) return aplicarLiquidacion().catch((e) => aviso(e.message)).finally(() => ($("#guardar-lote").disabled = false));
  const elegidas = filasRevision.filter((f) => f.incluir);
  if (!elegidas.length) return aviso("No hay nada tildado.");
  const incompleta = elegidas.find((f) => faltantes(f).length && f.origen !== "planilla");
  if (incompleta) return aviso(`${incompleta.paciente || "Un paciente"}: falta ${faltantes(incompleta).join(", ")}`);
  const errores = [], fallidas = [];
  const existentes = datos().prestaciones;
  const repetidas = [], completadas = [], guardadas = [];
  let n = 0, fojas = 0;
  try {
    for (const f of elegidas) try {
      const mismo = (p) => p.fecha === f.fecha && (p.paciente || "").trim().toLowerCase() === (f.paciente || "").trim().toLowerCase();
      const ya = existentes.find((p) => mismo(p) && p.tipo === f.tipo && (p.procedimiento || "") === (f.procedimiento || "")) ||
        cirugiaRepetida(f, guardadas);
      const docs = documentosDe(f);
      if (ya || (Object.keys(docs).some((c) => DOCS[c]) && esAnestesia())) {
        // Ya cargado: no se duplica, pero las fotos de los documentos se agregan a ese paciente (antes se descartaban)
        const existente = ya || existentes.find((p) => mismo(p) && p.especialidad === "anestesia");
        if (existente && Object.keys(docs).length) {
          const marcas = Object.fromEntries(Object.keys(docs).filter((c) => DOCS[c]).map((c) => [DOCS[c].campo, true]));
          const guardada = await guardarPrestacion({ ...existente, ...marcas });
          fojas += await guardarDocumentos(guardada, docs);
          completadas.push(f.paciente);
          continue;
        }
        if (ya) { repetidas.push(f.paciente); continue; }
      }
      const guardada = await guardarPrestacion({ ...f, fecha_presentacion: null, id: undefined });
      guardadas.push(guardada);
      fojas += await guardarDocumentos(guardada, documentosDe(f));
      n++;
    } catch (e) {
      if (f.origen !== "planilla") throw e;
      errores.push(`${f.paciente || "Sin nombre"}: ${e.message}`); fallidas.push(f);
    }
    const mesGuardado = elegidas[0].fecha.slice(0, 7);
    if (errores.length) {
      // Nada se pierde: lo que no se pudo guardar queda en la revisión para corregirlo
      mostrarRevision(fallidas, "No se guardaron");
      return aviso(`Guardadas ${n}${repetidas.length ? ` · ya estaban ${repetidas.length}` : ""}. No se guardaron ${errores.length}: ${errores.slice(0, 3).join(" · ")}` +
        (errores.length > 3 ? "…" : "") + " Corregilas abajo y tocá Guardar.");
    }
    fojas += await guardarArchivosDeCarga(elegidas[0].fecha);
    const lista = (l) => (l.length > 5 ? `${l.slice(0, 5).join(", ")} y ${l.length - 5} más` : l.join(", "));
    aviso(`Guardadas ${n} en ${nombreMes(mesGuardado)}` + (repetidas.length ? ` · ya estaban: ${lista(repetidas)}` : "") +
      (completadas.length ? ` · documentos agregados a ${completadas.join(", ")}` : "") +
      (fojas ? ` · ${fojas} ${fojas === 1 ? "documento" : "documentos"} subiendo a tu Drive…` : ""));
    cerrarRevision();
    $("#mes").value = mesGuardado;
    ir("prestaciones");
  } catch (e) { aviso(e.message); }
}

// ---------- Cámara: varias fotos seguidas ----------
// La cámara del celular (por el selector de archivos) saca una sola foto por vez. Esta saca las que hagan falta y al tocar
// «Listo» las entrega al mismo botón que se usaba (como si se hubieran elegido juntas). Sin permiso de cámara: el selector.
async function camaraVarias(input) {
  let flujo;
  try {
    flujo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 } }, audio: false });
  } catch {
    aviso("No se pudo abrir la cámara: elegí las fotos (mantené apretada la primera para elegir varias).");
    return input.click();
  }
  const fotos = [], dlg = document.createElement("dialog");
  dlg.className = "camara";
  dlg.innerHTML = `<video autoplay playsinline muted></video>
    <div class="camara-fotos"></div>
    <div class="fila camara-botones"><button type="button" class="boton secundario" data-cancelar>Cancelar</button>
      <button type="button" class="disparo" data-sacar aria-label="Sacar foto"></button>
      <button type="button" class="boton" data-listo disabled>Listo (0)</button></div>`;
  document.body.appendChild(dlg);
  const video = dlg.querySelector("video");
  video.srcObject = flujo;
  const cerrar = () => { flujo.getTracks().forEach((t) => t.stop()); dlg.close(); dlg.remove(); };
  const sacar = async () => {
    let blob = null;
    try { if (window.ImageCapture) blob = await new ImageCapture(flujo.getVideoTracks()[0]).takePhoto(); } catch {}
    if (!blob) {
      const c = document.createElement("canvas");
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext("2d").drawImage(video, 0, 0);
      blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.92));
    }
    if (!blob) return;
    const f = new File([blob], `foto-${Date.now()}-${fotos.length + 1}.jpg`, { type: "image/jpeg" });
    fotos.push(f);
    dlg.querySelector(".camara-fotos").insertAdjacentHTML("beforeend", `<img src="${URL.createObjectURL(f)}" alt="Foto ${fotos.length}">`);
    const listo = dlg.querySelector("[data-listo]");
    listo.disabled = false; listo.textContent = `Listo (${fotos.length})`;
    video.classList.add("flash"); setTimeout(() => video.classList.remove("flash"), 150);
  };
  dlg.onclick = (ev) => {
    if (ev.target.closest("[data-cancelar]")) cerrar();
    else if (ev.target.closest("[data-sacar]")) sacar().catch((e) => aviso(e.message));
    else if (ev.target.closest("[data-listo]") && fotos.length) {
      cerrar();
      const dt = new DataTransfer();
      fotos.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  dlg.addEventListener("cancel", cerrar);
  dlg.showModal();
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-camara]");
  if (!b) return;
  const input = b.parentElement.querySelector(b.dataset.camara) || document.querySelector(b.dataset.camara);
  if (input) camaraVarias(input);
});

// ---------- Editar en diálogo ----------

function editar(p) {
  const dlg = $("#dlg"), cuerpo = $("#dlg-cuerpo");
  let actual = { ...p };
  // Anestesia: al abrir ya se sugiere la complejidad y se calcula el valor
  if (esAnestesia()) actual = { ...actual, ...Motor.estimar(datos(), { ...actual, fecha: actual.fecha || hoy() }) };
  else if (actual.tipo !== "consulta" && !actual.sugerencias) actual.sugerencias = Motor.sugerencias(actual);
  const pintar = () => {
    cuerpo.innerHTML = `<h2>${p.id ? "Prestación" : esAnestesia() ? TIPOS[p.tipo] : "Nueva " + TIPOS[p.tipo].toLowerCase()}</h2>` + camposPrestacion(actual, true) +
      `<div class="fila"><button class="boton" data-ok>Guardar</button><button class="boton secundario" data-cerrar>Cerrar</button>
       ${p.id ? '<button class="boton peligro chico" data-borrar>Borrar</button>' : ""}</div>`;
  };
  pintar();
  cuerpo.onclick = async (ev) => {
    if (ev.target.matches("[data-cerrar]")) dlg.close();
    if (ev.target.matches("[data-borrar]") && confirm("¿Borrar esta prestación?")) { await Almacen.borrar("prestaciones", p.id); dlg.close(); refrescar(); }
    if (ev.target.matches("[data-ok]")) {
      const datosForm = leerCampos(cuerpo, actual), f = faltantes(datosForm);
      if (f.length) return aviso("Falta completar: " + f.join(", "));
      const rep = !p.id && cirugiaRepetida(datosForm); // solo al cargar una nueva (editar una existente no se frena)
      if (rep) return aviso(`Ya está cargada la cirugía de ${rep.paciente} del ${fechaCorta(rep.fecha)} (${rep.procedimiento || "sin procedimiento"}). Si fue otro procedimiento en el mismo acto, agregalo en esa ficha.`);
      try {
        // Si mientras estaba abierta cambió (llegó un cobro, se sincronizó), se aplica solo lo que se editó en la ficha
        const ahora = p.id && Almacen.doc.prestaciones.find((x) => x.id === p.id);
        let aGuardar = datosForm;
        if (ahora && p.actualizado && ahora.actualizado !== p.actualizado) {
          const cambio = (k) => JSON.stringify(datosForm[k] ?? null) !== JSON.stringify(p[k] ?? null);
          aGuardar = { ...ahora, _docs: datosForm._docs };
          for (const k of CAMPOS) if (cambio(k)) aGuardar[k] = datosForm[k];
        }
        const guardada = await guardarPrestacion(aGuardar);
        if (p.id) await renombrarDocumentos(guardada);
        const n = await guardarDocumentos(guardada, datosForm._docs);
        dlg.close(); aviso(n ? `Guardado · los documentos van a tu Drive › Liquidaciones › ${RAMA_DRIVE()} › Pacientes` : "Guardado"); refrescar();
      }
      catch (e) { aviso(e.message); }
    }
  };
  if (!cuerpo.dataset.enlazado) {
    cuerpo.dataset.enlazado = "1";
    enlazarEstimacion(cuerpo, () => (cuerpo._actual ? leerCampos(cuerpo, cuerpo._actual()) : null), (n) => cuerpo._guardar(n));
  }
  cuerpo._actual = () => actual;
  cuerpo._guardar = (n) => { actual = { ...actual, ...n }; pintar(); };
  dlg.showModal();
}

// ---------- Prestaciones ----------

function verPrestaciones() {
  const os = $("#f-os").value, est = $("#f-estado").value, tipo = $("#f-tipo").value, q = Motor.plano($("#f-q").value), h = hoy();
  let lista = datos().prestaciones;
  const periodo = $("#f-periodo").value, desde = $("#f-desde").value, hasta = $("#f-hasta").value;
  $("#f-desde-l").hidden = !["dia", "rango"].includes(periodo); $("#f-hasta-l").hidden = periodo !== "rango";
  $("#f-desde-t").textContent = periodo === "dia" ? "Día" : "Desde";
  $("#mes").classList.toggle("apagado", estado.vista === "prestaciones" && periodo !== "mes");
  if (periodo === "mes") lista = lista.filter((p) => p.fecha.slice(0, 7) === mes());
  else if (periodo === "dia") lista = desde ? lista.filter((p) => p.fecha === desde) : lista;
  else if (periodo === "rango") lista = lista.filter((p) => (!desde || p.fecha >= desde) && (!hasta || p.fecha <= hasta));
  if (tipo === "procedimientos") lista = lista.filter((p) => p.tipo !== "consulta"); else if (tipo) lista = lista.filter((p) => p.tipo === tipo);
  if (os === "-") lista = lista.filter((p) => !p.obra_social); else if (os) lista = lista.filter((p) => p.obra_social === os);
  if (est === "vencida") lista = lista.filter((p) => Motor.vencida(p, h));
  else if (est === "a_cobrar") lista = lista.filter((p) => ["pendiente", "presentada"].includes(p.estado));
  else if (est === "revisar") lista = lista.filter((p) => p.revisar_cobro);
  else if (est === "falta_doc") lista = lista.filter((p) => p.estado === "pendiente" && docFaltante(p).length);
  else if (est === "para_cargar") lista = lista.filter((p) => p.estado === "pendiente" && !docFaltante(p).length);
  else if (est) lista = lista.filter((p) => p.estado === est);
  if (q) lista = lista.filter((p) => Motor.plano([p.paciente, p.dni, p.procedimiento, refTexto(p), p.nro_ref, p.nro_circuito].join(" ")).includes(q));
  lista.sort((a, b) => (b.fecha + (b.hora || "")).localeCompare(a.fecha + (a.hora || "")));
  estado.seleccion.clear(); actualizarSeleccion();
  const total = lista.reduce((s, p) => s + (p.valor_estimado || 0), 0);
  $("#lista").innerHTML = lista.length ? `<p class="ayuda">${lista.length} ${tipo === "consulta" ? "consultas" : tipo ? "procedimientos" : "prestaciones"}<span class="economia"> · ${pesos(total)} estimado · tildá para marcar varias</span></p>` +
    lista.map((p) => {
      const chip = (p.revisar_cobro ? '<span class="chip vencida">revisar</span><br>' : "") + (p.solo_registro && !["cobrada", "debitada"].includes(p.estado) ? '<span class="chip">registro</span>' :
        Motor.vencida(p, h) ? '<span class="chip vencida">vencida</span>' : `<span class="chip ${p.estado}">${ESTADOS[p.estado]}</span>`) +
        (esAnestesia() && p.estado === "pendiente" && docFaltante(p).length ? `<br><span class="chip vencida">falta ${docFaltante(p).join(", ")}</span>` : "");
      const detalle = p.tipo === "consulta" ? TIPOS.consulta : procedimientosDe(p) + (esAnestesia() ? (p.complejidad ? ` · compl. ${p.complejidad}` : "") :
        (p.rol === "ayudante" ? " (ayudante)" : "") + (p.codigo_aac ? " · " + codigosDe(p, "codigo_aac") : ""));
      return `<div class="item" data-id="${p.id}"><input type="checkbox" data-sel="${p.id}" class="economia">
        <div class="cuerpo"><div class="titulo">${esc(p.paciente)}</div>
        <div class="sub">${esAnestesia() && p.nro_ref ? `Ref. ${refTexto(p)} · ` : ""}${p.carpeta_docs?.link ? `<a href="${esc(p.carpeta_docs.link)}" target="_blank" rel="noopener">📁 documentos</a> · ` : ""}${fechaCorta(p.fecha)} · ${esc(p.obra_social || p.obra_social_texto || "¿obra social?")} · ${esc(detalle)}</div></div>
        <div class="monto economia">${pesos(p.monto_cobrado ?? p.valor_estimado)}<br>${chip}</div></div>`;
    }).join("") : '<p class="ayuda">Nada para mostrar con estos filtros.</p>';
}

function actualizarSeleccion() {
  $("#acciones-sel").hidden = !estado.seleccion.size;
  $("#n-sel").textContent = estado.seleccion.size + " elegidas";
}

async function marcar(nuevo) {
  let fecha = hoy();
  if (nuevo !== "pendiente") {
    const escrita = prompt(`Fecha ${nuevo === "cobrada" ? "de cobro" : "de presentación"} (día/mes/año):`, fechaCorta(hoy()).replace(/\/(\d\d)$/, "/20$1"));
    if (!escrita) return;
    fecha = fechaDeTexto(escrita);
    if (!fecha) return aviso(`«${escrita}» no es una fecha válida. Escribila como día/mes/año, por ejemplo 21/10/2026.`);
  }
  const porId = new Map(datos().prestaciones.map((p) => [p.id, p]));
  for (const id of estado.seleccion) {
    const p = { ...porId.get(id), estado: nuevo };
    if (nuevo === "presentada") p.fecha_presentacion = fecha;
    else if (nuevo === "cobrada") { p.fecha_cobro = fecha; p.monto_cobrado ??= p.valor_estimado; }
    else Object.assign(p, { fecha_presentacion: null, fecha_cobro: null, monto_cobrado: null });
    await guardarPrestacion(p);
  }
  aviso(`${estado.seleccion.size} marcadas como ${ESTADOS[nuevo].toLowerCase()}` + (nuevo === "cobrada" ? " (con el valor estimado; editá el monto si cobraste otro)" : ""));
  verPrestaciones();
}

// ---------- Cobros ----------

function verCobros() {
  const d = datos(), r = Motor.cobros(d, hoy()), plazos = Motor.plazosReales(d);
  $("#flujo").innerHTML = r.meses.length ? `<table><tr><th>Mes</th><th class="n">#</th><th class="n">Total</th></tr>` +
    r.meses.map((m) => `<tr><td><b style="${m.mes === "vencido" ? "color:var(--rojo)" : ""}">${nombreMes(m.mes)}</b>
      <div class="ayuda" style="margin:2px 0 0">${m.obras_sociales.slice(0, 4).map(([o, v]) => esc(o) + " " + pesos(v)).join(" · ")}</div></td>
      <td class="n">${m.n}</td><td class="n">${pesos(m.total)}</td></tr>`).join("") + "</table>" : '<p class="ayuda">No hay nada pendiente de cobro.</p>';
  $("#a-presentar").innerHTML = r.a_presentar.length ? `<table><tr><th>Obra social</th><th>Hasta</th><th class="n">#</th><th class="n">Total</th></tr>` +
    r.a_presentar.map((o) => `<tr><td>${esc(o.obra_social)}</td><td>${fechaCorta(o.fecha)}</td><td class="n">${o.n}</td><td class="n">${pesos(o.total)}</td></tr>`).join("") + "</table>"
    : '<p class="ayuda">Nada pendiente de presentar.</p>';
  $("#vencidas").innerHTML = r.vencidas.length ? r.vencidas.map((p) => `<div class="item" data-id="${p.id}"><div class="cuerpo">
      <div class="titulo">${esc(p.paciente)}</div><div class="sub">${esc(p.obra_social || "")} · ${fechaCorta(p.fecha)} · ${p.dias_atraso} días de atraso</div></div>
      <div class="monto">${pesos(p.valor_estimado)}</div></div>`).join("") : '<p class="ayuda">Nada vencido. 👌</p>';
  verHistorialLiquidaciones();
  $("#plazos-reales").innerHTML = plazos.length ? `<table><tr><th>Obra social</th><th class="n">Cobros</th><th class="n">Días</th><th class="n">Cobrado / estimado</th></tr>` +
    plazos.map((o) => `<tr><td>${esc(o.obra_social)}</td><td class="n">${o.n}</td><td class="n">${o.dias}</td><td class="n">${o.cobrado_vs_estimado ?? "—"} %</td></tr>`).join("") + "</table>"
    : '<p class="ayuda">Todavía no hay cobros registrados.</p>';
}

// Historial de lo cobrado, por liquidación (número guardado o anotado en las notas «Liq. N»); lo marcado cobrado a mano,
// por mes de cobro
const numeroLiquidacion = (p) => Lector.numeroLiq(p.liquidacion) || Lector.numeroLiq((p.notas || "").match(/\bLiq\. ([^·()]+)/)?.[1]) || p.liquidacion ||
  (p.notas || "").match(/\bLiq\. ([^\s·()]+)/)?.[1] || "";
const cobradas = () => datos().prestaciones.filter((p) => ["cobrada", "debitada"].includes(p.estado) && p.fecha_cobro);

function verHistorialLiquidaciones() {
  const todas = cobradas();
  const anios = [...new Set(todas.map((p) => p.fecha_cobro.slice(0, 4)))].sort().reverse();
  const sel = $("#liq-anio"), antes = sel.value;
  sel.innerHTML = anios.map((a) => `<option>${a}</option>`).join("") + (anios.length > 1 ? '<option value="">Todos</option>' : "");
  if (antes !== undefined && [...sel.options].some((o) => o.value === antes)) sel.value = antes;
  const anio = sel.value, lista = todas.filter((p) => !anio || p.fecha_cobro.startsWith(anio));
  if ($("#liq-vista").value === "mes") return verCobradoPorMes(lista);
  const grupos = {};
  for (const p of lista) {
    const n = numeroLiquidacion(p), k = n ? "L" + n : "M" + p.fecha_cobro.slice(0, 7);
    (grupos[k] ||= { numero: n, mes: p.fecha_cobro.slice(0, 7), fecha: p.fecha_cobro, ps: [] }).ps.push(p);
    if (p.fecha_cobro > grupos[k].fecha) grupos[k].fecha = p.fecha_cobro;
  }
  const filas = Object.values(grupos).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const total = (ps, k) => ps.reduce((s, p) => s + (p[k] || 0), 0);
  $("#historial-liq").innerHTML = filas.length ? `<p class="ayuda">${lista.length} cobradas · ${pesos(total(lista, "monto_cobrado"))}</p>` + filas.map((g) => {
    const cob = total(g.ps, "monto_cobrado"), est = total(g.ps, "valor_estimado"), dif = est ? Math.round(100 * (cob - est) / est) : null;
    const posteriores = g.ps.filter((p) => p.fecha > g.fecha).length;
    return `<details class="liq"><summary><div><b>${g.numero ? "Liquidación " + esc(g.numero) : "Cobradas a mano · " + nombreMes(g.mes)}</b>
        <div class="ayuda" style="margin:0">${g.numero && ajuste("liq_archivos", {})[g.numero] ? `<a href="${esc(ajuste("liq_archivos", {})[g.numero].link)}" target="_blank" rel="noopener">📄 PDF</a> · ` : ""}${fechaCorta(g.fecha)} · ${g.ps.length} ${g.ps.length === 1 ? "prestación" : "prestaciones"}${dif != null ? ` · ${dif >= 0 ? "+" : ""}${dif} % vs. estimado` : ""}</div></div>
        <div class="monto"><b>${pesos(cob)}</b></div></summary>
      ${posteriores ? `<p class="alerta" style="margin:6px 0">⚠️ La fecha de cobro (${fechaCorta(g.fecha)}) es anterior a ${posteriores} de sus prestaciones: seguramente se cargó con otra fecha.
        <button class="boton chico secundario" data-cambiar-cobro="${g.ps.map((p) => p.id).join(",")}">Corregir la fecha de cobro</button></p>` : ""}
      <table><tr><th>Paciente</th><th class="n">Cobrado</th><th class="n">Estimado</th></tr>${g.ps.sort((a, b) => a.fecha.localeCompare(b.fecha)).map((p) => `<tr data-id="${p.id}" style="cursor:pointer">
        <td>${esc(p.paciente)}<div class="ayuda" style="margin:0">${fechaCorta(p.fecha)} · ${esc(p.obra_social || p.obra_social_texto || "")} · ${esc(p.tipo === "consulta" ? "Consulta" : procedimientosDe(p))}${p.estado === "debitada" ? " · <b>debitada</b>" : ""}</div></td>
        <td class="n">${pesos(p.monto_cobrado)}</td><td class="n">${pesos(p.valor_estimado)}</td></tr>`).join("")}</table></details>`;
  }).join("") : '<p class="ayuda">Todavía no hay cobros registrados. Cargá el PDF de la liquidación desde «Cargar».</p>';
}

// Lo cobrado por mes (por la fecha de cobro): total del mes y, adentro, cada liquidación con sus pacientes
function verCobradoPorMes(lista) {
  const meses = {};
  for (const p of lista) (meses[p.fecha_cobro.slice(0, 7)] ||= []).push(p);
  const suma = (ps) => ps.reduce((s, p) => s + (p.monto_cobrado || 0), 0);
  $("#historial-liq").innerHTML = `<p class="ayuda">${lista.length} cobradas · ${pesos(suma(lista))}</p>` + Object.entries(meses).sort((a, b) => b[0].localeCompare(a[0])).map(([m, ps]) => {
    const liqs = {};
    for (const p of ps) (liqs[numeroLiquidacion(p) || "Cobradas a mano"] ||= []).push(p);
    return `<details class="liq"><summary><div><b>${nombreMes(m)}</b><div class="ayuda" style="margin:0">${ps.length} ${ps.length === 1 ? "prestación" : "prestaciones"} · ${Object.keys(liqs).length} ${Object.keys(liqs).length === 1 ? "liquidación" : "liquidaciones"}</div></div>
      <div class="monto"><b>${pesos(suma(ps))}</b></div></summary>
      <table><tr><th>Liquidación</th><th class="n">#</th><th class="n">Cobrado</th></tr>${Object.entries(liqs).sort((a, b) => suma(b[1]) - suma(a[1])).map(([n, l]) =>
        `<tr><td>${esc(n)}<div class="ayuda" style="margin:0">${[...new Set(l.map((p) => p.paciente))].slice(0, 4).map(esc).join(" · ")}${l.length > 4 ? "…" : ""}</div></td><td class="n">${l.length}</td><td class="n">${pesos(suma(l))}</td></tr>`).join("")}</table></details>`;
  }).join("");
}

// ---------- Análisis: estadística y economía del año ----------

// Barras de una serie (cantidad o plata por mes); el valor de cada mes al tocarla o pasar el mouse
function barrasMes(meses, valores, formato) {
  const max = Math.max(1, ...valores), iMax = valores.indexOf(Math.max(...valores));
  const id = "b" + Math.random().toString(36).slice(2, 8);
  return `<div class="barras" id="${id}" role="img" aria-label="${meses.map((m, i) => nombreMes(m) + ": " + formato(valores[i])).join(", ")}">` +
    meses.map((m, i) => `<div class="b" data-txt="${esc(nombreMes(m) + ": " + formato(valores[i]))}" title="${esc(nombreMes(m) + ": " + formato(valores[i]))}">
      ${i === iMax && valores[i] ? `<small>${formato(valores[i])}</small>` : ""}<i style="height:${(100 * valores[i]) / max}%"></i></div>`).join("") +
    `</div><div class="ejes">${meses.map((m) => `<span>${MESES[+m.slice(5, 7) - 1].slice(0, 1).toUpperCase()}</span>`).join("")}</div><div class="barras-valor" id="${id}-v"></div>`;
}

function verAnalisis() {
  const d = datos(), todas = d.prestaciones, quir = (p) => p.tipo !== "consulta", anest = esAnestesia();
  const anios = [...new Set(todas.map((p) => p.fecha.slice(0, 4)).concat(cobradas().map((p) => p.fecha_cobro.slice(0, 4))))].sort().reverse();
  const sel = $("#an-anio"), antes = sel.value;
  sel.innerHTML = anios.map((a) => `<option>${a}</option>`).join("") || `<option>${hoy().slice(0, 4)}</option>`;
  if (antes && anios.includes(antes)) sel.value = antes;
  const anio = sel.value, previo = String(+anio - 1);
  const delAnio = (a) => todas.filter((p) => p.fecha.startsWith(a));
  const ps = delAnio(anio), cx = ps.filter(quir), cxPrev = delAnio(previo).filter(quir);
  const cobradasAnio = cobradas().filter((p) => p.fecha_cobro.startsWith(anio)), cobPrev = cobradas().filter((p) => p.fecha_cobro.startsWith(previo));
  const suma = (l, k) => l.reduce((s, p) => s + (p[k] || 0), 0);
  const conValor = ps.filter((p) => !p.solo_registro);
  const cobrado = suma(cobradasAnio, "monto_cobrado"), estimado = suma(conValor, "valor_estimado");
  const debitado = ps.filter((p) => p.estado === "debitada").reduce((s, p) => s + Math.max(0, (p.valor_estimado || 0) - (p.monto_cobrado || 0)), 0);
  const pagas = ps.filter((p) => ["cobrada", "debitada"].includes(p.estado) && p.monto_cobrado > 0 && p.valor_estimado > 0);
  const efectividad = suma(pagas, "valor_estimado") ? Math.round(100 * suma(pagas, "monto_cobrado") / suma(pagas, "valor_estimado")) : null;
  const dias = pagas.filter((p) => p.fecha_cobro).map((p) => (Date.parse(p.fecha_cobro) - Date.parse(p.fecha)) / 864e5);
  const variacion = (a, b) => (b ? `${a >= b ? "+" : ""}${Math.round((100 * (a - b)) / b)} % vs. ${previo}` : "");
  const kpi = (t, v, sub = "", clase = "") => `<div class="kpi ${clase}"><small>${t}</small><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const nombreQ = anest ? "Anestesias" : "Cirugías";
  $("#an-nota").textContent = ps.some((p) => p.solo_registro) ? "Las cargadas desde planillas cuentan en las cantidades, no en la plata." : "";
  $("#an-kpis").innerHTML = kpi(nombreQ, cx.length, variacion(cx.length, cxPrev.length)) +
    kpi(anest ? "Consultas preanestésicas" : "Consultas", ps.length - cx.length) +
    `<div class="economia" style="display:contents">` +
    kpi("Cobrado en el año", pesos(cobrado), [variacion(cobrado, suma(cobPrev, "monto_cobrado")),
      cobradasAnio.some((p) => p.revisar_cobro) ? `incluye ${pesos(suma(cobradasAnio.filter((p) => p.revisar_cobro), "monto_cobrado"))} para revisar` : ""].filter(Boolean).join(" · "), "verde") +
    kpi("Facturado estimado", pesos(estimado)) +
    kpi("Promedio cobrado por " + (anest ? "anestesia" : "cirugía"), pesos(cobradasAnio.filter(quir).length ? suma(cobradasAnio.filter(quir), "monto_cobrado") / cobradasAnio.filter(quir).length : null)) +
    kpi("Cobrado / estimado", efectividad != null ? efectividad + " %" : "—", "de lo ya cobrado") +
    kpi("Días hasta cobrar", dias.length ? Math.round(dias.reduce((a, b) => a + b, 0) / dias.length) : "—", "promedio") +
    kpi("Debitado", pesos(debitado), "", debitado ? "rojo" : "") + `</div>`;
  const meses = Array.from({ length: 12 }, (_, i) => `${anio}-${String(i + 1).padStart(2, "0")}`);
  $("#an-titulo-n").textContent = nombreQ + " por mes";
  $("#an-n-mes").innerHTML = barrasMes(meses, meses.map((m) => cx.filter((p) => p.fecha.startsWith(m)).length), (n) => String(n));
  const liqAnio = [...new Set(cobradasAnio.map(numeroLiquidacion).filter(Boolean))];
  $("#an-cobrado-mes").innerHTML = barrasMes(meses, meses.map((m) => suma(cobradasAnio.filter((p) => p.fecha_cobro.startsWith(m)), "monto_cobrado")), pesos) +
    `<p class="ayuda" style="margin-top:6px">${cobradasAnio.length ? `${liqAnio.length} ${liqAnio.length === 1 ? "liquidación cargada" : "liquidaciones cargadas"} con cobro en ${anio}` +
      (cobradasAnio.some((p) => !numeroLiquidacion(p)) ? " y cobros marcados a mano" : "") + ". El detalle está en Cobros → «Liquidaciones cobradas»."
      : `No hay cobros con fecha en ${anio}. Para verlos acá, cargá el PDF de cada liquidación («Detalle Liquidación») desde Cargar → «Liquidación (PDF)».`}</p>`;
  // Por obra social
  const os = {};
  for (const p of cx) {
    const x = (os[p.obra_social || p.obra_social_texto || "Sin obra social"] ||= { n: 0, cob: 0, ncob: 0, est: 0, dias: 0, nd: 0, deb: 0 });
    x.n++;
    if (p.monto_cobrado > 0) { x.cob += p.monto_cobrado; x.ncob++; if (p.valor_estimado) x.est += p.valor_estimado; if (p.fecha_cobro) { x.dias += (Date.parse(p.fecha_cobro) - Date.parse(p.fecha)) / 864e5; x.nd++; } }
    if (p.estado === "debitada") x.deb++;
  }
  $("#an-os").innerHTML = Object.keys(os).length ? `<table><tr><th>Obra social</th><th class="n">#</th><th class="n economia">Cobrado</th><th class="n economia">Promedio</th></tr>` +
    Object.entries(os).sort((a, b) => b[1].n - a[1].n).map(([k, x]) => `<tr><td>${esc(k)}${x.deb ? ` <span class="chip vencida">${x.deb} debitada${x.deb > 1 ? "s" : ""}</span>` : ""}<div class="barra"><i style="width:${(100 * x.n) / cx.length}%"></i></div></td><td class="n">${x.n}</td>
      <td class="n economia">${x.cob ? pesos(x.cob) : "—"}</td><td class="n economia">${x.ncob ? pesos(x.cob / x.ncob) : "—"}</td></tr>`).join("") + "</table>" +
      '<p class="ayuda economia" style="margin-top:6px">Los días que tarda cada una en pagar están en Cobros.</p>'
    : `<p class="ayuda">Sin ${nombreQ.toLowerCase()} en ${anio}.</p>`;
  // Procedimientos (o complejidades en anestesia)
  // Lo que solo dice el módulo de la liquidación («MODULO 4 DE…») no es un procedimiento: va junto como «sin procedimiento»
  const clave = (p) => anest ? (p.complejidad ? "Complejidad " + p.complejidad : "Sin complejidad") :
    !p.procedimiento || procedimientoCortado(p) ? "SIN PROCEDIMIENTO (falta el código de la liquidación)" :
    p.procedimiento.trim().toUpperCase().replace(/\s+/g, " ").slice(0, 60) + (p.procedimiento_estimado ? " (probable, por el código)" : "");
  // Se agrupan sin acentos ni signos («LÁPAROSCOPICA» = «LAPAROSCOPICA»); se muestra como figura la primera vez
  const proc = {}, comoFigura = {};
  for (const p of cx) {
    const k = Motor.plano(clave(p)).replace(/[^a-z0-9]+/g, " ").trim(); comoFigura[k] ||= clave(p);
    const x = (proc[k] ||= { n: 0, cob: 0, ncob: 0 }); x.n++; if (p.monto_cobrado > 0) { x.cob += p.monto_cobrado; x.ncob++; }
  }
  $("#an-titulo-proc").textContent = anest ? "Por complejidad" : "Procedimientos más frecuentes";
  const top = Object.entries(proc).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, anest ? 12 : 10);
  $("#an-proc").innerHTML = top.length ? `<table><tr><th>${anest ? "Complejidad" : "Procedimiento"}</th><th class="n">#</th><th class="n economia">Promedio cobrado</th></tr>` +
    top.map(([k, x]) => `<tr><td>${esc(comoFigura[k])}</td><td class="n">${x.n}</td><td class="n economia">${x.ncob ? pesos(x.cob / x.ncob) : "—"}</td></tr>`).join("") + "</table>" : "";
  // Otros: instituciones, rol, urgencias
  const contar = (f) => { const c = {}; for (const p of cx) { const k = f(p); if (k) c[k] = (c[k] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]); };
  const bloques = [["Institución", contar((p) => (p.institucion || "").trim().toUpperCase() || "Sin dato")],
    ...(anest ? [] : [["Rol", contar((p) => (p.rol === "ayudante" ? "Ayudante" : "Cirujano"))]]),
    ["Urgencia", contar((p) => (p.urgencia ? "De urgencia" : "Programada"))]];
  $("#an-otros").innerHTML = cx.length ? bloques.filter(([, l]) => !(l.length === 1 && l[0][0] === "Sin dato")).map(([t, l]) => `<table><tr><th>${t}</th><th class="n">#</th><th class="n">%</th></tr>` +
    l.slice(0, 8).map(([k, n]) => `<tr><td>${esc(k)}</td><td class="n">${n}</td><td class="n">${Math.round((100 * n) / cx.length)} %</td></tr>`).join("") + "</table>").join('<div style="height:10px"></div>') : "";
  $$("#v-analisis .barras .b").forEach((b) => b.addEventListener("click", () => {
    const cont = b.parentElement; cont.querySelectorAll(".b").forEach((x) => x.classList.toggle("activa", x === b));
    $("#" + cont.id + "-v").textContent = b.dataset.txt;
  }));
}

// ---------- Valores y cuenta ----------

function verValores() {
  const d = datos();
  const uq = [...d.uq].sort((a, b) => b.vigencia.localeCompare(a.vigencia));
  $("#uq-valor").value = uq[0]?.valor ?? "";
  $("#uq-vigencia").value = (uq[0]?.vigencia || "").slice(0, 7);
  $("#inflacion").value = ajuste("inflacion_mensual", "");
  $("#pct-asociacion").value = ajuste("pct_asociacion", "");
  $("#pct-modulo-general").value = ajuste("pct_modulo_general", 0) || "";
  $("#liq-anterior-pct").value = ajuste("liq_anterior_pct", 70);
  $("#liq-anterior-hasta").value = ajuste("liq_anterior_hasta", "2025-12-31");
  // Dónde está cada cosa en el Drive
  const rama = RAMA_DRIVE();
  $("#donde-drive").innerHTML = `En tu Google Drive, carpeta <b>Liquidaciones › ${rama}</b>:<br>
    · <b>Pacientes › año</b>: una carpeta por paciente («fecha – APELLIDO, Nombre – ${esAnestesia() ? "Ref 0001" : "procedimiento"}») con sus documentos en PDF
    (${esAnestesia() ? "foja quirúrgica, foja de anestesia, autorización y datos del paciente" : "parte quirúrgico y datos del paciente"}).<br>
    · <b>Liquidaciones cobradas › año</b>: el PDF de cada liquidación («fecha – Liquidación número – total»).<br>
    ${esAnestesia() ? "" : "· <b>Listados de consultas › año</b>: el listado de cada día.<br>"}
    · <b>Planillas cargadas</b>: los Excel que cargaste.<br>
    Los nombres empiezan con la fecha (se ordenan solos). En el buscador del Drive podés buscar por apellido, DNI, obra social${esAnestesia() ? ", Ref o n° de circuito" : " o procedimiento"}.
    En <b>Liquidaciones</b> quedan además la planilla «${esAnestesia() ? "Anestesiología" : "Liquidaciones"} – planilla», los datos y los respaldos diarios.`;
  $("#abrir-carpeta").hidden = true;
  // Últimos errores de Drive (con el motivo que da Google), para saber qué pasó si algo no sube
  $("#errores-drive").hidden = !Almacen.registro.length;
  $("#errores-drive-lista").innerHTML = Almacen.registro.map((e) => `<li>${esc(e.cuando)}: ${esc(e.texto)}</li>`).join("");
  if (Almacen.tieneToken()) Almacen.enlaceCarpeta(esAnestesia() ? ["Anestesiología"] : []).then((l) => { $("#abrir-carpeta").href = l; $("#abrir-carpeta").hidden = false; }).catch(() => {});
  verAranceles();
  $("#apellido").value = ajuste("apellido", "");
  $("#min-bloqueo").value = String(minutosBloqueo());
  $("#uq-hist").textContent = "Historia UQ AAC: " + uq.map((u) => `${u.vigencia.slice(0, 7)} ${pesos(u.valor)}`).join(" · ");
  const doc = Almacen.doc;
  $("#cuenta-texto").textContent = doc.cuenta
    ? `Google Drive: ${doc.cuenta} · ${Almacen.estado}${doc.ultima_sync ? " · última copia " + new Date(doc.ultima_sync).toLocaleString("es-AR") : ""}`
    : "Sin Drive: los datos están solo en este celular. Conectá tu Google Drive para tener copia y usarla en otro dispositivo.";
  $("#conectar").textContent = doc.cuenta ? "Reconectar Google Drive" : "Conectar Google Drive";
  const conteo = {}, ultima = {};
  for (const v of d.valores) { conteo[v.obra_social] = (conteo[v.obra_social] || 0) + 1; if (!ultima[v.obra_social] || ultima[v.obra_social] < v.vigencia) ultima[v.obra_social] = v.vigencia; }
  $("#tabla-os").innerHTML = `<table><tr><th>Obra social</th><th class="n">Presenta día</th><th class="n">Paga a (días)</th>${esAnestesia() ? "" : '<th class="n">% módulo</th>'}<th class="n">${esAnestesia() ? "Aranceles" : "Valores"}</th></tr>` +
    d.obras.map((o) => `<tr data-os="${esc(o.nombre)}" style="${o.activa ? "" : "opacity:.5"}"><td>${esc(o.nombre)}${o.notas ? `<div class="ayuda" style="margin:0">${esc(o.notas)}</div>` : ""}</td>
      <td class="n">${o.dia_presentacion || "—"}</td><td class="n">${o.dias_pago}</td>${esAnestesia() ? "" : `<td class="n">${o.pct_modulo ?? "—"}</td>`}
      <td class="n">${conteo[o.nombre] || 0}${ultima[o.nombre] ? "<br><small>" + ultima[o.nombre].slice(0, 7) + "</small>" : ""}</td></tr>`).join("") + "</table>";
  const elegida = $("#v-os").value;
  const nombres = [...new Set(d.obras.map((o) => o.nombre).concat("MÍNIMO ÉTICO CMPC"))];
  $("#v-os").innerHTML = nombres.map((n) => `<option ${n === elegida ? "selected" : ""}>${esc(n)}</option>`).join("");
  verTablaValores();
}

// Aranceles por complejidad (anestesia): se guardan como valores «ANE-1»…«ANE-13» de cada obra social
function verAranceles() {
  if (!esAnestesia()) return;
  const d = datos(), os = $("#ane-os").value || d.obras.find((o) => o.activa)?.nombre || "";
  $("#ane-os").innerHTML = d.obras.filter((o) => o.activa || o.nombre === os).map((o) => `<option ${o.nombre === os ? "selected" : ""}>${esc(o.nombre)}</option>`).join("");
  if (!$("#ane-vigencia").value) $("#ane-vigencia").value = mes();
  const vig = $("#ane-vigencia").value + "-01";
  const actual = (c) => d.valores.filter((v) => v.obra_social === os && v.codigo === "ANE-" + c && v.vigencia <= vig).sort((a, b) => b.vigencia.localeCompare(a.vigencia))[0];
  $("#ane-valores").innerHTML = Array.from({ length: 13 }, (_, i) => i + 1).map((c) =>
    `<label>Complejidad ${c}${c > 7 ? " (opcional)" : ""}<input type="number" step="0.01" data-ane="${c}" value="${actual(c)?.monto ?? ""}" placeholder="${c > 7 ? "= 7 × " + String(Motor.catalogos.ANEST?.reglas.mayor_a_7[c]).replace(".", ",") : ""}"></label>`).join("");
  const filas = d.obras.map((o) => [o.nombre, Array.from({ length: 7 }, (_, i) => d.valores.filter((v) => v.obra_social === o.nombre && v.codigo === "ANE-" + (i + 1))
    .sort((a, b) => b.vigencia.localeCompare(a.vigencia))[0])]).filter(([, v]) => v.some(Boolean));
  $("#ane-tabla").innerHTML = filas.length ? `<table><tr><th>Obra social</th>${[1, 2, 3, 4, 5, 6, 7].map((c) => `<th class="n">${c}</th>`).join("")}</tr>` +
    filas.map(([n, v]) => `<tr><td>${esc(n)}</td>${v.map((x) => `<td class="n">${x ? pesos(x.monto) : "—"}</td>`).join("")}</tr>`).join("") + "</table>"
    : '<p class="ayuda">Todavía no cargaste aranceles. Pedí a la asociación la tabla de valores por complejidad de cada obra social.</p>';
}
async function guardarAranceles() {
  const os = $("#ane-os").value, vigencia = ($("#ane-vigencia").value || mes()) + "-01";
  if (!os) return aviso("Elegí la obra social");
  const propios = Almacen.doc.valores.filter((v) => !v.borrada);
  const registros = $$("[data-ane]").filter((i) => i.value !== "").map((i) => {
    const codigo = "ANE-" + i.dataset.ane, previo = propios.find((v) => v.obra_social === os && v.codigo === codigo && v.vigencia === vigencia);
    return { id: previo?.id, obra_social: os, codigo, descripcion: "Anestesia complejidad " + i.dataset.ane, monto: Number(i.value), vigencia, tipo: "honorario",
      fuente: "Cargado por el anestesiólogo", confianza: "cargado" };
  });
  if (!registros.length) return aviso("Cargá al menos un valor");
  await Almacen.guardarVarios("valores", registros);
  const n = await recalcularPendientes();
  aviso(`Aranceles de ${os} guardados; ${n} pendientes recalculados.`);
  verAranceles();
}

function verTablaValores() {
  const valores = datos().valores.filter((v) => v.obra_social === $("#v-os").value);
  // Deshacer una importación entera (afecta a todas las obras sociales de ese archivo, no solo a la elegida)
  const todos = datos().valores, lotes = new Map();
  for (const v of valores) if (v.lote && !lotes.has(v.lote)) {
    const del = todos.filter((x) => x.lote === v.lote);
    lotes.set(v.lote, { archivo: v.archivo, n: del.length, os: new Set(del.map((x) => x.obra_social)).size });
  }
  $("#lotes-valores").innerHTML = lotes.size ? `<p class="ayuda" style="width:100%;margin:0">Importaciones de donde salen estos valores
    (deshacer una borra todo lo que trajo ese archivo, en todas las obras sociales):</p>` + [...lotes].map(([k, l]) =>
    `<button class="boton chico secundario" data-borrar-lote="${esc(k)}">Deshacer «${esc(l.archivo)}» (${l.n} valores${l.os > 1 ? ` en ${l.os} obras sociales` : ""})</button>`).join(" ") : "";
  valores
    .sort((a, b) => (a.codigo_aac || a.codigo).localeCompare(b.codigo_aac || b.codigo) || b.vigencia.localeCompare(a.vigencia));
  $("#tabla-valores").innerHTML = valores.length ? `<table><tr><th>Código</th><th>Descripción</th><th>Desde</th><th class="n">Monto</th><th></th></tr>` +
    valores.map((v) => `<tr><td>${esc(v.codigo)}<div class="ayuda" style="margin:0">${v.codigo_aac && v.codigo_aac !== v.codigo ? (v.codigo_aac === "CONSULTA" ? "consulta" : "= AAC " + esc(v.codigo_aac)) : ""}</div></td>
      <td>${esc(v.descripcion)}<div class="ayuda" style="margin:0">${v.tipo === "modulo" ? "Módulo (institución) · " : ""}${esc((v.fuente || "").slice(0, 80))}</div></td>
      <td>${v.vigencia.slice(0, 7)}</td><td class="n">${pesos(v.monto)}</td>
      <td>${v.base ? "" : `<button class="boton chico peligro" data-borrar-valor="${v.id}" aria-label="Borrar">✕</button>`}</td></tr>`).join("") + "</table>"
    : '<p class="ayuda">Sin valores: se usa la referencia AAC. Pedí la circular de valores a la obra social (o al Colegio Médico) y cargala acá.</p>';
}

function dialogo(html, alAceptar) {
  const dlg = $("#dlg"), cuerpo = $("#dlg-cuerpo");
  cuerpo._actual = null;
  cuerpo.innerHTML = html + `<div class="fila"><button class="boton" data-ok>Guardar</button><button class="boton secundario" data-cerrar>Cerrar</button></div>`;
  cuerpo.onclick = async (ev) => {
    if (ev.target.matches("[data-cerrar]")) dlg.close();
    if (ev.target.matches("[data-ok]")) {
      try { if ((await alAceptar(leerCampos(cuerpo, {}))) !== false) { dlg.close(); verValores(); } } catch (e) { aviso(e.message); }
    }
  };
  dlg.showModal();
}

function editarObraSocial(o) {
  dialogo(`<h2>${o.nombre ? esc(o.nombre) : "Nueva obra social"}</h2><div class="grid">
    ${o.nombre ? "" : '<label class="ancho">Nombre<input name="nombre"></label>'}
    <label class="ancho">Cómo aparece escrita (separado por comas)<input name="alias" value="${esc(o.alias)}"></label>
    <label>Día de presentación<input type="number" name="dia_presentacion" value="${o.dia_presentacion ?? 18}" min="0" max="28"></label>
    <label>Paga a (días)<input type="number" name="dias_pago" value="${o.dias_pago ?? 60}" min="0"></label>
    ${esAnestesia() ? "" : `<label>% del módulo para el cirujano<input type="number" name="pct_modulo" value="${o.pct_modulo ?? ""}" step="0.1" placeholder="o cargalo en cada cirugía"></label>
    <label class="check ancho"><input type="checkbox" name="paga_modulo" ${o.paga_modulo ? "checked" : ""}> Paga por módulo (al importar listas, los valores quedan como módulo)</label>`}
    <label>Categoría<input name="categoria" value="${esc(o.categoria)}"></label>
    <label class="ancho">Notas<textarea name="notas" rows="2">${esc(o.notas)}</textarea></label>
    <label class="check"><input type="checkbox" name="activa" ${o.activa === false ? "" : "checked"}> Activa</label></div>
    <p class="ayuda">Día de presentación 0 = se cobra en el acto (particular).</p>`, async (d) => {
    const nombre = (o.nombre || d.nombre || "").trim().toUpperCase();
    if (!nombre) { aviso("Falta el nombre"); return false; }
    const propia = Almacen.doc.obras.find((x) => x.nombre === nombre);
    await Almacen.guardar("obras", { ...o, ...d, nombre, id: propia?.id || "os-" + nombre });
    await recalcularPendientes();
    aviso("Guardado; fechas de cobro recalculadas.");
  });
}

function nuevoValor() {
  const os = $("#v-os").value;
  dialogo(`<h2>Cargar valor · ${esc(os)}</h2><div class="grid">
    <label>Código de la obra social<input name="codigo"></label>
    <label>Equivale a (AAC)<input name="codigo_aac" placeholder="08.02.17 o CONSULTA"></label>
    <label class="ancho">Descripción<input name="descripcion"></label>
    <label>Monto ($)<input type="number" name="monto" step="0.01"></label>
    <label>Vigente desde<input type="month" name="vigencia" value="${mes()}"></label>
    <label>Tipo<select name="tipo"><option value="honorario">Honorario del médico</option><option value="modulo">Módulo (total institución)</option></select></label>
    <label class="ancho">Fuente<input name="fuente" placeholder="Circular, resolución, liquidación…"></label></div>`, async (d) => {
    if (!d.codigo || !d.monto || !d.vigencia) { aviso("Completá código, monto y vigencia."); return false; }
    const vigencia = d.vigencia.slice(0, 7) + "-01";
    const previo = Almacen.doc.valores.find((v) => !v.borrada && v.obra_social === os && v.codigo === d.codigo.trim() && v.vigencia === vigencia);
    await Almacen.guardar("valores", { ...d, id: previo?.id, obra_social: os, codigo: d.codigo.trim(), vigencia, fuente: d.fuente || "Cargado por el médico", confianza: "cargado" });
    await recalcularPendientes();
    aviso("Valor guardado; pendientes recalculados.");
  });
}

// ---------- Importar lista de valores (Excel, Word, PDF, foto) ----------

const NOMENCLADORES = { aac: "de la AAC", pami: "del nomenclador PAMI", propio: "propios de la obra social o del sanatorio" };
const sinSeparadores = (c) => String(c).replace(/[.\-\s]/g, "");
const tipoDeOS = (d, os) => (d.obras.find((o) => o.nombre === os)?.paga_modulo ? "modulo" : "honorario");
const opcionesTipo = (elegido) => `<option value="honorario">Honorario del médico</option><option value="modulo" ${elegido === "modulo" ? "selected" : ""}>Módulo (total institución)</option>`;

// Varios archivos de una vez (p. ej. uno por cirugía): los del sistema del sanatorio se revisan juntos; los demás, de a uno
async function importarValores(archivos) {
  const d = datos(), osDe = (t) => Motor.obraSocialCanonica(d, t);
  const largos = [], otros = [];
  for (const archivo of archivos) {
    aviso("Leyendo «" + archivo.name + "»…");
    let lectura;
    try { lectura = await Importador.leer(archivo, (t) => aviso(t)); } catch (e) { aviso(`«${archivo.name}»: ${e.message}`); continue; }
    const interpretado = Importador.interpretar(lectura, osDe);
    if (!interpretado.items.length || !interpretado.columnas.length) {
      aviso("No encontré renglones con código y monto en «" + archivo.name + "». La lista tiene que tener una columna de códigos y una de montos.");
      continue;
    }
    (interpretado.largo ? largos : otros).push({ archivo, lectura, interpretado });
  }
  const pasos = [...(largos.length ? [() => importarLargo(largos, osDe)] : []), ...otros.map((x) => () => importarAncho(x, osDe))];
  const siguiente = () => {
    const paso = pasos.shift();
    if (!paso) return;
    paso();
    if (pasos.length) $("#dlg").addEventListener("close", () => setTimeout(siguiente, 50), { once: true });
  };
  siguiente();
}

// Lista con una o varias columnas de montos (una por obra social, o honorario / gastos…)
function importarAncho({ archivo, lectura, interpretado: { columnas, items } }, osDe) {
  const d = datos();
  const osArchivo = Importador.obraSocial(d, archivo.name, lectura.texto) || $("#v-os").value;
  const nombres = [...new Set(d.obras.map((o) => o.nombre).concat("MÍNIMO ÉTICO CMPC"))];
  // Cada columna de montos: de qué obra social es (por su encabezado) o, la primera útil, de la obra social del archivo
  let usada = false;
  for (const c of columnas) {
    const deEncabezado = osDe(c.nombre);
    c.os = deEncabezado || (!c.ignorar && !usada ? osArchivo : "");
    if (c.os && !deEncabezado) usada = true;
  }
  const nom = Importador.nomenclador(items);
  const opciones = (elegida) => '<option value="">— no usar —</option>' + nombres.map((n) => `<option ${n === elegida ? "selected" : ""}>${esc(n)}</option>`).join("");
  const muestra = items.slice(0, 40);
  dialogo(`<h2>Importar valores</h2>
    <p class="ayuda">«${esc(archivo.name)}» · <b>${items.length} códigos</b> con monto. Revisá a qué obra social va cada columna y desde cuándo rigen.</p>
    <div class="grid">
      <label>Vigentes desde<input type="month" name="vigencia" value="${Importador.vigencia(lectura.texto + "\n" + archivo.name) || mes()}"></label>
      <label>Los códigos son<select name="clase">${Object.entries(NOMENCLADORES).map(([k, t]) => `<option value="${k}" ${k === nom.sistema ? "selected" : ""}>${t[0].toUpperCase() + t.slice(1)}</option>`).join("")}</select></label>
      ${columnas.map((c) => `<label class="ancho">Columna «${esc(c.nombre)}» (ej. ${pesos(c.ejemplo)})<select name="col_${c.j}">${opciones(c.os)}</select></label>
        <label>Tipo<select name="tipo_${c.j}">${opcionesTipo(c.modulo ? "modulo" : tipoDeOS(d, c.os))}</select></label>`).join("")}
      <label class="check ancho"><input type="checkbox" name="equivalencias" checked> Usar las equivalencias AAC sugeridas (columna «AAC»)</label>
    </div>
    <p class="ayuda">${nom.conDesc ? `Por las descripciones, los códigos parecen ${NOMENCLADORES[nom.sistema]} (${nom.sistema === "aac" ? nom.nAAC : nom.sistema === "pami" ? nom.nPAMI : nom.conDesc - nom.nAAC - nom.nPAMI} de ${nom.conDesc}).` : ""}
      Con la equivalencia AAC el valor se usa en tus cirugías aunque no tengan cargado el código de la obra social.</p>
    <div class="tabla"><table><tr><th>Código</th><th>Descripción</th><th>AAC</th>${columnas.map((c) => `<th class="n">${esc(c.nombre)}</th>`).join("")}</tr>
      ${muestra.map((it) => { const e = nom.porCodigo.get(it.codigo) || {}; return `<tr><td>${esc(it.codigo)}</td><td>${esc(it.descripcion)}</td>
        <td><small>${esc(e.aac || "")}${e.nombre ? " · " + esc(e.nombre.slice(0, 40)) : ""}</small></td>${columnas.map((c) => `<td class="n">${it.montos[c.j] ? pesos(it.montos[c.j]) : ""}</td>`).join("")}</tr>`; }).join("")}
    </table></div>${items.length > muestra.length ? `<p class="ayuda">… y ${items.length - muestra.length} códigos más.</p>` : ""}`, async (f) => {
    if (!f.vigencia) { aviso("Falta desde cuándo rigen los valores."); return false; }
    const elegidas = columnas.filter((c) => f["col_" + c.j]);
    if (!elegidas.length) { aviso("Elegí la obra social de al menos una columna."); return false; }
    const vigencia = f.vigencia.slice(0, 7) + "-01", lote = "lote-" + Date.now();
    const propios = Almacen.doc.valores.filter((v) => !v.borrada);
    const registros = [];
    for (const c of elegidas) {
      const os = f["col_" + c.j];
      for (const it of items) {
        if (!it.montos[c.j]) continue;
        const e = nom.porCodigo.get(it.codigo) || {};
        const previo = propios.find((v) => v.obra_social === os && sinSeparadores(v.codigo) === sinSeparadores(it.codigo) && v.vigencia === vigencia);
        registros.push({ id: previo?.id, obra_social: os, codigo: f.clase === "aac" ? it.codigo : sinSeparadores(it.codigo),
          codigo_aac: f.clase === "aac" ? (e.es === "aac" ? e.aac : it.codigo) : f.equivalencias ? e.aac || null : null, nomenclador: f.clase,
          descripcion: it.descripcion, abordaje: Motor.viaDe(it.descripcion), monto: Math.round(it.montos[c.j] * 100) / 100, vigencia, tipo: f["tipo_" + c.j] || "honorario",
          fuente: `Importado de «${archivo.name}»`, confianza: "importado", lote, archivo: archivo.name });
      }
    }
    await Almacen.guardarVarios("valores", registros);
    const n = await recalcularPendientes();
    $("#v-os").value = f["col_" + elegidas[0].j];
    aviso(`${registros.length} valores guardados (${[...new Set(elegidas.map((c) => f["col_" + c.j]))].join(", ")}); ${n} pendientes recalculados.`);
  });
}

// Listados del sistema del sanatorio: un renglón por práctica, obra social y plan (uno o varios archivos)
function importarLargo(lista, osDe) {
  const d = datos();
  let valores = [], items = [], nuevos = [];
  const sinReconocer = new Set(), columnasUsadas = new Set();
  for (const { archivo, interpretado: { columnas, items: its } } of lista) {
    const col = columnas.find((c) => !c.ignorar) || columnas[0];
    columnasUsadas.add(col.nombre);
    const r = Importador.porObraSocial(its, col.j, osDe);
    valores = valores.concat(r.valores.map((g) => ({ ...g, archivo: archivo.name }))); r.sinReconocer.forEach((x) => sinReconocer.add(x)); items = items.concat(its);
    // Las que no están en la app: se pueden agregar como obras sociales nuevas (con sus valores)
    const faltan = new Set(r.sinReconocer);
    nuevos = nuevos.concat(Importador.porObraSocial(its.filter((it) => faltan.has(it.os_texto)), col.j, (t) => Importador.nombreBase(t) || null)
      .valores.map((g) => ({ ...g, archivo: archivo.name })));
  }
  const obrasNuevas = new Map();
  for (const g of nuevos) obrasNuevas.set(g.os, [...new Set([...(obrasNuevas.get(g.os) || []), g.os_texto])]);
  const nombresArchivos = lista.map((x) => x.archivo.name);
  if (!valores.length && !nuevos.length) return aviso(`${nombresArchivos.join(", ")}: no hay valores para importar.`);
  const practicas = [...new Map([...valores, ...nuevos].map((g) => [g.codigo, g.descripcion])).entries()];
  const nom = Importador.nomenclador(practicas.map(([codigo, descripcion]) => ({ codigo, descripcion })));
  const totalOS = new Set(items.map((it) => it.os_texto)).size;
  valores.sort((a, b) => a.codigo.localeCompare(b.codigo) || a.os.localeCompare(b.os));
  const vig = lista.map((x) => Importador.vigencia(x.lectura.texto + "\n" + x.archivo.name)).find(Boolean) || mes();
  dialogo(`<h2>Importar valores</h2>
    <p class="ayuda">${nombresArchivos.map((n) => "«" + esc(n) + "»").join(", ")}: ${practicas.length === 1 ? "1 práctica" : practicas.length + " prácticas"}
      con valores para ${totalOS} obras sociales y planes (valor de la columna «${esc([...columnasUsadas].join(", "))}»).
      Se cargan <b>${valores.length} valores</b> para tus obras sociales. Los códigos parecen ${NOMENCLADORES[nom.sistema]}.</p>
    <div class="grid">
      <label>Vigentes desde<input type="month" name="vigencia" value="${vig}"></label>
      ${practicas.map(([cod, desc], i) => {
        const e = nom.porCodigo.get(cod) || {}, sug = Motor.sugerir("AAC", desc).slice(0, 3);
        if (e.aac && !sug.some((c) => c.code === e.aac)) sug.unshift({ code: e.aac, name: e.nombre });
        return `<label class="ancho">${esc(cod)} · ${esc(desc)} equivale en la AAC a<select name="aac_${i}">
          ${sug.map((c) => `<option value="${esc(c.code)}" ${c.code === e.aac ? "selected" : ""}>${esc(c.code)} · ${esc((c.name || "").slice(0, 70))}</option>`).join("")}
          <option value="" ${e.aac ? "" : "selected"}>— ninguna (solo por el código ${esc(cod)}) —</option></select></label>`; }).join("")}
    </div>
    <p class="ayuda">Con la equivalencia AAC el valor se usa en tus cirugías aunque no tengan cargado el código del sanatorio.
      «Módulo»: el valor es el total; tu parte la ponés en cada cirugía («% del módulo para vos»).</p>
    <div class="tabla"><table><tr><th>Código</th><th>Obra social</th><th class="n">Valor</th><th>Tipo</th></tr>
      ${valores.map((g, k) => `<tr><td>${esc(g.codigo)}</td><td>${esc(g.os)}<br><small>${esc(g.os_texto)}</small></td>
        <td class="n">${pesos(g.monto)}${g.min !== g.max ? `<br><small>según plan ${pesos(g.min)} a ${pesos(g.max)}</small>` : ""}</td>
        <td><select name="tipo_${k}">${opcionesTipo(tipoDeOS(d, g.os))}</select></td></tr>`).join("")}
    </table></div>
    ${obrasNuevas.size ? `<label class="check"><input type="checkbox" name="agregar_nuevas"> Agregar también las <b>${obrasNuevas.size} obras sociales</b> del archivo que no tenés
      cargadas, con sus ${nuevos.length} valores</label>
      <label>Tipo de esos valores<select name="tipo_nuevas">${opcionesTipo("honorario")}</select></label>
      <details><summary class="ayuda">Ver cuáles son</summary><div class="tabla"><table><tr><th>Obra social nueva</th><th>En el archivo</th><th class="n">Valor</th></tr>
        ${nuevos.map((g) => `<tr><td>${esc(g.os)}</td><td><small>${esc(obrasNuevas.get(g.os).join(" · "))}</small></td><td class="n">${pesos(g.monto)}</td></tr>`).join("")}
      </table></div><p class="ayuda">Las variantes de una sede («SAN PEDRO» y «SAN PEDRO (LBY)») quedan como una sola. Plazos de cobro por defecto
        (presenta el 18, paga a 60 días): cambialos en Valores → Obras sociales.</p></details>` : ""}`,
  async (f) => {
    if (!f.vigencia) { aviso("Falta desde cuándo rigen los valores."); return false; }
    const vigencia = f.vigencia.slice(0, 7) + "-01", lote = "lote-" + Date.now();
    const aac = new Map(practicas.map(([cod], i) => [cod, f["aac_" + i] || null]));
    const propios = Almacen.doc.valores.filter((v) => !v.borrada);
    if (f.agregar_nuevas) {
      await Almacen.guardarVarios("obras", [...obrasNuevas].map(([nombre, alias]) => ({ id: "os-" + nombre, nombre, alias: alias.join(", "),
        dia_presentacion: 18, dias_pago: 60, activa: true, notas: `Agregada al importar ${nombresArchivos.join(", ")}` })));
    }
    const registros = [...valores, ...(f.agregar_nuevas ? nuevos.map((g) => ({ ...g, nueva: true })) : [])].map((g, k) => {
      const previo = propios.find((v) => v.obra_social === g.os && sinSeparadores(v.codigo) === sinSeparadores(g.codigo) && v.vigencia === vigencia);
      return { id: previo?.id, obra_social: g.os, codigo: sinSeparadores(g.codigo), codigo_aac: aac.get(g.codigo) || null, nomenclador: nom.sistema,
        descripcion: g.descripcion + (g.min !== g.max ? ` (según plan ${pesos(g.min)} a ${pesos(g.max)})` : ""), abordaje: Motor.viaDe(g.descripcion), monto: g.monto, vigencia,
        tipo: (g.nueva ? f.tipo_nuevas : f["tipo_" + k]) || "honorario", fuente: `Importado de «${g.archivo || nombresArchivos[0]}» (${g.os_texto})`, confianza: "importado", lote,
        archivo: nombresArchivos.length === 1 ? nombresArchivos[0] : `${nombresArchivos.length} archivos` };
    });
    if (!registros.length) { aviso("Ninguna obra social del archivo coincide con las tuyas: tildá «Agregar también…» para importarlas."); return false; }
    await Almacen.guardarVarios("valores", registros);
    const n = await recalcularPendientes();
    $("#v-os").value = registros[0].obra_social;
    aviso(`${registros.length} valores guardados en ${new Set(registros.map((r) => r.obra_social)).size} obras sociales; ${n} pendientes recalculados.`);
  });
}

// Respaldos diarios automáticos del Drive (ver almacen.js)
async function verRespaldos() {
  if (!Almacen.tieneToken()) return aviso("Conectá Google Drive para ver los respaldos (Mi cuenta → Conectar Google Drive).");
  $("#respaldos").innerHTML = '<p class="cargando">Buscando respaldos…</p>';
  const lista = await Almacen.respaldos();
  $("#respaldos").innerHTML = lista.length ? `<p class="ayuda">Tocá uno para recuperar lo que falte desde ese día:</p>` +
    lista.map((r) => `<button class="boton chico secundario" style="margin:0 6px 6px 0" data-respaldo="${esc(r.id)}" data-dia="${fechaCorta(r.dia)}">${fechaCorta(r.dia)}</button>`).join("")
    : '<p class="ayuda">Todavía no hay respaldos: se crea el primero en la próxima sincronización.</p>';
}

async function borrarLote(lote) {
  const del = Almacen.doc.valores.filter((v) => v.lote === lote && !v.borrada);
  if (!del.length || !confirm(`¿Deshacer la importación de «${del[0].archivo}»? Se borran sus ${del.length} valores en ${new Set(del.map((v) => v.obra_social)).size} obras sociales (las obras sociales agregadas quedan).`)) return;
  await Almacen.guardarVarios("valores", del.map((v) => ({ ...v, borrada: true })));
  await recalcularPendientes();
  verValores();
}

async function recalcularPendientes() {
  const pend = datos().prestaciones.filter((p) => ["pendiente", "presentada"].includes(p.estado));
  // Una con un dato raro (fecha mal escrita…) no frena a las demás: queda como estaba
  // Solo se guardan las que cambian (guardar todas las marcaría como recién editadas y podría pisar lo de otro dispositivo)
  const clave = (x) => JSON.stringify([x.valor_estimado, x.valor_bruto, x.valor_origen, x.fecha_presentacion, x.fecha_cobro_estimada, x.obra_social, x.codigo_aac, x.estado]);
  await guardarEnLote(async () => { for (const p of pend) try {
    const nuevo = Motor.completar(datos(), { ...p });
    if (clave(nuevo) !== clave(p)) await guardarPrestacion(p);
  } catch {} });
  return pend.length;
}

// ---------- Liquidación de honorarios: marcar lo cobrado ----------

const claveNombre = (n) => {
  const [ap, nom = ""] = Motor.plano(n).replace(/[^a-z, ]/g, "").split(",");
  return { ap: ap.trim().replace(/\s+/g, " "), nom: nom.trim().split(/\s+/)[0] || "" };
};
// flojo (solo para relacionar liquidaciones con la lista propia): errores de tipeo en el nombre («Jennifer» / «Jenifer») o en
// el apellido («ALBERTRNGO» / «ALBERTENGO») y nombre y apellido invertidos («NELVY, RAMSEYER» / «RAMSEYER, NELVI»)
function distancia(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let previa = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const fila = [i];
    for (let j = 1; j <= b.length; j++) fila[j] = Math.min(previa[j] + 1, fila[j - 1] + 1, previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previa = fila;
  }
  return previa[b.length];
}
const parecidas = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && distancia(a, b) <= (Math.min(a.length, b.length) >= 8 ? 2 : 1));
function mismoPaciente(a, b, flojo = false) {
  const x = claveNombre(a), y = claveNombre(b);
  if (x.ap && x.ap === y.ap && (!x.nom || !y.nom || x.nom.startsWith(y.nom) || y.nom.startsWith(x.nom) || // la liquidación corta los nombres
    (flojo && x.nom.length >= 3 && y.nom.length >= 3 && x.nom.slice(0, 3) === y.nom.slice(0, 3)))) return true;
  if (!flojo) return false;
  const fichas = (n) => Motor.plano(n || "").replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  const fa = fichas(a), fb = fichas(b);
  if (!fa.length || !fb.length) return false;
  const iguales = fa.filter((w) => fb.some((v) => parecidas(w, v))).length;
  return iguales >= Math.min(2, fa.length, fb.length);
}
const mismoApellido = (a, b) => { const x = claveNombre(a).ap, y = claveNombre(b).ap; return !!x && x === y; };
const diasEntre = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

// Cada línea → la prestación que le corresponde: mismo n.º de atención, o mismo paciente, ±3 días
function conciliar(liq) {
  const d = datos(), usadas = new Set();
  const out = liq.lineas.map((l) => {
    const os = Motor.obraSocialCanonica(d, l.obra_social_texto);
    return { linea: l, os, esConsulta: Motor.equivalenteAAC(os, l.codigo) === "CONSULTA" || /\bcons/i.test(l.descripcion), p: null, incluir: true, grupo: null };
  });
  const mismoActo = (a, b) => (a.atencion && b.atencion === a.atencion) || mismoPaciente(a.paciente, b.paciente, true);
  // Una consulta va con una consulta y una cirugía con una cirugía (la consulta del mismo día no se queda con la cirugía)
  // y la obra social: si la liquidación trae solo el apellido («RODRIGUEZ,»), tiene que coincidir; con nombre y apellido
  // iguales se acepta aunque difiera (la planilla puede tenerla mal)
  const nombreFuerte = (l, p) => !!claveNombre(l.paciente).nom && mismoPaciente(l.paciente, p.paciente);
  const mismoTipo = (r, p) => (p.tipo === "consulta") === r.esConsulta && (!r.os || !p.obra_social || r.os === p.obra_social || nombreFuerte(r.linea, p));
  // Primero las fechas exactas y después las cercanas: con varias sesiones del mismo paciente (curaciones seguidas, la
  // misma atención) cada línea va a la de su día y no a la de al lado
  // (en una internación la fecha de la liquidación puede correrse unos días de la de la cirugía: hasta 7, lo más cercano
  // primero). Nunca una cirugía posterior a la emisión de la liquidación.
  // Ya cobrada antes (la misma liquidación cargada otra vez, o con una versión anterior con otro número o fecha): se marca
  // para corregir su número y fecha, sin volver a sumarla. Mismo paciente y código o monto; primero la fecha exacta.
  const cobradaAntes = d.prestaciones.filter((p) => ["cobrada", "debitada"].includes(p.estado) && p.monto_cobrado);
  const yaUsadas = new Set();
  for (const maxDias of [0, 1, 3, 7]) for (const r of out) {
    if (r.p || r.ya) continue;
    const l = r.linea, num = Lector.numeroLiq(l.numero) || l.numero;
    // La misma línea: mismo código y monto (de esta liquidación, o sin número guardado)
    const mismaLinea = (p) => (p.cobro_lineas || []).some((x) => (!x.liq || x.liq === num) && x.codigo === l.codigo && Math.abs(x.monto - l.monto) < 1) ||
      ((!p.cobro_lineas || !p.cobro_lineas.length) && (p.codigo_os === l.codigo || Math.abs(p.monto_cobrado - l.monto) < 1));
    // Cobrada en OTRA liquidación: solo si es el mismo día y la misma atención (si no, es un segundo pago, p. ej. otra curación)
    const deOtra = (p) => numeroLiquidacion(p) && numeroLiquidacion(p) !== num && !/^L$/.test(numeroLiquidacion(p));
    const p = cobradaAntes.find((p) => !yaUsadas.has(p.id) && diasEntre(p.fecha, l.fecha) <= maxDias && mismoActo(l, p) && mismoTipo(r, p) && mismaLinea(p) &&
      (!deOtra(p) || (p.fecha === l.fecha && p.atencion && p.atencion === l.atencion) || !(p.cobro_lineas || []).length));
    if (p) { r.p = p; r.ya = true; yaUsadas.add(p.id); }
  }
  // Línea negativa (débito o devolución de algo ya cobrado en otra liquidación): se descuenta de esa cirugía
  for (const r of out) {
    if (r.p || r.linea.monto >= 0) continue;
    const l = r.linea;
    r.p = cobradaAntes.filter((p) => mismoActo(l, p) && diasEntre(p.fecha, l.fecha) <= 7 && (p.codigo_os === l.codigo || (p.cobro_lineas || []).some((x) => x.codigo === l.codigo)))
      .sort((a, b) => diasEntre(a.fecha, l.fecha) - diasEntre(b.fecha, l.fecha))[0] || null;
    if (r.p) r.debito = true;
  }
  for (const maxDias of [0, 1, 3, 7]) for (const r of out) {
    if (r.p) continue;
    const l = r.linea;
    // El mismo día alcanza con el apellido («VILLAR, MARIA» en la liquidación y «VILLAR, ADRIANA» en la planilla)
    const p = d.prestaciones.filter((p) => !usadas.has(p.id) && p.estado !== "cobrada" && diasEntre(p.fecha, l.fecha) <= maxDias && mismoTipo(r, p) &&
      (mismoActo(l, p) || (maxDias === 0 && mismoApellido(l.paciente, p.paciente))) && (!l.emision || p.fecha <= l.emision))
      .sort((a, b) => diasEntre(a.fecha, l.fecha) - diasEntre(b.fecha, l.fecha) || (b.atencion === l.atencion) - (a.atencion === l.atencion) ||
        (b.codigo_os === l.codigo) - (a.codigo_os === l.codigo) || ((b.tipo === "consulta") === r.esConsulta) - ((a.tipo === "consulta") === r.esConsulta))[0];
    // Varias líneas del mismo acto (mismo paciente y día; p. ej. tres ítems de una escisión): van a la misma prestación
    if (p) { r.p = p; usadas.add(p.id); }
  }
  for (const r of out) if (!r.p) {
    const u = out.find((u) => u.p && u.linea.fecha === r.linea.fecha && u.esConsulta === r.esConsulta && mismoActo(r.linea, u.linea));
    if (u) { r.p = u.p; r.ya = u.ya; }
  }
  out.forEach((r, i) => {
    if (r.p) return;
    const g = out.slice(0, i).find((x) => !x.p && x.linea.fecha === r.linea.fecha && x.esConsulta === r.esConsulta && mismoActo(r.linea, x.linea));
    r.grupo = g ? g.grupo : i;
  });
  return out;
}

let conciliacion = null;

async function leerLiquidacion(archivos) {
  $("#cargar-botones").hidden = true; $("#leyendo").hidden = false;
  try {
    // Cada archivo por separado (así cada PDF se guarda en el Drive con su número), después todo junto
    const textos = [];
    for (const [i, a] of archivos.entries())
      // Todas las páginas (las órdenes de pago traen el detalle al final, después de la página 6)
      textos.push(await Lector.textoDe([a], (t) => ($("#leyendo-texto").textContent = (archivos.length > 1 ? `Archivo ${i + 1} de ${archivos.length}: ` : "") + t), { paginas: 300 }));
    const texto = textos.join("\n");
    const porArchivo = archivos.map((a, i) => ({ archivo: a, liq: Lector.liquidacion(textos[i]) }));
    const liq = Lector.liquidacion(texto);
    if (!liq.lineas.length) throw new Error("No se reconoció una liquidación («Detalle Liquidación»). Cargá el PDF tal como lo descargás del sistema.");
    const cargadas = ajuste("liquidaciones", []);
    const yaCargadas = (liq.liquidaciones || []).map((x) => x.numero).filter((n) => cargadas.includes(n));
    if (yaCargadas.length && !confirm(`${yaCargadas.length === 1 ? "La liquidación " + yaCargadas[0] + " ya se cargó" : "Ya se cargaron: " + yaCargadas.join(", ")}. ¿Cargar de nuevo?`)) throw new Error("Cancelado");
    conciliacion = { liq, filas: conciliar(liq), archivos, porArchivo };
    $("#texto-leido").textContent = texto;
    mostrarConciliacion();
  } catch (e) { aviso(e.message); $("#cargar-botones").hidden = false; }
  finally { $("#leyendo").hidden = true; }
}

function mostrarConciliacion() {
  const { liq, filas } = conciliacion;
  const ok = filas.filter((f) => f.p && !f.ya).length, ya = filas.filter((f) => f.ya).length;
  $("#revision").hidden = false;
  const varias = (liq.liquidaciones || []).length > 1;
  $("#revision-titulo").textContent = varias ? `${(liq.liquidaciones || []).length} liquidaciones` : `Liquidación ${liq.numero}`;
  $("#guardar-lote").textContent = "Aplicar liquidación";
  $("#revision-filas").innerHTML = `<p class="ayuda">${esc(liq.empresa)} · emitida ${fechaCorta(liq.emision)} · total ${pesos(liq.total)}<br>
      <b>${ok}</b> líneas coinciden con prestaciones cargadas (se marcan cobradas con el monto liquidado); <b>${filas.length - ok - ya}</b> no estaban
      cargadas (se agregan como cobradas)${ya ? `; <b>${ya}</b> ya estaban cobradas (no se suman de nuevo: se corrige su número de liquidación y su fecha)` : ""}.</p>
    ${varias ? `<p class="ayuda">El archivo trae ${(liq.liquidaciones || []).length} liquidaciones: cada una se cobra con su fecha de emisión
      (${(liq.liquidaciones || []).map((x) => `${esc(x.numero)}: ${x.emision ? fechaCorta(x.emision) : "sin fecha"}`).join(" · ")}).</p><input id="liq-fecha" type="hidden" value="">`
      : `<label>Fecha de cobro<input id="liq-fecha" data-fecha inputmode="numeric" placeholder="dd/mm/aaaa" value="${esc(fechaLarga(liq.emision || hoy()))}"></label>`}` +
    filas.map((f, i) => `<div class="item" style="cursor:default"><input type="checkbox" data-liq-incluir="${i}" ${f.incluir ? "checked" : ""}>
      <div class="cuerpo"><div class="titulo">${esc(f.linea.paciente)}</div>
      <div class="sub">${fechaCorta(f.linea.fecha)} · ${esc(f.os || f.linea.obra_social_texto)} · ${esc(f.linea.codigo)} ${esc(f.linea.descripcion)}</div>
      <div class="sub">${f.debito && !f.ya ? `− débito de lo cobrado: ${esc(f.p.paciente)} · ${fechaCorta(f.p.fecha)}` : f.ya ? `↻ ya estaba cobrada: ${esc(f.p.paciente)} · ${fechaCorta(f.p.fecha)}` : f.p ? `✓ ${esc(f.p.paciente)} · ${fechaCorta(f.p.fecha)} · estimado ${pesos(f.p.valor_estimado)}` : "＋ nueva (no estaba cargada)"}</div></div>
      <div class="monto">${pesos(f.linea.monto)}</div></div>`).join("");
}

async function aplicarLiquidacion() {
  const { liq, filas, porArchivo } = conciliacion;
  $("#guardar-lote").disabled = true;
  const elegida = fechaDeTexto($("#liq-fecha")?.value || "");
  // Cada línea con su liquidación: número y fecha de emisión (si el archivo trae una sola, la fecha que se eligió)
  const deLinea = (l) => ({ numero: l.numero || liq.numero, fecha: ((liq.liquidaciones || []).length > 1 ? l.emision : elegida) || l.emision || liq.emision || hoy() });
  const grupos = new Map(); // prestación → líneas
  for (const f of filas.filter((x) => x.incluir)) {
    const clave = f.p ? f.p.id : "nueva-" + f.grupo;
    if (!grupos.has(clave)) grupos.set(clave, { p: f.p, lineas: [], f });
    grupos.get(clave).lineas.push(f.linea);
  }
  let marcadas = 0, nuevas = 0, corregidas = 0, hechas = 0;
  const errores = [], tocadas = new Set();
  let huerfanas = 0;
  await guardarEnLote(async () => { for (const { p, lineas, f } of grupos.values()) try {
    if (++hechas % 25 === 0) { aviso(`Aplicando la liquidación… ${hechas} de ${grupos.size}`); await new Promise((ok) => setTimeout(ok)); }
    const l = lineas[0], total = lineas.reduce((s, x) => s + x.monto, 0), { numero, fecha } = deLinea(l), nota = `Liq. ${numero}`;
    const detalle = lineas.length > 1 ? ` (${lineas.length} ítems)` : "";
    // Lo liquidado por cada código: así el valor de cada práctica se actualiza con lo último cobrado
    const cobro_lineas = lineas.map((x) => ({ codigo: x.codigo, monto: x.monto, liq: numero || null }));
    if (p && f.debito && !f.ya) {
      // Débito de algo cobrado antes: se descuenta y queda anotado
      const neto = (p.monto_cobrado || 0) + total;
      tocadas.add(p.id);
      await guardarPrestacion({ ...p, monto_cobrado: neto, cobro_lineas: [...(p.cobro_lineas || []), ...cobro_lineas], estado: neto <= 0 ? "debitada" : p.estado,
        motivo_debito: p.motivo_debito || `Descontado en la liquidación ${numero} (${pesos(-total)})`, notas: [p.notas, nota + " (débito)"].filter(Boolean).join(" · ") });
      corregidas++;
    } else if (p && f.ya) {
      // Ya cobrada: número, fecha y monto de esta liquidación (las notas viejas «Liq. …» se reemplazan)
      const notas = [(p.notas || "").replace(/\s*·?\s*Liq\. [^·]*/g, "").trim(), nota + detalle].filter(Boolean).join(" · ");
      tocadas.add(p.id);
      // Se reemplazan solo las líneas de esta liquidación (las de otra, p. ej. un débito posterior, se conservan)
      const otras = (p.cobro_lineas || []).filter((x) => x.liq && x.liq !== numero);
      const todas = [...otras, ...cobro_lineas], neto = todas.reduce((t, x) => t + x.monto, 0);
      const fechaPago = otras.length ? [fecha, p.fecha_cobro].filter(Boolean).sort()[0] : fecha;
      await guardarPrestacion({ ...p, fecha_cobro: fechaPago, monto_cobrado: neto, cobro_lineas: todas, estado: neto <= 0 ? "debitada" : p.estado,
        liquidacion: otras.length ? p.liquidacion || numero : numero || null, solo_registro: false, revisar_cobro: false, notas });
      corregidas++;
    } else if (p) {
      // Los códigos de las otras líneas que no estaban en la prestación se agregan como procedimientos del mismo acto
      const conocidos = new Set([p.codigo_os, ...(p.extras || []).map((x) => x.codigo_os)].filter(Boolean));
      const extras = [...(p.extras || [])];
      for (const x of lineas.slice(1)) if (!conocidos.has(x.codigo) && x.codigo !== l.codigo) { extras.push({ procedimiento: procedimientoDeCodigo(x.codigo, x.descripcion).procedimiento, codigo_os: x.codigo }); conocidos.add(x.codigo); }
      tocadas.add(p.id);
      await guardarPrestacion({ ...p, extras, revisar_cobro: false, estado: total <= 0 ? "debitada" : "cobrada", fecha_cobro: fecha, monto_cobrado: total, cobro_lineas, solo_registro: false, liquidacion: numero || null, codigo_os: p.codigo_os || l.codigo,
        atencion: p.atencion || l.atencion, notas: [p.notas, nota + detalle].filter(Boolean).join(" · ") });
      marcadas++;
    } else {
      // Nunca la misma cirugía dos veces: si ya está cargada (mismo paciente y día) sin cobrar, se marca esa
      const ya = cirugiaRepetida({ fecha: l.fecha, paciente: l.paciente, tipo: f.esConsulta ? "consulta" : "cirugia" });
      const soloApellido = !claveNombre(l.paciente).nom, otraOS = ya && ya.obra_social && f.os && ya.obra_social !== f.os;
      if (ya && !["cobrada", "debitada"].includes(ya.estado) && !(soloApellido && otraOS)) {
        tocadas.add(ya.id);
        await guardarPrestacion({ ...ya, revisar_cobro: false, estado: "cobrada", fecha_cobro: fecha, monto_cobrado: total, cobro_lineas, solo_registro: false, liquidacion: numero || null,
          codigo_os: ya.codigo_os || l.codigo, atencion: ya.atencion || l.atencion, notas: [ya.notas, nota + detalle].filter(Boolean).join(" · ") });
        marcadas++;
        continue;
      }
      const aac = Motor.equivalenteAAC(f.os, l.codigo), cx = procedimientoDeCodigo(l.codigo, l.descripcion, l.paciente, l.fecha);
      const nueva = await guardarPrestacion({ fecha: l.fecha, paciente: l.paciente, obra_social: f.os, obra_social_texto: l.obra_social_texto, atencion: l.atencion,
        tipo: f.esConsulta ? "consulta" : "cirugia", procedimiento: f.esConsulta ? "" : cx.procedimiento, procedimiento_estimado: !f.esConsulta && cx.estimado, codigo_os: l.codigo,
        extras: f.esConsulta ? [] : [...new Map(lineas.slice(1).filter((x) => x.codigo !== l.codigo).map((x) => [x.codigo, { procedimiento: procedimientoDeCodigo(x.codigo, x.descripcion).procedimiento, codigo_os: x.codigo }])).values()],
        codigo_aac: aac && aac !== "CONSULTA" ? aac : null, estado: total <= 0 ? "debitada" : "cobrada", fecha_cobro: fecha, monto_cobrado: total, cobro_lineas, liquidacion: numero || null, origen: "liquidacion",
        // Un débito que no encontró su cobro: no se le estima valor (no infla lo facturado) y queda para revisar
        ...(total <= 0 ? { pct: 0, revisar_cobro: true } : {}),
        notas: nota + detalle });
      tocadas.add(nueva.id);
      nuevas++;
    }
  } catch (e) { errores.push(`${lineas[0].paciente} (${fechaCorta(lineas[0].fecha)}): ${e.message}`); }
    // Lo que dice ser de una de estas liquidaciones pero no figura en su detalle (cargas viejas con el número cambiado): deja de
    // contarse en ella y queda para revisar (no se borra)
    const num = (l) => Lector.numeroLiq(l.numero) || l.numero;
    const incompletas = new Set([...filas.filter((f) => !f.incluir).map((f) => num(f.linea)), ...(errores.length ? liq.lineas.map(num) : [])]);
    const cargadas = new Set(liq.lineas.map(num).filter((n) => n && !incompletas.has(n)));
    for (const p of datos().prestaciones.filter((p) => ["cobrada", "debitada"].includes(p.estado) && !tocadas.has(p.id) && cargadas.has(numeroLiquidacion(p)))) {
      const n = numeroLiquidacion(p);
      await guardarPrestacion({ ...p, liquidacion: null, revisar_cobro: true,
        notas: [(p.notas || "").replace(/\s*·?\s*Liq\. [^·]*/g, "").trim(), `Revisar: figuraba en la liquidación ${n}, pero no está en su detalle`].filter(Boolean).join(" · ") });
      huerfanas++;
    }
  });
  const unidas = await unirRepetidas().catch(() => 0);
  await Almacen.ajuste("liquidaciones", [...new Set([...ajuste("liquidaciones", []), ...((liq.liquidaciones || []).length ? liq.liquidaciones.map((x) => x.numero) : [liq.numero]).filter(Boolean)])]);
  // Autoactualizar: las pendientes sin valor de referencia toman lo último cobrado por la misma práctica
  const antes = new Map(datos().prestaciones.map((p) => [p.id, p.valor_estimado]));
  await recalcularPendientes();
  const actualizadas = datos().prestaciones.filter((p) => ["pendiente", "presentada"].includes(p.estado) && antes.get(p.id) !== p.valor_estimado).length;
  conciliacion = null;
  $("#guardar-lote").disabled = false;
  cerrarRevision();
  aviso(`Liquidación cargada: ${marcadas} marcadas cobradas, ${nuevas} agregadas` + (corregidas ? `, ${corregidas} ya estaban (corregidas)` : "") + (actualizadas ? `; ${actualizadas} pendientes con el valor actualizado.` : ".") +
    (unidas ? ` Se unieron ${unidas} repetidas.` : "") + (huerfanas ? ` ${huerfanas} cobros no figuran en su liquidación: quedaron para revisar (Inicio → Para hacer).` : "") +
    (errores.length ? ` No se pudieron aplicar ${errores.length}: ${errores.slice(0, 3).join(" · ")}${errores.length > 3 ? "…" : ""}` : ""));
  // Los PDF van al Drive después (cada uno como está, con su número), sin trabar
  guardarPDFsLiquidacion(liq, porArchivo).catch((e) => aviso("Los PDF de la liquidación no se pudieron guardar en el Drive: " + e.message));
  $("#f-periodo").value = "todos"; $("#f-estado").value = "cobrada";
  ir("prestaciones");
}

// ---------- Planilla Excel: cirugías y procedimientos, consultas, resumen mensual ----------

// Una planilla por rama: cirugía («Liquidaciones – planilla», en «Liquidaciones») y anestesiología («Anestesiología – planilla»,
// en «Liquidaciones/Anestesiología»). Cada una con todas las prestaciones de su rama, sea cual sea la rama abierta.
async function construirExcel(rama = esAnestesia() ? "anestesia" : "cirugia") {
  await new Promise((ok, mal) => {
    if (window.XLSX) return ok();
    const s = document.createElement("script");
    s.src = "vendor/xlsx.full.min.js"; s.onload = ok; s.onerror = () => mal(new Error("No se pudo cargar el generador de Excel"));
    document.head.appendChild(s);
  });
  const todas = datos(rama).prestaciones.sort((a, b) => (a.fecha + (a.hora || "")).localeCompare(b.fecha + (b.hora || "")));
  const deCirugia = rama === "cirugia" ? todas : [], deAnestesia = rama === "anestesia" ? todas : [];
  const lista = deCirugia;
  // Fechas como número de serie de planilla (días desde 30/12/1899) con formato dd/mm/aaaa: Google Sheets y Excel las
  // importan como fecha. (Las «celdas de fecha» ISO no las toma Google: quedaban vacías o como texto.)
  const fechaX = (t) => {
    if (!t || !/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
    const [y, m, d] = t.slice(0, 10).split("-").map(Number);
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;
  };
  const FECHAS = ["Fecha", "Presentada", "Cobro estimado", "Cobrada el", "Vigente desde", "Cargada el", "Liquidada el"];
  const etiquetas = (p) => ETIQUETAS[p.especialidad === "anestesia" ? "anestesia" : "cirugia"];
  const est = (p) => (Motor.vencida(p, hoy()) ? "Vencida" : etiquetas(p).estados[p.estado]);
  // ¿El valor es un módulo (total para la institución, del que te toca un %) o tu honorario directo?
  const tipoValor = (p) => p.valor_manual ? "Cargado a mano" : /^Ayudantía en módulo/.test(p.valor_origen || "") ? "Módulo (ayudantía: no se cobra)"
    : /^Módulo|^Sin honorario conocido · Módulo/.test(p.valor_origen || "") ? "Módulo" : p.valor_estimado != null ? "Honorario directo" : "";
  // Anestesiología: como la planilla de control (situación, documentación faltante, cargado en la asociación, liquidado neto)
  const anestesias = deAnestesia.map((p, i) => ({
    "N°": i + 1, "Ref.": refTexto(p), "Fecha": fechaX(p.fecha), "Hora": p.hora || "", "Paciente": p.paciente, "DNI": p.dni || "", "Afiliado": p.afiliado || "",
    "Obra social": p.obra_social || p.obra_social_texto || "", "Lugar": p.institucion || "", "Tipo": etiquetas(p).tipos[p.tipo], "Procedimiento": procedimientosDe(p),
    "Complejidad": Motor.complejidadEfectiva(p) ?? "", "Recargos": Motor.recargosAnestesia(p).map(([n, x]) => `${n} +${x} %`).join(", "),
    "Monto cargado (bruto)": p.valor_bruto ?? null, "Neto estimado": p.valor_estimado ?? null, "Situación": est(p),
    "N° de circuito": p.nro_circuito || "", "Doc faltante": docFaltante(p).join(" / ").toUpperCase(), "Carpeta (Drive)": p.carpeta_docs?.link || "", "Foja quirúrgica (Drive)": (p.foja_archivos || []).map((a) => a.link).join(" "),
    "Foja de anestesia (Drive)": (p.foja_anestesia_archivos || []).map((a) => a.link).join(" "), "Autorización (Drive)": (p.autorizacion_archivos || []).map((a) => a.link).join(" "), "Cargada el": fechaX(p.estado !== "pendiente" && p.fecha_presentacion),
    "Liquidada el": fechaX(p.fecha_cobro), "Cobrado (neto)": p.monto_cobrado ?? null,
    "Diferencia": p.monto_cobrado != null && p.valor_estimado != null ? p.monto_cobrado - p.valor_estimado : null,
    "Comentario": p.notas || "", "Origen del valor": p.valor_origen || "" }));
  const cirugias = lista.filter((p) => p.tipo !== "consulta").map((p) => ({
    "Fecha": fechaX(p.fecha), "Paciente": p.paciente, "DNI": p.dni || "", "Afiliado": p.afiliado || "", "Obra social": p.obra_social || p.obra_social_texto || "",
    "Institución": p.institucion || "", "Tipo": TIPOS[p.tipo], "Procedimiento": procedimientosDe(p), "Código AAC": codigosDe(p, "codigo_aac"),
    "Código obra social": codigosDe(p, "codigo_os"), "Rol": p.rol === "ayudante" ? "Ayudante" : "Cirujano", "% facturado": p.pct ?? 100,
    "Tipo de valor": tipoValor(p), "% del módulo": p.pct_modulo ?? null,
    "Endoscopía": p.tipo === "endoscopia" ? ENDOSCOPIAS[p.endoscopia] || "" : "", "Llegó a ciego": p.ciego ? SI_NO[p.ciego] : "",
    "Polipectomía": p.polipectomia ? SI_NO[p.polipectomia] : "", "Observaciones (endoscopía)": p.observaciones || "",
    "Valor estimado": p.valor_estimado ?? null, "Estado": est(p), "Presentada": fechaX(p.estado !== "pendiente" && p.fecha_presentacion),
    "Cobro estimado": fechaX(p.fecha_cobro_estimada), "Cobrada el": fechaX(p.fecha_cobro), "Monto cobrado": p.monto_cobrado ?? null,
    "Diferencia": p.monto_cobrado != null && p.valor_estimado != null ? p.monto_cobrado - p.valor_estimado : null, "Motivo del débito": p.motivo_debito || "",
    "N° atención": p.atencion || "", "Origen del valor": p.valor_origen || "", "Notas": p.notas || "" }));
  const consultas = lista.filter((p) => p.tipo === "consulta").map((p) => ({
    "Fecha": fechaX(p.fecha), "Hora": p.hora || "", "Paciente": p.paciente, "DNI": p.dni || "", "Afiliado": p.afiliado || "",
    "Obra social": p.obra_social || p.obra_social_texto || "", "Código obra social": p.codigo_os || "", "Valor estimado": p.valor_estimado ?? null,
    "Estado": est(p), "Cobro estimado": fechaX(p.fecha_cobro_estimada), "Cobrada el": fechaX(p.fecha_cobro), "Monto cobrado": p.monto_cobrado ?? null,
    "N° atención": p.atencion || "", "Notas": p.notas || "" }));
  const grupos = {};
  for (const p of todas) {
    const k = p.fecha.slice(0, 7) + "|" + (p.obra_social || p.obra_social_texto || "Sin obra social") + (p.especialidad === "anestesia" ? " (anestesiología)" : "");
    const g = (grupos[k] ||= { "Mes": p.fecha.slice(0, 7), "Obra social": k.split("|")[1], "Consultas": 0, "Cirugías y procedimientos": 0,
      "Estimado": 0, "Cobrado": 0, "Falta cobrar": 0 });
    g[p.tipo === "consulta" ? "Consultas" : "Cirugías y procedimientos"]++;
    g["Estimado"] += p.valor_estimado || 0;
    g["Cobrado"] += ["cobrada", "debitada"].includes(p.estado) ? p.monto_cobrado || 0 : 0;
    g["Falta cobrar"] += ["pendiente", "presentada"].includes(p.estado) ? p.valor_estimado || 0 : 0;
  }
  // Valores (los de la app, los cargados y los importados): qué es módulo y qué es honorario directo
  const valores = datos(rama).valores.slice().sort((a, b) => a.obra_social.localeCompare(b.obra_social) || String(a.codigo).localeCompare(String(b.codigo)) || b.vigencia.localeCompare(a.vigencia))
    .map((v) => ({ "Obra social": v.obra_social, "Código": v.codigo, "Equivale a (AAC)": v.codigo_aac || "", "Descripción": v.descripcion || "",
      "Tipo de valor": v.tipo === "modulo" ? "Módulo (total institución)" : "Honorario directo", "Monto": v.monto ?? null,
      "Vigente desde": fechaX(v.vigencia), "Fuente": v.fuente || "" }));
  const resumen = Object.values(grupos).sort((a, b) => b["Mes"].localeCompare(a["Mes"]) || b["Estimado"] - a["Estimado"]);
  const libro = XLSX.utils.book_new();
  const DINERO = ["Valor estimado", "Monto cobrado", "Diferencia", "Estimado", "Cobrado", "Falta cobrar", "Monto", "Monto cargado (bruto)", "Neto estimado", "Cobrado (neto)"];
  const hoja = (filas, nombre, columnas) => {
    const h = XLSX.utils.json_to_sheet(filas.length ? filas : [Object.fromEntries(columnas.map((c) => [c, ""]))]);
    const cab = Object.keys(filas[0] || Object.fromEntries(columnas.map((c) => [c, ""])));
    h["!cols"] = cab.map((c) => ({ wch: Math.min(45, Math.max(c.length + 2, ...filas.slice(0, 200).map((f) => String(f[c] ?? "").length > 40 ? 40 : 12))) }));
    cab.forEach((c, j) => {
      const formato = DINERO.includes(c) ? "$ #,##0" : FECHAS.includes(c) ? "dd/mm/yyyy" : null;
      if (!formato) return;
      for (let i = 1; i <= filas.length; i++) { const celda = h[XLSX.utils.encode_cell({ r: i, c: j })]; if (celda && typeof celda.v === "number") celda.z = formato; }
    });
    h["!autofilter"] = { ref: h["!ref"] };
    XLSX.utils.book_append_sheet(libro, h, nombre);
  };
  if (rama === "cirugia") {
    hoja(cirugias, "Cirugías y procedimientos", ["Fecha", "Paciente", "Obra social", "Procedimiento"]);
    hoja(consultas, "Consultas", ["Fecha", "Paciente", "Obra social"]);
  } else hoja(anestesias, "Anestesiología", ["N°", "Fecha", "Paciente", "Obra social", "Lugar", "Procedimiento", "Situación", "Doc faltante"]);
  hoja(resumen, "Resumen mensual", ["Mes", "Obra social", "Estimado", "Cobrado"]);
  hoja(valores, rama === "cirugia" ? "Valores cargados" : "Aranceles por complejidad", ["Obra social", "Código", "Descripción", "Tipo de valor", "Monto"]);
  return XLSX.write(libro, { bookType: "xlsx", type: "array" });
}

// Las planillas del Drive: la de cada rama que tenga datos (o la abierta)
async function planillasDrive() {
  const todas = Almacen.doc.prestaciones.filter((p) => !p.borrada);
  const out = [];
  if (todas.some((p) => (p.especialidad || "cirugia") === "cirugia") || !esAnestesia())
    out.push({ nombre: "Liquidaciones – planilla", ruta: [], bytes: await construirExcel("cirugia") });
  if (todas.some((p) => p.especialidad === "anestesia") || esAnestesia())
    out.push({ nombre: "Anestesiología – planilla", ruta: ["Anestesiología"], bytes: await construirExcel("anestesia") });
  return out;
}

function exportarCSV() {
  const cols = ["fecha", "hora", "tipo", "paciente", "dni", "afiliado", "obra_social", "institucion", "procedimiento", "rol", "pct", "codigo_aac",
    "codigo_os", "valor_estimado", "valor_origen", "estado", "fecha_presentacion", "fecha_cobro_estimada", "fecha_cobro", "monto_cobrado", "notas"];
  const filas = datos().prestaciones.filter((p) => p.fecha.slice(0, 7) === mes()).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const celda = (v) => (v == null ? "" : typeof v === "number" ? String(v).replace(".", ",") : `"${String(v).replace(/"/g, '""')}"`);
  return [cols.join(";")].concat(filas.map((p) => cols.map((c) => celda(p[c])).join(";"))).join("\r\n");
}

// ---------- Inicio de la app ----------

function mostrarSync(e) {
  const cuenta = Almacen.doc.cuenta;
  $("#sync").textContent = cuenta ? "Drive: " + (Almacen.pendiente && e === "al día" ? "cambios sin subir" : e) : "Solo en este dispositivo";
  Almacen.adjuntosPendientes().then((n) => { if (n) $("#sync").textContent += ` · ${n} ${n === 1 ? "documento" : "documentos"} por subir` +
    (Almacen.errorAdjuntos ? ` (${Almacen.errorAdjuntos})` : ""); }).catch(() => {});
  // Cambios que no llegaron a Drive (venció el acceso de Google): botón para subirlos
  $("#subir-ahora").hidden = !(cuenta && Almacen.pendiente && !Almacen.tieneToken() && !Almacen.bloqueada());
  if (estado.vista === "valores") verValores();
}

// Renovar el acceso de Google sin pedir nada (vuelve enseguida a la app). Solo si no hay nada a medio cargar.
function renovarAcceso() {
  if ($("#dlg").open || !$("#revision").hidden) return false;
  sessionStorage.setItem("liq_silencioso", String(Date.now()));
  Almacen.conectar({ silencioso: true });
  return true;
}

async function arrancar() {
  $("#mes").value = hoy().slice(0, 7);
  const vuelta = Almacen.recibirToken(); // {ok} | {error} | null
  await Promise.all([Almacen.iniciar(), Motor.cargarCatalogos(), cargarBase()]);
  Almacen.alCambiar = mostrarSync;
  $("#f-os").innerHTML = '<option value="">Todas</option>' + datos().obras.map((o) => `<option>${esc(o.nombre)}</option>`).join("") + '<option value="-">Sin reconocer</option>';

  $$("nav.abajo button").forEach((b) => b.addEventListener("click", () => ir(b.dataset.vista)));
  $("#mes").addEventListener("change", () => { $("#f-periodo").value = "mes"; refrescar(); });
  $("#leer-planilla").addEventListener("change", (ev) => { leerPlanilla([...ev.target.files]); ev.target.value = ""; });
  $$("[data-leer]").forEach((i) => i.addEventListener("change", () => { leer(i.dataset.leer, [...i.files]); i.value = ""; }));
  $$("[data-pegado]").forEach((b) => b.addEventListener("click", () => {
    const t = $("#texto-pegado").value.trim();
    if (!t) return aviso("Pegá primero el texto");
    leer(b.dataset.pegado, [], t);
  }));
  $$("[data-nueva]").forEach((b) => b.addEventListener("click", () => editar({ fecha: hoy(), tipo: b.dataset.nueva, paciente: "", rol: "cirujano", pct: 100, estado: "pendiente", origen: "manual" })));
  $("#guardar-lote").addEventListener("click", guardarLote);
  $("#cancelar-lote").addEventListener("click", cerrarRevision);
  $("#f-periodo").addEventListener("change", () => {
    if ($("#f-periodo").value !== "mes" && !$("#f-desde").value) $("#f-desde").value = $("#f-periodo").value === "dia" ? hoy() : mes() + "-01";
  });
  ["#f-tipo", "#f-os", "#f-estado", "#f-periodo", "#f-desde", "#f-hasta"].forEach((s) => $(s).addEventListener("change", verPrestaciones));
  let tq; $("#f-q").addEventListener("input", () => { clearTimeout(tq); tq = setTimeout(verPrestaciones, 250); });
  const abrir = (ev) => {
    const sel = ev.target.closest("[data-sel]");
    if (sel) { sel.checked ? estado.seleccion.add(sel.dataset.sel) : estado.seleccion.delete(sel.dataset.sel); actualizarSeleccion(); return; }
    if (ev.target.closest("a")) return; // enlace a la carpeta del Drive: se abre sin abrir la ficha
    const item = ev.target.closest(".item");
    if (item) editar(datos().prestaciones.find((p) => p.id === item.dataset.id));
  };
  $("#lista").addEventListener("click", abrir);
  $("#vencidas").addEventListener("click", abrir);
  $$("[data-marcar]").forEach((b) => b.addEventListener("click", () => marcar(b.dataset.marcar)));
  $("#guardar-ref").addEventListener("click", async () => {
    if ($("#uq-valor").value && $("#uq-vigencia").value) {
      const vig = $("#uq-vigencia").value + "-01";
      if (!datos().uq.some((u) => u.vigencia === vig && u.valor === +$("#uq-valor").value)) {
        await Almacen.guardar("uq", { valor: +$("#uq-valor").value, vigencia: vig, fuente: "Cargado por el médico" });
      }
    }
    await Almacen.ajuste("inflacion_mensual", $("#inflacion").value || "0");
    if (!esAnestesia()) {
      await Almacen.ajuste("pct_modulo_general", Number($("#pct-modulo-general").value) || 0); // vacío = no se usa
      if ($("#liq-anterior-pct").value !== "") await Almacen.ajuste("liq_anterior_pct", Number($("#liq-anterior-pct").value));
      if ($("#liq-anterior-hasta").value) await Almacen.ajuste("liq_anterior_hasta", $("#liq-anterior-hasta").value);
    }
    if (esAnestesia()) await Almacen.ajuste("pct_asociacion", $("#pct-asociacion").value === "" ? 0 : Number($("#pct-asociacion").value));
    const n = await recalcularPendientes();
    aviso(`Guardado; ${n} pendientes recalculadas.`);
    verValores();
  });
  $("#apellido").addEventListener("change", () => Almacen.ajuste("apellido", $("#apellido").value.trim()));
  $("#recalcular").addEventListener("click", async () => aviso(`${await recalcularPendientes()} prestaciones recalculadas`));
  $("#an-anio").addEventListener("change", verAnalisis);
  $("#liq-anio").addEventListener("change", verHistorialLiquidaciones);
  $("#liq-vista").addEventListener("change", verHistorialLiquidaciones);
  $("#historial-liq").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-cambiar-cobro]");
    if (!b) return;
    const f = fechaDeTexto(prompt("Fecha de cobro de esta liquidación (día/mes/año):") || "");
    if (!f) return aviso("Fecha no válida (escribila como día/mes/año)");
    const ids = new Set(b.dataset.cambiarCobro.split(","));
    for (const p of datos().prestaciones.filter((x) => ids.has(x.id))) await guardarPrestacion({ ...p, fecha_cobro: f });
    aviso("Fecha de cobro corregida."); verCobros();
  });
  $("#historial-liq").addEventListener("click", (ev) => { const tr = ev.target.closest("tr[data-id]"); const p = tr && datos().prestaciones.find((x) => x.id === tr.dataset.id); if (p) editar(p); });
  $("#unir-repetidas").addEventListener("click", async () => {
    if (!confirm("¿Unir las cirugías repetidas (mismo paciente y mismo día)? Queda la más completa; las otras se pueden recuperar desde un respaldo.")) return;
    const n = await unirRepetidas(); aviso(n ? `Se unieron ${n} repetidas.` : "No hay cirugías repetidas."); refrescar();
  });
  $("#exportar").addEventListener("click", async () => {
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([await construirExcel()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      a.download = `Liquidaciones ${hoy()}.xlsx`; a.click();
    } catch (e) { aviso(e.message); }
  });
  $("#planilla").addEventListener("click", async () => {
    try {
      if (!Almacen.tieneToken()) return Almacen.conectar();
      await Almacen.subirPlanilla(await construirExcel());
      aviso("Excel guardado en Drive › Liquidaciones › Liquidaciones.xlsx");
    } catch (e) { aviso(e.message); }
  });
  Almacen.planilla = planillasDrive; // se actualizan en el Drive en cada sincronización
  // Sumar otra foto o página al documento que se está revisando: se vuelve a leer todo junto
  $("#agregar-foto-input").addEventListener("change", (ev) => {
    const nuevas = [...ev.target.files];
    ev.target.value = "";
    if (nuevas.length && ultimaLectura) leer(ultimaLectura.tipo, [...ultimaLectura.archivos, ...nuevas]);
  });
  $$("[data-liq]").forEach((i) => i.addEventListener("change", () => { leerLiquidacion([...i.files]); i.value = ""; }));
  $("#revision-filas").addEventListener("change", (ev) => {
    const c = ev.target.closest("[data-liq-incluir]");
    if (c && conciliacion) conciliacion.filas[+c.dataset.liqIncluir].incluir = c.checked;
  });
  $("#especialidad").addEventListener("change", () => cambiarRama($("#especialidad").value));
  $("#cambiar-rama").addEventListener("click", () => cambiarRama(esAnestesia() ? "cirugia" : "anestesia"));
  $("#cerrar-sesion").addEventListener("click", bloquearYa);
  $("#ane-os").addEventListener("change", verAranceles);
  $("#ane-vigencia").addEventListener("change", verAranceles);
  $("#ane-guardar").addEventListener("click", () => guardarAranceles().catch((e) => aviso(e.message)));
  $("#circuito").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-paso]");
    if (!tr) return;
    $("#f-periodo").value = "todos"; $("#f-estado").value = tr.dataset.paso; $("#f-tipo").value = "";
    ir("prestaciones");
  });
  $("#modo").addEventListener("change", async () => { await Almacen.ajuste("modo", $("#modo").value); aplicarModo(); aviso("Guardado"); });
  $("#sin-copia").addEventListener("click", (ev) => { if (ev.target.matches("[data-ir]")) { ev.preventDefault(); ir(ev.target.dataset.ir); } });
  $("#version-app").textContent = "Versión " + VERSION_APP;
  $("#actualizar-app").addEventListener("click", (ev) => { ev.preventDefault(); aviso("Buscando la versión nueva…"); actualizarAhora(); });
  $("#copia-bajar").addEventListener("click", async () => {
    const clave = prompt("Elegí una clave para la copia (mínimo 6 caracteres). Anotala: sin ella la copia no se puede abrir.");
    if (!clave) return;
    if (clave.length < 6) return aviso("La clave tiene que tener al menos 6 caracteres.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([await Almacen.exportarCopia(clave)], { type: "application/json" }));
    a.download = `Liquidaciones copia ${hoy()}.json`; a.click();
    await Almacen.marcarCopia();
    aviso("Copia descargada (cifrada). Guardala fuera del celular: mail, Drive o PC.");
  });
  $("#copia-subir").addEventListener("change", async (ev) => {
    const archivo = ev.target.files[0]; ev.target.value = "";
    if (!archivo) return;
    const clave = prompt("Clave de la copia:");
    if (!clave) return;
    try { aviso(`Copia restaurada: ${await Almacen.importarCopia(await archivo.text(), clave)} prestaciones nuevas (lo que ya tenías se mantiene).`); refrescar(); }
    catch (e) { aviso(e.message); }
  });
  $("#min-bloqueo").addEventListener("change", async () => {
    await Almacen.ajuste("minutos_bloqueo", +$("#min-bloqueo").value);
    Almacen.minutosBloqueo = +$("#min-bloqueo").value;
    aviso("Guardado");
  });
  const conectar = () => { try { Almacen.conectar(); } catch (e) { aviso(e.message); } };
  $("#conectar").addEventListener("click", conectar);
  $("#conectar-inicio").addEventListener("click", conectar);
  $("#sin-drive").addEventListener("click", async (ev) => {
    ev.preventDefault();
    await Almacen.usarLocal();
    Almacen.tienePin() ? pedirPin("desbloquear") : pedirPin("crear");
  });
  $("#sincronizar").addEventListener("click", () => (Almacen.tieneToken() ? Almacen.sincronizar().then(refrescar).catch((e) => aviso(e.message)) : renovarAcceso()));
  $("#subir-ahora").addEventListener("click", () => renovarAcceso() || aviso("Terminá de cargar lo que estás editando y volvé a tocar «Subir a Drive»."));
  // Al volver a la app con cambios sin subir y el acceso vencido: renovarlo y subir
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Almacen.bloqueada() || !Almacen.doc.cuenta) return;
    if (Almacen.tieneToken()) { if (Almacen.pendiente) Almacen.sincronizar().then(refrescar).catch(() => {}); }
    else if (Almacen.pendiente) renovarAcceso();
  });
  $("#salir").addEventListener("click", async (ev) => {
    ev.preventDefault();
    await cerrarCuenta();
  });
  $("#tabla-os").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-os]");
    if (tr) editarObraSocial(datos().obras.find((o) => o.nombre === tr.dataset.os));
  });
  $("#nueva-os").addEventListener("click", () => editarObraSocial({}));
  $("#v-os").addEventListener("change", verTablaValores);
  $("#nuevo-valor").addEventListener("click", nuevoValor);
  // Valores: cada sección se abre o se cierra (se recuerda en este celular)
  $$("details.plegable").forEach((d) => {
    try { d.open = localStorage.getItem("plegable-" + d.dataset.plegable) === "1"; } catch { /* sin almacenamiento */ }
    d.addEventListener("toggle", () => { try { localStorage.setItem("plegable-" + d.dataset.plegable, d.open ? "1" : "0"); } catch { /* idem */ } });
  });
  $("#ver-respaldos").addEventListener("click", () => verRespaldos().catch((e) => aviso(e.message)));
  $("#respaldos").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-respaldo]");
    if (!b || !confirm(`¿Recuperar desde el respaldo del ${b.dataset.dia}? Vuelve lo que falta o se borró; no cambia lo que tenés hoy.`)) return;
    try {
      const n = await Almacen.recuperarRespaldo(b.dataset.respaldo);
      aviso(n ? `${n} registros recuperados del respaldo del ${b.dataset.dia}.` : "No faltaba nada: tu base está completa.");
      refrescar();
    } catch (e) { aviso(e.message); }
  });
  $("#importar-valores").addEventListener("change", (ev) => { const a = [...ev.target.files]; ev.target.value = ""; if (a.length) importarValores(a); });
  $("#lotes-valores").addEventListener("click", (ev) => { const b = ev.target.closest("[data-borrar-lote]"); if (b) borrarLote(b.dataset.borrarLote); });
  $("#tabla-valores").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-borrar-valor]");
    if (b && confirm("¿Borrar este valor?")) { await Almacen.borrar("valores", b.dataset.borrarValor); verTablaValores(); }
  });
  registrarActualizaciones();
  window.addEventListener("online", () => Almacen.tieneToken() && Almacen.sincronizar().then(refrescar).catch(() => {}));

  configurarSeguridad();
  estado.volvioDeGoogle = !!vuelta?.ok;
  const cuenta = Almacen.cuenta, local = Almacen.local && !cuenta;
  // 1) Cuenta de Google primero (el PIN viene después)
  if (vuelta?.error) {
    sessionStorage.removeItem("liq_silencioso");
    if (!cuenta || (vuelta.error !== "interaction_required" && vuelta.error !== "login_required")) return bienvenida("No se pudo ingresar con Google. Probá de nuevo.");
    return bienvenida(`Tu sesión de Google venció: ingresá de nuevo con ${cuenta}.`);
  }
  if (!cuenta && !vuelta?.ok && !local) return bienvenida();
  // 2) Acceso a Drive vencido (dura 1 hora): renovarlo sin pedir nada, antes del PIN. Una vez por apertura.
  if (cuenta && !vuelta?.ok && Almacen.accesoVencido() && !sessionStorage.getItem("liq_silencioso")) return renovarAcceso();
  sessionStorage.removeItem("liq_silencioso");
  // 3) PIN
  if (Almacen.tienePin()) return Almacen.bloqueada() ? pedirPin("desbloquear") : entrar(); // sesión en uso: no pide el PIN al recargar
  pedirPin("crear");
}

// Lo cargado antes de esta versión: varias prestaciones del mismo paciente y día (mismo estado) → un solo acto
async function unificarActos() {
  if (ajuste("actos_unificados", false)) return;
  const grupos = {};
  for (const p of datos().prestaciones) {
    if (p.tipo === "consulta") continue;
    (grupos[Motor.plano(p.paciente).replace(/[^a-z]/g, "") + "|" + p.fecha] ||= []).push(p);
  }
  let unidos = 0;
  for (const g of Object.values(grupos)) {
    if (g.length < 2 || new Set(g.map((p) => p.estado)).size > 1) continue;
    g.sort((a, b) => (b.pct || 100) - (a.pct || 100) || (b.valor_estimado || 0) - (a.valor_estimado || 0));
    const [principal, ...resto] = g;
    const extras = [...(principal.extras || []), ...resto.flatMap((r) => [{ procedimiento: r.procedimiento, codigo_aac: r.codigo_aac, codigo_os: r.codigo_os }, ...(r.extras || [])])];
    const cobrado = g.some((x) => x.monto_cobrado != null) ? g.reduce((t, x) => t + (x.monto_cobrado || 0), 0) : principal.monto_cobrado;
    await guardarPrestacion({ ...principal, pct: 100, extras, monto_cobrado: cobrado });
    for (const r of resto) await Almacen.borrar("prestaciones", r.id);
    unidos++;
  }
  await Almacen.ajuste("actos_unificados", true);
  if (unidos) { aviso(`${unidos} cirugías con varios procedimientos quedaron agrupadas en un solo acto.`); refrescar(); }
}

// Cirugías repetidas (mismo paciente y día, de cada rama): queda una sola, la más completa (cobrada > presentada >
// cargada a mano o por foto > planilla), con los datos que le falten tomados de las otras. Las otras se marcan borradas
// (se recuperan desde un respaldo). También las de planilla que quedaron con la fecha del día en que se cargaron
// (versiones anteriores ponían la de hoy si no podían leerla) cuando la misma cirugía está con su fecha real.
// Para unir sola (sin preguntar) hace falta más que para avisar: mismo tipo y mismo DNI, o el mismo nombre completo (o el de
// la liquidación, que viene cortado: «PEREYRA,» con «PEREYRA, FRANCISCO»)
function mismaParaUnir(a, b) {
  if (a.tipo !== b.tipo || a.fecha !== b.fecha) return false;
  const dni = (x) => String(x.dni || "").replace(/\D/g, "");
  if (dni(a) && dni(b)) return dni(a) === dni(b);
  const x = claveNombre(a.paciente || ""), y = claveNombre(b.paciente || ""), completo = (n) => Motor.plano(n || "").replace(/[^a-z]/g, "");
  return completo(a.paciente) === completo(b.paciente) || (x.ap && x.ap === y.ap && (!x.nom || !y.nom));
}

// opciones.paso1: solo en el arreglo de la v55 (copias de planilla con la fecha del día de carga)
async function unirRepetidas({ paso1 = false } = {}) {
  const vivas = Almacen.doc.prestaciones.filter((p) => !p.borrada && p.tipo !== "consulta");
  const rama = (p) => p.especialidad || "cirugia", diaDe = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "");
  const borrar = new Set(), cambios = new Map();
  const peso = (p) => (["cobrada", "debitada"].includes(p.estado) ? 100 : p.estado === "presentada" ? 50 : 0) + (p.origen !== "planilla" ? 20 : 0) +
    ["dni", "afiliado", "obra_social", "institucion", "codigo_aac", "codigo_os", "complejidad", "nro_circuito"].filter((k) => p[k]).length;
  // 1) Planilla con la fecha del día de carga, repetida con su fecha real
  const proc = (p) => Motor.plano(p.procedimiento || "").replace(/[^a-z]/g, "");
  if (paso1) for (const p of vivas) {
    if (p.origen !== "planilla" || ["cobrada", "debitada"].includes(p.estado)) continue;
    const dia = diaDe(p.actualizado);
    if (!dia || Math.abs(Date.parse(p.fecha) - Date.parse(dia)) > 2 * 864e5) continue;
    const real = vivas.find((q) => q !== p && !borrar.has(q.id) && rama(q) === rama(p) && q.fecha < p.fecha && proc(q) && proc(q) === proc(p) &&
      mismaCirugia({ ...q, fecha: p.fecha }, p));
    if (real) borrar.add(p.id);
  }
  // 2) Mismo paciente y mismo día
  const porDia = {};
  for (const p of vivas) if (!borrar.has(p.id)) (porDia[rama(p) + "|" + p.fecha] ||= []).push(p);
  for (const lista of Object.values(porDia)) {
    const usados = new Set();
    for (const p of lista) {
      if (usados.has(p.id)) continue;
      const grupo = lista.filter((q) => !usados.has(q.id) && (q === p || mismaParaUnir(q, p)));
      grupo.forEach((q) => usados.add(q.id));
      if (grupo.length < 2) continue;
      // Dos cobros distintos el mismo día son pagos separados: no se tocan; el mismo cobro repetido (mismo monto y código,
      // de una liquidación cargada dos veces) sí se une
      const cobros = grupo.filter((q) => ["cobrada", "debitada"].includes(q.estado));
      const firma = (q) => Math.round(q.monto_cobrado || 0) + "|" + (q.codigo_os || "");
      if (cobros.length > 1 && new Set(cobros.map(firma)).size > 1) continue;
      grupo.sort((a, b) => peso(b) - peso(a));
      const [queda, ...resto] = grupo;
      const nuevo = { ...queda };
      for (const r of resto) {
        for (const k of CAMPOS) if ((nuevo[k] == null || nuevo[k] === "" || (Array.isArray(nuevo[k]) && !nuevo[k].length)) && r[k] != null && r[k] !== "" &&
          !(Array.isArray(r[k]) && !r[k].length) && !["estado", "origen", "solo_registro", "id"].includes(k)) nuevo[k] = r[k];
        if (r.procedimiento && proc(r) !== proc(nuevo)) nuevo.notas = [nuevo.notas, `También figuraba: ${r.procedimiento}`].filter(Boolean).join(" · ");
        borrar.add(r.id);
      }
      if (queda.origen !== "planilla") nuevo.solo_registro = false;
      cambios.set(queda.id, nuevo);
    }
  }
  // 2b) El mismo cobro repetido (también consultas): mismo paciente, día, código y monto cobrado → queda uno
  const cobroIgual = {};
  for (const p of Almacen.doc.prestaciones.filter((q) => !q.borrada && !borrar.has(q.id) && ["cobrada", "debitada"].includes(q.estado) && q.monto_cobrado)) {
    const k = [rama(p), p.tipo === "consulta", p.fecha, Motor.plano(p.paciente || "").replace(/[^a-z]/g, ""), p.codigo_os || "", Math.round(p.monto_cobrado)].join("|");
    if (cobroIgual[k] && !cambios.has(p.id)) borrar.add(p.id); else cobroIgual[k] ||= p.id;
  }
  // 3) Lo que una liquidación agregó como nuevo («MODULO 4 DE…») cuando la misma cirugía ya estaba (por ejemplo en la
  // planilla) sin cobrar, con fecha cercana (hasta 7 días antes de la emisión): queda la cirugía con su nombre y su fecha,
  // y se le pasa el cobro
  const libres = vivas.filter((q) => !borrar.has(q.id) && !["cobrada", "debitada"].includes(q.estado));
  // Que sea la misma cirugía: mismo código o atención, o la cirugía propia es una de las del módulo cobrado (o el mismo día)
  const palabras = (t) => Motor.plano(t || "").split(/[^a-z]+/).filter((w) => w.length >= 6);
  const compatibles = (x, l) => (x.codigo_os && x.codigo_os === l.codigo_os) || (x.atencion && x.atencion === l.atencion) ||
    (itemsModulo(l.codigo_os).length ? palabras(x.procedimiento).some((w) => itemsModulo(l.codigo_os).some((it) => Motor.plano(it).includes(w))) : diasEntre(x.fecha, l.fecha) <= 1);
  const tomadas = new Set();
  for (const l of vivas.filter((q) => !borrar.has(q.id) && q.origen === "liquidacion" && ["cobrada", "debitada"].includes(q.estado))) {
    const q = libres.filter((x) => !tomadas.has(x.id) && rama(x) === rama(l) && diasEntre(x.fecha, l.fecha) <= 7 && x.fecha <= (l.fecha_cobro || "9999") &&
      x.tipo !== "consulta" && l.tipo !== "consulta" && mismoPaciente(x.paciente, l.paciente, true) && compatibles(x, l)).sort((a, b) => diasEntre(a.fecha, l.fecha) - diasEntre(b.fecha, l.fecha))[0];
    if (!q) continue;
    tomadas.add(q.id); borrar.add(l.id);
    const base = cambios.get(q.id) || q;
    cambios.set(q.id, { ...base, estado: l.estado, fecha_cobro: l.fecha_cobro, monto_cobrado: l.monto_cobrado, cobro_lineas: l.cobro_lineas, liquidacion: l.liquidacion,
      atencion: base.atencion || l.atencion, codigo_os: base.codigo_os || l.codigo_os, obra_social: base.obra_social || l.obra_social, solo_registro: false,
      notas: [base.notas, l.notas].filter(Boolean).join(" · ") });
  }
  for (const p of cambios.values()) await guardarPrestacion(p);
  if (borrar.size) await Almacen.guardarVarios("prestaciones", Almacen.doc.prestaciones.filter((p) => borrar.has(p.id)).map((p) => ({ ...p, borrada: true })));
  return borrar.size;
}

// v62: lo cargado desde liquidaciones con la descripción cortada («MODULO 4 DE») toma la cirugía por su código
async function nombrarCirugiasDeLiquidacion() {
  if (ajuste("cirugias_por_codigo_v62", false) || !Motor.catalogos.PAMI) return;
  const cambiar = Almacen.doc.prestaciones.filter((p) => !p.borrada && p.codigo_os && procedimientoCortado(p));
  await guardarEnLote(async () => { for (const p of cambiar) try {
    const cx = procedimientoDeCodigo(p.codigo_os, p.procedimiento, p.paciente, p.fecha);
    await guardarPrestacion({ ...p, procedimiento: cx.procedimiento, procedimiento_estimado: cx.estimado,
      extras: (p.extras || []).map((x) => (x.codigo_os && !/[a-zñáéíóú]/.test(x.procedimiento || "") ? { ...x, procedimiento: procedimientoDeCodigo(x.codigo_os, x.procedimiento).procedimiento } : x)) });
  } catch {} });
  await Almacen.ajuste("cirugias_por_codigo_v62", true);
  if (cambiar.length) { aviso(`${cambiar.length} cirugías de liquidaciones tomaron su nombre por el código (las «probables» se confirman en la ficha).`); refrescar(); }
}

// v60: los cobros repetidos (la misma liquidación cargada varias veces) se unen
async function arreglarCobrosRepetidos() {
  if (ajuste("arreglo_cobros_v60", false)) return;
  const n = await unirRepetidas();
  await Almacen.ajuste("arreglo_cobros_v60", true);
  if (n) { aviso(`Se unieron ${n} cobros repetidos (la misma liquidación cargada más de una vez).`); refrescar(); }
}

// v58: une lo que las liquidaciones agregaron como nuevo con la misma cirugía ya cargada (fecha cercana)
async function arreglarLiquidaciones() {
  if (ajuste("arreglo_liq_v58", false)) return;
  const n = await unirRepetidas();
  await Almacen.ajuste("arreglo_liq_v58", true);
  if (n) { aviso(`Se unieron ${n} cirugías que las liquidaciones habían agregado repetidas (quedan con su procedimiento y el cobro).`); refrescar(); }
}

// v55: lo cargado desde planillas pasa a «solo registro» (no suma a lo que falta cobrar) y se unen las cirugías repetidas
async function arreglarPlanillas() {
  if (ajuste("arreglo_planillas_v55", false)) return;
  const viejas = Almacen.doc.prestaciones.filter((p) => !p.borrada && p.origen === "planilla" && ["pendiente", "presentada"].includes(p.estado) && !p.solo_registro);
  if (viejas.length) await Almacen.guardarVarios("prestaciones", viejas.map((p) => ({ ...p, solo_registro: true, valor_estimado: null,
    valor_origen: "Solo registro (cargada desde una planilla): sin valor ni cobro esperado", fecha_presentacion: null, fecha_cobro_estimada: null })));
  const n = await unirRepetidas({ paso1: true });
  await Almacen.ajuste("arreglo_planillas_v55", true);
  if (viejas.length || n) {
    aviso(`Arreglado: ${viejas.length} cirugías de planillas quedaron como solo registro (no suman a lo que falta cobrar)` +
      (n ? ` y se unieron ${n} repetidas (se recuperan desde un respaldo si hiciera falta).` : "."));
    refrescar();
  }
}

// ---------- Actualizaciones de la app ----------
const VERSION_APP = "67"; // igual que VERSION en sw.js

function registrarActualizaciones() {
  if (!("serviceWorker" in navigator)) return;
  const habia = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => reg.update()).catch(() => {});
  // Versión nueva instalada: recargar una vez para usarla (si no hay nada a medio cargar)
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!habia || sessionStorage.getItem("liq_recargada")) return;
    if ($("#dlg").open || !$("#revision").hidden) return aviso("Hay una versión nueva de la app: se usa al volver a abrirla.");
    sessionStorage.setItem("liq_recargada", "1");
    location.reload();
  });
}

// Forzar: borrar la copia guardada de la app (no los datos ni el lector) y volver a bajarla
async function actualizarAhora() {
  try {
    for (const k of await caches.keys()) if (!k.includes("libs")) await caches.delete(k);
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.update();
  } catch { /* sin service worker */ }
  sessionStorage.removeItem("liq_recargada");
  location.reload();
}

function bienvenida(mensaje) {
  $("#bienvenida-aviso").textContent = mensaje || "";
  $("#bienvenida-aviso").hidden = !mensaje;
  ir("bienvenida");
}

// Ya desbloqueada (o con el PIN recién creado)
function entrar() {
  $("#pin").value = $("#pin2").value = "";
  // v52: las pendientes se recalculan una vez (sin % general del módulo; la referencia cargada no la pisa un cobro) (el valor a mano no se toca)
  // Los arreglos de una vez corren con los datos al día (después de traer lo del Drive): así un celular con datos viejos
  // no los aplica sobre lo viejo y pisa lo hecho en otro
  // v66: lo cobrado hasta 2025 era ~65–70 % de tu parte, no 30 % (dividir por 0,30 daba más que el módulo entero)
  const liq70 = () => (ajuste("liq_anterior_70_v66", false) ? Promise.resolve() : (Number(ajuste("liq_anterior_pct", 70)) === 30 ? Almacen.ajuste("liq_anterior_pct", 70) : Promise.resolve())
    .then(() => Almacen.ajuste("liq_anterior_70_v66", true)));
  const arreglos = () => liq70().then(() => ajuste("recalculo_v66", false) ? Promise.resolve() : recalcularPendientes().then(() => Almacen.ajuste("recalculo_v66", true)))
    .then(arreglarPlanillas).then(arreglarLiquidaciones).then(arreglarCobrosRepetidos).then(nombrarCirugiasDeLiquidacion).then(ordenarDrive)
    .then(() => refrescar()).catch((e) => aviso(e.message));
  Almacen.minutosBloqueo = minutosBloqueo();
  aplicarModo();
  $("#f-os").innerHTML = '<option value="">Todas</option>' + datos().obras.map((o) => `<option>${esc(o.nombre)}</option>`).join("") + '<option value="-">Sin reconocer</option>';
  mostrarSync(Almacen.estado);
  ir("inicio");
  if (Almacen.tieneToken()) {
    // Al entrar: traer lo cargado en otros dispositivos y subir lo de este
    Almacen.sincronizar().then(() => { if (estado.volvioDeGoogle) aviso("Datos al día con Google Drive (" + Almacen.doc.cuenta + ")"); estado.volvioDeGoogle = false; refrescar(); })
      .then(arreglos, (e) => aviso(e.message)).finally(() => { unificarActos().catch(() => {}); aplicarModo(); preguntarEspecialidad(); });
  } else if (Almacen.doc.cuenta) {
    // Con Drive pero sin acceso ahora: los arreglos esperan a la próxima sincronización
    mostrarSync("cambios sin subir");
    unificarActos().catch(() => {});
    preguntarEspecialidad();
  } else {
    arreglos();
    unificarActos().catch(() => {});
    preguntarEspecialidad();
  }
}

// ---------- Seguridad: PIN, bloqueo automático ----------

const minutosBloqueo = () => +ajuste("minutos_bloqueo", 15);
const TEXTOS_PIN = {
  crear: ["Creá tu PIN", "Protege los datos de tus pacientes en este celular: quedan cifrados y solo se abren con el PIN. Mínimo 6 números. No se puede recuperar: anotalo en un lugar seguro.", "Crear PIN"],
  desbloquear: ["Desbloquear", "Ingresá tu PIN.", "Entrar"],
  cambiar: ["Cambiar PIN", "Ingresá el PIN actual y el nuevo (mínimo 6 números).", "Cambiar"],
};

function pedirPin(modo) {
  estado.modoPin = modo;
  const [titulo, ayuda, boton] = TEXTOS_PIN[modo];
  $("#pin-titulo").textContent = titulo; $("#pin-ayuda").textContent = ayuda; $("#pin-ok").textContent = boton;
  $("#pin2").hidden = modo === "desbloquear";
  $("#pin").placeholder = modo === "cambiar" ? "PIN actual" : "PIN";
  $("#pin2").placeholder = modo === "cambiar" ? "PIN nuevo" : "Repetí el PIN";
  $("#olvide-pin").hidden = modo === "crear";
  $("#pin-error").hidden = true;
  ir("pin");
  setTimeout(() => $("#pin").focus(), 50);
}

function configurarSeguridad() {
  $("#form-pin").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pin = $("#pin").value, pin2 = $("#pin2").value, error = $("#pin-error"), boton = $("#pin-ok");
    const mostrar = (t) => { error.textContent = t; error.hidden = false; $("#pin").value = ""; $("#pin").focus(); };
    const valido = (x) => /^\d{6,12}$/.test(x);
    error.hidden = true; boton.disabled = true;
    try {
      if (estado.modoPin === "desbloquear") await Almacen.desbloquear(pin);
      else if (estado.modoPin === "crear") {
        if (!valido(pin)) return mostrar("El PIN tiene que tener entre 6 y 12 números.");
        if (pin !== pin2) { $("#pin2").value = ""; return mostrar("Los dos PIN no coinciden."); }
        await Almacen.crearPin(pin);
      } else {
        if (!valido(pin2)) return mostrar("El PIN nuevo tiene que tener entre 6 y 12 números.");
        await Almacen.cambiarPin(pin, pin2);
        aviso("PIN cambiado");
      }
      entrar();
    } catch (e) { mostrar(e.message); }
    finally { boton.disabled = false; }
  });
  $("#olvide-pin").addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (estado.modoPin === "cambiar") return entrar();
    if (!confirm("Sin el PIN, los datos de este celular no se pueden abrir: se van a borrar.\n\nSi tenías Google Drive conectado, después lo conectás de nuevo y se recupera lo que ya estaba copiado allá. ¿Borrar y empezar de nuevo?")) return;
    if (Almacen.pendiente && !confirm("⚠️ ATENCIÓN: en este celular hay cambios que todavía NO se subieron a Google Drive. Si seguís, esos cambios no se van a poder recuperar.\n\n¿Seguro que querés empezar de nuevo?")) return;
    await Almacen.olvidePin();
    location.reload();
  });
  $("#bloquear").addEventListener("click", () => menuConfiguracion().catch((e) => aviso(e.message)));
  $("#cambiar-pin").addEventListener("click", () => pedirPin("cambiar"));
  // Bloqueo automático: N minutos (Valores → Mi cuenta) sin tocar la app, o al volver a ella después de ese tiempo
  let ultima = Date.now();
  ["pointerdown", "keydown", "input"].forEach((e) => document.addEventListener(e, () => { ultima = Date.now(); Almacen.tocar(); }, { passive: true, capture: true }));
  const controlar = () => {
    if (Almacen.tienePin() && !Almacen.bloqueada() && Date.now() - ultima > minutosBloqueo() * 60e3) bloquearYa();
  };
  setInterval(controlar, 15000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && controlar());
}

// Se recarga la página: no queda en memoria ni en pantalla ningún dato de pacientes
// ⚙️ Configuración (arriba a la derecha): rama del administrador, cerrar sesión, cerrar la cuenta en este celular…
// Guía corta, según la rama (para que cada colega empiece solo)
function verGuia() {
  const dlg = $("#dlg"), cuerpo = $("#dlg-cuerpo");
  cuerpo._actual = null;
  const pasos = esAnestesia() ? [
    ["📷 Cargar", "En <b>Cargar → Parte quirúrgico</b> elegí todas las fotos o PDF del acto juntos (o «Sacar varias fotos seguidas»): protocolo quirúrgico, registro de anestesia, autorización y hojas de la historia clínica. La app lee los datos del paciente y elige la mejor foto para cada documento."],
    ["✅ Revisar", "Revisá paciente, fecha, obra social y <b>complejidad</b> (la app sugiere la del nomenclador de anestesiólogos). En «Fotos cargadas» podés corregir qué es cada foto. Tocá <b>Guardar</b>."],
    ["📁 Drive", "Los documentos se guardan en PDF en <b>Liquidaciones › Anestesiología › Pacientes › año</b>, una carpeta por paciente («fecha – APELLIDO – Ref 0001»). Las liquidaciones, en «Liquidaciones cobradas». En el buscador del Drive podés buscar por nombre, DNI, obra social o Ref. Esperá el aviso «✓ Documentos subidos»."],
    ["🔁 Circuito", "En <b>Inicio</b>: «Falta documentación» → «Listas para cargar» → «Cargadas» → «Liquidadas». Cuando cargás en la asociación, poné el <b>N° de circuito</b> y marcala como cargada; cuando liquidan, anotá el monto."],
    ["💲 Valores", "En <b>Valores → Aranceles por complejidad</b> cargá lo que paga cada obra social y el % que retiene la asociación."],
  ] : [
    ["📷 Cargar", "En <b>Cargar</b>: foto o PDF del <b>listado diario</b> (consultas) o del <b>parte quirúrgico</b>. La app reconoce paciente, obra social y procedimiento, y sugiere código y valor."],
    ["📁 Drive", "Todo queda en tu Drive en <b>Liquidaciones › Cirugía</b>: «Pacientes › año» (una carpeta por paciente con el parte y sus datos en PDF), «Liquidaciones cobradas», «Listados de consultas» y «Planillas cargadas». Los nombres empiezan con la fecha; en el buscador del Drive podés buscar por apellido, DNI u obra social."],
    ["✅ Revisar", "Revisá los datos, el código y el % (ayudante, operación múltiple, módulo). Tocá <b>Guardar</b>."],
    ["📤 Presentar y cobrar", "En <b>Prestaciones</b> tildá varias y marcalas presentadas o cobradas. Con el PDF de la liquidación del sanatorio («Cargar la liquidación»), se marcan solas con el monto real."],
    ["💲 Valores", "En <b>Valores</b> importá listas de valores (Excel, PDF, Word o foto). Lo que te pagan de verdad corrige las estimaciones siguientes."],
  ];
  cuerpo.innerHTML = `<h2>Cómo se usa</h2>` + pasos.map(([t, d]) => `<p><b>${t}</b><br><span class="ayuda" style="margin:0">${d}</span></p>`).join("") +
    `<p class="ayuda"><b>Tus datos</b> quedan cifrados en el celular y en <b>tu</b> Google Drive (respaldo diario automático). Nadie más los ve.
     Arriba, «Drive: al día» indica que todo está guardado.</p><div class="fila"><button class="boton" data-cerrar>Listo</button></div>`;
  cuerpo.onclick = (ev) => { if (ev.target.matches("[data-cerrar]")) dlg.close(); };
  dlg.showModal();
}

async function menuConfiguracion() {
  const admin = await esAdmin(), dlg = $("#dlg"), cuerpo = $("#dlg-cuerpo");
  if (dlg.open) return;
  cuerpo._actual = null;
  const cuenta = Almacen.doc.cuenta;
  cuerpo.innerHTML = `<h2>Configuración</h2>
    <p class="ayuda">${cuenta ? "Cuenta: " + esc(cuenta) : "Sin Google Drive: los datos están solo en este celular."} · ${ESPECIALIDADES[esAnestesia() ? "anestesia" : "cirugia"]}</p>
    <div style="display:grid;gap:8px">
      ${admin ? `<button class="boton secundario" data-menu="rama">⇄ Pasar a ${esAnestesia() ? "Cirugía" : "Anestesiología"}</button>` : ""}
      <button class="boton secundario" data-menu="guia">📖 Cómo se usa</button>
      <button class="boton secundario" data-menu="valores">⚙️ Valores y mi cuenta</button>
      <button class="boton secundario" data-menu="actualizar">⟳ Buscar actualización</button>
      ${Almacen.tienePin() ? '<button class="boton secundario" data-menu="sesion">🔒 Cerrar sesión <small>(pide el PIN para volver)</small></button>' : ""}
      <button class="boton peligro" data-menu="cuenta">Cerrar cuenta en este celular</button>
      <button class="boton secundario" data-menu="cerrar">Volver</button>
    </div>
    <p class="ayuda">«Cerrar cuenta» quita la cuenta y los datos de este celular solo si todo está guardado en tu Drive; para volver: ingresar con Google.</p>`;
  cuerpo.onclick = async (ev) => {
    const b = ev.target.closest("[data-menu]");
    if (!b) return;
    dlg.close();
    const accion = b.dataset.menu;
    if (accion === "rama") await cambiarRama(esAnestesia() ? "cirugia" : "anestesia");
    else if (accion === "valores") ir("valores");
    else if (accion === "guia") verGuia();
    else if (accion === "actualizar") { aviso("Buscando la versión nueva…"); actualizarAhora(); }
    else if (accion === "sesion") await bloquearYa();
    else if (accion === "cuenta") await cerrarCuenta();
  };
  dlg.showModal();
}

// Cerrar la cuenta en este celular: nunca se borra del celular algo que no esté a salvo en el Drive
async function cerrarCuenta() {
  if (!Almacen.doc.cuenta) return aviso("Tus datos están solo en este celular: conectá Google Drive (o descargá una copia) antes de cerrar la cuenta.");
  try { await Almacen.sincronizar(); } catch { /* se avisa abajo */ }
  if (Almacen.pendiente || Almacen.estado !== "al día" || await Almacen.adjuntosPendientes())
    return aviso("No se pudo subir todo a tu Drive (datos o documentos): no se cierra la cuenta para no perder nada. Probá de nuevo con señal.");
  if (!confirm("Tus datos están a salvo en tu Drive. Se quitan de ESTE celular junto con el PIN (para volver: ingresar con Google). ¿Seguir?")) return;
  await Almacen.desconectar(); location.reload();
}

async function bloquearYa() {
  await Almacen.bloquear();
  location.reload();
}

arrancar().catch((e) => aviso(e.message));
