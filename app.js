"use strict";
// Liquidaciones (celular, sin servidor). Vistas: inicio, cargar, prestaciones, cobros, valores.
// Cálculo: motor.js · Lectura de documentos: lector.js · Datos y Google Drive: almacen.js

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pesos = (n) => (n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString("es-AR"));
const fechaCorta = (iso) => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(2, 4) : "");
const hoy = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const nombreMes = (m) => (m === "vencido" ? "Vencido" : MESES[+m.slice(5, 7) - 1] + " " + m.slice(0, 4));
const TIPOS = { consulta: "Consulta", cirugia: "Cirugía", practica: "Práctica" };
const ESTADOS = { pendiente: "Sin presentar", presentada: "Presentada", cobrada: "Cobrada", debitada: "Debitada" };
const CAMPOS = ["fecha", "hora", "tipo", "paciente", "dni", "afiliado", "obra_social", "obra_social_texto", "institucion", "procedimiento",
  "diagnostico", "abordaje", "urgencia", "rol", "pct", "codigo_aac", "codigo_os", "valor_manual", "estado", "fecha_presentacion",
  "fecha_cobro", "monto_cobrado", "origen", "notas"];

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
  const clave = (v) => v.obra_social + "|" + v.codigo + "|" + v.vigencia;
  const tapados = new Set(valoresPropios.map(clave));
  return { obras, valores: estado.base.valores.filter((v) => !tapados.has(clave(v))).concat(valoresPropios),
           uq: estado.base.uq.concat(vivos(d.uq)), prestaciones: vivos(d.prestaciones) };
}
const ajuste = (k, porDefecto) => Almacen.doc.ajustes[k]?.valor ?? porDefecto;

