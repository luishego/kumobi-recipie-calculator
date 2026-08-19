// Endpoint de sesión (HU-01) — edge-native (sin firebase-admin).
//  POST  { idToken }  → verifica el ID token de Firebase (certs de Google) y
//                       acuña NUESTRA cookie de sesión (HS256, SESSION_SECRET).
//  DELETE            → borra la cookie (logout).
import type { APIRoute } from 'astro';
import {
  verifyFirebaseIdToken,
  mintSessionToken,
  readEnv,
} from '../../lib/session';
import { SESSION_COOKIE } from '../../lib/constants';

const DEFAULT_MAX_AGE_MS = 60 * 60 * 24 * 5 * 1000; // 5 días

function maxAgeMs(locals: unknown): number {
  const raw = readEnv(locals, 'SESSION_COOKIE_MAX_AGE_MS');
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGE_MS;
}

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  let idToken: string | undefined;
  try {
    const body = await request.json();
    idToken = body?.idToken;
  } catch {
    return json({ error: 'Cuerpo inválido.' }, 400);
  }
  if (!idToken) return json({ error: 'Falta idToken.' }, 400);

  const secret = readEnv(locals, 'SESSION_SECRET');
  if (!secret) {
    console.error('[api/session] Falta SESSION_SECRET en el entorno.');
    return json({ error: 'Configuración del servidor incompleta.' }, 500);
  }
  // projectId es público (mismo que la config del cliente), disponible en build.
  const projectId = import.meta.env.PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) {
    console.error('[api/session] Falta PUBLIC_FIREBASE_PROJECT_ID.');
    return json({ error: 'Configuración del servidor incompleta.' }, 500);
  }

  const expiresInMs = maxAgeMs(locals);

  try {
    const user = await verifyFirebaseIdToken(idToken, projectId);
    const token = await mintSessionToken(user, secret, Math.floor(expiresInMs / 1000));

    cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: import.meta.env.PROD,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(expiresInMs / 1000),
    });

    return json({ ok: true }, 200);
  } catch (err) {
    console.error('[api/session] verificación/acuñación falló:', err);
    return json({ error: 'No se pudo crear la sesión.' }, 401);
  }
};

export const DELETE: APIRoute = async ({ cookies }) => {
  cookies.delete(SESSION_COOKIE, { path: '/' });
  return json({ ok: true }, 200);
};

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
