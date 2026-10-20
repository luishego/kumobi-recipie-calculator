// ─────────────────────────────────────────────────────────────────────────
// Lista las cuentas de Firebase Auth con sus Custom Claims.
// SOLO LECTURA: no escribe nada, nunca.
//
//   node scripts/list-users.mjs
//
// Para qué: responder "¿quién tiene acceso a qué?" sin entrar a la consola.
// La columna ENTRA_AL_MENU aplica la misma regla que el guard del panel del
// menú (épica 04 §5.4): claim `menuAdmin: true`, o `role` dentro de
// MENU_ADMIN_ROLES, que por defecto es solo `admin`.
//
// Fuente de credenciales, igual que set-claim.mjs:
//   1) FIREBASE_ADMIN_CREDENTIALS_FILE (ruta al JSON)  — si no, ...
//   2) ./secrets/serviceAccount.json  (ubicación por defecto)
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/** Debe coincidir con el default de MENU_ADMIN_ROLES en kumobi-menu. */
const MENU_ADMIN_ROLES = (process.env.MENU_ADMIN_ROLES ?? 'admin')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

const { users } = await getAuth().listUsers(1000);

console.log(`\nProyecto: ${serviceAccount.project_id}`);
console.log(`Cuentas: ${users.length}`);
console.log(`Regla de acceso al menú: menuAdmin=true  |  role ∈ [${MENU_ADMIN_ROLES.join(', ')}]\n`);

const rows = users.map((u) => {
  const c = u.customClaims ?? {};
  const permitido =
    c.menuAdmin === true || (typeof c.role === 'string' && MENU_ADMIN_ROLES.includes(c.role));
  return {
    correo: u.email ?? '(sin correo)',
    rol: c.role ?? '—',
    tenant: c.tenantId ?? '—',
    menuAdmin: c.menuAdmin === true ? 'sí' : '—',
    deshabilitada: u.disabled ? 'SÍ' : 'no',
    ultimoAcceso: u.metadata.lastSignInTime
      ? new Date(u.metadata.lastSignInTime).toISOString().slice(0, 10)
      : 'nunca',
    ENTRA_AL_MENU: u.disabled ? 'no (deshabilitada)' : permitido ? '>>> SÍ <<<' : 'no',
  };
});

console.table(rows);

// Claims que no conocemos: avisar, porque un script de escritura que los
// perdiera rompería algo que nadie está mirando.
const extras = users
  .map((u) => ({
    email: u.email,
    extra: Object.keys(u.customClaims ?? {}).filter(
      (k) => !['role', 'tenantId', 'menuAdmin'].includes(k),
    ),
  }))
  .filter((x) => x.extra.length);
if (extras.length) {
  console.log('\nClaims adicionales (se conservan al escribir):');
  for (const x of extras) console.log(`  ${x.email}: ${x.extra.join(', ')}`);
}

const entran = rows.filter((r) => r.ENTRA_AL_MENU === '>>> SÍ <<<');
console.log(`\n→ Hoy entrarían al panel del menú: ${entran.length} de ${users.length}`);
for (const r of entran) {
  const via = r.menuAdmin === 'sí' ? 'claim menuAdmin' : `rol "${r.rol}"`;
  console.log(`   · ${r.correo} (por ${via})`);
}
console.log();
