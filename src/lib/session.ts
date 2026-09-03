// Sesión edge-native (sin firebase-admin) — compatible con el runtime de
// Cloudflare (Web Crypto vía `jose`).
//
// Flujo:
//  1. El cliente inicia sesión con Firebase Auth y obtiene un ID token (RS256,
//     firmado por Google).
//  2. `verifyFirebaseIdToken` valida ese ID token contra los certificados
//     públicos x509 de Google (issuer/audience = projectId) y extrae uid/email/role.
//  3. `mintSessionToken` acuña NUESTRA cookie de sesión (HS256, firmada con
//     SESSION_SECRET) con la expiración que definamos.
//  4. El middleware verifica esa cookie con `verifySessionToken` en cada request.
//
// Nota: no hay verificación de revocación (a diferencia de createSessionCookie).
// Aceptable para herramienta interna; las Firestore Rules siguen exigiendo el rol.

import { SignJWT, jwtVerify, importX509, decodeProtectedHeader } from 'jose';

export interface SessionUser {
  uid: string;
  email: string | null;
  role: string | null;
  /**
   * Inquilino al que pertenece el usuario (épica 02 §5.8).
   *
   * `null` significa "la sesión no lo trae": o el usuario aún no tiene el claim,
   * o la cookie se acuñó antes de que este campo existiera. Quien necesite un
   * inquilino concreto debe pasar por `resolveTenantId` (src/lib/sales/tenant.ts),
   * que aplica el periodo de gracia; aquí se refleja la realidad sin maquillarla.
   */
  tenantId: string | null;
}

/** Lee una variable de entorno en Cloudflare (runtime) o en dev/build (import.meta.env). */
export function readEnv(locals: unknown, key: string): string | undefined {
  const rt = (locals as { runtime?: { env?: Record<string, unknown> } } | undefined)?.runtime
    ?.env?.[key];
  if (typeof rt === 'string' && rt) return rt;
  const im = (import.meta.env as Record<string, unknown>)?.[key];
  if (typeof im === 'string' && im) return im;
  return undefined;
}

// ── Verificación del ID token de Firebase (RS256, certs de Google) ───────────
const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certsCache: { certs: Record<string, string>; exp: number } | null = null;

async function getGoogleCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certsCache && now < certsCache.exp) return certsCache.certs;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error(`No se pudieron obtener los certificados de Google (${res.status})`);
  const certs = (await res.json()) as Record<string, string>;
  const cc = res.headers.get('cache-control') ?? '';
  const m = cc.match(/max-age=(\d+)/);
  const ttl = m ? Number(m[1]) * 1000 : 3600 * 1000;
  certsCache = { certs, exp: now + ttl };
  return certs;
}

/**
 * Valida un ID token de Firebase. Lanza si es inválido/expirado o el issuer/
 * audience no corresponde a `projectId`. Devuelve el usuario con sus claims.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
): Promise<SessionUser> {
  const header = decodeProtectedHeader(idToken);
  if (!header.kid) throw new Error('ID token sin kid');
  const certs = await getGoogleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('kid del ID token no está en los certificados de Google');

  const key = await importX509(pem, 'RS256');
  const { payload } = await jwtVerify(idToken, key, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ['RS256'],
  });
  if (!payload.sub) throw new Error('ID token sin sub (uid)');

  return {
    uid: payload.sub,
    email: (payload.email as string | undefined) ?? null,
    role: (payload.role as string | undefined) ?? null,
    tenantId: (payload.tenantId as string | undefined) ?? null,
  };
}

// ── Cookie de sesión propia (HS256, SESSION_SECRET) ──────────────────────────
function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Acuña la cookie de sesión (JWT HS256) con la expiración indicada. */
export async function mintSessionToken(
  user: SessionUser,
  secret: string,
  maxAgeSec: number,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return await new SignJWT({ email: user.email, role: user.role, tenantId: user.tenantId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.uid)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + maxAgeSec)
    .sign(secretKey(secret));
}

/** Verifica la cookie de sesión. Devuelve el usuario o null si es inválida. */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      algorithms: ['HS256'],
    });
    if (!payload.sub) return null;
    return {
      uid: payload.sub,
      email: (payload.email as string | undefined) ?? null,
      role: (payload.role as string | undefined) ?? null,
      // Las cookies acuñadas antes de la épica 02 no traen este campo. Se leen
      // como `null` en vez de rechazarse: invalidar todas las sesiones vivas al
      // desplegar sacaría del panel a quien estuviera trabajando.
      tenantId: (payload.tenantId as string | undefined) ?? null,
    };
  } catch {
    return null;
  }
}