async function guardarPrestacion(p) {
  if (!p.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(p.fecha)) throw new Error(`Fecha inválida para ${p.paciente || "la prestación"}`);
  if (!(p.paciente || "").trim()) throw new Error("Falta el nombre del paciente");
  const limpio = { id: p.id };
  for (const k of CAMPOS) limpio[k] = p[k] ?? null;
  limpio.estado ||= "pendiente"; limpio.tipo ||= "consulta"; limpio.rol ||= "cirujano"; limpio.pct ||= 100; limpio.origen ||= "manual";
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

function verInicio() {
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
    <label>Fecha<input type="date" name="fecha" value="${esc(p.fecha)}" required></label>
    <label>Tipo${sel("tipo", TIPOS, p.tipo)}</label>
    <label class="ancho">Paciente<input name="paciente" value="${esc(p.paciente)}" required></label>
    <label>Obra social<select name="obra_social">${opcionesOS(p.obra_social)}</select></label>
    <label>Afiliado<input name="afiliado" value="${esc(p.afiliado)}" inputmode="numeric"></label>
    ${p.obra_social_texto && p.obra_social_texto !== p.obra_social ? `<p class="ayuda ancho" style="margin-top:-6px">Leído: «${esc(p.obra_social_texto.slice(0, 80))}»</p>` : ""}
    ${quir ? `
    <label class="ancho">Procedimiento<input name="procedimiento" value="${esc(p.procedimiento)}"></label>
    <label class="ancho">Código AAC<select name="codigo_aac">${opcionesCodigo(p)}</select></label>
    <div class="ancho fila" style="margin-top:-4px"><button type="button" class="boton chico secundario" data-buscar-codigo>Buscar otro código</button></div>
    <label>Abordaje${sel("abordaje", { "": "—", laparoscopica: "Laparoscópica", convencional: "Convencional", robotica: "Robótica", percutanea: "Percutánea", endoscopica: "Endoscópica" }, p.abordaje || "")}</label>
    <label>Rol${sel("rol", { cirujano: "Cirujano", ayudante: "Ayudante" }, p.rol || "cirujano")}</label>
    <label>% a facturar<input type="number" name="pct" value="${p.pct || 100}" min="1" max="100"></label>
    <label>Código obra social<input name="codigo_os" value="${esc(p.codigo_os)}"></label>
    <label class="check"><input type="checkbox" name="urgencia" ${p.urgencia ? "checked" : ""}> Urgencia</label>` : ""}
    ${completo ? `
    <label>Hora<input type="time" name="hora" value="${esc(p.hora)}"></label>
    <label>DNI<input name="dni" value="${esc(p.dni)}" inputmode="numeric"></label>
    <label>Institución<input name="institucion" value="${esc(p.institucion)}"></label>
    <label>Valor a mano ($)<input type="number" name="valor_manual" value="${p.valor_manual ?? ""}" placeholder="vacío = estimado"></label>
    <label>Estado${sel("estado", ESTADOS, p.estado || "pendiente")}</label>
    <label>Presentada el<input type="date" name="fecha_presentacion" value="${esc(p.estado === "pendiente" ? "" : p.fecha_presentacion)}"></label>
    <label>Cobrada el<input type="date" name="fecha_cobro" value="${esc(p.fecha_cobro)}"></label>
    <label>Monto cobrado ($)<input type="number" name="monto_cobrado" value="${p.monto_cobrado ?? ""}"></label>
    <label class="ancho">Notas<textarea name="notas" rows="2">${esc(p.notas)}</textarea></label>` : ""}
  </div>
  <div class="valor"><b>${pesos(p.valor_estimado)}</b> <span class="ayuda">· cobro estimado ${fechaCorta(p.fecha_cobro_estimada)}</span>
    <div class="origen">${esc(p.valor_origen)}</div></div>`;
}

function leerCampos(el, base) {
  const p = { ...base };
  $$("input[name], select[name], textarea[name]", el).forEach((c) => {
    if (c.type === "checkbox") p[c.name] = c.checked;
    else if (c.type === "number") p[c.name] = c.value === "" ? null : Number(c.value);
    else p[c.name] = c.value === "" ? null : c.value;
  });
  if (p.estado === "pendiente" && p.fecha_presentacion) p.estado = "presentada";
  return p;
}

// Re-estimar al cambiar algo que cambia el valor (obra social, código, rol…)
function enlazarEstimacion(el, obtener, guardar) {
  const recalcular = (cambio) => {
    const p = obtener();
    if (!p) return; // el diálogo muestra otra cosa (obra social, valor)
    if (["procedimiento", "tipo", "abordaje"].includes(cambio)) p.codigo_aac = null;
    if (cambio === "obra_social") p.codigo_os = null;
    if (!p.fecha) return;
    const e = Motor.estimar(datos(), { ...p, fecha_presentacion: p.estado === "pendiente" ? null : p.fecha_presentacion });
    guardar({ ...p, ...e, sugerencias: e.sugerencias || p.sugerencias });
  };
  el.addEventListener("change", (ev) => {
    if (!ev.target.name || ["notas", "dni", "afiliado", "hora", "institucion", "estado", "monto_cobrado", "paciente"].includes(ev.target.name)) return;
    recalcular(ev.target.name);
  });
  el.addEventListener("click", (ev) => {
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
    mostrarRevision(filas.map((f) => ({ ...f, fecha: f.fecha || hoy(), fecha_leida: !!f.fecha, ...Motor.estimar(d, { ...f, fecha: f.fecha || hoy() }) })),
      tipo === "parte" ? "Parte quirúrgico" : "Listado" + (filas[0].fecha ? " del " + fechaCorta(filas[0].fecha) : ""));
  } catch (e) {
    aviso(e.message);
    if (e.texto !== undefined) {
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
        <b>${esc(x.paciente || "Paciente " + (i + 1))}</b>${x.ausente ? ' <span class="chip vencida">ausente</span>' : ""}${fechaDudosa(x) ? ' <span class="chip vencida">revisá la fecha</span>' : ""}</label>` +
        camposPrestacion(x, false);
    };
    pintar();
    div.addEventListener("change", (ev) => {
      if (ev.target.matches("[data-incluir]")) { filasRevision[i].incluir = ev.target.checked; div.classList.toggle("apagada", !ev.target.checked); }
      else {
        filasRevision[i] = { ...filasRevision[i], ...leerCampos(div, {}) };
        if (ev.target.name === "fecha") filasRevision[i].fecha_leida = true;
      }
    }, true);
    enlazarEstimacion(div, () => ({ ...filasRevision[i], ...leerCampos(div, {}) }), (p) => { filasRevision[i] = { ...filasRevision[i], ...p }; pintar(); });
    cont.appendChild(div);
  });
}

// Fecha no leída (se puso la de hoy) o de hace más de un año: casi siempre es otra fecha del documento
const fechaDudosa = (x) => !x.fecha_leida || Math.abs(Date.now() - Date.parse(x.fecha)) > 366 * 864e5;

function cerrarRevision() { $("#revision").hidden = true; $("#cargar-botones").hidden = false; filasRevision = []; }

