// ─────────────────────────────────────────────────────────────────────────
// Asigna un Custom Claim `role` a un usuario de Firebase Auth.
// Uso local (no forma parte del runtime de la app). Requiere el JSON de
// cuenta de servicio (el mismo secreto que usa el SSR).
//
//   node scripts/set-claim.mjs <email> <role> [tenantId]
//   node scripts/set-claim.mjs chef@kumobi.mx admin
//   node scripts/set-claim.mjs chef@otro.mx admin tnt_otro
//
// role válido: admin | chef | manager
// tenantId: inquilino al que pertenece el usuario (épica 02 §5.8).
//   Por defecto `tnt_kumobi`, que es el único inquilino que existe hoy.
//
// Fuente de credenciales (en este orden):
//   1) FIREBASE_ADMIN_CREDENTIALS_FILE (ruta al JSON)  — si no, ...
//   2) ./secrets/serviceAccount.json  (ubicación por defecto)
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const VALID_ROLES = ['admin', 'chef', 'manager'];
const DEFAULT_TENANT = 'tnt_kumobi';

const [, , email, role, tenantArg] = process.argv;
const tenantId = tenantArg || DEFAULT_TENANT;

if (!email || !role) {
  console.error('Uso: node scripts/set-claim.mjs <email> <role> [tenantId]');
  console.error('  role válido: admin | chef | manager');
  console.error(`  tenantId por defecto: ${DEFAULT_TENANT}`);
  process.exit(1);
}
if (!VALID_ROLES.includes(role)) {
  console.error(`Role inválido: "${role}". Debe ser uno de: ${VALID_ROLES.join(', ')}`);
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
  // Conserva cualquier otro claim existente y fija/actualiza role.
  const existing = user.customClaims || {};
  await auth.setCustomUserClaims(user.uid, { ...existing, role, tenantId });
  console.log(
    `✓ Claims asignados: ${email} (uid ${user.uid}) → role="${role}", tenantId="${tenantId}"`,
  );
  console.log('  Nota: el usuario debe cerrar y volver a iniciar sesión (o refrescar');
  console.log('  el idToken) para que el nuevo claim surta efecto.');
  process.exit(0);
} catch (err) {
  console.error(`✗ Error asignando el claim a ${email}:`);
  console.error(`  ${err?.code || ''} ${err?.message || err}`);
  process.exit(1);
}
