// Asistente de IA (como el de Quirón): el médico pregunta o pide cambios en lenguaje común y la IA consulta los datos con
// herramientas. Modelo abierto en Groq (plan gratuito, clave propia de cada médico, guardada solo en su dispositivo y cifrada
// con el PIN; Groq no entrena con lo que recibe). Seguridad:
// 1. Ningún dato de pacientes sale del dispositivo: las herramientas devuelven las prestaciones con una referencia («P12») y
//    el paciente como «#3»; nunca nombre, DNI, afiliado, notas ni observaciones. Los nombres que el médico escribe se tapan
//    («la de Pérez» → «la de [paciente #3]») y la app sabe a quién corresponde cada uno.
// 2. Antes de mandar, el médico ve la indicación tal como sale. Control final: si en lo que sale aparece un DNI, un afiliado
//    o un nombre de paciente, no se manda nada.
// 3. La IA no puede borrar ni guardar: solo PROPONE cambios y marcas (presentada/cobrada); el médico ve cada uno con el
//    nombre del paciente, elige cuáles aplicar y puede deshacer. Nunca se pierde ni se pisa un dato sin que lo acepte.
// Las cuentas (cuánto falta cobrar, vencido, etc.) las hace la app (motor.js), no la IA.
const AsistenteLiq = (() => {
  const URL_GROQ = "https://api.groq.com/openai/v1";
  const MODELO = "openai/gpt-oss-120b";
  const PREFERIDOS = ["openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct", "qwen/qwen3-32b", "llama-3.3-70b-versatile", "openai/gpt-oss-20b"];
  const MAX_PASOS = 6;

  // Campos que la IA puede proponer cambiar (nunca paciente, DNI, afiliado, notas, documentos)
  const EDITABLES = ["fecha", "tipo", "obra_social", "procedimiento", "abordaje", "rol", "urgencia", "codigo_aac", "codigo_os", "institucion", "monto_cobrado", "pct"];
  const NOMBRES = { fecha: "Fecha", tipo: "Tipo", obra_social: "Obra social", procedimiento: "Procedimiento", abordaje: "Abordaje", rol: "Rol", urgencia: "Urgencia",
    codigo_aac: "Código AAC", codigo_os: "Código de la obra social", institucion: "Institución", monto_cobrado: "Monto cobrado", pct: "% a facturar" };
  const ESTADOS = ["pendiente", "presentada", "cobrada"];

  const HERRAMIENTAS = [
    { type: "function", function: { name: "buscar_prestaciones",
      description: "Busca prestaciones (consultas, cirugías, endoscopías, prácticas) del médico. Devuelve cada una con su referencia (ref), el paciente como #n, fecha, obra social, procedimiento, códigos, estado y montos. Usala para encontrar las prestaciones antes de proponer cambios o para responder preguntas de detalle.",
      parameters: { type: "object", properties: {
        mes: { type: "string", description: "AAAA-MM" }, desde: { type: "string", description: "AAAA-MM-DD" }, hasta: { type: "string", description: "AAAA-MM-DD" },
        obra_social: { type: "string" }, estado: { type: "string", enum: ["pendiente", "presentada", "cobrada", "debitada", "a_cobrar", "vencida"] },
        tipo: { type: "string", enum: ["consulta", "cirugia", "endoscopia", "practica", "procedimientos"] },
        texto: { type: "string", description: "Palabras del procedimiento o código" }, paciente: { type: "string", description: "Referencia de paciente #n" },
        limite: { type: "integer", description: "Máximo de filas (hasta 60)" } } } } },
    { type: "function", function: { name: "resumen_del_mes",
      description: "Totales de un mes calculados por la app: facturado estimado, cobrado, falta cobrar, vencido, cantidad de prestaciones y el detalle por obra social.",
      parameters: { type: "object", properties: { mes: { type: "string", description: "AAAA-MM" } }, required: ["mes"] } } },
    { type: "function", function: { name: "cobros_previstos",
      description: "Lo que falta cobrar (todos los meses): cuánto entra cada mes según los plazos de cada obra social, lo vencido y lo que hay que presentar y hasta cuándo.",
      parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "proponer_cambios",
      description: "Propone cambiar datos de prestaciones. NO guarda nada: el médico ve la propuesta y decide. Campos: " + EDITABLES.join(", ") +
        ". fecha en AAAA-MM-DD; urgencia true/false; rol cirujano|ayudante; abordaje laparoscopica|convencional|robotica|percutanea|endoscopica; tipo consulta|cirugia|endoscopia|practica; monto_cobrado y pct números.",
      parameters: { type: "object", properties: { cambios: { type: "array", items: { type: "object", properties: {
        ref: { type: "string" }, campo: { type: "string", enum: EDITABLES }, valor: {} }, required: ["ref", "campo", "valor"] } } }, required: ["cambios"] } } },
    { type: "function", function: { name: "proponer_estado",
      description: "Propone marcar prestaciones como presentada, cobrada o pendiente (volver a sin presentar). NO guarda nada: el médico confirma. Cobrada sin monto toma el valor estimado.",
      parameters: { type: "object", properties: { refs: { type: "array", items: { type: "string" } }, estado: { type: "string", enum: ESTADOS },
        fecha: { type: "string", description: "AAAA-MM-DD de presentación o de cobro (por defecto hoy)" } }, required: ["refs", "estado"] } } },
  ];

  const instrucciones = (hoy, rama) => `Sos el asistente de la app Liquidaciones de un médico argentino (${rama === "anestesia" ? "anestesiólogo" : "cirujano"}): lleva sus prestaciones, lo que factura a cada obra social y lo que cobra. Hoy es ${hoy}.
Usá las herramientas para consultar los datos; nunca inventes números: los totales los calcula la app (resumen_del_mes, cobros_previstos, buscar_prestaciones).
Para cambiar algo, primero buscá las prestaciones y después usá proponer_cambios o proponer_estado: NO se guarda nada hasta que el médico lo confirme. No hay forma de borrar prestaciones.
Los pacientes aparecen como «#n» o «[paciente #n]» (la app oculta sus datos): usá esa referencia en el filtro "paciente" y nombralos así en la respuesta.
Si hay ambigüedad (varias prestaciones posibles, falta la fecha), preguntá antes de proponer.
${rama === "anestesia" ? "Rama anestesiología: no uses códigos AAC, PAMI ni módulos de cirugía. Nunca nombres siglas de asociaciones: decí «la asociación».\n" : ""}Respondé en castellano rioplatense, breve y claro, con montos en pesos ($ 1.234.567). Fechas como DD/MM/AAAA.`;

  // ---------- Privacidad: referencias en lugar de pacientes ----------
  // Palabras que no se tapan aunque coincidan con un nombre (meses, estados, obras sociales…): «las de julio» es el mes
  const COMUNES = new Set(("enero febrero marzo abril mayo junio julio agosto septiembre setiembre octubre noviembre diciembre lunes martes miercoles jueves viernes sabado domingo " +
    "hoy ayer manana semana mes ano cobrada cobradas presentada presentadas pendiente pendientes vencida vencidas debitada consulta consultas cirugia cirugias " +
    "todas todos las los del de la el que con sin para por una uno dos tres esta este cuanto cuanta falta cobrar pami osde swiss medical galeno sancor apross iosfa").split(" "));

  // Se crea una vez por conversación (las referencias P12 / #3 se mantienen) y se actualiza con cada mensaje (`indexar`)
  function crearPrivado(prestaciones, plano) {
    const refs = new Map(), idDeRef = new Map(), tokens = new Map(), tokenDe = new Map();
    let palabras = new Map(), sensibles = new Set(), nRef = 0, nTok = 0;
    const clave = (p) => plano(p.paciente || "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
    const ref = (p) => { if (!refs.has(p.id)) { refs.set(p.id, "P" + ++nRef); idDeRef.set("P" + nRef, p.id); } return refs.get(p.id); };
    const tokenPaciente = (k) => { if (!tokenDe.has(k)) { const t = "#" + ++nTok; tokenDe.set(k, t); tokens.set(t, new Set([k])); } return tokenDe.get(k); };
    function indexar(lista) {
      palabras = new Map();
      for (const p of lista) {
        const k = clave(p);
        if (!k) continue;
        for (const w of k.split(" ")) if (w.length >= 3 && !COMUNES.has(w)) (palabras.get(w) || palabras.set(w, new Set()).get(w)).add(k);
      }
      sensibles = new Set(lista.flatMap((p) => [p.dni, p.afiliado].map((x) => String(x || "").replace(/\D/g, "")).filter((x) => x.length >= 6)));
    }
    indexar(prestaciones);
    // «la de Pérez» → «la de [paciente #3]» (si el apellido es de varios pacientes, #3 los agrupa)
    function taparTexto(texto) {
      let t = String(texto || "").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[dato]").replace(/\+?\d[\d \t().-]{5,}\d/g, (m) => (m.replace(/\D/g, "").length >= 7 ? "[número]" : m));
      return t.replace(/[\p{L}]+/gu, (w) => {
        const k = plano(w), quienes = palabras.get(k);
        if (!quienes) return w;
        const lista = [...quienes];
        if (lista.length === 1) return `[paciente ${tokenPaciente(lista[0])}]`;
        const grupo = "#" + ++nTok;
        tokens.set(grupo, new Set(lista));
        return `[paciente ${grupo}]`;
      });
    }
    // Todo texto de un resultado de herramienta pasa por el mismo filtro (p. ej. una institución con el apellido de un paciente)
    const taparObjeto = (o) => (typeof o === "string" ? taparTexto(o) : Array.isArray(o) ? o.map(taparObjeto)
      : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ["ref", "paciente"].includes(k) ? v : taparObjeto(v)])) : o);
    const pacientesDe = (token) => tokens.get(String(token || "").replace(/^\[?paciente\s*/i, "").replace(/\]$/, "").trim()) || null;
    // Control final antes de mandar: ningún DNI/afiliado ni palabra de nombre de paciente
    function fugas(payload) {
      const crudo = JSON.stringify(payload), hallado = [];
      const numeros = (crudo.match(/\d[\d .()\/-]*\d|\d/g) || []).map((x) => x.replace(/\D/g, ""));
      if ([...sensibles].some((n) => numeros.some((x) => x.includes(n)))) hallado.push("DNI o afiliado");
      for (const w of plano(crudo).replace(/\[paciente #\d+\]/g, " ").split(/[^a-z]+/)) if (w.length >= 4 && palabras.has(w)) { hallado.push("nombre de un paciente"); break; }
      return hallado;
    }
    return { ref, idDeRef, tokenPaciente, clave, taparTexto, taparObjeto, pacientesDe, fugas, tokens, indexar };
  }

  // ---------- Llamada a Groq (formato OpenAI con herramientas) ----------
  async function llamar(conf, cuerpo, ms = 90000) {
    if (!conf.clave) throw new Error("Falta tu clave de Groq (Valores › Mi cuenta › Asistente de IA).");
    if (!navigator.onLine) throw new Error("Sin conexión: el asistente necesita internet.");
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(URL_GROQ + "/chat/completions", { method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + conf.clave },
        body: JSON.stringify({ model: conf.modelo || MODELO, temperature: 0.1, ...cuerpo }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j.error?.message || r.statusText || "";
        if (r.status === 401 || r.status === 403) throw new Error("La clave de Groq no es válida (revisala en Valores › Mi cuenta › Asistente de IA).");
        if (r.status === 429) throw new Error("Se llegó al límite gratuito de Groq por ahora. Esperá un rato y probá de nuevo.");
        if (r.status === 404 || /model/i.test(msg)) throw new Error(`El modelo «${conf.modelo || MODELO}» no está disponible: elegí otro en Valores › Mi cuenta › Asistente de IA.`);
        throw new Error(`Groq respondió con un error (${r.status}): ${msg}`);
      }
      return j.choices?.[0]?.message || {};
    } catch (e) {
      if (e.name === "AbortError") throw new Error("La IA tardó demasiado en responder. Probá de nuevo.");
      throw e;
    } finally { clearTimeout(t); }
  }

  async function modelos(clave) {
    const r = await fetch(URL_GROQ + "/models", { headers: { Authorization: "Bearer " + clave } });
    if (r.status === 401 || r.status === 403) throw new Error("La clave no es válida.");
    if (!r.ok) throw new Error(`Groq respondió con un error (${r.status}).`);
    return ((await r.json()).data || []).filter((m) => m.active !== false).map((m) => m.id).filter((id) => !/whisper|tts|guard|embed|orpheus|playai|distil/i.test(id)).sort();
  }

  // ---------- Conversación: la IA llama herramientas (que ejecuta la app) hasta responder ----------
  // `ctx`: { conf, hoy, rama, privado, herramientas: {nombre: (args) => resultado}, historial }
  async function preguntar(ctx, indicacion) {
    const enviado = [];
    const mensajes = [{ role: "system", content: instrucciones(ctx.hoy, ctx.rama) }, ...(ctx.historial || []), { role: "user", content: indicacion }];
    const propuestas = { cambios: [], estados: [] };
    for (let paso = 0; paso < MAX_PASOS; paso++) {
      const f = ctx.privado.fugas(mensajes.slice(1));
      if (f.length) throw new Error(`No se mandó nada: quedaba un dato de pacientes (${f.join(", ")}). Escribilo de otra forma.`);
      const m = await llamar(ctx.conf, { messages: mensajes, tools: HERRAMIENTAS, tool_choice: "auto" });
      const llamadas = m.tool_calls || [];
      mensajes.push({ role: "assistant", content: m.content || "", ...(llamadas.length ? { tool_calls: llamadas } : {}) });
      if (!llamadas.length) {
        const texto = String(m.content || "").replace(/\bD\.?A\.?R\.?C\.?\b/g, "la asociación").trim();
        return { texto, propuestas, enviado: mensajes.slice(1), historial: mensajes.slice(1) };
      }
      for (const c of llamadas) {
        let args = {};
        try { args = JSON.parse(c.function?.arguments || "{}"); } catch { /* argumentos rotos: la herramienta avisa */ }
        let resultado;
        try {
          const h = ctx.herramientas[c.function?.name];
          if (!h) throw new Error("herramienta desconocida");
          resultado = ctx.privado.taparObjeto(await h(args, propuestas));
        } catch (e) { resultado = { error: e.message }; }
        mensajes.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(resultado) });
      }
    }
    return { texto: "No llegué a una respuesta: probá preguntarlo de forma más concreta.", propuestas, enviado: mensajes.slice(1), historial: mensajes.slice(1) };
  }

  return { MODELO, PREFERIDOS, EDITABLES, NOMBRES, ESTADOS, HERRAMIENTAS, crearPrivado, preguntar, modelos, instrucciones };
})();