async function guardarLote() {
  const elegidas = filasRevision.filter((f) => f.incluir);
  if (!elegidas.length) return aviso("No hay nada tildado.");
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
  if (actual.tipo !== "consulta" && !actual.sugerencias) actual.sugerencias = Motor.sugerencias(actual);
  const pintar = () => {
    cuerpo.innerHTML = `<h2>${p.id ? "Prestación" : "Nueva " + TIPOS[p.tipo].toLowerCase()}</h2>` + camposPrestacion(actual, true) +
      `<div class="fila"><button class="boton" data-ok>Guardar</button><button class="boton secundario" data-cerrar>Cerrar</button>
       ${p.id ? '<button class="boton peligro chico" data-borrar>Borrar</button>' : ""}</div>`;
  };
  pintar();
  cuerpo.onclick = async (ev) => {
    if (ev.target.matches("[data-cerrar]")) dlg.close();
    if (ev.target.matches("[data-borrar]") && confirm("¿Borrar esta prestación?")) { await Almacen.borrar("prestaciones", p.id); dlg.close(); refrescar(); }
    if (ev.target.matches("[data-ok]")) {
      try { await guardarPrestacion(leerCampos(cuerpo, actual)); dlg.close(); aviso("Guardado"); refrescar(); }
      catch (e) { aviso(e.message); }
    }
  };
  if (!cuerpo.dataset.enlazado) {
    cuerpo.dataset.enlazado = "1";
    enlazarEstimacion(cuerpo, () => (cuerpo._actual ? { ...cuerpo._actual(), ...leerCampos(cuerpo, {}) } : null), (n) => cuerpo._guardar(n));
  }
  cuerpo._actual = () => actual;
  cuerpo._guardar = (n) => { actual = { ...actual, ...n }; pintar(); };
  dlg.showModal();
}

// ---------- Prestaciones ----------

function verPrestaciones() {
  const os = $("#f-os").value, est = $("#f-estado").value, q = Motor.plano($("#f-q").value), h = hoy();
  let lista = datos().prestaciones;
  if (!$("#f-todos-meses").checked) lista = lista.filter((p) => p.fecha.slice(0, 7) === mes());
  if (os === "-") lista = lista.filter((p) => !p.obra_social); else if (os) lista = lista.filter((p) => p.obra_social === os);
  if (est === "vencida") lista = lista.filter((p) => Motor.vencida(p, h));
  else if (est === "a_cobrar") lista = lista.filter((p) => ["pendiente", "presentada"].includes(p.estado));
  else if (est) lista = lista.filter((p) => p.estado === est);
  if (q) lista = lista.filter((p) => Motor.plano([p.paciente, p.dni, p.procedimiento].join(" ")).includes(q));
  lista.sort((a, b) => (b.fecha + (b.hora || "")).localeCompare(a.fecha + (a.hora || "")));
  estado.seleccion.clear(); actualizarSeleccion();
  const total = lista.reduce((s, p) => s + (p.valor_estimado || 0), 0);
  $("#lista").innerHTML = lista.length ? `<p class="ayuda">${lista.length} prestaciones · ${pesos(total)} estimado · tildá para marcar varias</p>` +
    lista.map((p) => {
      const chip = Motor.vencida(p, h) ? '<span class="chip vencida">vencida</span>' : `<span class="chip ${p.estado}">${ESTADOS[p.estado]}</span>`;
      const detalle = p.tipo === "consulta" ? "Consulta" : (p.procedimiento || TIPOS[p.tipo]) + (p.rol === "ayudante" ? " (ayudante)" : "") + (p.codigo_aac ? " · " + p.codigo_aac : "");
      return `<div class="item" data-id="${p.id}"><input type="checkbox" data-sel="${p.id}">
        <div class="cuerpo"><div class="titulo">${esc(p.paciente)}</div>
        <div class="sub">${fechaCorta(p.fecha)} · ${esc(p.obra_social || p.obra_social_texto || "¿obra social?")} · ${esc(detalle)}</div></div>
        <div class="monto">${pesos(p.monto_cobrado ?? p.valor_estimado)}<br>${chip}</div></div>`;
    }).join("") : '<p class="ayuda">Nada para mostrar con estos filtros.</p>';
}

function actualizarSeleccion() {
  $("#acciones-sel").hidden = !estado.seleccion.size;
  $("#n-sel").textContent = estado.seleccion.size + " elegidas";
}

