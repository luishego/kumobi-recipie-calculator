// ─────────────────────────────────────────────────────────────────────────
// Da o quita el acceso al panel del menú (épica 04, HU-18) mediante el Custom
// Claim `menuAdmin`.
//
//   node scripts/set-menu-admin.mjs <email> [on|off]
//   node scripts/set-menu-admin.mjs cocina@kumobi.mx          # on (default)
//   node scripts/set-menu-admin.mjs exempleado@kumobi.mx off
//
// Por qué existe aparte de set-claim.mjs: `role` decide qué se puede hacer en
// el panel de COSTEO; `menuAdmin` decide quién puede reescribir la CARTA
// PÚBLICA. Son permisos sobre cosas distintas y mezclarlos obligaría a dar
// acceso al Food Cost para poder cambiar un precio del menú.
//
// Conserva todos los demás claims del usuario, igual que set-claim.mjs.
//
// Fuente de credenciales:
//   1) FIREBASE_ADMIN_CREDENTIALS_FILE (ruta al JSON)  — si no, ...
//   2) ./secrets/serviceAccount.json  (ubicación por defecto)
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [, , email, modoArg = 'on'] = process.argv;
const modo = String(modoArg).toLowerCase();

if (!email || !['on', 'off'].includes(modo)) {
  console.error('Uso: node scripts/set-menu-admin.mjs <email> [on|off]');
  console.error('  on  (default): da acceso al panel del menú');
  console.error('  off          : lo quita');
  process.exit(1);
}

const credPath = resolve(
  process.cwd(),
  process.env.FIREBASE_ADMIN_CREDENTIALS_FILE || './secrets/serviceAccount.json',
);

let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(credPath, 'utf8'));
} catch {
  console.error(`No se pudo leer el JSON de cuenta de servicio en: ${credPath}`);
  console.error('Coloca el archivo ahí o define FIREBASE_ADMIN_CREDENTIALS_FILE.');
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();

try {
  const user = await auth.getUserByEmail(email);
  const existing = user.customClaims || {};

  if (modo === 'on') {
    await auth.setCustomUserClaims(user.uid, { ...existing, menuAdmin: true });
    console.log(`✓ ${email} (uid ${user.uid}) → menuAdmin: true`);
  } else {
    // Se borra la llave en vez de ponerla en false: el guard exige === true,
    // así que dejar `menuAdmin: false` funcionaría igual, pero deja basura que
    // después alguien tiene que interpretar.
    const { menuAdmin, ...resto } = existing;
    await auth.setCustomUserClaims(user.uid, resto);
    console.log(`✓ ${email} (uid ${user.uid}) → claim menuAdmin eliminado`);
  }

  if (modo === 'on' && !existing.tenantId) {
    console.log('');
    console.log('⚠ Esta cuenta no tiene `tenantId`. Hoy no estorba —el panel del menú');
    console.log('  todavía no filtra por inquilino— pero en cuanto las secciones e');
    console.log('  ítems lleven tenant_id (fases 3 y 4), una cuenta sin inquilino no');
    console.log('  verá nada. Asígnalo con:');
    console.log(`      node scripts/set-claim.mjs ${email} <role> tnt_kumobi`);
  }

  if (modo === 'off' && existing.role === 'admin') {
    console.log('');
    console.log('⚠ OJO: esta cuenta tiene role="admin", y el panel del menú deja');
    console.log('  entrar también por rol (MENU_ADMIN_ROLES, default "admin").');
    console.log('  Quitar menuAdmin NO le quita el acceso. Para cerrárselo hay que');
    console.log('  cambiarle el rol, o sacar "admin" de MENU_ADMIN_ROLES.');
  }

  console.log('');
  console.log('  Nota: el usuario debe cerrar y volver a iniciar sesión para que el');
  console.log('  cambio surta efecto — la cookie de sesión lleva los claims dentro y');
  console.log('  vive hasta 5 días.');
  process.exit(0);
} catch (err) {
  console.error(`✗ Error cambiando menuAdmin para ${email}:`);
  console.error(`  ${err?.code || ''} ${err?.message || err}`);
  process.exit(1);
}
