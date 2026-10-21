# Liquidaciones — versión celular (sin servidor)

App web instalable (Android y iPhone). No necesita una PC prendida ni un servidor propio:

- **Todo corre en el celular**: sugerencia de códigos AAC/PAMI, valores por obra social, fechas de cobro y resúmenes
  (`motor.js`, el mismo algoritmo que la versión de PC; `tests/test_movil.py` verifica que den igual).
- **Seguridad**: PIN obligatorio; los datos del celular se guardan cifrados (AES-256-GCM, clave derivada del PIN con
  PBKDF2); bloqueo automático a los 5 minutos; librerías alojadas en la app (`vendor/`) y política de seguridad de
  contenido que solo permite conectarse con Google Drive.
- **Lectura de documentos gratis y sin sacar datos del teléfono** (`lector.js`): PDF con texto → lectura directa;
  captura de pantalla, foto o PDF escaneado → PaddleOCR PP-OCRv5 (modelo de IA open source, en el celular). Reglas arman las
  prestaciones a partir de etiquetas («Paciente:», «Obra social:», «Procedimiento:»…). También se puede pegar el texto.
- **Datos de cada profesional**: en el celular (funciona sin señal) y copia en **su** Google Drive, carpeta
  «Liquidaciones» (`almacen.js`). Permiso `drive.file`: la app solo ve los archivos que ella creó.
- La primera vez que se lee un documento descarga el lector (~27 MB, desde la misma app); después funciona sin conexión (`sw.js`).
  Medido con 46 documentos reales (Geclisa, Swiss Medical, SAPyde, IMRC): 98 % de los datos correctos.

## Publicarla (una sola vez)

Es un sitio estático: cualquier hosting gratuito con HTTPS sirve (GitHub Pages, Cloudflare Pages, Netlify).
Se publica el contenido de esta carpeta tal cual.

## Google Drive: crear el «ID de cliente» (una sola vez, ~10 minutos)

1. Entrar a https://console.cloud.google.com con una cuenta de Google y crear un proyecto («Liquidaciones»).
2. *APIs y servicios → Biblioteca* → habilitar **Google Drive API**.
3. *APIs y servicios → Pantalla de consentimiento de OAuth* → tipo **Externo**; nombre «Liquidaciones», correo de
   soporte; en *Permisos* agregar `.../auth/drive.file`. Pasarla a **En producción** (con `drive.file` no requiere
   revisión de Google; mientras está «En prueba» solo entran los correos agregados como usuarios de prueba).
4. *Credenciales → Crear credenciales → ID de cliente de OAuth* → **Aplicación web**:
   - Orígenes autorizados de JavaScript: la dirección de la app (p. ej. `https://usuario.github.io`).
   - URI de redireccionamiento autorizados: la dirección completa (p. ej. `https://usuario.github.io/liquidaciones/`).
5. Copiar el ID de cliente en `config.js` → `GOOGLE_CLIENT_ID` y volver a publicar.

El ID de cliente no es secreto (va en el código de la página).

## Uso en el celular

Abrir la dirección en Chrome (Android) o Safari (iPhone) → «Agregar a pantalla de inicio» → «Conectar mi Google
Drive». Cada colega usa su propia cuenta: sus datos no se mezclan con los de otro.

## Límites conocidos

- La lectura funciona bien con texto de computadora (capturas, PDF). Escrito a mano: completar en la revisión.
- Los formatos de cada sistema de historia clínica varían: si un campo no se reconoce, se corrige en la revisión
  (y se pueden agregar etiquetas en `ETIQUETAS`, `lector.js`).
- La sesión de Google dura una hora: si venció, la app guarda en el celular y pide «Sincronizar» para subir la copia.
