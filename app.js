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
               estados: { pendiente: "Sin cargar en DARC", presentada: "Cargada en DARC", cobrada: "Liquidada", debitada: "Debitada" } },
};
const EDADES = { "": "—", neonato: "Neonato (hasta 30 días) +50 %", lactante: "1 mes a 3 años +40 %", nino: "3 a 14 años +30 %", mayor70: "70 años o más +30 %" };
const VIAS = { misma: "Misma vía (50 %)", distinta: "Otra vía o bilateral (75 %)" };
// Documentación física que falta para cargar la anestesia en la asociación (foja quirúrgica y orden/autorización)
const docFaltante = (p) => (p.tipo === "consulta" ? [] : [!p.doc_foja && "foja", !p.doc_autorizacion && "autorización"].filter(Boolean));
const SI_NO = { "": "—", si: "Sí", no: "No" };
const ESTADOS = { pendiente: "Sin presentar", presentada: "Presentada", cobrada: "Cobrada", debitada: "Debitada" };
const CAMPOS = ["fecha", "hora", "tipo", "atencion", "paciente", "dni", "afiliado", "obra_social", "obra_social_texto", "institucion", "procedimiento",
  "diagnostico", "abordaje", "urgencia", "rol", "pct", "pct_modulo", "codigo_aac", "codigo_os", "valor_manual", "estado", "fecha_presentacion",
  "fecha_cobro", "monto_cobrado", "origen", "notas", "endoscopia", "ciego", "polipectomia", "observaciones", "extras",
  "complejidad", "edad_grupo", "feriado", "obesidad", "suspendida", "doc_foja", "doc_autorizacion"];

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

function datos() {
  const d = Almacen.doc, vivos = (l) => l.filter((x) => !x.borrada);
  const propias = new Map(vivos(d.obras).map((o) => [o.nombre, o]));
  const obras = estado.base.obras.filter((o) => !propias.has(o.nombre)).concat([...propias.values()]).map((o) => ({ activa: true, ...o }));
  const valoresPropios = vivos(d.valores);
  const clave = (v) => v.obra_social + "|" + String(v.codigo).replace(/[.\-\s]/g, "") + "|" + v.vigencia;
  const tapados = new Set(valoresPropios.map(clave));
  return { obras, especialidad: ajuste("especialidad", "cirugia"), pct_darc: Number(ajuste("pct_darc", 0)) || 0, valores: estado.base.valores.filter((v) => !tapados.has(clave(v))).concat(valoresPropios),
           uq: estado.base.uq.concat(vivos(d.uq)), prestaciones: vivos(d.prestaciones) };
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
  limpio.estado ||= "pendiente"; limpio.tipo ||= "consulta"; limpio.rol ||= "cirujano"; if (limpio.pct == null || limpio.pct === "") limpio.pct = 100; limpio.origen ||= "manual";
  return Almacen.guardar("prestaciones", Motor.completar(datos(), limpio));
}

// ---------- Navegación ----------

const TITULOS = { inicio: "Inicio", cargar: "Cargar", prestaciones: "Prestaciones", cobros: "Cobros", valores: "Valores", bienvenida: "Liquidaciones", pin: "Liquidaciones" };

function ir(vista) {
  estado.vista = vista;
  $$("main > section").forEach((s) => (s.hidden = s.id !== "v-" + vista));
  $$("nav.abajo button").forEach((b) => b.classList.toggle("activa", b.dataset.vista === vista));
  const afuera = ["bienvenida", "pin"].includes(vista);
  $("nav.abajo").hidden = afuera;
  $("#bloquear").hidden = afuera || !Almacen.tienePin();
  $("#titulo").textContent = TITULOS[vista];
  $("#mes").hidden = !["inicio", "prestaciones", "valores"].includes(vista);
  ({ inicio: verInicio, prestaciones: verPrestaciones, cobros: verCobros, valores: verValores }[vista] || (() => {}))();
}
const refrescar = () => ir(estado.vista);

