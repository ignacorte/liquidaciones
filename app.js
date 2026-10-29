"use strict";
// Liquidaciones (celular, sin servidor). Vistas: inicio, cargar, prestaciones, cobros, valores.
// Cálculo: motor.js · Lectura de documentos: lector.js · Datos y Google Drive: almacen.js

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pesos = (n) => (n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString("es-AR"));
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
const DOCS = {
  quirurgica: { campo: "doc_foja", lista: "foja_archivos", nombre: "Foja quirúrgica", corto: "foja quirúrgica", archivo: "Foja quirúrgica", ruta: ["Anestesiología", "Fojas"] },
  anestesia: { campo: "doc_foja_anestesia", lista: "foja_anestesia_archivos", nombre: "Foja de anestesia", corto: "foja de anestesia", archivo: "Foja de anestesia", ruta: ["Anestesiología", "Fojas"] },
  autorizacion: { campo: "doc_autorizacion", lista: "autorizacion_archivos", nombre: "Autorización de la obra social", corto: "autorización", archivo: "Autorización", ruta: ["Anestesiología", "Autorizaciones"] },
};
const docFaltante = (p) => (p.tipo === "consulta" ? [] : Object.values(DOCS).filter((x) => !p[x.campo]).map((x) => x.corto));
const SI_NO = { "": "—", si: "Sí", no: "No" };
const ESTADOS = { pendiente: "Sin presentar", presentada: "Presentada", cobrada: "Cobrada", debitada: "Debitada" };
const CAMPOS = ["fecha", "hora", "tipo", "atencion", "paciente", "dni", "afiliado", "obra_social", "obra_social_texto", "institucion", "procedimiento",
  "diagnostico", "abordaje", "urgencia", "rol", "pct", "pct_modulo", "codigo_aac", "codigo_os", "valor_manual", "estado", "fecha_presentacion",
  "fecha_cobro", "monto_cobrado", "origen", "notas", "endoscopia", "ciego", "polipectomia", "observaciones", "extras",
  "complejidad", "edad_grupo", "feriado", "obesidad", "suspendida", "doc_foja", "doc_autorizacion", "especialidad", "foja_archivos",
  "doc_foja_anestesia", "foja_anestesia_archivos", "autorizacion_archivos", "nro_circuito", "nro_ref"];

// Endoscopía: el procedimiento se escribe solo a partir del tipo (si no se escribió otro)
function textoEndoscopia(p) {
  const base = { alta: "Videoendoscopía digestiva alta", baja: "Videocolonoscopía", ambas: "Videoendoscopía digestiva alta + videocolonoscopía" }[p.endoscopia];
  return base ? base + (p.polipectomia === "si" ? " con polipectomía" : "") : "";
}
const esTextoAutomatico = (t) => !t || /^Videoendoscop|^Videocolonosc/.test(t);

