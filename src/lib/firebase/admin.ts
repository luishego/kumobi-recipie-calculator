// Firebase Admin SDK (servidor). Solo se importa desde código SSR/endpoints.
// Crea y verifica las cookies de sesión. Requiere credenciales de cuenta de servicio.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeApp,
  getApps,
  getApp,
  cert,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';

let adminApp: App | undefined;

function normalizePrivateKey(key: string | undefined): string {
  // Las variables de entorno guardan la clave con \n literales.
  return (key ?? '').replace(/\\n/g, '\n');
}

/**
 * Resuelve las credenciales de la cuenta de servicio en dos modos (en este orden):
 *  1. Archivo JSON: FIREBASE_ADMIN_CREDENTIALS_FILE=ruta/al/serviceAccount.json
 *     (recomendado: el secreto vive solo en disco, ignorado por git).
 *  2. Variables sueltas: FIREBASE_ADMIN_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY.
 */
function resolveServiceAccount(): ServiceAccount {
  const credFile = import.meta.env.FIREBASE_ADMIN_CREDENTIALS_FILE;
  if (credFile) {
    const abs = resolve(process.cwd(), credFile);
    let raw: string;
    try {
      raw = readFileSync(abs, 'utf8');
    } catch {
      throw new Error(
        `No se pudo leer el archivo de credenciales Admin en "${abs}" ` +
          '(FIREBASE_ADMIN_CREDENTIALS_FILE). Verifica la ruta.',
      );
    }
    const json = JSON.parse(raw) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
    if (!json.project_id || !json.client_email || !json.private_key) {
      throw new Error(
        'El JSON de cuenta de servicio no tiene project_id / client_email / private_key.',
      );
    }
    return {
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey: normalizePrivateKey(json.private_key),
    };
  }

  const projectId = import.meta.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = import.meta.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(import.meta.env.FIREBASE_ADMIN_PRIVATE_KEY);

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Faltan credenciales de Firebase Admin. Usa FIREBASE_ADMIN_CREDENTIALS_FILE ' +
        '(ruta al JSON de cuenta de servicio) o las tres variables ' +
        'FIREBASE_ADMIN_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY. Revisa tu .env.',
    );
  }
  return { projectId, clientEmail, privateKey };
}

export function getAdminApp(): App {
  if (adminApp) return adminApp;
  if (getApps().length) {
    adminApp = getApp();
    return adminApp;
  }

  adminApp = initializeApp({
    credential: cert(resolveServiceAccount()),
  });
  return adminApp;
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}
