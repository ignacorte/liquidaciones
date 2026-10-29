"use strict";
// Motor de cálculo (corre en el celular): nomencladores AAC/PAMI, sugerencia de código, valor estimado y fechas de
// cobro. Portado de app/codigos.py y app/valuacion.py (versión de PC): mismo algoritmo y mismos datos; si se corrige
// uno, corregir el otro. tests/test_motor_js.py compara los dos.

const Motor = (() => {
  const plano = (t) => (t || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

  // ---------- Sugerencia de código ----------
  const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "con", "por", "para", "en", "un", "una", "incluye",
    "colocacion", "tratamiento", "como", "unico", "procedimiento", "cirugia", "modulo", "guiada", "guia", "bajo", "control",
    "realizacion", "especificados"]);
  const SYNONYMS = { tc: "tomografico", tac: "tomografico", tomografia: "tomografico", eco: "ecografico", ecografia: "ecografico",
    eventracion: "eventroplastia", videolaparoscopica: "laparoscopica", abseso: "absceso", abceso: "absceso", abscesos: "absceso",
    // «hernia umbilical» en un parte = hernioplastia (sin esto gana «hernia hiatal», módulo esofágico)
    hernia: "hernioplastia", hernias: "hernioplastia" };
  const EXTRA_ROOTS = {
    tapp: ["laparo"], tep: ["laparo"], etep: ["laparo"], ipom: ["laparo"], robotica: ["laparo"],
    lichtenstein: ["conven"], rives: ["conven"], stoppa: ["conven"], sublay: ["conven"], onlay: ["conven"], abierta: ["conven"],
    shouldice: ["conven"], tar: ["separa", "compon"], ramirez: ["separa", "compon"],
    coleccion: ["absces"], colecciones: ["absces"], hepatica: ["higado"], hepatico: ["higado"],
    intraabdominal: ["intrap"], intraabdominales: ["intrap"],
    nissen: ["antirr"], toupet: ["antirr"], funduplicatura: ["antirr"], hiatal: ["antirr"],
  };
  const APPROACH_ROOTS = ["laparo", "conven"];
  const EXCLUSIVE_TERMS = ["transvisceral", "endoscop"];
  const OTHER_ROUTES = ["abierta", "laparosc", "transvisceral", "endoscop", "quirurgic", "laparotom", "toracotom"];
  const VIDEO_TERMS = ["laparosc", "videotoracosc", "video", "endosc", "percut", "toracosc"];

  // Órganos: un procedimiento sobre un órgano nunca se codifica con una práctica de otro (biopsia renal ≠ biopsia de páncreas)
  const ORGANOS = [["renal", /\b(renal|renales|rinon|nefr[a-z]*)\b/], ["suprarrenal", /\b(suprarrenal[a-z]*|adrenal[a-z]*)\b/],
    ["higado", /\b(hepat[a-z]*|higado)\b/], ["pancreas", /\bpancrea[a-z]*/], ["tiroides", /\btiroid[a-z]*/], ["bazo", /\b(esplen[a-z]*|bazo)\b/],
    ["pulmon", /\b(pulmon[a-z]*|pleur[a-z]*)\b/], ["mama", /\bmama[a-z]*/], ["prostata", /\bprostat[a-z]*/],
    ["vejiga", /\b(vesical[a-z]*|vesico[a-z]*|vejiga)\b/], ["salival", /\b(salival[a-z]*|parotid[a-z]*)\b/]];
  const organos = (t) => new Set(ORGANOS.filter(([, re]) => re.test(t)).map(([o]) => o));

  const COBERTURA = 0.35;
  const raiz = (w) => (w.includes("ectom") ? w.slice(0, 6) + "~ect" : w.includes("ostom") ? w.slice(0, 6) + "~ost" : w.slice(0, 6));

  function palabras(texto) {
    const words = new Set();
    for (let w of plano(texto).match(/[a-z]+/g) || []) {
      (EXTRA_ROOTS[w] || []).forEach((r) => words.add(r));
      w = SYNONYMS[w] || w;
      if (w.length > 2 && !STOPWORDS.has(w)) words.add(raiz(w));
    }
    if (words.has("biopsi") && words.has("percut")) words.add("puncio");
    if (words.has("coleci~ect") && words.has("laparo")) words.add("colela");
    if (words.has("antirr")) words.delete("hernio");
    if (words.has("higado")) words.delete("hepati"); // el órgano cuenta una vez (si no, le gana a la acción: punción ≠ segmentectomía)
    return words;
  }

  const catalogos = {};
  const idfs = {};

  function idf(nombre) {
    if (idfs[nombre]) return idfs[nombre];
    const codes = catalogos[nombre].codes, counts = {};
    for (const c of codes) for (const w of palabras(c.items.join(" ") + " " + c.name)) counts[w] = (counts[w] || 0) + 1;
    const out = {};
    for (const [w, n] of Object.entries(counts)) out[w] = Math.log((codes.length + 1) / (n + 0.5));
    return (idfs[nombre] = out);
  }

  function sugerir(nombre, procedimiento, limite = 3) {
    const data = catalogos[nombre];
    if (!data || !(procedimiento || "").trim()) return [];
    // «VIDEOCOLECISTECTOMIA», «videolaparoscópica»: el prefijo pegado se separa
    procedimiento = procedimiento.replace(/\b(video)(?=[a-záéíóúñ]{6,})/gi, "$1 ");
    const pesos = idf(nombre), wanted = palabras(procedimiento);
    let plain = plano(procedimiento);
    if (wanted.has("antirr")) plain += " diafragm"; // la cirugía antirreflujo lleva plástica diafragmática
    const organosPedidos = organos(plain);
    const pesoTotal = [...wanted].reduce((t, w) => t + (pesos[w] || 0), 0);
    const scored = [];
    for (const code of data.codes) {
      let best = 0;
      const nameWords = palabras(code.name);
      for (const item of code.items.length ? code.items : [code.name]) {
        const words = new Set([...palabras(item), ...nameWords]);
        let score = 0;
        for (const w of wanted) if (words.has(w)) score += pesos[w] || 0;
        // Cobertura mínima: el código tiene que cubrir buena parte de lo pedido (no una sola palabra suelta)
        if (pesoTotal && score < pesoTotal * COBERTURA) continue;
        for (const r of APPROACH_ROOTS) {
          if (words.has(r) && !wanted.has(r) && APPROACH_ROOTS.some((o) => o !== r && wanted.has(o))) score -= 3;
        }
        const itemPlain = plano(item + " " + code.name);
        score -= 6 * EXCLUSIVE_TERMS.filter((t) => itemPlain.includes(t) && !plain.includes(t)).length;
        if (wanted.has("percut") && !words.has("percut") && OTHER_ROUTES.some((t) => itemPlain.includes(t))) score -= 4;
        for (const q of ["bilateral", "recidivad", "diafragm", "coledocotom"]) if (plano(item).includes(q) && !plain.includes(q)) score -= 3;
        const delCodigo = organos(itemPlain);
        if (organosPedidos.size && delCodigo.size && ![...delCodigo].some((o) => organosPedidos.has(o))) score -= 20;
        else if (organosPedidos.size && !delCodigo.size) score -= 4; // el procedimiento nombra un órgano y el código no
        best = Math.max(best, score);
      }
      if (best > 0) scored.push([best, code]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limite).map(([, c]) => c);
  }

  function buscar(nombre, texto, limite = 20) {
    const q = plano(texto).trim();
    if (!q || !catalogos[nombre]) return [];
    const t = q.split(/\s+/);
    return catalogos[nombre].codes.filter((c) => c.code.startsWith(q) || t.every((x) => plano(c.name + " " + c.items.join(" ")).includes(x))).slice(0, limite);
  }

  const infoCodigo = (nombre, code) => (catalogos[nombre]?.codes || []).find((c) => c.code === code) || null;

  // ---------- Feriados y horario (recargo AAC por urgencia) ----------
  function pascua(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, mes - 1, dia));
  }
  const iso = (d) => d.toISOString().slice(0, 10);
  const sumarDias = (fecha, n) => { const d = new Date(fecha + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  function esFeriado(fecha) {
    // Nacionales inamovibles + Carnaval y Viernes Santo (los trasladables no se mueven acá: diferencia menor)
    const y = +fecha.slice(0, 4), md = fecha.slice(5);
    if (["01-01", "03-24", "04-02", "05-01", "05-25", "06-20", "07-09", "12-08", "12-25", "06-17", "08-17", "10-12", "11-20"].includes(md)) return true;
    const p = iso(pascua(y));
    return [sumarDias(p, -48), sumarDias(p, -47), sumarDias(p, -2)].includes(fecha);
  }
  function fueraDeHorario(fecha, hora) {
    const dow = new Date(fecha + "T00:00:00Z").getUTCDay(); // 0 domingo
    if (esFeriado(fecha) || dow === 0) return true;
    if (!hora || !/^\d{1,2}:\d{2}/.test(hora)) return false;
    const h = +hora.split(":")[0];
    return h >= 21 || h < 7 || (dow === 6 && h >= 13);
  }

  function honorarioAAC(code, valorUQ, fecha, hora, abordaje, urgencia) {
    const info = infoCodigo("AAC", code);
    if (!info) return null;
    const reglas = catalogos.AAC.rules, ajustes = [];
    const nombre = info.name.toLowerCase();
    if (["laparoscopica", "robotica"].includes(abordaje) && !VIDEO_TERMS.some((t) => nombre.includes(t))) ajustes.push(["videoendoscópica", reglas.videoendoscopic_pct]);
    if (urgencia && fecha && fueraDeHorario(fecha, hora)) ajustes.push(["urgencia fuera de horario", reglas.off_hours_emergency_pct]);
    const factor = 1 + ajustes.reduce((s, [, p]) => s + p, 0) / 100;
    return { codigo: info.code, nombre: info.name, uq: info.uq, valorUQ, ajustes, cirujano: Math.round(info.uq * valorUQ * factor) };
  }

  // ---------- Equivalencias código de obra social → AAC ----------
  // Verificadas por descripción (el mismo número no es la misma práctica en distintos nomencladores: APROSS 080527 es
  // apendicectomía laparoscópica y AAC 08.05.27 es devolvulación de colon). Fuente: Quirón (billing/analysis.py),
  // Nomenclador PAMI y RESOL-2023-1069; APROSS Res. 177/2026 y 189/2025.
  const EQUIVALENCIAS = {
    PAMI: { 820125: "CONSULTA", 820126: "CONSULTA", 301033: "08.02.17", 301032: "08.02.25", 301034: "08.02.19", 301017: "08.07.09",
            301024: "08.05.24", 301029: "13.01.13", 301030: "13.01.04" },
    APROSS: { 420128: "CONSULTA", 420504: "CONSULTA", 420505: "CONSULTA", 42010101: "CONSULTA", "080203": "08.02.17", "080205": "08.02.25",
              "080215": "08.02.27", "080206": "08.02.35", "080210": "08.02.34", "080714": "08.07.09", "080524": "08.05.24", "080527": "08.05.24",
              130102: "13.01.02", 13010200: "13.01.02", 130104: "13.01.04", 130112: "13.01.12", 130113: "13.01.13" },
  };
  const CODIGOS_CONSULTA = new Set(["820125", "820126", "940100", "42010101", "420101", "42010100"]);
  const equivalenteAAC = (os, codigo) => (codigo ? EQUIVALENCIAS[os]?.[codigo] || (CODIGOS_CONSULTA.has(codigo) ? "CONSULTA" : null) : null);

  // ---------- Valuación ----------
  const CONSULTA = "CONSULTA", PARTICULAR_TABLA = "MÍNIMO ÉTICO CMPC";
  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
  const pesosDec = (n) => "$" + Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

  // datos = { obras: [{nombre, alias, dias_pago, dia_presentacion, pct_modulo}], valores: [{obra_social, codigo, monto,
  //   vigencia 'AAAA-MM-01', tipo, codigo_aac, fuente}], uq: [{valor, vigencia}], prestaciones: [...] }
  function obraSocialCanonica(datos, texto) {
    const pal = (t) => " " + plano(t).replace(/[^a-z0-9]+/g, " ").trim() + " ";
    const escrito = pal((texto || "").replace(/^\s*\d+\s*-\s*/, ""));
    let mejor = null;
    for (const o of datos.obras) {
      for (const alias of [o.nombre, ...(o.alias || "").split(",")]) {
        const k = pal(alias);
        if (k.trim() && escrito.includes(k) && (!mejor || k.length > mejor[0])) mejor = [k.length, o.nombre];
      }
    }
    return mejor ? mejor[1] : null;
  }

  function valorUQ(datos, fecha) {
    const v = datos.uq.filter((u) => u.vigencia <= fecha).sort((a, b) => b.vigencia.localeCompare(a.vigencia))[0];
    return v ? v.valor : catalogos.AAC.uq_value;
  }

  // «08.02.03» = «080203» (las listas importadas traen los códigos con o sin puntos)
  const mismoCodigo = (a, b) => String(a ?? "").replace(/[.\-\s]/g, "") === String(b ?? "").replace(/[.\-\s]/g, "");
  function valorOS(datos, os, codigoAAC, codigoOS, fecha) {
    if (!os) return null;
    const c = datos.valores.filter((v) => v.obra_social === os && v.vigencia <= fecha &&
      ((codigoAAC && v.codigo_aac === codigoAAC) || (codigoOS && mismoCodigo(v.codigo, codigoOS))));
    c.sort((a, b) => (b.tipo === "honorario") - (a.tipo === "honorario") || b.vigencia.localeCompare(a.vigencia));
    return c[0] || null;
  }

  // Lo cobrado la última vez por la misma práctica (mismo código AAC, o mismo código de la obra social)
  function ultimoCobro(datos, os, codigoAAC, codigoOS, rol, pct, id) {
    if (!os || !(codigoAAC || codigoOS)) return null;
    return datos.prestaciones.filter((p) => !p.borrada && p.obra_social === os && ((codigoAAC && p.codigo_aac === codigoAAC) ||
      (codigoOS && p.codigo_os === codigoOS)) && (p.rol || "cirujano") === rol &&
      (p.pct || 100) === pct && p.monto_cobrado > 0 && p.id !== id).sort((a, b) => (b.fecha_cobro || "").localeCompare(a.fecha_cobro || ""))[0] || null;
  }

  function sugerencias(p) {
    const texto = [p.procedimiento, p.abordaje].filter(Boolean).join(" ");
    return { aac: sugerir("AAC", texto).map((c) => ({ code: c.code, name: c.name, uq: c.uq })),
             pami: sugerir(catalogos.PAMI_TODO ? "PAMI_TODO" : "PAMI", texto, 5).map((c) => ({ code: c.code, name: c.name, tipo: c.tipo, h: c.h, modulo: c.modulo })) };
  }

  function fechasCobro(datos, os, fecha, presentada) {
    const o = datos.obras.find((x) => x.nombre === os);
    const diasPago = o ? o.dias_pago : 60, diaPres = o ? o.dia_presentacion : 10;
    if (!diaPres) return { fecha_presentacion: null, fecha_cobro_estimada: fecha };
    let pres = presentada;
    if (!pres) {
      let y = +fecha.slice(0, 4), m = +fecha.slice(5, 7) + 1;
      if (m > 12) { m = 1; y += 1; }
      pres = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(diaPres, 28)).padStart(2, "0")}`;
    }
    return { fecha_presentacion: pres, fecha_cobro_estimada: sumarDias(pres, diasPago) };
  }

  // «% a facturar» vacío = 100; 0 = no se cobra (p. ej. ayudantía en un módulo)
  const pctDe = (x) => (x === 0 || x === "0" ? 0 : Number(x) || 100);

  // PAMI paga el módulo completo a la institución, sin separar cirujano y ayudantes: la ayudantía no se cobra aparte
  function ayudantiaEnModuloPami(os, p, codigoOS) {
    if (os !== "PAMI" || (p.rol || "cirujano") !== "ayudante" || p.valor_manual) return null;
    const vp = codigoOS ? valorPami(codigoOS, p.fecha) : null;
    return vp && vp.modulo ? vp : null;
  }

  // Parte del módulo para el cirujano: la cargada en la cirugía o, si no, la de la obra social
  function pctModulo(p, o) {
    if (p.pct_modulo > 0) return { pct: Number(p.pct_modulo), nota: " (cargado en la cirugía)" };
    if (o && o.pct_modulo) return { pct: o.pct_modulo, nota: "" };
    return null;
  }

  function valor(datos, p, os, codigoAAC, codigoOS) {
    if (p.valor_manual) return [Number(p.valor_manual), "Cargado a mano"];
    const rol = p.rol || "cirujano", pct = pctDe(p.pct), reglas = catalogos.AAC.rules;
    if (pct === 0) return [0, "0 % a facturar: no se cobra"];
    const factor = (rol === "ayudante" ? reglas.assistant_pct / 100 : 1) * pct / 100;
    const extra = (rol === "ayudante" ? ` × ${reglas.assistant_pct} % (ayudante)` : "") + (pct !== 100 ? ` × ${pct} % (operación múltiple)` : "");
    const tabla = os === "PARTICULAR" ? PARTICULAR_TABLA : os;
    const fila = valorOS(datos, tabla, codigoAAC, codigoOS, p.fecha);
    if (fila && fila.tipo === "honorario") {
      return [Math.round(fila.monto * factor), `${tabla} ${fila.codigo} vigente desde ${fila.vigencia.slice(0, 7)}${extra} · ${fila.fuente || "s/fuente"}`];
    }
    const cobro = ultimoCobro(datos, os, codigoAAC, codigoOS, rol, pct, p.id);
    if (cobro) return [Math.round(cobro.monto_cobrado), `Último cobro real ${os} ${codigoAAC || codigoOS} (${cobro.fecha_cobro})`];
    let modulo = "";
    const vp = os === "PAMI" && codigoOS ? valorPami(codigoOS, p.fecha) : null;
    if (vp && !vp.modulo && !vp.sinValor) {
      return [Math.round(vp.monto * factor), `PAMI ${vp.codigo}: ${vp.unidades} u. de honorarios ${vp.tipo} × ${pesosDec(vp.valorUnidad)}${extra} · ` +
        `${vp.fuente}${vp.gastos ? ` · gastos para la institución: ${pesos(vp.gastos)}` : ""}`];
    }
    if (vp && vp.modulo && !(fila && fila.tipo === "modulo")) {
      const o = datos.obras.find((x) => x.nombre === os);
      const pm = pctModulo(p, o);
      if (pm) return [Math.round(vp.monto * pm.pct / 100 * factor), `Módulo PAMI ${vp.codigo} ${pesos(vp.monto)} × ${pm.pct} %${pm.nota}${extra}`];
      modulo = ` · Módulo PAMI ${vp.codigo}: ${vp.unidades} u. × ${pesosDec(vp.valorUnidad)} = ${pesos(vp.monto)} (total a la institución)`;
    }
    if (vp && vp.sinValor) modulo = ` · PAMI ${vp.codigo}: ${vp.unidades} u. ${vp.tipo} (falta el valor de esa unidad)`;
    if (fila && fila.tipo === "modulo") {
      const o = datos.obras.find((x) => x.nombre === os);
      const pm = pctModulo(p, o);
      if (pm) return [Math.round(fila.monto * pm.pct / 100 * factor), `Módulo ${os} ${fila.codigo} ${pesos(fila.monto)} × ${pm.pct} %${pm.nota}${extra}`];
      modulo = ` · Módulo ${os} ${fila.codigo}: ${pesos(fila.monto)} (total a la institución)`;
    }
    const uq = valorUQ(datos, p.fecha);
    if (p.tipo === "consulta") return [Math.round(reglas.consult_uq * uq), `Referencia AAC: consulta ${reglas.consult_uq} UQ × ${pesos(uq)} (sin valor cargado para la obra social)`];
    const hon = honorarioAAC(codigoAAC, uq, p.fecha, p.hora, p.abordaje, p.urgencia);
    if (!hon) {
      // Sin práctica de la AAC equivalente (p. ej. biopsia renal: la AAC no tiene urología de ese tipo)
      if (modulo) return [null, `Sin honorario conocido${modulo}. Cargá el «% del módulo para vos» en la cirugía o el valor a mano.`];
      return [null, "Sin código: elegí el código del procedimiento"];
    }
    const aj = hon.ajustes.map(([n, x]) => ` +${x} % ${n}`).join("");
    return [Math.round(hon.cirujano * factor), `Referencia AAC ${hon.codigo}: ${hon.uq} UQ × ${pesos(uq)}${aj}${extra}${modulo}`];
  }

  // Completa una prestación: obra social del padrón, código sugerido, valor y fechas. No modifica p.
  function estimar(datos, p) {
    const os = p.obra_social || obraSocialCanonica(datos, p.obra_social_texto);
    const out = { obra_social: os, codigo_aac: p.codigo_aac || null, codigo_os: p.codigo_os || null, sugerencias: null };
    const equivalente = equivalenteAAC(os, out.codigo_os);
    if (p.tipo === "consulta") out.codigo_aac = CONSULTA;
    else if (!out.codigo_aac && equivalente && equivalente !== CONSULTA) out.codigo_aac = equivalente;
    else if (!out.codigo_aac) {
      out.sugerencias = sugerencias(p);
      if (out.sugerencias.aac.length) out.codigo_aac = out.sugerencias.aac[0].code;
      if (!out.codigo_os && os === "PAMI" && out.sugerencias.pami.length) out.codigo_os = out.sugerencias.pami[0].code;
    }
    [out.valor_estimado, out.valor_origen] = valor(datos, p, os, out.codigo_aac, out.codigo_os);
    const sinCobro = !p.valor_manual && (pctDe(p.pct) === 0 || ayudantiaEnModuloPami(os, p, out.codigo_os));
    if (sinCobro && pctDe(p.pct) !== 0) {
      const vp = ayudantiaEnModuloPami(os, p, out.codigo_os);
      [out.valor_estimado, out.valor_origen] = [0, `Ayudantía en módulo PAMI ${vp.codigo}: PAMI paga el módulo completo (${pesos(vp.monto)}) a la institución, sin separar ayudantes; no se cobra aparte`];
    }
    // Otros procedimientos del mismo acto (mismo paciente y día): cada uno con su código, al % de operación múltiple (AAC)
    if (p.extras?.length && p.tipo !== "consulta") {
      const pct = catalogos.AAC.rules.multiple_same_approach_pct;
      out.extras = p.extras.map((x) => {
        const e = estimar(datos, { ...p, extras: null, procedimiento: x.procedimiento, codigo_aac: x.codigo_aac || null, codigo_os: x.codigo_os || null,
          pct: x.pct || pct, valor_manual: null });
        return { procedimiento: x.procedimiento || "", codigo_aac: e.codigo_aac, codigo_os: e.codigo_os || x.codigo_os || null, pct: x.pct || pct,
                 valor: e.valor_estimado, sugerencias: e.sugerencias };
      });
      const suma = out.extras.reduce((t, x) => t + (x.valor || 0), 0);
      if (sinCobro) out.extras.forEach((x) => { x.valor = 0; });
      else if (!p.valor_manual && out.valor_estimado != null) {
        out.valor_estimado += suma;
        out.valor_origen += ` · + ${out.extras.length} procedimiento${out.extras.length > 1 ? "s" : ""} del mismo acto (${pesos(suma)})`;
      }
    }
    Object.assign(out, fechasCobro(datos, os, p.fecha, p.fecha_presentacion));
    return out;
  }

  // Al guardar: estado coherente con las fechas; particular = cobrada en el acto
  function completar(datos, p) {
    const q = { ...p };
    if (q.monto_cobrado && !q.fecha_cobro) q.fecha_cobro = new Date().toISOString().slice(0, 10);
    if (q.fecha_cobro && ["pendiente", "presentada"].includes(q.estado)) q.estado = "cobrada";
    if (q.estado === "pendiente") q.fecha_presentacion = null; // la guardada es la estimada: se recalcula
    const e = estimar(datos, q);
    delete e.sugerencias;
    if (e.extras) e.extras = e.extras.map(({ sugerencias, ...x }) => x);
    Object.assign(q, e);
    if (q.fecha_presentacion === null && q.estado === "pendiente" && q.valor_estimado) {
      Object.assign(q, { estado: "cobrada", fecha_cobro: q.fecha, monto_cobrado: q.valor_estimado });
    }
    return q;
  }

  // ---------- Resúmenes ----------
  const vencida = (p, hoy) => ["pendiente", "presentada"].includes(p.estado) && p.fecha_cobro_estimada && p.fecha_cobro_estimada < hoy;
  const meses = (desde, hasta) => Math.max(0, (new Date(hasta) - new Date(desde.slice(0, 10))) / 864e5) / 30.4;

  function resumen(datos, mes, hoy, inflacion) {
    const filas = datos.prestaciones.filter((p) => !p.borrada && p.fecha.slice(0, 7) === mes);
    const nuevo = () => ({ n: 0, consultas: 0, cirugias: 0, estimado: 0, cobrado: 0, pendiente: 0, vencido: 0, nominal: 0, real: 0 });
    const tot = nuevo(), porOS = {}, porPac = {};
    for (const p of filas) {
      const est = p.valor_estimado || 0;
      const cob = ["cobrada", "debitada"].includes(p.estado) ? p.monto_cobrado || 0 : 0;
      const pend = ["pendiente", "presentada"].includes(p.estado) ? est : 0;
      const cuando = p.fecha_cobro || p.fecha_cobro_estimada || hoy;
      const real = (cob || est) / Math.pow(1 + inflacion / 100, meses(p.fecha, cuando > p.fecha ? cuando : p.fecha));
      const kOS = p.obra_social || p.obra_social_texto || "Sin obra social", kP = p.paciente + "|" + (p.obra_social || "");
      for (const d of [tot, porOS[kOS] ||= nuevo(), porPac[kP] ||= nuevo()]) {
        d.n++; d.consultas += p.tipo === "consulta"; d.cirugias += p.tipo === "cirugia";
        d.estimado += est; d.cobrado += cob; d.pendiente += pend; d.real += real; d.nominal += cob || est;
        if (vencida(p, hoy)) d.vencido += est;
      }
    }
    const cerrar = (d) => ({ ...d, perdida_inflacion: Math.round(d.nominal - d.real) });
    return {
      totales: cerrar(tot),
      por_obra_social: Object.entries(porOS).map(([k, v]) => ({ obra_social: k, ...cerrar(v) })).sort((a, b) => b.estimado - a.estimado),
      por_paciente: Object.entries(porPac).map(([k, v]) => ({ paciente: k.split("|")[0], obra_social: k.split("|")[1], ...cerrar(v) })).sort((a, b) => b.estimado - a.estimado),
    };
  }

  function cobros(datos, hoy) {
    const porMes = {}, vencidas = [], aPresentar = {};
    const pendientes = datos.prestaciones.filter((p) => !p.borrada && ["pendiente", "presentada"].includes(p.estado))
      .sort((a, b) => (a.fecha_cobro_estimada || "").localeCompare(b.fecha_cobro_estimada || ""));
    for (const p of pendientes) {
      const v = p.valor_estimado || 0, os = p.obra_social || "Sin obra social";
      let clave;
      if (vencida(p, hoy)) {
        vencidas.push({ ...p, dias_atraso: Math.round((new Date(hoy) - new Date(p.fecha_cobro_estimada)) / 864e5) });
        clave = "vencido";
      } else clave = (p.fecha_cobro_estimada || hoy).slice(0, 7);
      const m = (porMes[clave] ||= { total: 0, n: 0, os: {} });
      m.total += v; m.n++; m.os[os] = (m.os[os] || 0) + v;
      if (p.estado === "pendiente" && p.fecha_presentacion && p.fecha_presentacion >= hoy) {
        const x = (aPresentar[os] ||= { n: 0, total: 0, fecha: p.fecha_presentacion });
        x.n++; x.total += v; if (p.fecha_presentacion < x.fecha) x.fecha = p.fecha_presentacion;
      }
    }
    return {
      meses: Object.entries(porMes).sort(([a], [b]) => (a === "vencido" ? -1 : b === "vencido" ? 1 : a.localeCompare(b)))
        .map(([mes, v]) => ({ mes, total: v.total, n: v.n, obras_sociales: Object.entries(v.os).sort((a, b) => b[1] - a[1]) })),
      vencidas,
      a_presentar: Object.entries(aPresentar).map(([k, v]) => ({ obra_social: k, ...v })).sort((a, b) => a.fecha.localeCompare(b.fecha)),
    };
  }

  function plazosReales(datos) {
    const g = {};
    for (const p of datos.prestaciones) {
      if (p.borrada || !p.fecha_cobro) continue;
      const x = (g[p.obra_social || "—"] ||= { n: 0, dias: 0, cobrado: 0, estimado: 0 });
      x.n++; x.dias += (new Date(p.fecha_cobro) - new Date(p.fecha)) / 864e5; x.cobrado += p.monto_cobrado || 0; x.estimado += p.valor_estimado || 0;
    }
    return Object.entries(g).map(([os, x]) => ({ obra_social: os, n: x.n, dias: Math.round(x.dias / x.n),
      cobrado_vs_estimado: x.estimado ? Math.round(1000 * x.cobrado / x.estimado) / 10 : null })).sort((a, b) => b.dias - a.dias);
  }

  async function cargarCatalogos(base = "datos/") {
    const [aac, pami, nom, unidades] = await Promise.all(["aac_2026_08.json", "pami_2024_02.json", "pami_nomenclador_2026_10.json", "pami_unidades.json"]
      .map((f) => fetch(base + f).then((r) => r.json())));
    catalogos.AAC = aac; catalogos.PAMI = pami;
    catalogos.PAMI_NOM = nom;
    unidadesPami = unidades.unidades;
    // Para sugerir el código PAMI: los módulos de cirugía (con lo que incluye cada uno) + las prácticas quirúrgicas, clínicas
    // y de imágenes del nomenclador oficial (no laboratorio, odontología, traslados…)
    const modulos = new Set(pami.codes.map((c) => c.code));
    const porCodigo = new Map(nom.codes.map((c) => [c.code, c]));
    catalogos.PAMI_TODO = { codes: pami.codes.map((c) => ({ ...porCodigo.get(c.code), ...c })).concat(nom.codes.filter((c) =>
      !modulos.has(c.code) && !/ONCOPLAN/.test(c.modulo) && /QUIRURGICA|CLINICA \(I-II-III\)|IMAGENES|CONSULTA MEDICA \(II-III\)/.test(c.tipo))) };
  }

  // ---------- Valor PAMI por unidades del nomenclador oficial ----------
  // Valor = unidades × valor de la unidad vigente. Prácticas comunes: honorarios (médico) y gastos (institución) por
  // separado. Tipos «MODULADA»: módulo, pago total a la institución (las unidades vienen en la columna de honorarios).
  let unidadesPami = [];
  function unidadPami(tipo, fecha) {
    const del = unidadesPami.filter((u) => u.tipo === tipo).sort((a, b) => b.vigencia.localeCompare(a.vigencia));
    return del.find((u) => u.vigencia <= (fecha || "").slice(0, 7)) || del[del.length - 1] || null;
  }
  function valorPami(codigo, fecha) {
    const c = (catalogos.PAMI_NOM?.codes || []).find((x) => x.code === String(codigo || ""));
    if (!c || !c.tipo || !c.h) return null;
    const u = unidadPami(c.tipo, fecha);
    if (!u) return { codigo: c.code, nombre: c.name, sinValor: true, unidades: c.h, tipo: c.tipo };
    if (/MODULADA/.test(c.tipo)) {
      return { codigo: c.code, nombre: c.name, modulo: true, monto: c.h * u.gasto, unidades: c.h, tipo: c.tipo, valorUnidad: u.gasto, fuente: u.fuente };
    }
    if (!u.honorario) return null;
    return { codigo: c.code, nombre: c.name, monto: c.h * u.honorario, unidades: c.h, tipo: c.tipo, valorUnidad: u.honorario, fuente: u.fuente,
             gastos: c.g && u.gasto ? c.g * u.gasto : 0 };
  }

  return { plano, sugerir, buscar, infoCodigo, honorarioAAC, obraSocialCanonica, estimar, completar, sugerencias, fechasCobro,
           resumen, cobros, plazosReales, vencida, cargarCatalogos, catalogos, valorUQ, CONSULTA, equivalenteAAC, valorPami };
})();
