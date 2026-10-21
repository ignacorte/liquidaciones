"use strict";
// Lectura de partes quirúrgicos y listados de consultas, gratis y dentro del celular (nada sale del teléfono):
// - PDF con texto (exportado de la historia clínica): se lee el texto directo con pdf.js.
// - Captura de pantalla, foto o PDF escaneado: reconocimiento de texto con Tesseract (español).
// Después, reglas arman las prestaciones; el médico revisa antes de guardar.

const Lector = (() => {
  // Librerías alojadas en la propia app (vendor/): no se carga código de otros sitios (ver la política de seguridad en index.html)
  const local = (ruta) => new URL("vendor/" + ruta, location.href).href;
  const TESSERACT = local("tesseract.min.js"); // tesseract.js 5.1.1
  const PDFJS = local("pdf.min.js"), PDFJS_WORKER = local("pdf.worker.min.js"); // pdf.js 3.11.174
  const plano = (t) => (t || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  const cargados = {};
  const script = (src) => (cargados[src] ||= new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => mal(new Error("Sin conexión para descargar el lector (solo hace falta la primera vez)."));
    document.head.appendChild(s);
  }));

  let worker = null;
  async function ocr(imagen, avance) {
    await script(TESSERACT);
    if (!worker) {
      worker = await Tesseract.createWorker("spa", 1, {
        workerPath: local("worker.min.js"), corePath: local(""), langPath: local("lang"), workerBlobURL: false,
        logger: (m) => m.status === "recognizing text" && avance && avance(`Leyendo texto… ${Math.round(m.progress * 100)} %`),
      });
    }
    const { data } = await worker.recognize(imagen);
    return data.text;
  }

  // Foto del celular (12 MP, a veces HEIC) o captura chica: girada según EXIF, a ~2800 px de lado y en grises. Así el reconocimiento
  // no se queda sin memoria en el teléfono y anda igual con cualquier formato que el navegador sepa mostrar.
  async function preparar(archivo) {
    let img;
    try { img = await createImageBitmap(archivo, { imageOrientation: "from-image" }); }
    catch {
      img = await new Promise((ok, mal) => {
        const i = new Image();
        i.onload = () => ok(i); i.onerror = () => mal(new Error("No se pudo abrir la imagen. Probá con una captura de pantalla (PNG/JPG)."));
        i.src = URL.createObjectURL(archivo);
      });
    }
    // Lado mayor ~2800 px: agranda capturas chicas (WhatsApp las deja en ~900 px y el texto queda ilegible para el
    // lector) y achica las fotos de 12 MP (memoria del teléfono)
    // Capturas altas del celular (texto chico a lo ancho): hasta 4200 px de alto
    const ladoMaximo = img.height > img.width * 1.6 ? 4200 : 2800;
    const escala = Math.min(3, ladoMaximo / Math.max(img.width, img.height));
    const lienzo = document.createElement("canvas");
    lienzo.width = Math.round(img.width * escala); lienzo.height = Math.round(img.height * escala);
    const ctx = lienzo.getContext("2d");
    ctx.filter = "grayscale(1) contrast(1.15)";
    ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
    return lienzo;
  }

  async function textoPDF(archivo, avance) {
    await script(PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: await archivo.arrayBuffer() }).promise;
    const paginas = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 6); i++) {
      const pag = await pdf.getPage(i);
      const items = (await pag.getTextContent()).items.filter((x) => x.str.trim());
      if (items.length < 5) {
        // Escaneado: se dibuja la página y se reconoce el texto
        const vista = pag.getViewport({ scale: 2 });
        const lienzo = document.createElement("canvas");
        lienzo.width = vista.width; lienzo.height = vista.height;
        await pag.render({ canvasContext: lienzo.getContext("2d"), viewport: vista }).promise;
        paginas.push(await ocr(lienzo, avance));
        continue;
      }
      // Agrupar por renglón (misma altura) y ordenar de izquierda a derecha
      const renglones = [];
      for (const it of items) {
        const y = it.transform[5], x = it.transform[4];
        let r = renglones.find((r) => Math.abs(r.y - y) < 3);
        if (!r) renglones.push((r = { y, partes: [] }));
        r.partes.push({ x, s: it.str, w: it.width });
      }
      renglones.sort((a, b) => b.y - a.y);
      paginas.push(renglones.map((r) => {
        r.partes.sort((a, b) => a.x - b.x);
        let linea = "", fin = null;
        for (const p of r.partes) {
          linea += (fin !== null && p.x - fin > 8 ? "   " : fin !== null && p.x - fin > 1 ? " " : "") + p.s;
          fin = p.x + p.w;
        }
        return linea;
      }).join("\n"));
    }
    return paginas.join("\n");
  }

  async function textoDe(archivos, avance) {
    const partes = [];
    for (const [i, a] of archivos.entries()) {
      avance && avance(`Leyendo ${i + 1} de ${archivos.length}…`);
      partes.push(a.type === "application/pdf" ? await textoPDF(a, avance) : await ocr(await preparar(a), avance));
    }
    return partes.join("\n");
  }

  // ---------- Reglas ----------
  const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

  function fechaISO(texto) {
    const t = plano(texto);
    let m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
    if (m) {
      let [, d, mes, y] = m.map(Number);
      if (y < 100) y += 2000;
      if (mes >= 1 && mes <= 12 && d >= 1 && d <= 31) return `${y}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    m = t.match(/\b(\d{1,2}) de ([a-z]+)(?: de)? (\d{4})/);
    if (m && MESES[m[2]]) return `${m[3]}-${String(MESES[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    return m ? m[0] : "";
  }

  // Etiquetas de los partes (las más largas primero, para que «diagnóstico postoperatorio» gane a «diagnóstico»)
  // Sin etiqueta de fecha: la fecha del texto más cercana a hoy (último año), descartando nacimiento, ingreso y alta
  function fechaProbable(texto) {
    const hoy = Date.now();
    const candidatas = texto.split(/\r?\n/).flatMap((linea) => {
      const p = plano(linea);
      return [...p.matchAll(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{1,2} de [a-z]+(?: de)? \d{4}\b/g)]
        .filter((m) => !/nac|edad|ingres|egres|alta|vto|venc|emisi/.test(p.slice(Math.max(0, m.index - 25), m.index)))
        .map((m) => fechaISO(m[0]));
    }).concat([...plano(texto).matchAll(/\b([0-3]\d)(?:[1l|]|\s+)([01]?\d)(?:[1l|]|\s+)(20\d\d)\b/g)].map((m) => fechaISO(`${m[1]}/${m[2]}/${m[3]}`)))
      .filter((f) => f && Math.abs(hoy - Date.parse(f)) < 400 * 864e5);
    return candidatas.sort((a, b) => Math.abs(hoy - Date.parse(a)) - Math.abs(hoy - Date.parse(b)))[0] || "";
  }

  // Etiquetas de los partes. En cada campo, de la más específica a la más genérica: si aparecen varias, gana la primera
  // de la lista («cirugía realizada» le gana a «cirugía», que también aparece en «Fecha cirugía»).
  const ETIQUETAS = {
    apellidos: ["apellidos", "apellido"],
    nombres: ["nombres"],
    atencion: ["n° at.", "nº at.", "n° atencion", "nro. atencion", "nro atencion", "atencion"],
    codigo_os: ["codigo quirurgico", "codigo de practica", "codigo practica"],
    paciente: ["apellido y nombre", "apellidos y nombres", "apellido/s y nombre/s", "nombre y apellido", "nombre del paciente",
      "datos del paciente", "paciente", "beneficiario", "nombre"],
    dni: ["d.n.i.", "dni", "documento", "nro. documento", "n° documento", "doc", "numero"],
    obra_social: ["os / plan - nro. afiliado", "obra social", "financ.", "financiador", "cobertura medica", "cobertura", "financiador", "prepaga", "entidad", "o. social", "o. s.", "o.s.", "os"],
    afiliado: ["n° de afiliado", "nro. de afiliado", "nro de afiliado", "n° afiliado", "nro afiliado", "nro. afiliado", "n° de beneficio",
      "nro. beneficio", "beneficio", "credencial", "carnet", "n° socio", "nro socio", "afiliado"],
    fecha: ["fecha de cirugia", "fecha de la cirugia", "fecha cirugia", "fecha de operacion", "fecha operacion", "fecha de intervencion",
      "fecha intervencion", "fecha qx", "fecha del procedimiento", "fecha de la practica", "fecha"],
    hora: ["hora de inicio", "hora inicio", "hora de comienzo", "comienzo", "inicio"],
    diagnostico: ["diagnostico operatorio", "diagnostico postoperatorio", "diagnostico preoperatorio", "diagnostico post", "diagnostico pre", "diagnostico"],
    procedimiento: ["operacion practicada", "procedimientos realizados", "procedimiento realizado", "procedimiento quirurgico", "cirugia realizada", "cirugia efectuada",
      "operacion realizada", "operacion efectuada", "intervencion realizada", "intervencion efectuada", "intervencion quirurgica",
      "acto quirurgico", "practica realizada", "procedimiento", "operacion indicada", "intervencion", "operacion", "cirugia"],
    cirujano: ["cirujano principal", "cirujano"],
    ayudantes: ["primer ayudante", "segundo ayudante", "1er ayudante", "2do ayudante", "ayudantes", "ayudante"],
    anestesista: ["anestesiologo", "anestesista"],
    institucion: ["institucion", "sanatorio", "clinica", "establecimiento"],
    otros: ["edad", "sexo", "habitacion", "cama", "hc", "historia clinica", "hora de fin", "hora fin", "fin", "finalizacion", "instrumentadora",
      "descripcion", "hallazgos", "tecnica", "anatomia patologica", "telefono", "domicilio", "fecha de nacimiento", "fecha nacimiento",
      "fecha nac", "f. nac", "f. nacimiento", "nacimiento", "fecha de ingreso", "fecha ingreso", "fecha de egreso", "fecha de alta", "plan", "medico",
      // Geclisa: la descripción de la técnica («Procedimientos:») no es el procedimiento a facturar
      "procedimientos", "fec. ingreso", "fec. egreso", "fec. egr. prob", "hs. ing", "hs. eg", "hs. egr. prob", "tipo doc", "tipo internacion",
      "hora de finalizacion", "tiempo operatorio", "riesgo quirurgico", "tipo de anestesia", "instrumentador", "otros profesionales",
      "estudios intraoperatorios", "fecha nac.", "f. nac.", "n° h clinica", "n° h.clinica", "sexo", "edad"],
  };
  // Normalizadas igual que el texto («Nº» → «no»: la º se descompone en «o»)
  const LISTA = Object.entries(ETIQUETAS).flatMap(([campo, ls]) => ls.map((l, prioridad) => ({ campo, l: plano(l), prioridad })))
    .sort((a, b) => b.l.length - a.l.length);
  const patron = (l) => l.replace(/[.\/]/g, (c) => "\\" + c).replace(/ /g, "\\s+");
  // Separador: «:» o «=»; también «-» o varios espacios / tabulación (tablas sin dos puntos)
  const RE_ETIQUETA = new RegExp("(?:^|\\s{2,}|[|;]\\s*|\\b)(" + LISTA.map((x) => patron(x.l)).join("|") +
    ")(?:\\s*(?:n[°º]\\.?\\s*)?[:=]|\\s+-\\s|\\s{2,}|\\t|(?<=\\.)\\s)", "g"); // «Nº At. 946568»: tras abreviatura alcanza un espacio

  // Valores por etiqueta: «Paciente: X   DNI: 123» → {paciente: X, dni: 123}. Si la etiqueta queda sola en el renglón,
  // el valor es el renglón siguiente (formularios en dos columnas).
  function porEtiqueta(texto) {
    const lineas = texto.split(/\r?\n/);
    const out = {}, prioridad = {};
    lineas.forEach((linea, i) => {
      const p = plano(linea);
      const marcas = [];
      RE_ETIQUETA.lastIndex = 0;
      let m;
      while ((m = RE_ETIQUETA.exec(p))) {
        const etiqueta = m[1].replace(/\s+/g, " ");
        const def = LISTA.find((x) => x.l === etiqueta);
        if (def) marcas.push({ ...def, desde: m.index + m[0].length, inicio: m.index });
      }
      marcas.forEach((mk, j) => {
        let valor = linea.slice(mk.desde, j + 1 < marcas.length ? marcas[j + 1].inicio : undefined).trim().replace(/^[-–:.\s]+|[|;\s]+$/g, "")
          .replace(/\s+(n[°º?o]?\.?|nro\.?|nº)$/i, ""); // «N°» que pertenece a la etiqueta siguiente
        if (!valor && j + 1 === marcas.length) valor = (lineas.slice(i + 1).find((l) => l.trim()) || "").trim();
        if (!valor) return;
        if (mk.campo === "ayudantes" && out.ayudantes) out.ayudantes += ", " + valor;
        else if (!(mk.campo in out) || mk.prioridad < prioridad[mk.campo]) { out[mk.campo] = valor; prioridad[mk.campo] = mk.prioridad; }
      });
    });
    return out;
  }

  function abordaje(texto) {
    const t = plano(texto);
    if (/robot/.test(t)) return "robotica";
    if (/laparosc|videolap|\btapp\b|\btep\b|\betep\b|\bipom\b/.test(t)) return "laparoscopica";
    if (/percut/.test(t)) return "percutanea";
    if (/endosc/.test(t)) return "endoscopica";
    if (/laparotom|convencional|abiert|lichtenstein|\brives\b|stoppa/.test(t)) return "convencional";
    return "";
  }

  const soloDigitos = (t) => (t || "").replace(/\D/g, "");

  function nombreSinEtiqueta(texto) {
    const encabezado = texto.split(/\r?\n/).slice(0, 15).join("\n");
    const m = encabezado.match(/(?:^|\s)([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ']+(?: [A-ZÁÉÍÓÚÑ']+)?, ?[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ']+(?: [A-ZÁÉÍÓÚÑ']+){0,2})(?=\s{2,}|\s*$|\s+(?:DNI|HC|Edad))/m);
    // Que no sea una frase: sin palabras comunes de la descripción quirúrgica
    return m && !/\b(DE|DEL|LA|EL|CON|SE|Y|EN|POR|PARA)\b/.test(m[1]) ? m[1].trim() : "";
  }

  function parte(texto, obraSocial) {
    const e = porEtiqueta(texto);
    const dni = soloDigitos(e.dni || (plano(texto).match(/\bd\.?n\.?i\.?(?:\s*(?:numero|n°|nro\.?))?\s*:?\s*([\d.]{7,11})/) || [])[1]).replace(/^0+/, "");
    const procs = (e.procedimiento || "").replace(/^[\[\(|{]+/, "").split(/\s*(?:\+|;|\/|\by\b(?= [A-ZÁÉÍÓÚ])|\d\)\s)\s*/).map((s) => s.trim()).filter((s) => s.length > 3);
    const osTexto = e.obra_social || "";
    return {
      fecha: fechaISO(e.fecha || "") || fechaProbable(texto),
      hora: ((e.hora || "").match(/\d{1,2}[:.]\d{2}/) || [""])[0].replace(".", ":"),
      paciente: (e.apellidos ? e.apellidos.trim() + (e.nombres ? ", " + e.nombres.trim() : "") : e.paciente || nombreSinEtiqueta(texto)).replace(/\s*\b(dni|edad|h\.?c\.?)\b.*$/i, "").replace(/[.,\s]+$/, "").trim(),
      dni: dni.length >= 7 && dni.length <= 8 ? dni : "",
      obra_social_texto: osTexto.replace(/\s+-\s+\d[\d\s\/-]*$/, "") || (obraSocial(texto) || ""),
      // «PAMI / CAPITA UROLOGICO - 14594162170700»: el número de afiliado viene al final de la obra social
      afiliado: (e.afiliado || (osTexto.match(/-\s*(\d[\d\/-]{5,})\s*$/) || [])[1] || "").split(/\s{2,}/)[0],
      atencion: soloDigitos(e.atencion || ""),
      codigo_os: soloDigitos(e.codigo_os || ""),
      institucion: e.institucion || "",
      diagnostico: e.diagnostico || "",
      procedimientos: procs.length ? procs : [""],
      abordaje: abordaje((e.procedimiento || "") + " " + texto),
      // Solo si lo dice explícitamente («Guardia» aparece en las listas de evoluciones de la HC)
      urgencia: /\burgencia\b|\bemergencia\b/.test(plano(texto)) && !/\bno urgen|programad/.test(plano(texto)),
      cirujano: e.cirujano || "",
      ayudantes: (e.ayudantes || "").split(/\s*[,;\/]\s*/).filter(Boolean),
    };
  }

  const PRACTICA = /curaci|puncion|retiro de puntos|drenaje|biopsia|infiltr/;

  // Listado diario: un paciente por renglón (hora, nombre, DNI, obra social, afiliado en cualquier orden)
  // Turnero de Geclisa: los «#» suelen leerse como letras o símbolos sueltos, así que se busca por forma:
  // hora, obra social, «APELLIDO, NOMBRE», nota, código de la práctica y n.º de atención
  const NUMERICO = (t) => t.replace(/[Bb]/g, "8").replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/[Ss]/g, "5").replace(/Z/g, "2");
  function turno(linea, obraSocial) {
    const m = linea.match(/([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ']+(?: [A-ZÁÉÍÓÚÑ']+)*), ?([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ']+(?: [A-ZÁÉÍÓÚÑ']{2,})*)/);
    if (!m || /no dar/i.test(linea)) return null;
    // «PAMIIC Y LUNA, ALICIA»: el apellido empieza después de la obra social y del «#» leído como letra suelta
    const palabras = m[1].split(" ");
    const corte = palabras.reduce((k, w, i) => (i < palabras.length - 1 && (w.length === 1 || /^PAMI/i.test(w) || obraSocial(w)) ? i : k), -1);
    const apellido = palabras.slice(corte + 1).join(" ");
    const antes = linea.slice(0, m.index) + palabras.slice(0, corte + 1).join(" "), despues = linea.slice(m.index + m[0].length);
    const hora = (antes.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/) || [""])[0].replace(".", ":");
    const osTexto = (antes.replace(/^.*?\b([01]?\d|2[0-3])[:.][0-5]\d\b/, "").match(/[A-Za-zÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ."' ]{2,}/) || [""])[0].trim();
    const numeros = despues.split(/\s+/).map((t) => t.replace(/[^\dA-Za-z|]/g, "")).filter((t) => t.length >= 5 && (t.match(/\d/g) || []).length / t.length >= 0.6)
      .map(NUMERICO).map((t) => t.replace(/\D/g, ""));
    const nota = (despues.match(/[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ./]{2,}/) || [""])[0].trim();
    let os = obraSocial(osTexto) || obraSocial(osTexto.replace(/^PAMI\S*/i, "PAMI")); // PAMIUC (y cómo lo lee el lector: PAMIIC, PAMILC…)
    const codigo = numeros.find((n) => n.length === 6 || n.length === 8) || "";
    if (!os && /^8201\d\d$/.test(codigo)) os = "PAMI"; // 820126: consulta de especialista, nomenclador PAMI
    return { hora, paciente: `${apellido}, ${m[2]}`, obra_social_texto: os || osTexto, codigo_os: codigo,
      atencion: numeros.filter((n) => n.length === 7).pop() || "", nota };
  }

  function listado(texto, obraSocial) {
    const filas = [];
    const fecha = fechaISO(texto) || fechaProbable(texto);
    // Turnero de Geclisa: renglones con «#» (o lo que el lector haya hecho de ellos) y código de consulta
    if (/#|\bgeclisa\b|cronograma|informaci[oó]n del turno/i.test(texto)) {
      for (const linea of texto.split(/\r?\n/)) {
        const t = turno(linea, obraSocial);
        if (!t) continue;
        filas.push({ fecha, hora: t.hora, paciente: t.paciente, dni: "", afiliado: "", tipo: "consulta", obra_social_texto: t.obra_social_texto,
          codigo_os: t.codigo_os, atencion: t.atencion, notas: t.nota, ausente: false, detalle: "" });
      }
      if (filas.length) return filas;
    }
    for (const linea of texto.split(/\r?\n/)) {
      const p = plano(linea);
      if (!p.trim() || /\b(fecha|hora|paciente|apellido|obra social|turno)s?\b.*\b(obra social|paciente|dni|hora)\b/.test(p)) continue; // encabezado
      const hora = (linea.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/) || [""])[0].replace(".", ":");
      const os = obraSocial(linea);
      const numeros = (linea.match(/\d[\d.\/-]{5,}\d/g) || []).map(soloDigitos);
      const dni = numeros.find((n) => n.length >= 7 && n.length <= 8) || "";
      const afiliado = numeros.find((n) => n !== dni && n.length >= 6) || "";
      // Nombre: el tramo más largo de palabras (con coma «Pérez, Juan»), sin la obra social ni palabras de estado
      const sinRuido = linea.replace(/\d[\d:.\/-]*/g, " ").replace(/\b(ausente|presente|confirmad[oa]|control|primera vez|ulterior|consulta|particular|cancelad[oa]|atendid[oa])\b/gi, " ");
      const tramos = sinRuido.split(/\s{2,}|\t|\||;/).map((s) => s.trim()).filter((s) => /^[A-Za-zÁÉÍÓÚÑáéíóúñü' ,.]{5,}$/.test(s));
      const candidatos = tramos.filter((s) => !(os && obraSocial(s) === os) && !PRACTICA.test(plano(s)) && s.split(/[\s,]+/).filter(Boolean).length >= 2);
      // «Apellido, Nombre» primero; si no, el tramo más largo
      const nombre = (candidatos.sort((a, b) => b.includes(",") - a.includes(",") || b.length - a.length)[0] || "").replace(/[.,\s]+$/, "");
      if (!nombre || !(hora || os || dni)) continue;
      const tipo = PRACTICA.test(p) ? "practica" : "consulta";
      filas.push({
        fecha, hora, paciente: nombre, dni, afiliado, tipo,
        obra_social_texto: os || (/particular/.test(p) ? "PARTICULAR" : linea.replace(nombre, "").replace(/\s{2,}/g, " ").trim()),
        ausente: /ausente|no vino|no asisti|cancelad/.test(p),
        detalle: tipo === "practica" ? (linea.match(/(curaci\S*|punci\S*|retiro de puntos|drenaje\S*|biopsia\S*|infiltr\S*)[^|;]*/i) || [""])[0].trim() : "",
      });
    }
    return filas;
  }

  // Liquidación de honorarios («Detalle Liquidación» del sistema de la institución). Una línea por prestación:
  // atención, fecha, paciente, obra social, período, tipo de nomenclador, código, descripción, monto (formato 149,025.00)
  const RE_LIQ = /^\s*(\d{5,})\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(\d{1,6}\s+-\s+.+?)\s+(\d{6})\s+(\S+)\s+(\d{4,10})\s+(.+?)\s+(-?[\d.,]+\d{2})\s*$/;
  function monto(t) {
    let x = t.replace(/[$\s]/g, "");
    x = /,\d{2}$/.test(x) ? x.replace(/\./g, "").replace(",", ".") : x.replace(/,/g, "");
    return Number(x);
  }
  function liquidacion(texto) {
    const lineas = [];
    for (const l of texto.split(/\r?\n/)) {
      const m = l.match(RE_LIQ);
      if (!m) continue;
      lineas.push({ atencion: m[1], fecha: fechaISO(m[2]), paciente: m[3].replace(/[\s,]+$/, "").trim(), obra_social_texto: m[4].trim(),
        periodo: m[5], nomenclador: m[6], codigo: m[7], descripcion: m[8].trim(), monto: monto(m[9]) });
    }
    const numero = (texto.match(/Liquidaci[oó]n\s+N[º°o]?\s*([A-Z]?\s*[\d\s-]{6,})/i) || [])[1]?.replace(/\s+/g, " ").trim() || "";
    const emision = fechaISO((texto.match(/Fecha de Emisi[oó]n:?\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || "");
    const total = monto((texto.match(/Total Liquidaci[oó]n\s+([\d.,]+)/i) || [])[1] || "0");
    const empresa = ((texto.match(/Empresa:\s*(.+?)\s+-\s+Agente/i) || [])[1] || "").trim();
    return { numero, emision, total, empresa, lineas };
  }

  // Igual que la versión de PC (app/lectura.py): resultado → prestaciones
  function aPrestaciones(tipo, texto, { obraSocial, medico, pctMultiple }) {
    if (tipo === "listado") {
      return listado(texto, obraSocial).map((f) => ({ ...f, tipo: f.tipo, procedimiento: f.tipo === "practica" ? f.detalle : "",
        institucion: "", origen: "foto_listado", incluir: !f.ausente }));
    }
    const d = parte(texto, obraSocial);
    const ap = plano(medico || "").trim();
    const rol = ap && !plano(d.cirujano).includes(ap) && d.ayudantes.some((a) => plano(a).includes(ap)) ? "ayudante" : "cirujano";
    return d.procedimientos.map((proc, i) => ({
      fecha: d.fecha, hora: d.hora, tipo: "cirugia", paciente: d.paciente, dni: d.dni, afiliado: d.afiliado, atencion: d.atencion,
      codigo_os: i === 0 ? d.codigo_os : "",
      obra_social_texto: d.obra_social_texto, institucion: d.institucion, diagnostico: d.diagnostico, procedimiento: proc,
      abordaje: d.abordaje, urgencia: d.urgencia, rol, pct: i === 0 ? 100 : pctMultiple, origen: "foto_parte", incluir: true,
    }));
  }

  return { textoDe, aPrestaciones, parte, listado, liquidacion, fechaISO, porEtiqueta };
})();
