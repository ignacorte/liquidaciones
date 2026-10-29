// Configuración pública de la app (no tiene secretos).
// GOOGLE_CLIENT_ID: «ID de cliente OAuth» tipo «Aplicación web» creado en console.cloud.google.com (ver README).
const CONFIG = {
  GOOGLE_CLIENT_ID: "135649031000-1i8unkint6isj5r3eoafvv6n60sgcsqs.apps.googleusercontent.com",
  // Administradores: huella SHA-256 del email de Google (el email no queda publicado). Al entrar eligen cirugía o anestesiología;
  // los demás eligen una sola vez su especialidad y ven solo esa.
  ADMINS_SHA256: ["d9d3d79dee26b6a3ee27d2eddb33d120214b5770e20468c0d45b84ec6af11bae"],
};