// ---------- Inicio ----------

function avisoCopia() {
  const d = Almacen.doc, dias = d.ultima_copia ? (Date.now() - d.ultima_copia) / 864e5 : Infinity;
  const mostrar = !d.cuenta && d.prestaciones.length > 0 && dias > 7;
  $("#sin-copia").hidden = !mostrar;
  if (mostrar) $("#sin-copia").innerHTML = 'Tus datos están <b>solo en este celular</b>. Conectá Google Drive o descargá una copia en <a href="#" data-ir="valores">Valores → Copia de seguridad</a>.';
}

function verInicio() {
  avisoCopia();
  verCircuitoDarc();
  if (modoRegistro()) return verInicioRegistro();
  const inflacion = +ajuste("inflacion_mensual", 0);
  const r = Motor.resumen(datos(), mes(), hoy(), inflacion), t = r.totales;
  const kpi = (titulo, valor, clase = "") => `<div class="kpi ${clase}"><small>${titulo}</small><b>${valor}</b></div>`;
  $("#kpis").innerHTML = kpi("Facturado estimado", pesos(t.estimado)) + kpi("Cobrado", pesos(t.cobrado), "verde") +
    kpi("Falta cobrar", pesos(t.pendiente)) + kpi("Vencido", pesos(t.vencido), t.vencido ? "rojo" : "") +
    kpi("Consultas", t.consultas) + kpi("Cirugías", t.cirugias) + kpi("Prestaciones", t.n) +
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

// Anestesiología: en qué paso está cada anestesia (documentación → carga en DARC → liquidación), de todos los meses
function verCircuitoDarc() {
  if (!esAnestesia()) return;
  const lista = datos().prestaciones.filter((p) => p.tipo !== "consulta" || p.estado !== "cobrada");
  const pasos = [
    ["Falta documentación (foja o autorización)", "falta_doc", lista.filter((p) => p.estado === "pendiente" && docFaltante(p).length)],
    ["Listas para cargar en DARC", "para_darc", lista.filter((p) => p.estado === "pendiente" && !docFaltante(p).length)],
    ["Cargadas en DARC, sin liquidar", "presentada", lista.filter((p) => p.estado === "presentada")],
  ];
  $("#darc").innerHTML = `<table><tr><th>Paso</th><th class="n">#</th><th class="n">Neto estimado</th></tr>` +
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
  $("[data-marcar=presentada]").textContent = anest ? "Cargadas en DARC" : "Presentadas";
  $("[data-marcar=cobrada]").textContent = anest ? "Liquidadas" : "Cobradas";
  $("#titulo-presentar").textContent = anest ? "Para cargar en DARC" : "Para presentar";
  const elegido = $("#f-estado").value;
  $("#f-estado").innerHTML = '<option value="">Todos</option><option value="a_cobrar">A cobrar</option><option value="vencida">Vencidas</option>' +
    (anest ? '<option value="falta_doc">Falta documentación</option><option value="para_darc">Listas para cargar en DARC</option>' : "") +
    Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $("#f-estado").value = [...$("#f-estado").options].some((o) => o.value === elegido) ? elegido : "";
}

// La primera vez: ¿qué especialidad? (se puede cambiar en Valores → Mi cuenta)
function preguntarEspecialidad() {
  if (Almacen.doc.ajustes.especialidad || $("#dlg").open) return;
  const dlg = $("#dlg"), cuerpo = $("#dlg-cuerpo");
  cuerpo._actual = null;
  cuerpo.innerHTML = `<h2>¿Cuál es tu especialidad?</h2>
    <p class="ayuda">La app se adapta a cómo se liquida cada una. En anestesiología: complejidad del nomenclador de anestesiólogos,
      documentación (foja y autorización) y carga en la asociación (DARC). Podés cambiarla después en Valores → Mi cuenta.</p>
    <div class="fila"><button class="boton" data-especialidad="cirugia">Cirugía</button><button class="boton" data-especialidad="anestesia">Anestesiología</button></div>`;
  cuerpo.onclick = async (ev) => {
    const b = ev.target.closest("[data-especialidad]");
    if (!b) return;
    await Almacen.ajuste("especialidad", b.dataset.especialidad);
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
    <label class="economia">${esAnestesia() ? "Cargada en DARC el" : "Presentada el"}${campoFecha("fecha_presentacion", p.estado === "pendiente" ? "" : p.fecha_presentacion)}</label>
    <label class="economia">${esAnestesia() ? "Liquidada el" : "Cobrada el"}${campoFecha("fecha_cobro", p.fecha_cobro)}</label>
    <label class="economia">${esAnestesia() ? "Monto liquidado, neto ($)" : "Monto cobrado ($)"}<input type="number" name="monto_cobrado" value="${p.monto_cobrado ?? ""}"></label>
    <label class="ancho">Notas<textarea name="notas" rows="2">${esc(p.notas)}</textarea></label>` : ""}
  </div>
  ${faltantes(p).length ? `<div class="alerta" style="margin:4px 0">Falta: ${faltantes(p).join(", ")}</div>` : ""}
  ${esAnestesia() && docFaltante(p).length ? `<div class="alerta" style="margin:4px 0">Documentación pendiente: ${docFaltante(p).join(" y ")} (sin eso no se puede cargar en DARC)</div>` : ""}
  <div class="valor economia"><b>${pesos(p.valor_estimado)}</b> <span class="ayuda">${esAnestesia() && p.valor_bruto ? `neto · a cargar en DARC ${pesos(p.valor_bruto)} ` : ""}· cobro estimado ${fechaCorta(p.fecha_cobro_estimada)}</span>
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
    ${marca("feriado", "Feriado (+50 %)")}
    ${marca("obesidad", "Obesidad mórbida (+2 complejidades)")}
    ${marca("suspendida", "Operación suspendida (complejidad 1)")}
    <div class="ancho ayuda" style="margin:6px 0 0"><b>Documentación para cargar en DARC</b></div>
    ${marca("doc_foja", "Foja quirúrgica")}
    ${marca("doc_autorizacion", "Orden / autorización")}
    <p class="ancho ayuda" style="margin:0">Nocturno (20 a 7 h, +35 %) y fin de semana (sábado 13 h a lunes 7 h, +50 %) salen de la fecha y la hora.</p>`;
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
    const extra = /^extra_proc_(\d+)$/.exec(cambio || "");
    if (extra && p.extras?.[+extra[1]]) { p.extras[+extra[1]].codigo_aac = null; p.extras[+extra[1]].complejidad = null; } // cambió el texto: volver a sugerir
    if (cambio === "obra_social" && !p.codigo_os_manual) p.codigo_os = null; // el código escrito a mano no se pierde
    if (!p.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(p.fecha)) return; // fecha a medio escribir
    const e = Motor.estimar(datos(), { ...p, fecha_presentacion: p.estado === "pendiente" ? null : p.fecha_presentacion });
    guardar({ ...p, ...e, sugerencias: e.sugerencias || p.sugerencias });
  };
  el.addEventListener("change", (ev) => {
    if (!ev.target.name || ["notas", "dni", "afiliado", "hora", "institucion", "estado", "monto_cobrado", "paciente", "ciego", "observaciones"].includes(ev.target.name)) return;
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

async function leer(tipo, archivos, textoPegado) {
  $("#cargar-botones").hidden = true; $("#leyendo").hidden = false;
  const avance = (t) => ($("#leyendo-texto").textContent = t);
  try {
    const texto = textoPegado ?? await Lector.textoDe(archivos, avance);
    const d = datos();
    const filas = Lector.aPrestaciones(tipo, texto, { obraSocial: (t) => Motor.obraSocialCanonica(d, t), medico: ajuste("apellido", ""),
      pctMultiple: Motor.catalogos.AAC.rules.multiple_same_approach_pct });
    if (!filas.length || !filas.some((f) => f.paciente || f.procedimiento)) throw Object.assign(new Error("No se reconocieron pacientes: revisá el texto leído y completá a mano."), { texto });
    $("#texto-leido").textContent = texto;
    if (tipo === "parte" && Lector.esEstudio(texto)) {
      filas.forEach((f) => Object.assign(f, { incluir: false, estudio: true }));
      aviso("Parece el informe de un estudio (TAC, ecografía…), no un procedimiento: quedó destildado.");
    }
    if (tipo === "parte" && !ajuste("apellido", "")) aviso("Cargá tu apellido en Valores → Mi cuenta para saber si fuiste cirujano o ayudante.");
    // Varios códigos en el parte («180116 310009»): el principal es el quirúrgico (módulo, después práctica quirúrgica);
    // los demás (p. ej. la ecografía) van como otros procedimientos del mismo acto, con su nombre del nomenclador
    if (tipo === "parte") for (const f of filas) {
      const cods = [...new Set(f.codigos_os || [])];
      delete f.codigos_os;
      if (cods.length < 2) continue;
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
    mostrarRevision(filas.map((f) => ({ ...f, fecha: f.fecha || hoy(), fecha_leida: !!f.fecha, ...Motor.estimar(d, { ...f, fecha: f.fecha || hoy() }) })),
      tipo === "parte" ? "Parte quirúrgico" : "Listado" + (filas[0].fecha ? " del " + fechaCorta(filas[0].fecha) : ""));
  } catch (e) {
    aviso(e.message);
    if (e.texto !== undefined && !e.capturaApp) {
      $("#texto-leido").textContent = e.texto;
      mostrarRevision([{ fecha: hoy(), tipo: tipo === "parte" ? "cirugia" : "consulta", paciente: "", rol: "cirujano", pct: 100, incluir: true, origen: "manual" }], "Completar a mano");
    } else $("#cargar-botones").hidden = false;
  } finally { $("#leyendo").hidden = true; }
}

function mostrarRevision(filas, titulo) {
  filasRevision = filas;
  $("#revision").hidden = false;
  $("#revision-titulo").textContent = titulo + ` (${filas.length})`;
  const cont = $("#revision-filas");
  cont.innerHTML = "";
  filas.forEach((f, i) => {
    const div = document.createElement("div");
    const pintar = () => {
      const x = filasRevision[i];
      div.className = "revision" + (x.incluir ? "" : " apagada");
      div.innerHTML = `<label class="check"><input type="checkbox" data-incluir ${x.incluir ? "checked" : ""}>
        <b>${esc(x.paciente || "Paciente " + (i + 1))}</b>${x.ausente ? ' <span class="chip vencida">ausente</span>' : ""}${x.estudio ? ' <span class="chip vencida">informe de estudio</span>' : ""}${fechaDudosa(x) ? ' <span class="chip vencida">revisá la fecha</span>' : ""}</label>` +
        camposPrestacion(x, false);
    };
    pintar();
    div.addEventListener("change", (ev) => {
      if (ev.target.matches("[data-incluir]")) { filasRevision[i].incluir = ev.target.checked; div.classList.toggle("apagada", !ev.target.checked); }
      else {
        filasRevision[i] = leerCampos(div, filasRevision[i]);
        if (ev.target.name === "fecha") filasRevision[i].fecha_leida = true;
      }
    }, true);
    enlazarEstimacion(div, () => leerCampos(div, filasRevision[i]), (p) => { filasRevision[i] = { ...filasRevision[i], ...p }; pintar(); });
    cont.appendChild(div);
  });
}

// Fecha no leída (se puso la de hoy) o de hace más de un año: casi siempre es otra fecha del documento
const fechaDudosa = (x) => !x.fecha_leida || Math.abs(Date.now() - Date.parse(x.fecha)) > 366 * 864e5;

function cerrarRevision() { conciliacion = null; $("#guardar-lote").textContent = "Guardar"; $("#revision").hidden = true; $("#cargar-botones").hidden = false; filasRevision = []; }

async function guardarLote() {
  if (conciliacion) return aplicarLiquidacion().catch((e) => aviso(e.message));
  const elegidas = filasRevision.filter((f) => f.incluir);
  if (!elegidas.length) return aviso("No hay nada tildado.");
  const incompleta = elegidas.find((f) => faltantes(f).length);
  if (incompleta) return aviso(`${incompleta.paciente || "Un paciente"}: falta ${faltantes(incompleta).join(", ")}`);
  const existentes = datos().prestaciones;
  const repetidas = [];
  let n = 0;
  try {
    for (const f of elegidas) {
      const ya = existentes.some((p) => p.fecha === f.fecha && p.tipo === f.tipo && (p.paciente || "").toLowerCase() === (f.paciente || "").trim().toLowerCase() &&
        (p.procedimiento || "") === (f.procedimiento || ""));
      if (ya) { repetidas.push(f.paciente); continue; }
      await guardarPrestacion({ ...f, fecha_presentacion: null, id: undefined });
      n++;
    }
    const mesGuardado = elegidas[0].fecha.slice(0, 7);
    aviso(`Guardadas ${n} en ${nombreMes(mesGuardado)}` + (repetidas.length ? ` · ya estaban: ${repetidas.join(", ")}` : ""));
    cerrarRevision();
    $("#mes").value = mesGuardado;
    ir("prestaciones");
  } catch (e) { aviso(e.message); }
}

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
      try { await guardarPrestacion(datosForm); dlg.close(); aviso("Guardado"); refrescar(); }
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
  else if (est === "para_darc") lista = lista.filter((p) => p.estado === "pendiente" && !docFaltante(p).length);
  else if (est) lista = lista.filter((p) => p.estado === est);
  if (q) lista = lista.filter((p) => Motor.plano([p.paciente, p.dni, p.procedimiento].join(" ")).includes(q));
  lista.sort((a, b) => (b.fecha + (b.hora || "")).localeCompare(a.fecha + (a.hora || "")));
  estado.seleccion.clear(); actualizarSeleccion();
  const total = lista.reduce((s, p) => s + (p.valor_estimado || 0), 0);
  $("#lista").innerHTML = lista.length ? `<p class="ayuda">${lista.length} ${tipo === "consulta" ? "consultas" : tipo ? "procedimientos" : "prestaciones"}<span class="economia"> · ${pesos(total)} estimado · tildá para marcar varias</span></p>` +
    lista.map((p) => {
      const chip = (Motor.vencida(p, h) ? '<span class="chip vencida">vencida</span>' : `<span class="chip ${p.estado}">${ESTADOS[p.estado]}</span>`) +
        (esAnestesia() && p.estado === "pendiente" && docFaltante(p).length ? `<br><span class="chip vencida">falta ${docFaltante(p).join(" y ")}</span>` : "");
      const detalle = p.tipo === "consulta" ? TIPOS.consulta : procedimientosDe(p) + (esAnestesia() ? (p.complejidad ? ` · compl. ${p.complejidad}` : "") :
        (p.rol === "ayudante" ? " (ayudante)" : "") + (p.codigo_aac ? " · " + codigosDe(p, "codigo_aac") : ""));
      return `<div class="item" data-id="${p.id}"><input type="checkbox" data-sel="${p.id}" class="economia">
        <div class="cuerpo"><div class="titulo">${esc(p.paciente)}</div>
        <div class="sub">${fechaCorta(p.fecha)} · ${esc(p.obra_social || p.obra_social_texto || "¿obra social?")} · ${esc(detalle)}</div></div>
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
  $("#pct-darc").value = ajuste("pct_darc", "");
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
  $("#tabla-os").innerHTML = `<table><tr><th>Obra social</th><th class="n">Presenta día</th><th class="n">Paga a (días)</th><th class="n">% módulo</th><th class="n">Valores</th></tr>` +
    d.obras.map((o) => `<tr data-os="${esc(o.nombre)}" style="${o.activa ? "" : "opacity:.5"}"><td>${esc(o.nombre)}${o.notas ? `<div class="ayuda" style="margin:0">${esc(o.notas)}</div>` : ""}</td>
      <td class="n">${o.dia_presentacion || "—"}</td><td class="n">${o.dias_pago}</td><td class="n">${o.pct_modulo ?? "—"}</td>
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
    : '<p class="ayuda">Todavía no cargaste aranceles. Pedí a la asociación (DARC) la tabla de valores por complejidad de cada obra social.</p>';
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
    <label>% del módulo para el cirujano<input type="number" name="pct_modulo" value="${o.pct_modulo ?? ""}" step="0.1" placeholder="o cargalo en cada cirugía"></label>
    <label class="check ancho"><input type="checkbox" name="paga_modulo" ${o.paga_modulo ? "checked" : ""}> Paga por módulo (al importar listas, los valores quedan como módulo)</label>
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

async function construirExcel() {
  await new Promise((ok, mal) => {
    if (window.XLSX) return ok();
    const s = document.createElement("script");
    s.src = "vendor/xlsx.full.min.js"; s.onload = ok; s.onerror = () => mal(new Error("No se pudo cargar el generador de Excel"));
    document.head.appendChild(s);
  });
  const lista = datos().prestaciones.slice().sort((a, b) => (a.fecha + (a.hora || "")).localeCompare(b.fecha + (b.hora || "")));
  // Fechas como número de serie de planilla (días desde 30/12/1899) con formato dd/mm/aaaa: Google Sheets y Excel las
  // importan como fecha. (Las «celdas de fecha» ISO no las toma Google: quedaban vacías o como texto.)
  const fechaX = (t) => {
    if (!t || !/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
    const [y, m, d] = t.slice(0, 10).split("-").map(Number);
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;
  };
  const FECHAS = ["Fecha", "Presentada", "Cobro estimado", "Cobrada el", "Vigente desde", "Cargada en DARC", "Liquidada el"];
  const est = (p) => (Motor.vencida(p, hoy()) ? "Vencida" : ESTADOS[p.estado]);
  // ¿El valor es un módulo (total para la institución, del que te toca un %) o tu honorario directo?
  const tipoValor = (p) => p.valor_manual ? "Cargado a mano" : /^Ayudantía en módulo/.test(p.valor_origen || "") ? "Módulo (ayudantía: no se cobra)"
    : /^Módulo|^Sin honorario conocido · Módulo/.test(p.valor_origen || "") ? "Módulo" : p.valor_estimado != null ? "Honorario directo" : "";
  // Anestesiología: como la planilla de control (situación, documentación faltante, cargado en DARC, liquidado neto)
  const anestesias = lista.filter((p) => p.tipo !== "consulta").map((p, i) => ({
    "N°": i + 1, "Fecha": fechaX(p.fecha), "Hora": p.hora || "", "Paciente": p.paciente, "DNI": p.dni || "", "Afiliado": p.afiliado || "",
    "Obra social": p.obra_social || p.obra_social_texto || "", "Lugar": p.institucion || "", "Tipo": TIPOS[p.tipo], "Procedimiento": procedimientosDe(p),
    "Complejidad": Motor.complejidadEfectiva(p) ?? "", "Recargos": Motor.recargosAnestesia(p).map(([n, x]) => `${n} +${x} %`).join(", "),
    "Monto cargado (bruto)": p.valor_bruto ?? null, "Neto estimado": p.valor_estimado ?? null, "Situación": est(p),
    "Doc faltante": docFaltante(p).join(" / ").toUpperCase(), "Cargada en DARC": fechaX(p.estado !== "pendiente" && p.fecha_presentacion),
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
  for (const p of lista) {
    const k = p.fecha.slice(0, 7) + "|" + (p.obra_social || p.obra_social_texto || "Sin obra social");
    const g = (grupos[k] ||= { "Mes": p.fecha.slice(0, 7), "Obra social": k.split("|")[1], "Consultas": 0, "Cirugías y procedimientos": 0,
      "Estimado": 0, "Cobrado": 0, "Falta cobrar": 0 });
    g[p.tipo === "consulta" ? "Consultas" : "Cirugías y procedimientos"]++;
    g["Estimado"] += p.valor_estimado || 0;
    g["Cobrado"] += ["cobrada", "debitada"].includes(p.estado) ? p.monto_cobrado || 0 : 0;
    g["Falta cobrar"] += ["pendiente", "presentada"].includes(p.estado) ? p.valor_estimado || 0 : 0;
  }
  // Valores (los de la app, los cargados y los importados): qué es módulo y qué es honorario directo
  const valores = datos().valores.slice().sort((a, b) => a.obra_social.localeCompare(b.obra_social) || String(a.codigo).localeCompare(String(b.codigo)) || b.vigencia.localeCompare(a.vigencia))
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
  if (esAnestesia()) hoja(anestesias, "Anestesiología", ["N°", "Fecha", "Paciente", "Obra social", "Lugar", "Procedimiento", "Situación", "Doc faltante"]);
  else hoja(cirugias, "Cirugías y procedimientos", ["Fecha", "Paciente", "Obra social", "Procedimiento"]);
  hoja(consultas, "Consultas", ["Fecha", "Paciente", "Obra social"]);
  hoja(resumen, "Resumen mensual", ["Mes", "Obra social", "Estimado", "Cobrado"]);
  hoja(valores, "Valores cargados", ["Obra social", "Código", "Descripción", "Tipo de valor", "Monto"]);
  return XLSX.write(libro, { bookType: "xlsx", type: "array" });
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
    if (esAnestesia()) await Almacen.ajuste("pct_darc", $("#pct-darc").value === "" ? 0 : Number($("#pct-darc").value));
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
  Almacen.planilla = construirExcel; // se actualiza en el Drive en cada sincronización
  $$("[data-liq]").forEach((i) => i.addEventListener("change", () => { leerLiquidacion([...i.files]); i.value = ""; }));
  $("#revision-filas").addEventListener("change", (ev) => {
    const c = ev.target.closest("[data-liq-incluir]");
    if (c && conciliacion) conciliacion.filas[+c.dataset.liqIncluir].incluir = c.checked;
  });
  $("#especialidad").addEventListener("change", async () => {
    await Almacen.ajuste("especialidad", $("#especialidad").value);
    aplicarModo();
    const n = await recalcularPendientes();
    aviso(`Especialidad: ${ESPECIALIDADES[$("#especialidad").value]}; ${n} pendientes recalculados.`);
    verValores();
  });
  $("#ane-os").addEventListener("change", verAranceles);
  $("#ane-vigencia").addEventListener("change", verAranceles);
  $("#ane-guardar").addEventListener("click", () => guardarAranceles().catch((e) => aviso(e.message)));
  $("#darc").addEventListener("click", (ev) => {
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
    if (!confirm("Se borran los datos y el PIN de ESTE celular (la copia en tu Drive queda). ¿Seguir?")) return;
    await Almacen.desconectar(); location.reload();
  });
  $("#tabla-os").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-os]");
    if (tr) editarObraSocial(datos().obras.find((o) => o.nombre === tr.dataset.os));
  });
  $("#nueva-os").addEventListener("click", () => editarObraSocial({}));
  $("#v-os").addEventListener("change", verTablaValores);
  $("#nuevo-valor").addEventListener("click", nuevoValor);
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
const VERSION_APP = "29"; // igual que VERSION en sw.js

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
  $("#bloquear").addEventListener("click", bloquearYa);
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
async function bloquearYa() {
  await Almacen.bloquear();
  location.reload();
}

arrancar().catch((e) => aviso(e.message));