async function marcar(nuevo) {
  let fecha = hoy();
  if (nuevo !== "pendiente") {
    fecha = prompt(`Fecha (${nuevo === "cobrada" ? "de cobro" : "de presentación"}), AAAA-MM-DD:`, hoy());
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return;
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
  $("#apellido").value = ajuste("apellido", "");
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

function verTablaValores() {
  const valores = datos().valores.filter((v) => v.obra_social === $("#v-os").value)
    .sort((a, b) => (a.codigo_aac || a.codigo).localeCompare(b.codigo_aac || b.codigo) || b.vigencia.localeCompare(a.vigencia));
  $("#tabla-valores").innerHTML = valores.length ? `<table><tr><th>Código</th><th>Descripción</th><th>Desde</th><th class="n">Monto</th><th></th></tr>` +
    valores.map((v) => `<tr><td>${esc(v.codigo)}<div class="ayuda" style="margin:0">${esc(v.codigo_aac || "")}</div></td>
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
    <label>% del módulo para el cirujano<input type="number" name="pct_modulo" value="${o.pct_modulo ?? ""}" step="0.1"></label>
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

async function recalcularPendientes() {
  const pend = datos().prestaciones.filter((p) => ["pendiente", "presentada"].includes(p.estado));
  for (const p of pend) await guardarPrestacion(p);
  return pend.length;
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
  $("#sync").textContent = Almacen.doc.cuenta ? "Drive: " + e : "Solo en este celular";
  if (estado.vista === "valores") verValores();
}

async function arrancar() {
  $("#mes").value = hoy().slice(0, 7);
  const volvioDeGoogle = Almacen.recibirToken();
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
  ["#f-os", "#f-estado", "#f-todos-meses"].forEach((s) => $(s).addEventListener("change", verPrestaciones));
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
    const n = await recalcularPendientes();
    aviso(`Guardado; ${n} pendientes recalculadas.`);
    verValores();
  });
  $("#apellido").addEventListener("change", () => Almacen.ajuste("apellido", $("#apellido").value.trim()));
  $("#recalcular").addEventListener("click", async () => aviso(`${await recalcularPendientes()} prestaciones recalculadas`));
  $("#exportar").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + exportarCSV()], { type: "text/csv" }));
    a.download = `prestaciones_${mes()}.csv`; a.click();
  });
  $("#planilla").addEventListener("click", async () => {
    try {
      if (!Almacen.tieneToken()) return Almacen.conectar();
      const r = await Almacen.guardarPlanilla(`Prestaciones ${mes()}`, exportarCSV());
      aviso("Planilla guardada en Drive › Liquidaciones");
      if (r.webViewLink) window.open(r.webViewLink, "_blank");
    } catch (e) { aviso(e.message); }
  });
  const conectar = () => { try { Almacen.conectar(); } catch (e) { aviso(e.message); } };
  $("#conectar").addEventListener("click", conectar);
  $("#conectar-inicio").addEventListener("click", conectar);
  $("#sin-drive").addEventListener("click", async (ev) => { ev.preventDefault(); await Almacen.ajuste("sin_drive", true); pedirPin("crear"); });
  $("#sincronizar").addEventListener("click", () => (Almacen.tieneToken() ? Almacen.sincronizar().then(refrescar).catch((e) => aviso(e.message)) : conectar()));
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
  $("#tabla-valores").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-borrar-valor]");
    if (b && confirm("¿Borrar este valor?")) { await Almacen.borrar("valores", b.dataset.borrarValor); verTablaValores(); }
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  window.addEventListener("online", () => Almacen.tieneToken() && Almacen.sincronizar().then(refrescar).catch(() => {}));

  configurarSeguridad();
  estado.volvioDeGoogle = volvioDeGoogle;
  if (Almacen.tienePin()) return pedirPin("desbloquear");
  if (!Almacen.doc.cuenta && !ajuste("sin_drive", false) && !volvioDeGoogle) return ir("bienvenida");
  pedirPin("crear");
}

// Ya desbloqueada (o con el PIN recién creado)
function entrar() {
  $("#pin").value = $("#pin2").value = "";
  $("#f-os").innerHTML = '<option value="">Todas</option>' + datos().obras.map((o) => `<option>${esc(o.nombre)}</option>`).join("") + '<option value="-">Sin reconocer</option>';
  mostrarSync(Almacen.estado);
  ir("inicio");
  if (Almacen.tieneToken()) {
    Almacen.sincronizar().then(() => { if (estado.volvioDeGoogle) aviso("Google Drive conectado: " + Almacen.doc.cuenta); estado.volvioDeGoogle = false; refrescar(); })
      .catch((e) => aviso(e.message));
  } else if (Almacen.doc.cuenta) mostrarSync("pendiente: tocá Valores → Sincronizar");
}

// ---------- Seguridad: PIN, bloqueo automático ----------

const MINUTOS_BLOQUEO = 5;
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
  // Bloqueo automático: 5 minutos sin tocar la app, o al volver a ella después de ese tiempo
  let ultima = Date.now();
  ["pointerdown", "keydown", "input"].forEach((e) => document.addEventListener(e, () => (ultima = Date.now()), { passive: true, capture: true }));
  const controlar = () => {
    if (Almacen.tienePin() && !Almacen.bloqueada() && Date.now() - ultima > MINUTOS_BLOQUEO * 60e3) bloquearYa();
  };
  setInterval(controlar, 15000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && controlar());
}

// Se recarga la página: no queda en memoria ni en pantalla ningún dato de pacientes
function bloquearYa() {
  Almacen.bloquear();
  location.reload();
}

arrancar().catch((e) => aviso(e.message));
