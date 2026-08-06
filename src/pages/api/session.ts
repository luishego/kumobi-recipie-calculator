// Endpoint de sesión (HU-01).
//  POST  { idToken }  → intercambia el idToken por una session cookie (Admin SDK).
//  DELETE            → borra la cookie (logout).
import type { APIRoute } from 'astro';
import { getAdminAuth } from '../../lib/firebase/admin';
import { SESSION_COOKIE } from '../../lib/constants';

const DEFAULT_MAX_AGE_MS = 60 * 60 * 24 * 5 * 1000; // 5 días

function maxAgeMs(): number {
  const raw = import.meta.env.SESSION_COOKIE_MAX_AGE_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGE_MS;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  let idToken: string | undefined;
  try {
    const body = await request.json();
    idToken = body?.idToken;
  } catch {
    return json({ error: 'Cuerpo inválido.' }, 400);
  }

  if (!idToken) {
    return json({ error: 'Falta idToken.' }, 400);
  }

  const expiresIn = maxAgeMs();

  try {
    const auth = getAdminAuth();
    // Verifica el idToken antes de acuñar la cookie (revoca sesiones deshabilitadas).
    await auth.verifyIdToken(idToken, true);
    const sessionCookie = await auth.createSessionCookie(idToken, { expiresIn });

    cookies.set(SESSION_COOKIE, sessionCookie, {
      httpOnly: true,
      secure: import.meta.env.PROD,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(expiresIn / 1000),
    });

    return json({ ok: true }, 200);
  } catch (err) {
    console.error('[api/session] createSessionCookie falló:', err);
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
