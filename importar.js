// Importar listas de valores (aranceles) de cualquier archivo: Excel/CSV/ODS, Word (.docx), PDF, fotos o texto.
// Todo en el celular: de cada renglón se toman el código, la descripción y los montos; la app propone obra social,
// vigencia y qué columna es cada cosa, y el médico lo revisa antes de guardar.
const Importador = (() => {
  const plano = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function script(src) {
    return new Promise((ok, mal) => {
      if (document.querySelector(`script[src="${src}"]`)) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => mal(new Error("No se pudo cargar " + src));
      document.head.appendChild(s);
    });
  }

  // ---------- Archivo → renglones de celdas ----------

  // .docx = un .zip; se descomprime solo word/document.xml (sin librerías: DecompressionStream del navegador)
  async function deZip(buf, nombre) {
    const v = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
    let fin = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { fin = i; break; }
    if (fin < 0) throw new Error("El archivo de Word está dañado o no es .docx");
    let p = v.getUint32(fin + 16, true);
    for (let n = v.getUint16(fin + 10, true); n > 0; n--) {
      const metodo = v.getUint16(p + 10, true), tam = v.getUint32(p + 20, true), largo = v.getUint16(p + 28, true);
      const extra = v.getUint16(p + 30, true), coment = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
      const archivo = dec.decode(u8.subarray(p + 46, p + 46 + largo));
      if (archivo === nombre) {
        const ini = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const datos = u8.subarray(ini, ini + tam);
        if (metodo === 0) return dec.decode(datos);
        return new Response(new Blob([datos]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
      }
      p += 46 + largo + extra + coment;
    }
    throw new Error("No es un documento de Word (.docx)");
  }

  async function filasWord(archivo) {
    const xml = new DOMParser().parseFromString(await deZip(await archivo.arrayBuffer(), "word/document.xml"), "application/xml");
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const textoDe = (n) => [...n.getElementsByTagNameNS(W, "t")].map((t) => t.textContent).join("").trim();
    const filas = [], lineas = [];
    const cuerpo = xml.getElementsByTagNameNS(W, "body")[0];
    for (const n of cuerpo ? cuerpo.children : []) {
      if (n.localName === "tbl") {
        for (const tr of n.getElementsByTagNameNS(W, "tr")) {
          const celdas = [...tr.children].filter((c) => c.localName === "tc").map(textoDe);
          filas.push(celdas); lineas.push(celdas.join("   "));
        }
      } else if (n.localName === "p") {
        // Párrafos con tabulaciones: se tratan como renglones de texto
        const t = [...n.getElementsByTagNameNS(W, "r")].map((r) => [...r.children].map((c) => (c.localName === "tab" ? "   " : c.localName === "t" ? c.textContent : "")).join("")).join("");
        if (t.trim()) { lineas.push(t); filas.push(...filasTexto(t)); }
      }
    }
    return { filas, texto: lineas.join("\n"), tabla: true };
  }

  async function filasPlanilla(archivo) {
    await script("vendor/xlsx.full.min.js");
    const libro = XLSX.read(await archivo.arrayBuffer(), { type: "array" });
    const filas = [], lineas = [];
    for (const nombre of libro.SheetNames) {
      lineas.push(nombre);
      for (const f of XLSX.utils.sheet_to_json(libro.Sheets[nombre], { header: 1, raw: true, defval: "" })) {
        filas.push(f.map((c) => (typeof c === "string" ? c.trim() : c)));
        lineas.push(f.join("   "));
      }
    }
    return { filas, texto: lineas.join("\n"), tabla: true };
  }

  // Texto (PDF, foto, .txt): cada renglón → [código, descripción, montos…]
  const RE_CODIGO = /^(\d{1,3}(?:[.\-]\d{1,2}){1,3}[a-z]?|\d{4,8})$/i;
  function filasTexto(texto) {
    return texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const fichas = l.replace(/\$\s+/g, "$").split(/\s+/);
      const montos = [];
      while (fichas.length > 1 && !isNaN(monto(fichas[fichas.length - 1]))) montos.unshift(fichas.pop());
      const codigo = RE_CODIGO.test(fichas[0] || "") && fichas.length > 1 ? fichas.shift() : "";
      // Sin montos al final (encabezado): las cajas separadas por espacios
      if (!montos.length) return l.split(/\s{3,}|\t/);
      return [codigo, fichas.join(" "), ...montos];
    });
  }

  async function leer(archivo, avance) {
    const n = plano(archivo.name);
    if (/\.(xlsx|xlsm|xls|ods|csv)$/.test(n)) return filasPlanilla(archivo);
    if (/\.docx$/.test(n)) return filasWord(archivo);
    if (/\.doc$/.test(n)) throw new Error("Los .doc viejos de Word no se pueden leer en el celular: abrilo en Word y guardalo como .docx o PDF.");
    let texto;
    if (/\.txt$/.test(n) || archivo.type === "text/plain") texto = await archivo.text();
    else texto = await Lector.textoDe([archivo], avance, { paginas: 60 });
    return { filas: filasTexto(texto), texto, tabla: false };
  }

  // ---------- Celdas → valores ----------

  // «$ 12.345,67», «12345.67», «12,345.67», 12345 (número de Excel)
  function monto(v) {
    if (typeof v === "number") return v;
    let x = String(v ?? "").replace(/[$\s]/g, "").replace(/^ARS/i, "");
    if (!x || !/^\d[\d.,]*$/.test(x)) return NaN;
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(x) || /^\d+,\d{1,2}$/.test(x)) x = x.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(x)) x = x.replace(/,/g, "");
    else if (!/^\d+(\.\d{1,2})?$/.test(x)) return NaN;
    return Number(x);
  }
  const esCodigo = (c) => (typeof c === "number" ? Number.isInteger(c) && c >= 1000 && c < 1e8 : RE_CODIGO.test(String(c).trim()));
  const esTexto = (c) => typeof c === "string" && /[a-záéíóúñ]{3,}/i.test(c) && !esCodigo(c);
  const esTitulo = (c) => typeof c === "string" && /[a-záéíóúñ%]{2,}|%/i.test(c) && !esCodigo(c) && isNaN(monto(c)); // «UQ», «% gastos»

  // Encabezados que no son el honorario del médico (por defecto se ignoran). «Galeno» no: es también una obra social
  const NO_HONORARIO = /gasto|insumo|derecho|sanatori|pension|material|anestes|ayudant|\buq\b|unidad|cant|porc|%|iva|cama/;

  // Columnas: código (la de más códigos), descripción (la de más texto) y columnas de montos (números grandes)
  function interpretar(lectura) {
    const filas = lectura.filas.filter((f) => f.some((c) => String(c).trim()));
    const ancho = Math.max(0, ...filas.map((f) => f.length));
    const cuenta = (prueba) => Array.from({ length: ancho }, (_, j) => filas.filter((f) => prueba(f[j])).length);
    const codigos = cuenta(esCodigo), textos = cuenta(esTexto), numeros = cuenta((c) => monto(c) > 0);
    // La de códigos: la primera de la izquierda con casi tantos códigos como la que más (los montos enteros también «parecen» códigos)
    const colCodigo = codigos.findIndex((n) => n >= 0.6 * Math.max(...codigos));
    if (colCodigo < 0 || codigos[colCodigo] < 2) return { columnas: [], items: [] };
    const colDesc = textos.map((t, j) => (j === colCodigo ? -1 : t)).reduce((m, t, j, a) => (t > a[m] ? j : m), colCodigo === 0 ? 1 : 0);
    const esFila = (f) => esCodigo(f[colCodigo]) && f.some((c, j) => j !== colCodigo && monto(c) > 0);
    const datos = filas.filter(esFila);
    const posibles = Array.from({ length: ancho }, (_, j) => j).filter((j) => j !== colCodigo && j !== colDesc && numeros[j] >= Math.max(2, datos.length * 0.3));
    // Encabezado de cada columna: el último renglón sin datos con texto en esa columna, antes del primer dato
    const primera = filas.findIndex(esFila);
    const encabezado = (j) => {
      for (let i = primera - 1; i >= 0 && i >= primera - 6; i--) {
        const f = filas[i];
        if (lectura.tabla) { if (esTitulo(f[j])) return f[j]; continue; }
        // Texto: cajas del encabezado alineadas a la derecha con los montos
        const cajas = f.filter((c) => String(c).trim());
        const k = cajas.length - (ancho - j);
        if (cajas.length >= 2 && k >= 0 && esTitulo(cajas[k])) return cajas[k];
      }
      return "";
    };
    const columnas = posibles.map((j) => {
      const vals = datos.map((f) => monto(f[j])).filter((x) => x > 0);
      const nombre = encabezado(j) || `Columna ${j + 1}`;
      return { j, nombre, ejemplo: vals[0], chica: Math.max(...vals) < 1000, ignorar: NO_HONORARIO.test(plano(nombre)) || Math.max(...vals) < 1000,
        modulo: /modulo|total|institu|integral/.test(plano(nombre)) };
    });
    const items = datos.map((f) => ({
      codigo: String(f[colCodigo]).trim(), descripcion: String(f[colDesc] ?? "").replace(/\s+/g, " ").trim(),
      montos: Object.fromEntries(columnas.map((c) => [c.j, monto(f[c.j])]).filter(([, x]) => x > 0)),
    }));
    // Mismo código repetido (p. ej. una hoja por categoría): queda el primero
    const vistos = new Set();
    return { columnas, items: items.filter((it) => (vistos.has(it.codigo) ? false : vistos.add(it.codigo))) };
  }

  // Vigencia escrita en el archivo («vigencia octubre 2026», «a partir del 01/11/2026», «valores 11/2026») → «2026-11»
  const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
  function vigencia(texto) {
    const t = plano(texto).slice(0, 4000);
    const cerca = t.match(/(?:vigen\w*|a partir del?|desde|valores?|aranceles?|periodo)[^\n]{0,40}/g) || [];
    for (const trozo of [...cerca, t]) {
      let m = trozo.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d\d)\b/);
      if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[3]}-${m[2].padStart(2, "0")}`;
      m = trozo.match(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b\W{0,5}(?:de(?:l)?\s+)?(20\d\d)\b/);
      if (m) return `${m[2]}-${String(MESES[m[1]]).padStart(2, "0")}`;
      m = trozo.match(/\b(0?[1-9]|1[0-2])[\/-](20\d\d)\b/);
      if (m) return `${m[2]}-${m[1].padStart(2, "0")}`;
    }
    return "";
  }

  // Obra social: del nombre del archivo, del título o del encabezado de cada columna de montos
  function obraSocial(datos, nombreArchivo, texto) {
    const candidatos = [nombreArchivo.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " "), ...texto.split(/\r?\n/).slice(0, 15)];
    for (const c of candidatos) { const os = Motor.obraSocialCanonica(datos, c); if (os && os !== "PARTICULAR") return os; }
    return "";
  }

  return { leer, interpretar, vigencia, obraSocial, monto, filasTexto };
})();