// Procedimientos: datos del paciente obligatorios (para facturar y para el registro)
function faltantes(p) {
  if (p.tipo === "consulta" || p.origen === "liquidacion") return [];
  const f = [];
  if (!(p.paciente || "").trim()) f.push("nombre y apellido");
  if (!(p.dni || "").trim()) f.push("DNI");
  if (!p.obra_social) f.push("obra social");
  if (!(p.afiliado || "").trim() && p.obra_social !== "PARTICULAR") f.push("n.º de afiliado");
  if (p.tipo === "endoscopia" && !p.endoscopia) f.push("tipo de endoscopía");
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
  const obras = estado.base.obras.filter((o) => !propias.has(o.nombre)).concat([...propias.values()]).map((o) => ({ activa: true, ...o }));
  const valoresPropios = vivos(d.valores);
  const clave = (v) => v.obra_social + "|" + String(v.codigo).replace(/[.\-\s]/g, "") + "|" + v.vigencia;
  const tapados = new Set(valoresPropios.map(clave));
  const esp = rama || ajuste("especialidad", "cirugia");
  const deLaRama = (v) => (esp === "anestesia") === String(v.codigo || "").startsWith("ANE-");
  return { obras, especialidad: esp, pct_asociacion: Number(ajuste("pct_asociacion", 0)) || 0, valores: estado.base.valores.filter((v) => !tapados.has(clave(v))).concat(valoresPropios).filter(deLaRama),
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
  limpio.extras = limpio.tipo === "consulta" ? [] : (p.extras || []).filter((x) => (x.procedimiento || "").trim()).map(({ sugerencias, valor, ...x }) => x);
  limpio.especialidad ||= ajuste("especialidad", "cirugia"); // cada prestación queda en su especialidad
  if (limpio.especialidad === "anestesia" && !limpio.nro_ref) limpio.nro_ref = proximaRef();
  limpio.estado ||= "pendiente"; limpio.tipo ||= "consulta"; limpio.rol ||= "cirujano"; if (limpio.pct == null || limpio.pct === "") limpio.pct = 100; limpio.origen ||= "manual";
  return Almacen.guardar("prestaciones", Motor.completar(datos(), limpio));
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

const TITULOS = { inicio: "Inicio", cargar: "Cargar", prestaciones: "Prestaciones", cobros: "Cobros", valores: "Valores", bienvenida: "Liquidaciones", pin: "Liquidaciones" };

function ir(vista) {
  estado.vista = vista;
  $$("main > section").forEach((s) => (s.hidden = s.id !== "v-" + vista));
  $$("nav.abajo button").forEach((b) => b.classList.toggle("activa", b.dataset.vista === vista));
  const afuera = ["bienvenida", "pin"].includes(vista);
  $("nav.abajo").hidden = afuera;
  $("#bloquear").hidden = afuera;
  $("#cambiar-rama").hidden = afuera;
  $("#titulo").textContent = TITULOS[vista];
  $("#mes").hidden = !["inicio", "prestaciones", "valores"].includes(vista);
  ({ inicio: verInicio, prestaciones: verPrestaciones, cobros: verCobros, valores: verValores }[vista] || (() => {}))();
}
const refrescar = () => { if (esAnestesia() && !Almacen.bloqueada()) numerarAnestesias().catch(() => {}); ir(estado.vista); };

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
  $("#kpis").innerHTML = kpi("Facturado estimado", pesos(t.estimado)) + kpi("Cobrado", pesos(t.cobrado), "verde") +
    kpi("Falta cobrar", pesos(t.pendiente)) + kpi("Vencido", pesos(t.vencido), t.vencido ? "rojo" : "") +
    kpi(esAnestesia() ? "Consultas preanestésicas" : "Consultas", t.consultas) + kpi(esAnestesia() ? "Anestesiologías" : "Cirugías", t.cirugias) + kpi("Prestaciones", t.n) +
    kpi(`Pérdida por demora (${inflacion} %/mes)`, pesos(t.perdida_inflacion), t.perdida_inflacion ? "rojo" : "");
  const max = Math.max(1, ...r.por_obra_social.map((o) => o.estimado));
  $("#por-os").innerHTML = r.por_obra_social.length ? `<table><tr><th>Obra social</th><th class="n">#</th><th class="n">Estimado</th><th class="n">Cobrado</th><th class="n">Falta</th></tr>` +
    r.por_obra_social.map((o) => `<tr data-os="${esc(o.obra_social)}"><td>${esc(o.obra_social)}<div class="barra"><i style="width:${(100 * o.estimado) / max}%"></i></div></td>
      <td class="n">${o.n}</td><td class="n">${pesos(o.estimado)}</td><td class="n">${pesos(o.cobrado)}</td><td class="n">${pesos(o.pendiente)}</td></tr>`).join("") + "</table>"
    : `<p class="ayuda">Sin prestaciones en ${nombreMes(mes())}. Cargá el listado del día o un parte desde «Cargar».</p>`;
  $("#por-paciente").innerHTML = r.por_paciente.length ? `<table><tr><th>Paciente</th><th class="n">#</th><th class="n">Estimado</th><th class="n">Cobrado</th></tr>` +
    r.por_paciente.map((p) => `<tr><td>${esc(p.paciente)}<div class="ayuda" style="margin:0">${esc(p.obra_social)}</div></td>
      <td class="n">${p.n}</td><td class="n">${pesos(p.estimado)}</td><td class="n">${pesos(p.cobrado)}</td></tr>`).join("") + "</table>" : "";
}

// Anestesiología: en qué paso está cada anestesia (documentación → carga en la asociación → liquidación), de todos los meses
function verCircuito() {
  if (!esAnestesia()) return;
  const lista = datos().prestaciones.filter((p) => p.tipo !== "consulta" || p.estado !== "cobrada");
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

// Especialidad. Administrador: elige el camino cada vez que entra. Colegas: una sola vez, la primera (después ven solo ese)
async function preguntarEspecialidad() {
  const admin = await esAdmin();
  document.body.classList.toggle("admin", admin);
  if ((!admin && Almacen.doc.ajustes.especialidad) || $("#dlg").open || estado.caminoElegido) return;
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
    <label class="ancho">Procedimiento<input name="procedimiento" value="${esc(p.procedimiento)}"></label>
    <label class="ancho economia">Código AAC<select name="codigo_aac">${opcionesCodigo(p)}</select></label>
    <div class="ancho fila economia" style="margin-top:-4px"><button type="button" class="boton chico secundario" data-buscar-codigo>Buscar otro código</button></div>
    ${camposExtras(p)}
    <label>Abordaje${sel("abordaje", { "": "—", laparoscopica: "Laparoscópica", convencional: "Convencional", robotica: "Robótica", percutanea: "Percutánea", endoscopica: "Endoscópica" }, p.abordaje || "")}</label>
    <label>Rol${sel("rol", { cirujano: "Cirujano", ayudante: "Ayudante" }, p.rol || "cirujano")}</label>
    <label class="economia">% a facturar<input type="number" name="pct" value="${p.pct ?? 100}" min="0" max="100"></label>
    ${p.tipo === "consulta" ? "" : `<label class="economia">% del módulo para vos<input type="number" name="pct_modulo" value="${p.pct_modulo ?? ""}" min="0" max="100" step="0.1" placeholder="si paga por módulo"></label>`}
    ${campoCodigoOS(p)}
    <label class="check"><input type="checkbox" name="urgencia" ${p.urgencia ? "checked" : ""}> Urgencia</label>` : ""}
    ${completo ? `
    ${quir && esAnestesia() ? "" : `<label>Hora<input type="time" name="hora" value="${esc(p.hora)}"></label>`}
    ${quir ? "" : `<label>DNI<input name="dni" value="${esc(p.dni)}" inputmode="numeric"></label>`}
    ${quir && esAnestesia() ? "" : `<label>Institución<input name="institucion" value="${esc(p.institucion)}"></label>`}
    <label class="economia">Valor a mano ($)<input type="number" name="valor_manual" value="${p.valor_manual ?? ""}" placeholder="vacío = estimado"></label>
    <label class="economia">Estado${sel("estado", ESTADOS, p.estado || "pendiente")}</label>
    <label class="economia">${esAnestesia() ? "Cargada el" : "Presentada el"}${campoFecha("fecha_presentacion", p.estado === "pendiente" ? "" : p.fecha_presentacion)}</label>
    <label class="economia">${esAnestesia() ? "Liquidada el" : "Cobrada el"}${campoFecha("fecha_cobro", p.fecha_cobro)}</label>
    <label class="economia">${esAnestesia() ? "Monto liquidado, neto ($)" : "Monto cobrado ($)"}<input type="number" name="monto_cobrado" value="${p.monto_cobrado ?? ""}"></label>
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
    ${p.nro_ref ? `<p class="ancho ayuda" style="margin:0">Referencia: <b>Ref. ${refTexto(p)}</b> (va en el nombre de sus PDF en el Drive)</p>` : ""}
    ${marca("feriado", "Feriado (+50 %)" + (Motor.feriadoNacional(p.fecha) ? " · es feriado nacional" : ""))}
    ${marca("obesidad", "Obesidad mórbida (+2 complejidades)")}
    ${marca("suspendida", "Operación suspendida (complejidad 1)")}
    <div class="ancho ayuda" style="margin:6px 0 0"><b>Documentación</b></div>
    ${Object.entries(DOCS).map(([clase, x]) => documento(p, clase, x, marca)).join("")}
    <p class="ancho ayuda" style="margin:0">Nocturno (20 a 7 h, +35 %) y fin de semana (sábado 13 h a lunes 7 h, +50 %) salen de la fecha y la hora.</p>`;
}

// Un documento de la anestesia: casilla, archivos por guardar, enlaces al Drive y botón para adjuntar fotos o PDF
function documento(p, clase, x, marca) {
  const nuevos = documentosDe(p)[clase] || [], enDrive = p[x.lista] || [];
  return `${marca(x.campo, x.nombre)}
    <div class="ancho" data-doc="${clase}">
      ${nuevos.length ? `<p class="ayuda" style="margin:0">📄 ${(p._fotos || []).some((f) => f.clase === clase && f.reconocida) ? `Reconocida: es la ${x.corto}` : x.nombre} (${nuevos.length === 1 ? "1 foto" : nuevos.length + " fotos o páginas"} → un PDF): al guardar va a tu Drive › Liquidaciones › ${x.ruta.join(" › ")}${enDrive.length ? " y reemplaza al anterior" : ""}.</p>` : ""}
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
      const clase = ev.target.dataset.adjuntarDoc, x = DOCS[clase], archivos = [...ev.target.files], p = obtener();
      ev.target.value = "";
      guardar({ ...p, [x.campo]: true, _docs: { ...(p._docs || {}), [clase]: [...(p._docs?.[clase] || []), ...archivos] } });
      aviso(`${x.nombre}: ${archivos.length === 1 ? "agregada" : archivos.length + " fotos agregadas"}. Se guarda en tu Drive al tocar Guardar.`);
      return;
    }
    if (!ev.target.name || ["notas", "dni", "afiliado", "hora", "institucion", "nro_circuito", "estado", "monto_cobrado", "paciente", "ciego", "observaciones"].includes(ev.target.name)) return;
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
    mostrarRevision(filas.map((f) => ({ ...f, fecha: f.fecha || hoy(), fecha_leida: !!f.fecha, ...Motor.estimar(d, { ...f, fecha: f.fecha || hoy() }) })),
      tipo === "parte" ? "Parte quirúrgico" : "Listado" + (filas[0].fecha ? " del " + fechaCorta(filas[0].fecha) : ""));
  } catch (e) {
    aviso(e.message);
    if (e.texto !== undefined && !e.capturaApp) {
      $("#texto-leido").textContent = e.texto;
      mostrarRevision([{ fecha: hoy(), tipo: tipo === "parte" ? "cirugia" : "consulta", paciente: "", rol: "cirujano", pct: 100, incluir: true, origen: "manual",
        ...(tipo === "parte" && esAnestesia() && archivos?.length ? { _fotos: archivos.map((a) => ({ archivo: a, clase: "", reconocida: false })) } : {}) }], "Completar a mano");
    } else $("#cargar-botones").hidden = false;
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
        <b>${esc(x.paciente || "Paciente " + (i + 1))}</b>${x.ausente ? ' <span class="chip vencida">ausente</span>' : ""}${x.estudio ? ' <span class="chip vencida">informe de estudio</span>' : ""}${fechaDudosa(x) ? ' <span class="chip vencida">revisá la fecha</span>' : ""}</label>` +
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
  for (const x of f._fotos || []) if (x.clase) (docs[x.clase] ||= []).push(x.archivo);
  return docs;
};

// Fecha no leída (se puso la de hoy) o de hace más de un año: casi siempre es otra fecha del documento
const fechaDudosa = (x) => !x.fecha_leida || Math.abs(Date.now() - Date.parse(x.fecha)) > 366 * 864e5;

function cerrarRevision() { ultimaLectura = null; $("#agregar-foto").hidden = true; conciliacion = null; $("#guardar-lote").textContent = "Guardar"; $("#revision").hidden = true; $("#cargar-botones").hidden = false; filasRevision = []; }

// Documentos de la anestesia → Drive («Liquidaciones/Anestesiología/Fojas» y «…/Autorizaciones»), ligados a la prestación.
// Quedan cifrados en el celular y se suben en la sincronización (también si al guardar no había señal o el acceso de Google
// estaba vencido). Devuelve cuántos archivos quedaron por subir.
// «Ref 0012 – GOMEZ, ANA MARIA – 2026-10-21 – Circuito 4521 – Foja quirúrgica.pdf» (sin n° de circuito, sin esa parte)
function nombreDocumento(p, x, n, ext) {
  const limpio = (t) => String(t || "").replace(/[\\/:*?"<>|]/g, " ").trim();
  return [p.nro_ref && "Ref " + refTexto(p), limpio(p.paciente) || "paciente", p.fecha, p.nro_circuito && "Circuito " + limpio(p.nro_circuito), x.archivo]
    .filter(Boolean).join(" – ") + (n ? ` (${n})` : "") + ext;
}
// Si cambian el paciente, la fecha o el n° de circuito, los documentos ya subidos se renombran en el Drive
async function renombrarDocumentos(p) {
  let n = 0;
  for (const x of Object.values(DOCS)) {
    const lista = p[x.lista] || [];
    for (const [i, a] of lista.entries()) {
      const ext = (a.nombre.match(/(?: \(\d+\))?(\.[a-z0-9]+)$/i) || [, ""])[1];
      const nuevo = nombreDocumento(p, x, lista.length > 1 ? i + 1 : 0, ext);
      if (a.id && nuevo !== a.nombre) { await Almacen.encolarRenombre(p.id, x.lista, a.id, nuevo); n++; }
    }
  }
  if (n && Almacen.tieneToken()) Almacen.sincronizar().then(refrescar).catch(() => {});
}
async function guardarDocumentos(p, docs) {
  let n = 0;
  for (const [clase, archivos] of Object.entries(docs || {})) {
    const x = DOCS[clase];
    if (!archivos.length) continue;
    // Siempre un solo PDF por documento (las fotos y páginas juntas); reemplaza al que hubiera en el Drive
    const pdf = await aPDF(archivos);
    const ext = pdf.type === "application/pdf" ? ".pdf" : (pdf.name.match(/\.[a-z0-9]+$/i) || [".jpg"])[0];
    await Almacen.encolarAdjunto(p.id, nombreDocumento(p, x, 0, ext), pdf, x.ruta, { campo: x.campo, lista: x.lista, reemplaza: true });
    n++;
  }
  if (n) informarSubida();
  return n;
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
  if (!Almacen.tieneToken()) return setTimeout(() => aviso("Los documentos quedaron guardados en el celular. Para subirlos al Drive, tocá «Subir a Drive» arriba (se venció el acceso de Google)."), 3600);
  try { await Almacen.sincronizar(); } catch {}
  refrescar();
  const quedan = await Almacen.adjuntosPendientes();
  aviso(quedan ? `No se pudo subir ${quedan === 1 ? "1 documento" : quedan + " documentos"} al Drive: ${Almacen.errorAdjuntos || Almacen.estado}. Quedan en el celular y se reintenta solo.`
    : "✓ Documentos subidos a tu Drive (Liquidaciones › Anestesiología)");
}

async function guardarLote() {
  if (conciliacion) return aplicarLiquidacion().catch((e) => aviso(e.message));
  const elegidas = filasRevision.filter((f) => f.incluir);
  if (!elegidas.length) return aviso("No hay nada tildado.");
  const incompleta = elegidas.find((f) => faltantes(f).length);
  if (incompleta) return aviso(`${incompleta.paciente || "Un paciente"}: falta ${faltantes(incompleta).join(", ")}`);
  const existentes = datos().prestaciones;
  const repetidas = [], completadas = [];
  let n = 0, fojas = 0;
  try {
    for (const f of elegidas) {
      const mismo = (p) => p.fecha === f.fecha && (p.paciente || "").trim().toLowerCase() === (f.paciente || "").trim().toLowerCase();
      const ya = existentes.find((p) => mismo(p) && p.tipo === f.tipo && (p.procedimiento || "") === (f.procedimiento || ""));
      const docs = documentosDe(f);
      if (ya || (Object.keys(docs).length && esAnestesia())) {
        // Ya cargado: no se duplica, pero las fotos de los documentos se agregan a ese paciente (antes se descartaban)
        const existente = ya || existentes.find((p) => mismo(p) && p.especialidad === "anestesia");
        if (existente && Object.keys(docs).length) {
          const marcas = Object.fromEntries(Object.keys(docs).map((c) => [DOCS[c].campo, true]));
          const guardada = await guardarPrestacion({ ...existente, ...marcas });
          fojas += await guardarDocumentos(guardada, docs);
          completadas.push(f.paciente);
          continue;
        }
        if (ya) { repetidas.push(f.paciente); continue; }
      }
      const guardada = await guardarPrestacion({ ...f, fecha_presentacion: null, id: undefined });
      fojas += await guardarDocumentos(guardada, documentosDe(f));
      n++;
    }
    const mesGuardado = elegidas[0].fecha.slice(0, 7);
    aviso(`Guardadas ${n} en ${nombreMes(mesGuardado)}` + (repetidas.length ? ` · ya estaban: ${repetidas.join(", ")}` : "") +
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
      try {
        const guardada = await guardarPrestacion(datosForm);
        if (p.id) await renombrarDocumentos(guardada);
        const n = await guardarDocumentos(guardada, datosForm._docs);
        dlg.close(); aviso(n ? "Guardado · los documentos van a tu Drive › Liquidaciones › Anestesiología" : "Guardado"); refrescar();
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
  if (!$("#f-todos-meses").checked) lista = lista.filter((p) => p.fecha.slice(0, 7) === mes());
  if (tipo === "procedimientos") lista = lista.filter((p) => p.tipo !== "consulta"); else if (tipo) lista = lista.filter((p) => p.tipo === tipo);
  if (os === "-") lista = lista.filter((p) => !p.obra_social); else if (os) lista = lista.filter((p) => p.obra_social === os);
  if (est === "vencida") lista = lista.filter((p) => Motor.vencida(p, h));
  else if (est === "a_cobrar") lista = lista.filter((p) => ["pendiente", "presentada"].includes(p.estado));
  else if (est === "falta_doc") lista = lista.filter((p) => p.estado === "pendiente" && docFaltante(p).length);
  else if (est === "para_cargar") lista = lista.filter((p) => p.estado === "pendiente" && !docFaltante(p).length);
  else if (est) lista = lista.filter((p) => p.estado === est);
  if (q) lista = lista.filter((p) => Motor.plano([p.paciente, p.dni, p.procedimiento, refTexto(p), p.nro_ref, p.nro_circuito].join(" ")).includes(q));
  lista.sort((a, b) => (b.fecha + (b.hora || "")).localeCompare(a.fecha + (a.hora || "")));
  estado.seleccion.clear(); actualizarSeleccion();
  const total = lista.reduce((s, p) => s + (p.valor_estimado || 0), 0);
  $("#lista").innerHTML = lista.length ? `<p class="ayuda">${lista.length} ${tipo === "consulta" ? "consultas" : tipo ? "procedimientos" : "prestaciones"}<span class="economia"> · ${pesos(total)} estimado · tildá para marcar varias</span></p>` +
    lista.map((p) => {
      const chip = (Motor.vencida(p, h) ? '<span class="chip vencida">vencida</span>' : `<span class="chip ${p.estado}">${ESTADOS[p.estado]}</span>`) +
        (esAnestesia() && p.estado === "pendiente" && docFaltante(p).length ? `<br><span class="chip vencida">falta ${docFaltante(p).join(", ")}</span>` : "");
      const detalle = p.tipo === "consulta" ? TIPOS.consulta : procedimientosDe(p) + (esAnestesia() ? (p.complejidad ? ` · compl. ${p.complejidad}` : "") :
        (p.rol === "ayudante" ? " (ayudante)" : "") + (p.codigo_aac ? " · " + codigosDe(p, "codigo_aac") : ""));
      return `<div class="item" data-id="${p.id}"><input type="checkbox" data-sel="${p.id}" class="economia">
        <div class="cuerpo"><div class="titulo">${esc(p.paciente)}</div>
        <div class="sub">${esAnestesia() && p.nro_ref ? `Ref. ${refTexto(p)} · ` : ""}${fechaCorta(p.fecha)} · ${esc(p.obra_social || p.obra_social_texto || "¿obra social?")} · ${esc(detalle)}</div></div>
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
  $("#plazos-reales").innerHTML = plazos.length ? `<table><tr><th>Obra social</th><th class="n">Cobros</th><th class="n">Días</th><th class="n">Cobrado / estimado</th></tr>` +
    plazos.map((o) => `<tr><td>${esc(o.obra_social)}</td><td class="n">${o.n}</td><td class="n">${o.dias}</td><td class="n">${o.cobrado_vs_estimado ?? "—"} %</td></tr>`).join("") + "</table>"
    : '<p class="ayuda">Todavía no hay cobros registrados.</p>';
}

// ---------- Valores y cuenta ----------

function verValores() {
  const d = datos();
  const uq = [...d.uq].sort((a, b) => b.vigencia.localeCompare(a.vigencia));
  $("#uq-valor").value = uq[0]?.valor ?? "";
  $("#uq-vigencia").value = (uq[0]?.vigencia || "").slice(0, 7);
  $("#inflacion").value = ajuste("inflacion_mensual", "");
  $("#pct-asociacion").value = ajuste("pct_asociacion", "");
  // Dónde está cada cosa en el Drive
  $("#donde-drive").innerHTML = esAnestesia()
    ? "En tu Google Drive: carpeta <b>Liquidaciones › Anestesiología</b>, con la planilla <b>«Anestesiología – planilla»</b> y las carpetas <b>Fojas</b> (fojas quirúrgicas y de anestesia) y <b>Autorizaciones</b>. En <b>Liquidaciones</b> quedan los datos y los respaldos diarios."
    : "En tu Google Drive: carpeta <b>Liquidaciones</b>, con la planilla <b>«Liquidaciones – planilla»</b> (cirugías, consultas, resumen mensual y valores), los datos y los respaldos diarios.";
  $("#abrir-carpeta").hidden = true;
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
  for (const p of pend) await guardarPrestacion(p);
  return pend.length;
}

// ---------- Liquidación de honorarios: marcar lo cobrado ----------

const claveNombre = (n) => {
  const [ap, nom = ""] = Motor.plano(n).replace(/[^a-z, ]/g, "").split(",");
  return { ap: ap.trim().replace(/\s+/g, " "), nom: nom.trim().split(/\s+/)[0] || "" };
};
function mismoPaciente(a, b) {
  const x = claveNombre(a), y = claveNombre(b);
  if (!x.ap || x.ap !== y.ap) return false;
  return !x.nom || !y.nom || x.nom.startsWith(y.nom) || y.nom.startsWith(x.nom); // la liquidación corta los nombres
}
const diasEntre = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

// Cada línea → la prestación que le corresponde: mismo n.º de atención, o mismo paciente, ±3 días
function conciliar(liq) {
  const d = datos(), usadas = new Map(), out = [];
  for (const l of liq.lineas) {
    const os = Motor.obraSocialCanonica(d, l.obra_social_texto);
    const esConsulta = Motor.equivalenteAAC(os, l.codigo) === "CONSULTA" || /\bcons/i.test(l.descripcion);
    const candidatas = d.prestaciones.filter((p) => !usadas.has(p.id) && p.estado !== "cobrada" && diasEntre(p.fecha, l.fecha) <= 3 &&
      ((l.atencion && p.atencion === l.atencion) || mismoPaciente(p.paciente, l.paciente)))
      .sort((a, b) => (b.atencion === l.atencion) - (a.atencion === l.atencion) || (b.codigo_os === l.codigo) - (a.codigo_os === l.codigo) ||
        ((b.tipo === "consulta") === esConsulta) - ((a.tipo === "consulta") === esConsulta) || diasEntre(a.fecha, l.fecha) - diasEntre(b.fecha, l.fecha));
    let p = candidatas[0];
    // Varias líneas del mismo acto (mismo paciente y día; p. ej. tres ítems de una escisión): van a la misma prestación
    if (!p) p = [...usadas.values()].find((u) => u.linea.fecha === l.fecha && u.esConsulta === esConsulta &&
      ((l.atencion && u.linea.atencion === l.atencion) || mismoPaciente(u.linea.paciente, l.paciente)))?.p;
    const nueva = !p && out.find((x) => !x.p && x.linea.fecha === l.fecha && x.esConsulta === esConsulta &&
      ((l.atencion && x.linea.atencion === l.atencion) || mismoPaciente(x.linea.paciente, l.paciente)));
    const r = { linea: l, os, esConsulta, p: p || null, incluir: true, grupo: nueva ? nueva.grupo : out.length };
    if (p && !usadas.has(p.id)) usadas.set(p.id, r);
    out.push(r);
  }
  return out;
}

let conciliacion = null;

async function leerLiquidacion(archivos) {
  $("#cargar-botones").hidden = true; $("#leyendo").hidden = false;
  try {
    const texto = await Lector.textoDe(archivos, (t) => ($("#leyendo-texto").textContent = t));
    const liq = Lector.liquidacion(texto);
    if (!liq.lineas.length) throw new Error("No se reconoció una liquidación («Detalle Liquidación»). Cargá el PDF tal como lo descargás del sistema.");
    const cargadas = ajuste("liquidaciones", []);
    if (liq.numero && cargadas.includes(liq.numero) && !confirm(`La liquidación ${liq.numero} ya se cargó. ¿Cargarla de nuevo?`)) throw new Error("Cancelado");
    conciliacion = { liq, filas: conciliar(liq) };
    $("#texto-leido").textContent = texto;
    mostrarConciliacion();
  } catch (e) { aviso(e.message); $("#cargar-botones").hidden = false; }
  finally { $("#leyendo").hidden = true; }
}

function mostrarConciliacion() {
  const { liq, filas } = conciliacion;
  const ok = filas.filter((f) => f.p).length;
  $("#revision").hidden = false;
  $("#revision-titulo").textContent = `Liquidación ${liq.numero}`;
  $("#guardar-lote").textContent = "Aplicar liquidación";
  $("#revision-filas").innerHTML = `<p class="ayuda">${esc(liq.empresa)} · emitida ${fechaCorta(liq.emision)} · total ${pesos(liq.total)}<br>
      <b>${ok}</b> líneas coinciden con prestaciones cargadas (se marcan cobradas con el monto liquidado); <b>${filas.length - ok}</b> no estaban
      cargadas (se agregan como cobradas).</p>
    <label>Fecha de cobro<input id="liq-fecha" data-fecha inputmode="numeric" placeholder="dd/mm/aaaa" value="${esc(fechaLarga(liq.emision || hoy()))}"></label>` +
    filas.map((f, i) => `<div class="item" style="cursor:default"><input type="checkbox" data-liq-incluir="${i}" ${f.incluir ? "checked" : ""}>
      <div class="cuerpo"><div class="titulo">${esc(f.linea.paciente)}</div>
      <div class="sub">${fechaCorta(f.linea.fecha)} · ${esc(f.os || f.linea.obra_social_texto)} · ${esc(f.linea.codigo)} ${esc(f.linea.descripcion)}</div>
      <div class="sub">${f.p ? `✓ ${esc(f.p.paciente)} · ${fechaCorta(f.p.fecha)} · estimado ${pesos(f.p.valor_estimado)}` : "＋ nueva (no estaba cargada)"}</div></div>
      <div class="monto">${pesos(f.linea.monto)}</div></div>`).join("");
}

async function aplicarLiquidacion() {
  const { liq, filas } = conciliacion;
  const fecha = fechaDeTexto($("#liq-fecha").value) || liq.emision || hoy();
  const nota = `Liq. ${liq.numero}`;
  const grupos = new Map(); // prestación → líneas
  for (const f of filas.filter((x) => x.incluir)) {
    const clave = f.p ? f.p.id : "nueva-" + f.grupo;
    if (!grupos.has(clave)) grupos.set(clave, { p: f.p, lineas: [], f });
    grupos.get(clave).lineas.push(f.linea);
  }
  let marcadas = 0, nuevas = 0;
  for (const { p, lineas, f } of grupos.values()) {
    const l = lineas[0], total = lineas.reduce((s, x) => s + x.monto, 0);
    const detalle = lineas.length > 1 ? ` (${lineas.length} ítems)` : "";
    if (p) {
      // Los códigos de las otras líneas que no estaban en la prestación se agregan como procedimientos del mismo acto
      const conocidos = new Set([p.codigo_os, ...(p.extras || []).map((x) => x.codigo_os)].filter(Boolean));
      const extras = [...(p.extras || [])];
      for (const x of lineas.slice(1)) if (!conocidos.has(x.codigo) && x.codigo !== l.codigo) { extras.push({ procedimiento: x.descripcion, codigo_os: x.codigo }); conocidos.add(x.codigo); }
      await guardarPrestacion({ ...p, extras, estado: "cobrada", fecha_cobro: fecha, monto_cobrado: total, codigo_os: p.codigo_os || l.codigo,
        atencion: p.atencion || l.atencion, notas: [p.notas, nota + detalle].filter(Boolean).join(" · ") });
      marcadas++;
    } else {
      const aac = Motor.equivalenteAAC(f.os, l.codigo);
      await guardarPrestacion({ fecha: l.fecha, paciente: l.paciente, obra_social: f.os, obra_social_texto: l.obra_social_texto, atencion: l.atencion,
        tipo: f.esConsulta ? "consulta" : "cirugia", procedimiento: f.esConsulta ? "" : l.descripcion, codigo_os: l.codigo,
        extras: f.esConsulta ? [] : [...new Map(lineas.slice(1).filter((x) => x.codigo !== l.codigo).map((x) => [x.codigo, { procedimiento: x.descripcion, codigo_os: x.codigo }])).values()],
        codigo_aac: aac && aac !== "CONSULTA" ? aac : null, estado: "cobrada", fecha_cobro: fecha, monto_cobrado: total, origen: "liquidacion",
        notas: nota + detalle });
      nuevas++;
    }
  }
  if (liq.numero) await Almacen.ajuste("liquidaciones", [...new Set([...ajuste("liquidaciones", []), liq.numero])]);
  conciliacion = null;
  cerrarRevision();
  aviso(`Liquidación cargada: ${marcadas} marcadas cobradas, ${nuevas} agregadas.`);
  $("#f-todos-meses").checked = true; $("#f-estado").value = "cobrada";
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
    "N° de circuito": p.nro_circuito || "", "Doc faltante": docFaltante(p).join(" / ").toUpperCase(), "Foja quirúrgica (Drive)": (p.foja_archivos || []).map((a) => a.link).join(" "),
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
    "Diferencia": p.monto_cobrado != null && p.valor_estimado != null ? p.monto_cobrado - p.valor_estimado : null,
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
  $("#mes").addEventListener("change", refrescar);
  $$("[data-leer]").forEach((i) => i.addEventListener("change", () => { leer(i.dataset.leer, [...i.files]); i.value = ""; }));
  $$("[data-pegado]").forEach((b) => b.addEventListener("click", () => {
    const t = $("#texto-pegado").value.trim();
    if (!t) return aviso("Pegá primero el texto");
    leer(b.dataset.pegado, [], t);
  }));
  $$("[data-nueva]").forEach((b) => b.addEventListener("click", () => editar({ fecha: hoy(), tipo: b.dataset.nueva, paciente: "", rol: "cirujano", pct: 100, estado: "pendiente", origen: "manual" })));
  $("#guardar-lote").addEventListener("click", guardarLote);
  $("#cancelar-lote").addEventListener("click", cerrarRevision);
  ["#f-tipo", "#f-os", "#f-estado", "#f-todos-meses"].forEach((s) => $(s).addEventListener("change", verPrestaciones));
  let tq; $("#f-q").addEventListener("input", () => { clearTimeout(tq); tq = setTimeout(verPrestaciones, 250); });
  const abrir = (ev) => {
    const sel = ev.target.closest("[data-sel]");
    if (sel) { sel.checked ? estado.seleccion.add(sel.dataset.sel) : estado.seleccion.delete(sel.dataset.sel); actualizarSeleccion(); return; }
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
    if (esAnestesia()) await Almacen.ajuste("pct_asociacion", $("#pct-asociacion").value === "" ? 0 : Number($("#pct-asociacion").value));
    const n = await recalcularPendientes();
    aviso(`Guardado; ${n} pendientes recalculadas.`);
    verValores();
  });
  $("#apellido").addEventListener("change", () => Almacen.ajuste("apellido", $("#apellido").value.trim()));
  $("#recalcular").addEventListener("click", async () => aviso(`${await recalcularPendientes()} prestaciones recalculadas`));
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
    $("#f-todos-meses").checked = true; $("#f-estado").value = tr.dataset.paso; $("#f-tipo").value = "";
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

// ---------- Actualizaciones de la app ----------
const VERSION_APP = "42"; // igual que VERSION en sw.js

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
  estado.caminoElegido = false; // el administrador elige el camino cada vez que entra
  Almacen.minutosBloqueo = minutosBloqueo();
  aplicarModo();
  $("#f-os").innerHTML = '<option value="">Todas</option>' + datos().obras.map((o) => `<option>${esc(o.nombre)}</option>`).join("") + '<option value="-">Sin reconocer</option>';
  mostrarSync(Almacen.estado);
  ir("inicio");
  if (Almacen.tieneToken()) {
    // Al entrar: traer lo cargado en otros dispositivos y subir lo de este
    Almacen.sincronizar().then(() => { if (estado.volvioDeGoogle) aviso("Datos al día con Google Drive (" + Almacen.doc.cuenta + ")"); estado.volvioDeGoogle = false; refrescar(); })
      .catch((e) => aviso(e.message)).finally(() => { unificarActos().catch(() => {}); aplicarModo(); preguntarEspecialidad(); });
  } else {
    if (Almacen.doc.cuenta) mostrarSync("cambios sin subir");
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
async function menuConfiguracion() {
  const admin = await esAdmin(), dlg = $("#dlg"), cuerpo = $("#dlg-cuerpo");
  if (dlg.open) return;
  cuerpo._actual = null;
  const cuenta = Almacen.doc.cuenta;
  cuerpo.innerHTML = `<h2>Configuración</h2>
    <p class="ayuda">${cuenta ? "Cuenta: " + esc(cuenta) : "Sin Google Drive: los datos están solo en este celular."} · ${ESPECIALIDADES[esAnestesia() ? "anestesia" : "cirugia"]}</p>
    <div style="display:grid;gap:8px">
      ${admin ? `<button class="boton secundario" data-menu="rama">⇄ Pasar a ${esAnestesia() ? "Cirugía" : "Anestesiología"}</button>` : ""}
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
