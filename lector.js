"use strict";
// Lectura de partes quirúrgicos y listados de consultas, gratis y dentro del celular (nada sale del teléfono):
// - PDF con texto (exportado de la historia clínica): se lee el texto directo con pdf.js.
// - Captura de pantalla, foto o PDF escaneado: reconocimiento de texto con PaddleOCR (modelo de IA open source).
// Después, reglas arman las prestaciones; el médico revisa antes de guardar.

const Lector = (() => {
  // Librerías alojadas en la propia app (vendor/): no se carga código de otros sitios (ver la política de seguridad en index.html)
  const local = (ruta) => new URL("vendor/" + ruta, location.href).href;
  const PDFJS = local("pdf.min.js"), PDFJS_WORKER = local("pdf.worker.min.js"); // pdf.js 3.11.174
  const plano = (t) => (t || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  const cargados = {};
  const script = (src) => (cargados[src] ||= new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => mal(new Error("Sin conexión para descargar el lector (solo hace falta la primera vez)."));
    document.head.appendChild(s);
  }));

  // ---------- Reconocimiento de texto: PaddleOCR PP-OCRv5 (modelo de IA open source, Apache-2.0) ----------
  // Detección de renglones + reconocimiento latino (español con acentos, ñ, º), con ONNX Runtime Web dentro del
  // navegador. ~27 MB que se descargan una sola vez (vendor/paddle). Medido con 46 documentos reales: 98 % de los datos
  // correctos (Tesseract, el lector anterior, fallaba con fotos de pantalla y hojas de costado).
  let motor = null;
  async function paddle() {
    if (motor) return motor;
    motor = (async () => {
      const ort = await import(local("paddle/ort.wasm.min.mjs"));
      ort.env.wasm.wasmPaths = local("paddle/");
      // Varios hilos si la página está aislada (encabezados COOP/COEP que agrega sw.js); si no, uno
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      const { PaddleOcrService } = await import(local("paddle/paddleocr.mjs"));
      const bajar = (f, tipo) => fetch(local("paddle/" + f)).then((r) => {
        if (!r.ok) throw new Error("Sin conexión para descargar el lector (solo hace falta la primera vez).");
        return tipo === "texto" ? r.text() : r.arrayBuffer();
      });
      const [det, rec, dic] = await Promise.all([bajar("det.onnx"), bajar("rec_latin.onnx"), bajar("dict_latin.txt", "texto")]);
      return PaddleOcrService.createInstance({
        ort, modelPreset: "PP-OCRv5_mobile",
        // Como RapidOCR/PaddleOCR: el lado corto a 736 px como mínimo, sin achicar (por defecto la librería reduce a 960 px
        // de lado largo y se pierden los renglones chicos de una hoja entera)
        detection: { modelBuffer: det, limitType: "min", maxSideLength: 736, maxSideLimit: 4000 },
        // 504 clases = «blank» (CTC) + 502 caracteres del diccionario + espacio
        recognition: { modelBuffer: rec, charactersDictionary: ["blank", ...dic.replace(/\r/g, "").split("\n").filter((c, i, a) => c !== "" || i < a.length - 1), " "] },
      });
    })().catch((e) => { motor = null; throw e; });
    return motor;
  }

  // Renglones a partir de las cajas: misma altura = mismo renglón; los campos separados con tres espacios
  function renglones(resultados) {
    const cajas = resultados.filter((r) => r.text.trim()).map((r) => ({ t: r.text.trim(), x: r.box.x, y: r.box.y + r.box.height / 2, h: r.box.height }))
      .sort((a, b) => a.y - b.y);
    const lineas = [];
    for (const c of cajas) {
      const l = lineas[lineas.length - 1];
      if (l && Math.abs(l.y - c.y) < Math.min(l.h, c.h) * 0.6) { l.cajas.push(c); l.y = (l.y + c.y) / 2; }
      else lineas.push({ y: c.y, h: c.h, cajas: [c] });
    }
    return lineas.map((l) => l.cajas.sort((a, b) => a.x - b.x).map((c) => c.t).join("   ")).join("\n");
  }

  const pixeles = (lienzo) => {
    const d = lienzo.getContext("2d").getImageData(0, 0, lienzo.width, lienzo.height);
    return { width: d.width, height: d.height, data: new Uint8Array(d.data.buffer) };
  };
  function girar(origen, grados) {
    const l = document.createElement("canvas");
    l.width = origen.height; l.height = origen.width;
    const ctx = l.getContext("2d");
    ctx.translate(l.width / 2, l.height / 2); ctx.rotate((grados * Math.PI) / 180);
    ctx.drawImage(origen, -origen.width / 2, -origen.height / 2);
    return l;
  }
  const confianza = (rs) => (rs.length ? rs.reduce((s, r) => s + r.confidence * r.text.length, 0) / Math.max(1, rs.reduce((s, r) => s + r.text.length, 0)) : 0);

  function achicar(origen, lado) {
    const e = Math.min(1, lado / Math.max(origen.width, origen.height)), l = document.createElement("canvas");
    l.width = Math.round(origen.width * e); l.height = Math.round(origen.height * e);
    l.getContext("2d").drawImage(origen, 0, 0, l.width, l.height);
    return l;
  }

  async function leerImagen(lienzo, avance) {
    avance && avance("Preparando el lector…");
    const ocr = await paddle();
    // Orientación con una copia chica (rápido): si la mayoría de los renglones salen verticales, la hoja está de costado
    const chica = achicar(lienzo, 1000);
    const prueba = await ocr.recognize(pixeles(chica));
    const verticales = prueba.filter((r) => r.box.height > r.box.width * 1.5).length;
    let giro = 0;
    if (prueba.length >= 4 && verticales > prueba.length * 0.5) {
      let mejor = confianza(prueba);
      for (const g of [90, -90]) {
        const c = confianza(await ocr.recognize(pixeles(girar(chica, g))));
        if (c > mejor) { mejor = c; giro = g; }
      }
    }
    avance && avance(giro ? "La hoja estaba de costado: leyendo…" : "Leyendo…");
    return renglones(await ocr.recognize(pixeles(giro ? girar(lienzo, giro) : lienzo)));
  }

  // Foto del celular (12 MP, a veces HEIC) o captura chica: girada según EXIF y a un tamaño manejable. Así el reconocimiento
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
    // Lado mayor hasta 3000 px (fotos de 12 MP: memoria del teléfono); las capturas chicas se agrandan un poco
    const escala = Math.min(1.5, 3000 / Math.max(img.width, img.height));
    const lienzo = document.createElement("canvas");
    lienzo.width = Math.round(img.width * escala); lienzo.height = Math.round(img.height * escala);
    const ctx = lienzo.getContext("2d");
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
        paginas.push(await leerImagen(lienzo, avance));
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
      partes.push(a.type === "application/pdf" ? await textoPDF(a, avance) : await leerImagen(await preparar(a), avance));
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
  // Fecha leída con un dígito mal (2076): fuera del último año no es la de la prestación
  // Fecha posible: desde 2000 hasta dentro de un mes (descarta «2076» y números que no son fechas, como «30189»)
  const fechaCercana = (f) => (f && f >= "2000-01-01" && Date.parse(f) < Date.now() + 31 * 864e5 ? f : "");

  // Sin etiqueta de fecha: la fecha del texto más cercana a hoy (último año), descartando nacimiento, ingreso y alta
  function fechaProbable(texto) {
    const hoy = Date.now();
    const candidatas = texto.split(/\r?\n/).flatMap((linea) => {
      const p = plano(linea);
      if (/hasta|area/.test(p) && (p.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || []).length >= 2) return []; // rango de búsqueda de la HC
      // Sin etiqueta, «08.08.13» con puntos y año de 2 cifras es un código (AAC), no una fecha
      return [...p.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}-\d{1,2}-\d{4}\b|\b\d{1,2}\.\d{1,2}\.\d{4}\b|\b\d{1,2} de [a-z]+(?: de)? \d{4}\b/g)]
        .filter((m) => !/nac|edad|ingres|egres|alta|vto|venc|emisi|desde|hasta|fec\. ing|fec\. egr/.test(p.slice(Math.max(0, m.index - 25), m.index)))
        .map((m) => fechaISO(m[0]));
    }).concat([...plano(texto).matchAll(/\b([0-3]\d)(?:[1l|]|\s+)([01]?\d)(?:[1l|]|\s+)(20\d\d)\b/g)].map((m) => fechaISO(`${m[1]}/${m[2]}/${m[3]}`)))
      .filter((f) => fechaCercana(f));
    return candidatas.sort((a, b) => Math.abs(hoy - Date.parse(a)) - Math.abs(hoy - Date.parse(b)))[0] || "";
  }

  // Etiquetas de los partes. En cada campo, de la más específica a la más genérica: si aparecen varias, gana la primera
  // de la lista («cirugía realizada» le gana a «cirugía», que también aparece en «Fecha cirugía»).
  const ETIQUETAS = {
    apellidos: ["apellidos paciente", "apellidos", "apellido"],
    nombres: ["nombres paciente", "nombres"],
    atencion: ["n° at.", "nº at.", "n° atenc.", "nº atenc.", "n° atencion", "nº atencion", "nro. atencion", "nro atencion", "atencion"],
    codigo_os: ["codigo quirurgico", "codigo quirurgica", "codigo de practica", "codigo practica"],
    paciente: ["apellido y nombre", "apellidos y nombres", "apellido/s y nombre/s", "nombre y apellido", "nombre del paciente",
      "datos del paciente", "paciente", "beneficiario", "pac", "nombre"],
    dni: ["tipo y nro de documento", "n° doc.", "nº doc.", "nro. doc.", "nro doc", "d.n.i.", "dni", "documento", "nro. documento", "n° documento", "doc", "numero"],
    obra_social: ["os / plan - nro. afiliado", "o. s./plan", "o.s./plan", "obra social", "financ.", "financiador", "cobertura medica", "cobertura",
      "prepaga", "entidad", "o. social", "o. s.", "o.s.", "o.s", "os"],
    afiliado: ["nro. de credencial", "nro de credencial", "nro de beneficiario", "n° beneficiario", "n° de afiliado", "nro. de afiliado", "nro de afiliado",
      "n° afiliado", "nº afiliado", "nro afiliado", "nro. afiliado", "n° af.", "nº af.", "n° de beneficio", "nro. beneficio", "beneficio", "credencial",
      "carnet", "n° socio", "nro socio", "afiliado", "afil", "nro"],
    fecha: ["fecha de cirugia", "fecha de la cirugia", "fecha cirugia", "fecha de operacion", "fecha operacion", "fecha de intervencion",
      "fecha intervencion", "fecha qx", "fecha del procedimiento", "fecha de la practica", "fecha", "fec"],
    hora: ["hora de inicio", "hora inicio", "hora de comienzo", "hora comienzo", "apertura de piel", "comienzo", "inicio"],
    diagnostico: ["diagnostico operatorio", "diagnostico postoperatorio", "diagnostico pos-operatorio", "diagnostico preoperatorio", "diagnostico post",
      "diagnostico pre", "diagnostico"],
    // De la más fiable (lo que se hizo) a la menos (lo que se indicó o propuso)
    procedimiento: ["operacion practicada", "operacion efectuada", "estudio realizado", "procedimientos realizados", "procedimiento realizado",
      "procedimiento quirurgico", "cirugia realizada", "cirugia efectuada", "operacion realizada", "intervencion realizada", "intervencion efectuada",
      "intervencion quirurgica", "acto quirurgico", "practica realizada", "estudio", "procedimiento", "operacion propuesta", "operacion indicada",
      "intervencion", "operacion", "cirugia"],
    cirujano: ["medico cirujano", "cirujano principal", "cirujano"],
    ayudantes: ["primer ayudante", "segundo ayudante", "1er ayudante", "2do ayudante", "1o ayudante", "2o ayudante", "1° ayudante", "2° ayudante",
      "ayudante 1ero", "ayudante 2do", "ayudantes", "ayudante", "otros profesionales"],
    anestesista: ["anestesiologo", "anestesista"],
    conclusion: ["conclusion", "conclusiones", "hallazgos endoscopicos"],
    institucion: ["institucion", "sanatorio", "clinica", "establecimiento"],
    otros: ["edad", "sexo", "habitacion", "cama", "hc", "h. c.", "historia clinica", "hora de fin", "hora fin", "fin", "finalizacion", "instrumentadora",
      "instrumentista", "instrumentador", "descripcion", "hallazgos", "tecnica", "anatomia patologica", "examen anatopatologico", "telefono", "domicilio",
      "fecha de nacimiento", "fecha nacimiento", "fecha nac", "f. nac", "f. nacimiento", "nacimiento", "fecha de ingreso", "fecha ingreso", "fecha de egreso",
      "fecha de alta", "plan", "medico", "medico indicante", "medico a cargo", "medico responsable del egreso",
      // La descripción de la técnica no es el procedimiento a facturar
      "procedimientos", "protocolo", "operacion efectuada (descripcion)", "continuacion de los procedimientos",
      "fec. ingreso", "fec. ing.", "fec. egreso", "fec. egr.", "fec. egr. prob", "fec. nac.", "fec. nac", "fec. desde", "fec. hasta", "hs. ing", "hs. eg",
      "hs. egr. prob", "tipo doc", "tipo doc.", "tipo de documento", "tipo internacion", "tipo int.", "hora de finalizacion", "hora finalizacion",
      "cierre de piel", "tiempo operatorio", "riesgo quirurgico", "tipo de anestesia", "clase de anestesia", "anestesia", "cardiologo", "anat. patologo",
      "obstetrica", "transfusionista", "sangre y soluciones", "cultivo", "drenajes", "biopsia por congelacion", "suite", "numero de hc",
      "numero de encuentro", "n° de encuentro", "estudios intraoperatorios", "tipo de estudio", "motivos de consulta", "motivo de consulta", "solicitante",
      "esofago", "estomago", "duodeno", "datos del paciente", "fecha nac.", "f. nac.", "n° h clinica", "n° h.clinica", "nº h.clinica",
      "fec. egreso", "orden", "coseguro", "elementos", "total", "iva", "tipo alta"],
  };
  // Normalizadas igual que el texto («Nº» → «no»: la º se descompone en «o»)
  const LISTA = Object.entries(ETIQUETAS).flatMap(([campo, ls]) => ls.map((l, prioridad) => ({ campo, l: plano(l), prioridad })))
    .sort((a, b) => b.l.length - a.l.length);
  const patron = (l) => l.replace(/[.*+?^${}()|[\]\\\/]/g, (c) => "\\" + c).replace(/ /g, "\\s+");
  // Separador: «:» o «=»; también «-» o varios espacios / tabulación (tablas sin dos puntos)
  const RE_ETIQUETA = new RegExp("(?:^|\\s{2,}|[|;]\\s*|\\b)(" + LISTA.map((x) => patron(x.l)).join("|") +
    ")(?:\\s*(?:n[°º]\\.?\\s*)?[:=!]|\\s+[-–—]\\s|\\s{2,}|\\t|(?<=\\.)\\s|\\s(?=\\d)|\\s*$)", "g");
  // Separadores: «:» o «=»; guión; varios espacios o tabulación (tablas); tras abreviatura un espacio («Nº At. 946568»);
  // un espacio si sigue un número («Nro 1500…», «Fecha 23/09/2026»).
  // Además, al comienzo del renglón, una etiqueta de varias palabras seguida de un espacio («Nombre y Apellido DIAZ, Elsa»)
  const RE_INICIO = new RegExp("^\\s*(" + LISTA.filter((x) => x.l.includes(" ")).map((x) => patron(x.l)).join("|") + ")\\s+(?=\\S)");

  // Palabras médicas frecuentes: la lectura que las tiene bien escritas es la buena («VideoEndoscopía Alta» y no «Videcendoecopia Aa»)
  const VOCABULARIO = /endoscop|colonosc|gastro|laparosc|laparotom|hernio|colecist|apendic|eventro|explorador|inguinal|umbilical|\bcpre\b|papilot|polipect|biopsi|escision|lipoma|\balta\b|\bbaja\b|\bveda\b|\bvcc\b|litiasis|coledoc|varice|ligadura|hernia|malla|drenaje|absceso/g;

  // Con dos lecturas de la misma foto, el mismo dato aparece dos veces: se queda la versión que «se ve» mejor
  function calidad(campo, v) {
    const t = v.trim();
    if (campo === "paciente" || campo === "apellidos") return (/^[A-ZÁÉÍÓÚÑ]{3,}[ ,.]/.test(t) ? 3 : 0) + (/,/.test(t) ? 1 : 0) - (t.match(/[^A-Za-zÁÉÍÓÚÑáéíóúñü ,.'-]/g) || []).length;
    if (campo === "dni") return (/^\d{7,8}$/.test(t.replace(/\D/g, "").replace(/^0+/, "")) ? 10 : 0) - (t.match(/[^\d\s.\/-]/g) || []).length;
    if (["afiliado", "atencion"].includes(campo)) return (t.match(/\d/g) || []).length - (t.match(/[^\d\s.\/-]/g) || []).length * 2;
    if (campo === "fecha") return fechaISO(t) ? 2 : 0;
    if (["procedimiento", "diagnostico"].includes(campo)) return 2 * (plano(t).match(VOCABULARIO) || []).length - (t.match(/[^\wÁÉÍÓÚÑáéíóúñü ,.:;()+\/%-]/g) || []).length;
    return -(t.match(/[^\wÁÉÍÓÚÑáéíóúñü ,.:;()+\/%-]/g) || []).length; // menos símbolos raros = mejor
  }

  // El lector separa con tres espacios cada caja de texto: un valor termina donde termina su caja, salvo que siga con
  // «+» o paréntesis («LAPAROTOMIA EXPLORADORA +   CIRUGIA DE HARTMANN»)
  function primeraCaja(v) {
    const partes = v.split(/\s{3,}/);
    let out = partes[0];
    for (let k = 1; k < partes.length; k++) {
      if (/[+,(\/-]$/.test(out.trim()) || /^[+(]/.test(partes[k].trim())) out += " " + partes[k]; else break;
    }
    return out.trim();
  }
  const INSTITUCION = /clinica|maternidad|sanatorio|instituto|hospital|policlinico|swiss|medical|nombre del paciente/;
  const esEtiqueta = (linea) => { RE_ETIQUETA.lastIndex = 0; const r = RE_ETIQUETA.test(plano(linea)) || RE_INICIO.test(plano(linea)); RE_ETIQUETA.lastIndex = 0; return r; };
  const NARRACION = /^(paciente|se |bajo|previa|asepsia|antisepsia|en |con |luego|incision|pte|ptes|codigo|\d{2}\.\d{2}\.\d{2}\b)/;

  // Valores por etiqueta: «Paciente: X   DNI: 123» → {paciente: X, dni: 123}. Si la etiqueta queda sola en el renglón,
  // el valor es el renglón siguiente (formularios en dos columnas); el procedimiento puede seguir en el renglón de abajo.
  function porEtiqueta(texto) {
    const lineas = texto.split(/\r?\n/);
    const out = {}, prioridad = {};
    lineas.forEach((linea, i) => {
      linea = linea.replace(/([Nn][°º])(?=[A-Za-z])/g, "$1 "); // «N°AF.» → «N° AF.»
      const p = plano(linea);
      const marcas = [];
      RE_ETIQUETA.lastIndex = 0;
      let m;
      const inicio = p.match(RE_INICIO);
      if (inicio && !RE_ETIQUETA.test(p.slice(0, inicio[0].length + 1))) {
        const def = LISTA.find((x) => x.l === inicio[1].replace(/\s+/g, " "));
        if (def) marcas.push({ ...def, desde: inicio[0].length, inicio: 0 });
      }
      RE_ETIQUETA.lastIndex = 0;
      while ((m = RE_ETIQUETA.exec(p))) {
        const etiqueta = m[1].replace(/\s+/g, " ");
        const def = LISTA.find((x) => x.l === etiqueta);
        if (def) marcas.push({ ...def, desde: m.index + m[0].length, inicio: m.index });
      }
      // Etiquetas con letras mal leídas («OperaCión PraCtcada:», «Operacióni Propuesta:»): la caja «texto:» que más se
      // parezca a una etiqueta conocida (82 % o más)
      // (también la primera caja del renglón sin «:», si es una etiqueta de varias palabras: «Nom bre del Pacienta   ONETO»)
      for (const caja of p.matchAll(/(^|\s{3,})([a-z°][a-z°. /()-]{3,38}?)\s*[:!;]|(^)([a-z°][a-z°. ]{6,38}?)(?=\s{3,})/g)) {
        if (caja[4]) { caja[1] = caja[3]; caja[2] = caja[4]; }
        const inicioCaja = caja.index + caja[1].length;
        if (marcas.some((mk) => Math.abs(mk.inicio - inicioCaja) < 3)) continue;
        const escrito = caja[2].trim();
        let mejor = null;
        for (const x of LISTA) {
          if (x.l.length < 5 || Math.abs(x.l.length - escrito.length) > 3 || (caja[4] && !x.l.includes(" "))) continue;
          const sim = parecido(escrito, x.l);
          if (sim >= 0.82 && (!mejor || sim > mejor.sim)) mejor = { ...x, sim };
        }
        if (mejor) marcas.push({ ...mejor, desde: caja.index + caja[0].length, inicio: inicioCaja });
      }
      marcas.sort((a, b) => a.inicio - b.inicio);
      marcas.forEach((mk, j) => {
        let valor = linea.slice(mk.desde, j + 1 < marcas.length ? marcas[j + 1].inicio : undefined).trim().replace(/^[-–:.\s]+|[|;\s]+$/g, "")
          .replace(/\s+(n[°º?o]?\.?|nro\.?|nº)$/i, "") // «N°» que pertenece a la etiqueta siguiente
          .replace(/\s+[_*|~=<>»«“”"]+(\s.*)?$/, "").replace(/^[—–\s]+/, "").replace(/[\s,;]+$/, "").trim(); // basura del lector
        // El nombre del paciente no es la institución que figura en el mismo renglón («Clinica y Maternidad Suizo Argentina»)
        if (["paciente", "apellidos", "nombres"].includes(mk.campo)) valor = valor.split(/\s{3,}/).filter((c) => !INSTITUCION.test(plano(c))).join("   ");
        valor = primeraCaja(valor);
        // «Operación Efectuada (descripción):» leída con errores: es otra etiqueta (la descripción), no un valor
        if (/^\(?\s*descrip/i.test(plano(valor)) || /:$/.test(valor)) return;
        const siguientes = lineas.slice(i + 1).map((l) => l.trim()).filter(Boolean);
        if (!valor && j + 1 === marcas.length) {
          // Etiqueta sola: el valor está abajo (el procedimiento, hasta 3 renglones: «DRENAJE… / CANULACION…»)
          const abajo = [];
          for (const l of siguientes.slice(0, mk.campo === "procedimiento" ? 3 : 1)) {
            if (esEtiqueta(l) || (abajo.length && NARRACION.test(plano(l)))) break;
            abajo.push(primeraCaja(l));
          }
          valor = abajo.join(mk.campo === "procedimiento" ? " + " : " ");
        } else if (valor && mk.campo === "conclusion" && j + 1 === marcas.length) {
          // La conclusión de un informe sigue en los renglones de abajo (hasta la etiqueta siguiente)
          for (const l of siguientes.slice(0, 3)) { if (esEtiqueta(l)) break; valor += " " + l; }
        } else if (valor && mk.campo === "procedimiento" && j + 1 === marcas.length) {
          // Sigue abajo si termina en «+» o el renglón siguiente es corto y empieza con «(» o minúscula
          for (const l of siguientes.slice(0, 2)) {
            if (esEtiqueta(l) || NARRACION.test(plano(l)) || l.length > 90) break;
            if (/[+,]$/.test(valor) || /^[(a-záéíóú]/.test(l)) valor += " " + primeraCaja(l); else break;
          }
        }
        if (!valor) return;
        if (mk.campo === "ayudantes" && out.ayudantes) { if (!plano(out.ayudantes).includes(plano(valor))) out.ayudantes += ", " + valor; }
        else if (!(mk.campo in out) || mk.prioridad < prioridad[mk.campo] ||
                 (mk.prioridad === prioridad[mk.campo] && calidad(mk.campo, valor) > calidad(mk.campo, out[mk.campo]))) {
          out[mk.campo] = valor; prioridad[mk.campo] = mk.prioridad;
        }
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
    const titulo = texto.match(/historia cl[ií]nica\s*[-–]\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ]{4,50})/i);
    if (titulo) return titulo[1].trim();
    const lineas = texto.split(/\r?\n/).map((l) => l.trim());
    const nac = lineas.findIndex((l) => /^fecha nac/i.test(plano(l)));
    if (nac > 0 && /^[A-ZÁÉÍÓÚÑ]{2,}(?: [A-ZÁÉÍÓÚÑ]{2,}){1,4}$/.test(lineas[nac - 1])) return lineas[nac - 1];
    const encabezado = texto.split(/\r?\n/).slice(0, 15).join("\n");
    const m = encabezado.match(/(?:^|\s)([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ']+(?: [A-ZÁÉÍÓÚÑ']+)?, ?[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ']+(?: [A-ZÁÉÍÓÚÑ']+){0,2})(?=\s{2,}|\s*$|\s+(?:DNI|HC|Edad))/m);
    // Que no sea una frase: sin palabras comunes de la descripción quirúrgica
    return m && !/\b(DE|DEL|LA|EL|CON|SE|Y|EN|POR|PARA)\b/.test(m[1]) ? m[1].trim() : "";
  }

  function parte(texto, obraSocial) {
    const e = porEtiqueta(texto);
    // «Fecha 16/02/2022  Hasta 16/02/2023»: rango de búsqueda de la pantalla de la HC, no la fecha del procedimiento
    if (e.fecha) {
      const renglon = texto.split(/\r?\n/).find((l) => l.includes(e.fecha)) || "";
      if (/hasta|desde|área|area/i.test(renglon) && (renglon.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || []).length >= 2) delete e.fecha;
    }
    // Sin obra social legible: el n.º de beneficio de PAMI tiene 12 dígitos + 2 de parentesco (150088749201/00)
    if (!e.obra_social && /^1\d{11}[\/-]?\d{2}$/.test((e.afiliado || "").replace(/\s/g, ""))) e.obra_social = "PAMI";
    const esDni = (t) => /^\d{7,8}$/.test(soloDigitos(t).replace(/^0+/, ""));
    // El valor de «Tipo y Nro de Documento:» puede venir en otra caja («D.N.1   17486114»): el número de 7-8 cifras del renglón
    if (e.dni && !esDni(e.dni)) {
      const linea = texto.split(/\r?\n/).find((l) => l.includes(e.dni)) || "";
      const n = (linea.slice(linea.indexOf(e.dni)).match(/\b0*\d{1,2}\.?\d{3}\.?\d{3}\b/) || [])[0];
      if (n && esDni(n)) e.dni = n;
    }
    // Geclisa: DNI de 9 cifras con cero adelante (029123278), que no sea el n.º de afiliado
    if (!e.dni || !esDni(e.dni)) {
      const m = [...texto.matchAll(/(^|\s)(0\d{7,8})(?=\s|$)/g)].find((x) => !/afil/i.test(texto.slice(Math.max(0, x.index - 25), x.index)));
      if (m) e.dni = m[2];
    }
    const dni = soloDigitos(esDni(e.dni || "") ? e.dni : (plano(texto).match(/\b(?:d\.?n\.?i\.?|documento|n[°o] doc\.?)(?:\s*(?:numero|n°|no doc\.?|nro\.?|dni|d\.?n\.?i\.?))?\s*:?\s*([\d.]{7,11})/) || [])[1]).replace(/^0+/, "");
    // «GASTROSTOMIA (301007)»: código de la obra social entre paréntesis; «1- Videobroncoscopia . 2- Traqueostomia»: lista
    const codigoEnProc = ((e.procedimiento || "").match(/\((\d{6,8})\)/) || [])[1] || "";
    let procs = (e.procedimiento || "").replace(/\(\d{6,8}\)/g, "").replace(/(^|\s)\d\s*[-)]\s+/g, " + ").replace(/\s+\.(\s|$)/g, " ")
      .replace(/^[\s+\[\(|{]+/, "").split(/\s*(?:\+|;|\/|\by\b(?= [A-ZÁÉÍÓÚ])|\d\)\s)\s*/).map((s) => s.trim()).filter((s) => s.length > 2); // «VCC» tiene 3 letras
    // «Detalle de Prácticas Realizadas» (IMRC): un renglón por práctica con su código; la anestesia no es del cirujano
    let codigoPractica = "";
    if (/detalle de practicas realizadas/.test(plano(texto))) {
      const filas = texto.split(/\r?\n/).map((l) => l.match(/\b(\d{8})\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .\/,-]{4,}?)(?=\s{2,}|\s+\d{3,}|\s*$)/))
        .filter((m) => m && !/anestesia/i.test(m[2]));
      if (filas.length) { procs = filas.map((m) => m[2].trim()); codigoPractica = filas[0][1]; }
    }
    const osTexto = e.obra_social || "";
    return {
      fecha: fechaCercana(fechaISO(e.fecha || "")) || fechaProbable(texto),
      hora: ((e.hora || "").match(/\d{1,2}[:.]\d{2}/) || [""])[0].replace(".", ":"),
      paciente: (e.apellidos ? e.apellidos.trim() + (e.nombres ? ", " + e.nombres.trim() : "") : e.paciente || nombreSinEtiqueta(texto))
        .replace(/(?<=[A-ZÁÉÍÓÚÑ])0|0(?=[A-ZÁÉÍÓÚÑ]{2})/g, "O").replace(/^([A-ZÁÉÍÓÚÑ]{2,})\.\s+(?=[A-ZÁÉÍÓÚÑa-z])/, "$1, ").replace(/[|\[\]{}()_*~]/g, " ")
        .replace(/(^|\s)[A-Za-z](?=\s|,|$)/g, " ").replace(/\s+,/g, ",").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").replace(/\s*\b(dni|edad|h\.?c\.?)\b.*$/i, "").replace(/[.,\s]+$/, "").trim(),
      dni: dni.length >= 7 && dni.length <= 8 ? dni : "",
      obra_social_texto: osTexto.replace(/\s+-\s+\d[\d\s\/-]*$/, "").replace(/\s+nro\b.*$/i, "") || (obraSocial(texto) || ""),
      // «PAMI / CAPITA UROLOGICO - 14594162170700»: el número de afiliado viene al final de la obra social
      // Afiliado: tiene que tener números (si no, el lector tomó otra cosa)
      afiliado: ([e.afiliado, (osTexto.match(/-\s*(\d[\d\/-]{5,})\s*$/) || [])[1]].find((x) => (x || "").replace(/\D/g, "").length >= 3) || "").split(/\s{2,}/)[0].trim(),
      atencion: soloDigitos(e.atencion || ""),
      afiliadoPorForma: (texto.match(/(?:^|\s)(1\d{11}[\/-]?\d{2}|8000\d{15})(?=\s|$)/) || [])[1] || "",
      // «Código Quirúrgico: 180116 310009»: puede traer varios códigos; no pegarlos en un solo número
      codigos_os: ((e.codigo_os || "").match(/\d{5,8}/g) || []),
      codigo_os: ((e.codigo_os || "").match(/\d{5,8}/g) || [])[0] || codigoEnProc || codigoPractica,
      institucion: e.institucion || "",
      diagnostico: e.diagnostico || "",
      conclusion: e.conclusion || "",
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

  // Dos lecturas de la misma foto: cada paciente una sola vez, completando lo que a una lectura le faltó
  // Parecido entre dos textos (0 a 1), para reconocer el mismo nombre leído con una letra distinta («MIRTA» / «MITA»)
  function parecido(a, b) {
    const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let previo = d[0]; d[0] = i;
      for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, previo + (a[i - 1] === b[j - 1] ? 0 : 1)); previo = t; }
    }
    return 1 - d[b.length] / Math.max(a.length, b.length, 1);
  }
  function sinRepetir(filas) {
    const unicas = [];
    for (const f of filas) {
      const k = plano(f.paciente).replace(/[^a-z]/g, "");
      const previa = unicas.find((u) => parecido(plano(u.paciente).replace(/[^a-z]/g, ""), k) >= 0.85);
      if (!previa) unicas.push(f);
      else for (const [c, v] of Object.entries(f)) if (v && !previa[c]) previa[c] = v;
    }
    // Código de PAMI (8201xx) y obra social ilegible en las dos lecturas
    for (const f of unicas) if (/^8201\d\d$/.test(f.codigo_os || "") && !/pami/i.test(f.obra_social_texto || "") && (f.obra_social_texto || "").length < 4) f.obra_social_texto = "PAMI";
    return unicas;
  }

  // Programación de quirófano (Geclisa): un bloque por cirugía desde «Tipo de Anestesia:»; «Prestación <código> <práctica>»;
  // renglón «CIRUJANO  hh:mm  minutos  PACIENTE  Tel.: …»; obra social al final («IOSFA - IOSFA»). La fecha va arriba del bloque.
  function programaQuirofano(texto, obraSocial, medico) {
    const filas = [];
    let fecha = "", bloque = null;
    const cerrar = () => {
      if (!bloque || !bloque.paciente) return;
      const rol = medico && figura(medico, bloque.cirujano) ? "cirujano" : "ayudante";
      filas.push({ fecha, hora: bloque.hora, tipo: "cirugia", paciente: bloque.paciente, dni: "", afiliado: "", obra_social_texto: bloque.os,
        codigo_os: bloque.codigo, procedimiento: bloque.proc, notas: bloque.cirujano ? "Cirujano: " + bloque.cirujano : "", rol, ausente: false, detalle: "" });
    };
    for (const linea of texto.split(/\r?\n/)) {
      const l = linea.trim();
      if (/^\d{2}\/\d{2}\/\d{4}\b/.test(l) && !/:\s*\d/.test(l.slice(10, 20))) { const f = fechaISO(l); if (f && !/fiama|jolguin|alta|modi/i.test(l)) fecha = f; }
      if (/tipo de anestesia/i.test(l)) { cerrar(); bloque = { proc: "", codigo: "", paciente: "", cirujano: "", hora: "", os: "" }; }
      if (!bloque) continue;
      const pr = l.match(/Prestaci\S*\s+(\d{6,8})\s*(?:\s{2,}([A-ZÁÉÍÓÚÑ][^:]{4,}?))?(?:\s{3,}|$)/i);
      if (pr) { bloque.codigo = pr[1]; if (pr[2] && !/monitoreo/i.test(pr[2])) bloque.proc = pr[2].trim(); }
      // Práctica sin el código al lado: última caja en mayúsculas del renglón («Arco en C: No   HERNIOPLASTIA INGUINAL»)
      const ultima = l.split(/\s{3,}/).pop().trim();
      if (!bloque.proc && !pr && /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .,/()-]{6,}$/.test(ultima) && !/:/.test(ultima) && !/\d{1,2}:\d{2}/.test(l)) bloque.proc = ultima;
      const fila = l.match(/^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ,.]{3,}?)\s+([01]?\d|2[0-3]):([0-5]\d)\s+\d{2,3}\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ,.]{3,}?)(?=\s+Tel|\s{3,}|\s+\d|$)/);
      if (fila) { bloque.cirujano = fila[1].trim(); bloque.hora = `${fila[2].padStart(2, "0")}:${fila[3]}`; bloque.paciente = fila[4].trim(); }
      const os = l.match(/([A-Z][A-Z0-9. ]{2,}?)\s*-\s*([A-Z]{3,}(?: [A-Z]{3,})?)\s*$/);
      if (os && !/tel/i.test(os[0])) {
        const t = os[0].replace(/^(?:[MF]\s*\d{1,3}\s+|\d{1,3}\s+|[MF]\s+)/, "").trim(); // sin sexo y edad del paciente
        bloque.os = obraSocial(t) || obraSocial(t.replace(/^INSS\S*/i, "INSSJP")) || t;
      }
    }
    cerrar();
    return filas;
  }

  function listado(texto, obraSocial, medico) {
    if (/prestaci\S*\s+\d{6}/i.test(texto) && /tipo de anestesia/i.test(texto)) {
      const p = programaQuirofano(texto, obraSocial, medico);
      if (p.length) return p;
    }
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
      if (filas.length) return sinRepetir(filas);
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
    return sinRepetir(filas);
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

  // Endoscopías: alta (VEDA), baja (colonoscopía) o ambas; si se llegó a ciego y si hubo polipectomía (del informe)
  function endoscopia(proc, texto) {
    const t = plano(proc), todo = plano(texto);
    const alta = /\bveda\b|endoscopia (digestiva )?alta|gastroscop|esofagogastro|gastroduodenoscop|fibroendoscopia alta/.test(t);
    const baja = /\bvcc\b|colonoscop|rectosigmoidoscop|endoscopia (digestiva )?baja|videocolono/.test(t);
    if (!alta && !baja) return null;
    const ciego = !baja ? "" : /no se (logra|alcanza|llega)[^.]{0,40}ciego|sin llegar a(l)? ciego|incomplet/.test(todo) ? "no"
      : /ciego|valvula ileocecal|ileon terminal|intubacion ileal|orificio apendicular/.test(todo) ? "si" : "";
    const polipectomia = /polipectom|reseccion de(l)? polipo|polipos? (resecad|extraid)|asa de diatermia/.test(todo) ? "si"
      : /sin polipos|no se (observan|evidencian) polipos/.test(todo) ? "no" : "";
    return { endoscopia: alta && baja ? "ambas" : alta ? "alta" : "baja", ciego, polipectomia };
  }

  // ¿El médico figura en el texto? Tolera errores de tipeo y de lectura («CORTGGIANO», «Cortegiano», «Cortegg…»)
  function figura(apellido, texto) {
    const ap = plano(apellido).replace(/[^a-z]/g, "");
    if (ap.length < 4) return false;
    // «CORTEGGIANOIGNACIO» (apellido y nombre pegados) también cuenta
    return (plano(texto).match(/[a-z]{4,}/g) || []).some((w) => parecido(w, ap) >= 0.8 || (w.length >= 6 && ap.startsWith(w)) ||
      (w.length > ap.length && parecido(w.slice(0, ap.length), ap) >= 0.85));
  }
  function rolDe(medico, d, texto) {
    if (!medico) return "cirujano";
    if (figura(medico, d.cirujano)) return "cirujano";
    if (d.ayudantes.some((a) => figura(medico, a))) return "ayudante";
    // Por renglón: el apellido junto a «ayudante» u «otros profesionales» (o en el renglón de abajo, si quedó cortado)
    const lineas = texto.split(/\r?\n/);
    for (let i = 0; i < lineas.length; i++) {
      if (!figura(medico, lineas[i])) continue;
      const contexto = plano(lineas[i] + " " + (lineas[i - 1] || ""));
      const antes = plano(lineas[i]).split(new RegExp(plano(medico).slice(0, 5)))[0];
      if (/ayudante|otros profesionales/.test(antes) || (/ayudante|otros profesionales/.test(contexto) && !/cirujano/.test(antes))) return "ayudante";
      if (/cirujano/.test(antes)) return "cirujano";
    }
    return "cirujano";
  }

  // Informe de un estudio (TAC, ecografía…) pedido por el médico: no es un procedimiento suyo
  const esEstudio = (texto) => /medico indicante/.test(plano(texto)) ||
    /estudio:?\s*(t\.?\s?a\.?\s?c\.?|tomograf|resonancia|r\.?m\.?n|ecograf|radiograf|centellogra)/.test(plano(texto));

  // Igual que la versión de PC (app/lectura.py): resultado → prestaciones
  // Captura de pantalla de esta misma app (no es un parte ni un listado)
  const esCapturaDeLaApp = (texto) => /revisa los datos leidos|buscar otro codigo|agregar otro procedimiento \(mismo acto\)|buscar codigo pami/.test(plano(texto));

  function aPrestaciones(tipo, texto, { obraSocial, medico, pctMultiple }) {
    if (esCapturaDeLaApp(texto)) throw Object.assign(new Error("Esa imagen es una captura de pantalla de esta app, no un parte ni un listado. Cargá la foto del parte quirúrgico o de la historia clínica."), { capturaApp: true });
    if (tipo === "listado") {
      return listado(texto, obraSocial, medico).map((f) => ({ ...f, tipo: f.tipo, procedimiento: f.procedimiento || (f.tipo === "practica" ? f.detalle : ""),
        institucion: "", origen: "foto_listado", incluir: !f.ausente }));
    }
    const d = parte(texto, obraSocial);
    if (!d.afiliado && d.afiliadoPorForma) d.afiliado = d.afiliadoPorForma;
    const rol = rolDe(medico, d, texto);
    // VEDA + VCC en el mismo acto: una sola endoscopía «alta y baja»
    const endos = d.procedimientos.map((p) => endoscopia(p, texto));
    if (d.procedimientos.length > 1 && endos.every(Boolean)) {
      const tipos = new Set(endos.map((e) => e.endoscopia));
      const unica = { ...endos.find((e) => e.endoscopia !== "alta") || endos[0], endoscopia: tipos.size > 1 || tipos.has("ambas") ? "ambas" : [...tipos][0] };
      d.procedimientos = [d.procedimientos.join(" + ")];
      endos.splice(0, endos.length, unica);
    }
    return d.procedimientos.map((proc, i) => ({
      fecha: d.fecha, hora: d.hora, tipo: "cirugia", paciente: d.paciente, dni: d.dni, afiliado: d.afiliado, atencion: d.atencion,
      codigo_os: i === 0 ? d.codigo_os : "", codigos_os: i === 0 ? d.codigos_os : [],
      obra_social_texto: d.obra_social_texto, institucion: d.institucion, diagnostico: d.diagnostico, procedimiento: proc,
      abordaje: d.abordaje, urgencia: d.urgencia, rol, pct: i === 0 ? 100 : pctMultiple, origen: "foto_parte", incluir: true,
      ...(endos[i] ? { tipo: "endoscopia", abordaje: "endoscopica", ...endos[i], observaciones: d.conclusion } : {}),
    }));
  }

  return { textoDe, aPrestaciones, parte, listado, liquidacion, fechaISO, porEtiqueta, esEstudio, figura };
})();
