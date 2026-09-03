// Guard de sesión SSR (HU-01) — edge-native (sin firebase-admin).
// Verifica NUESTRA cookie de sesión (HS256) en cada request a rutas privadas.
// Sin cookie válida → redirección a /login. Nunca se renderiza contenido
// privado antes de validar la sesión.
import { defineMiddleware } from 'astro:middleware';
import { verifySessionToken, readEnv } from './lib/session';
import { SESSION_COOKIE, PRIVATE_PATHS } from './lib/constants';

function isPrivate(pathname: string): boolean {
  return PRIVATE_PATHS.some(
    (p) => pathname === p || (p !== '/' && pathname.startsWith(p + '/')),
  );
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, cookies, locals, redirect } = context;
  const pathname = url.pathname;

  locals.user = null;

  const cookie = cookies.get(SESSION_COOKIE)?.value;
  const secret = readEnv(locals, 'SESSION_SECRET');

  if (cookie && secret) {
    const user = await verifySessionToken(cookie, secret);
    if (user) {
      locals.user = user;
    } else {
      // Cookie inválida o expirada: se limpia y se trata como no autenticado.
      cookies.delete(SESSION_COOKIE, { path: '/' });
    }
  }

  // Usuario autenticado que visita /login → mándalo al dashboard.
  if (pathname === '/login' && locals.user) {
    return redirect('/');
  }

  // Ruta privada sin sesión.
  if (isPrivate(pathname) && !locals.user) {
    // La API responde JSON, no redirección: un `fetch` desde una isla seguiría
    // el 302, recibiría el HTML del login y fallaría al parsear, mostrando un
    // error incomprensible en vez de "tu sesión expiró".
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Sesión requerida.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    return redirect('/login');
  }

  return next();
});
