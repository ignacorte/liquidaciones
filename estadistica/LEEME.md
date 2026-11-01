# Base económica anónima: cómo habilitarla

La app solo envía datos si el profesional activa «Aportar mis cobros anónimos» **y** `ESTADISTICA_URL` en `config.js` tiene una URL.
Mientras esté vacía, no sale nada.

Qué llega por cada línea cobrada: especialidad, tipo, rol, obra social, código, vía, urgencia, mes de la prestación y del cobro, días
hasta el cobro, monto cobrado o debitado, estimado de la app, estado, % y versión, más un número de aportante al azar.
Nunca llegan nombre, DNI, afiliado, diagnóstico, fechas exactas, notas, institución ni el correo del profesional. El script además
descarta cualquier campo que no tenga la forma esperada.

## Publicar el receptor (una sola vez, con la cuenta de Google del responsable)

1. En Google Drive: **Nuevo → Hojas de cálculo de Google**. Llamala «Liquidaciones – Base económica».
2. En la planilla: **Extensiones → Apps Script**.
3. Borrá lo que aparece, pegá todo el contenido de `Codigo.gs` y tocá **Guardar**.
4. **Implementar → Nueva implementación**. En el engranaje elegí **Aplicación web**.
   - Descripción: «Base económica»
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
5. **Implementar** y autorizá con tu cuenta. Si aparece «Google no verificó esta app», es tu propio script: **Configuración avanzada → Ir a…**.
6. Copiá la **URL de la aplicación web** (termina en `/exec`). Al abrirla en el navegador tiene que responder `{"ok":true,…}`.
7. Esa URL va en `movil/config.js` → `ESTADISTICA_URL`, y se publica una versión nueva de la app.

Los datos quedan en la hoja «Cobros» de esa planilla, una fila por línea cobrada. Si la misma línea llega de nuevo, se actualiza y no se duplica.
Si un profesional toca «Dejar de compartir y borrar lo aportado», se borran todas sus filas.

## Para cambiar el script después

Editá el código y usá **Implementar → Administrar implementaciones → editar (lápiz) → Versión: nueva**. Así la URL no cambia.

## Antes de tener muchos usuarios

- Que un abogado revise `terminos.html` y `privacidad.html`.
- Inscribir la base en el Registro Nacional de Bases de Datos (AAIP), según la Ley 25.326.
- Mostrar resultados solo agregados y con un mínimo de casos y de profesionales, para que nadie pueda ser identificado.
