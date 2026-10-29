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
    return seccionado(texto) || { filas: filasTexto(texto), texto, tabla: false };
  }

  // «Nomenclador valorizado» (Colegio Médico): un título por práctica («080709   COLECISTECTOMIA») y debajo un renglón por
  // obra social («24 ASOCIACION MUTUAL …   481.634,91   486.613,02   968.247,93»). Se arma como tabla larga.
  const RE_TITULO = /^\s*(\d{2}\.\d{2}\.\d{2}|\d{6}|\d{8})\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][^\d]{3,}?)\s*$/;
  const RE_RENGLON = /^\s*(\d{1,6})\s+(.+?)\s+(\$?\s?\d[\d.]*,\d{2}(?:\s+\$?\s?\d[\d.]*,\d{2}){0,4})\s*$/;
  function seccionado(texto) {
    const lineas = texto.split(/\r?\n/);
    let practica = null, nTitulos = 0, columnas = null;
    const filas = [];
    for (const l of lineas) {
      if (!columnas && /honorario/i.test(l)) {
        // Encabezado de columnas: las palabras del final («Honorarios   Gastos   Importe»)
        columnas = l.split(/\s{2,}/).map((c) => c.trim()).filter((c) => /^[A-Za-zÁÉÍÓÚÑáéíóúñ. ]{3,}$/.test(c) && !/epoca|codigo|c[oó]digo/i.test(c));
      }
      const t = l.match(RE_TITULO);
      if (t) { practica = { codigo: t[1], descripcion: t[2].trim() }; nTitulos++; continue; }
      const r = practica && !/promedio|total/i.test(l) && l.match(RE_RENGLON);
      if (r) filas.push([practica.codigo, practica.descripcion, `${r[1]} - ${r[2].trim()}`, ...r[3].trim().split(/\s+(?=\$?\s?\d)/)]);
    }
    if (!nTitulos || filas.length < 5) return null;
    const montos = Math.max(...filas.map((f) => f.length - 3));
    const nombres = (columnas || []).slice(-montos);
    const cab = ["Código", "Descripción", "Obra social", ...Array.from({ length: montos }, (_, k) => nombres[k] || `Monto ${k + 1}`)];
    return { filas: [cab, ...filas], texto, tabla: true };
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

  // Columnas: código (la de más códigos), descripción (la de al lado, o la de más texto) y columnas de montos.
  // Formato «largo» (un renglón por práctica y obra social, como el listado de valores del sistema del sanatorio):
  // si hay una columna de obras sociales, cada renglón es el valor de esa práctica para esa obra social.
  function interpretar(lectura, obraSocial = () => null) {
    const filas = lectura.filas.filter((f) => f.some((c) => String(c).trim()));
    const ancho = Math.max(0, ...filas.map((f) => f.length));
    const cuenta = (prueba) => Array.from({ length: ancho }, (_, j) => filas.filter((f) => prueba(f[j])).length);
    const codigos = cuenta(esCodigo), textos = cuenta(esTexto), numeros = cuenta((c) => monto(c) > 0);
    // La de códigos: la primera de la izquierda con casi tantos códigos como la que más (los montos enteros también «parecen» códigos)
    const colCodigo = codigos.findIndex((n) => n >= 0.6 * Math.max(...codigos));
    if (colCodigo < 0 || codigos[colCodigo] < 1) return { columnas: [], items: [] };
    const maxTexto = Math.max(...textos.filter((_, j) => j !== colCodigo));
    const colDesc = textos[colCodigo + 1] >= 0.5 * maxTexto ? colCodigo + 1
      : textos.map((t, j) => (j === colCodigo ? -1 : t)).reduce((m, t, j, a) => (t > a[m] ? j : m), colCodigo === 0 ? 1 : 0);
    const primeraConCodigo = filas.findIndex((f) => esCodigo(f[colCodigo]));
    // Encabezado de cada columna: el último renglón sin datos con texto en esa columna, antes del primer dato
    const encabezado = (j, primera) => {
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
    const titulo = (j) => plano(encabezado(j, primeraConCodigo));
    // Columnas que nunca son montos: códigos, números de obra social, CUIT, IVA…
    const noMonto = (j) => /cod|nro|numero|^id$|cuit|afiliado|iva|plan/.test(titulo(j));
    // ¿Columna de obras sociales?
    const conCodigo = filas.filter((f) => esCodigo(f[colCodigo]));
    let colOS = -1;
    if (lectura.tabla) {
      const puntaje = Array.from({ length: ancho }, (_, j) => {
        if (j === colCodigo || j === colDesc) return 0;
        const n = conCodigo.filter((f) => typeof f[j] === "string" && obraSocial(f[j])).length;
        return (/os_nom|obra ?social|financiador|cobertura|prepaga|entidad|convenio/.test(titulo(j)) ? n * 2 : n);
      });
      const mejor = puntaje.indexOf(Math.max(...puntaje));
      const distintos = new Set(conCodigo.map((f) => String(f[colCodigo]))).size;
      const conTitulo = /os_nom|obra ?social|financiador|cobertura|prepaga|entidad|convenio/.test(titulo(mejor));
      if ((conTitulo ? puntaje[mejor] >= 2 : puntaje[mejor] >= Math.max(3, conCodigo.length * 0.3)) && conCodigo.length >= distintos * 2) colOS = mejor;
    }
    const esFila = (f) => esCodigo(f[colCodigo]) && f.some((c, j) => j !== colCodigo && j !== colOS && !noMonto(j) && monto(c) > 0);
    const datos = filas.filter(esFila);
    const primera = filas.findIndex(esFila);
    const posibles = Array.from({ length: ancho }, (_, j) => j)
      .filter((j) => j !== colCodigo && j !== colDesc && j !== colOS && !noMonto(j) && numeros[j] >= Math.max(1, datos.length * 0.3));
    const columnas = posibles.map((j) => {
      const vals = datos.map((f) => monto(f[j])).filter((x) => x > 0);
      const nombre = encabezado(j, primera) || `Columna ${j + 1}`;
      return { j, nombre, ejemplo: vals[0], ignorar: NO_HONORARIO.test(plano(nombre)) || Math.max(...vals) < 1000,
        modulo: /modulo|institu|integral/.test(plano(nombre)) };
    });
    const items = datos.map((f) => ({
      codigo: String(f[colCodigo]).trim(), descripcion: String(f[colDesc] ?? "").replace(/\s+/g, " ").trim(),
      os_texto: colOS >= 0 ? String(f[colOS]).trim() : "",
      montos: Object.fromEntries(columnas.map((c) => [c.j, monto(f[c.j])]).filter(([, x]) => x > 0)),
    }));
    if (colOS >= 0) {
      // Largo: una columna de valor (la de «total» si hay; si no, la primera útil)
      // Honorarios si la lista los separa de los gastos; si no, el total
      const total = columnas.find((c) => /honorario/.test(plano(c.nombre))) || columnas.find((c) => /^total$|^total[^a-z]|importe|valor|monto/.test(plano(c.nombre)))
        || columnas.find((c) => !c.ignorar) || columnas[0];
      for (const c of columnas) c.ignorar = c !== total;
      return { largo: true, columnaOS: encabezado(colOS, primera) || "Obra social", columnas, items };
    }
    // Mismo código repetido (p. ej. una hoja por categoría): queda el primero
    const vistos = new Set();
    return { columnas, items: items.filter((it) => (vistos.has(it.codigo) ? false : vistos.add(it.codigo))) };
  }

  // Formato largo → un valor por práctica y obra social de la app. De cada obra social del archivo, el valor más repetido
  // entre sus planes; si varias del archivo son la misma obra social («GALENO» y «GALENO ART LABOULAYE»), gana la principal.
  function porObraSocial(items, j, obraSocial) {
    const grupos = new Map();
    for (const it of items) {
      const x = it.montos[j];
      if (!x) continue;
      const k = it.codigo + "|" + it.os_texto;
      if (!grupos.has(k)) grupos.set(k, { codigo: it.codigo, descripcion: it.descripcion, os_texto: it.os_texto, valores: [] });
      grupos.get(k).valores.push(x);
    }
    const variante = /\b(art|lby|lbye|laboulaye|seguros?|aseguradora)\b|\(lby/;
    const elegidos = new Map(), sinOS = new Map();
    for (const g of grupos.values()) {
      const veces = new Map();
      for (const v of g.valores) veces.set(v, (veces.get(v) || 0) + 1);
      g.monto = [...veces].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
      g.min = Math.min(...g.valores); g.max = Math.max(...g.valores); g.planes = g.valores.length;
      g.os = obraSocial(g.os_texto);
      if (!g.os) { sinOS.set(g.os_texto, (sinOS.get(g.os_texto) || 0) + 1); continue; }
      const nombre = plano(g.os_texto.replace(/^\s*\d+\s*-\s*/, ""));
      g.puntaje = (variante.test(nombre) ? -1000 : 0) + g.planes * 10 - nombre.length / 100;
      const k = g.codigo + "|" + g.os, previo = elegidos.get(k);
      if (!previo || g.puntaje > previo.puntaje) elegidos.set(k, g);
    }
    return { valores: [...elegidos.values()], sinReconocer: [...sinOS.keys()] };
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

  // ¿De qué nomenclador son los códigos? No alcanza con el número (el 08.07.16 del sanatorio es una colecistectomía y en la AAC
  // es una reparación de la vía biliar): se compara la descripción del archivo con la del código en la AAC y en PAMI.
  const VACIAS = new Set(["para", "otra", "otras", "otro", "otros", "tipo", "segun", "incluye", "cada", "mismo", "misma", "desde", "hasta", "solo"]);
  const raices = (t) => new Set((plano(t).match(/[a-z]{4,}/g) || []).filter((w) => !VACIAS.has(w)).map((w) => w.slice(0, 6)));
  function coincidencia(desc, nombre) {
    const a = raices(desc), b = raices(nombre);
    return a.size ? [...a].filter((w) => b.has(w)).length / a.size : 0;
  }
  const formasAAC = (c) => {
    const d = String(c).replace(/\D/g, "");
    const f = /^\d{2}\.\d{2}\.\d{2}$/.test(String(c).trim()) ? [String(c).trim()] : [];
    if (d.length === 6 || (d.length === 8 && d.endsWith("00"))) f.push(`${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4, 6)}`);
    return f;
  };
  function nomenclador(items) {
    const aac = new Map(Motor.catalogos.AAC.codes.map((c) => [c.code, c]));
    const pami = new Map(((Motor.catalogos.PAMI_TODO || Motor.catalogos.PAMI || {}).codes || []).map((c) => [c.code, c]));
    const texto = (c) => c.name + " " + (c.items || []).join(" ");
    const porCodigo = new Map();
    let nAAC = 0, nPAMI = 0, conDesc = 0;
    for (const it of items) {
      if (porCodigo.has(it.codigo)) continue;
      const r = { aac: "", nombre: "", es: "" };
      if (it.descripcion) {
        conDesc++;
        const propio = formasAAC(it.codigo).find((k) => aac.has(k) && coincidencia(it.descripcion, texto(aac.get(k))) >= 0.5);
        const dePami = pami.get(String(it.codigo).replace(/\D/g, ""));
        if (propio) { r.es = "aac"; r.aac = propio; r.nombre = aac.get(propio).name; nAAC++; }
        else if (dePami && coincidencia(it.descripcion, texto(dePami)) >= 0.5) { r.es = "pami"; nPAMI++; }
        if (!r.aac) {
          // Entre las sugeridas, primero la del mismo capítulo que el código del archivo (080202 → 08.xx.xx, abdomen)
          const cap = String(it.codigo).replace(/\D/g, "").slice(0, 2), sug = Motor.sugerir("AAC", it.descripcion);
          const s = sug.find((c) => c.code.startsWith(cap + ".")) || sug[0];
          if (s) { r.aac = s.code; r.nombre = s.name; }
        }
      }
      porCodigo.set(it.codigo, r);
    }
    const sistema = conDesc && nAAC >= conDesc * 0.6 ? "aac" : conDesc && nPAMI >= conDesc * 0.6 ? "pami" : "propio";
    return { sistema, porCodigo, nAAC, nPAMI, conDesc };
  }

  // Nombre para una obra social nueva: «6004 - SAN PEDRO (LBY)» → «SAN PEDRO» (las variantes de una sede se juntan)
  const nombreBase = (t) => String(t).replace(/^\s*\d+\s*-\s*/, "").replace(/\(\s*lbye?\s*\)|\blbye?\b|\blaboulaye\b/gi, " ")
    .replace(/\s+/g, " ").replace(/[\s.,\-(]+$/, "").trim().toUpperCase();

  return { leer, interpretar, porObraSocial, nomenclador, nombreBase, vigencia, obraSocial, monto, filasTexto };
})();
