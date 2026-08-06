// Guard de sesión SSR (HU-01). Verifica la cookie de sesión (Admin SDK) en cada
// request a rutas privadas. Sin cookie válida → redirección a /login.
// Nunca se renderiza contenido privado antes de validar la sesión.
import { defineMiddleware } from 'astro:middleware';
import { getAdminAuth } from './lib/firebase/admin';
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

  const sessionCookie = cookies.get(SESSION_COOKIE)?.value;

  if (sessionCookie) {
    try {
      const decoded = await getAdminAuth().verifySessionCookie(sessionCookie, true);
      locals.user = {
        uid: decoded.uid,
        email: decoded.email ?? null,
        role: (decoded.role as string | undefined) ?? null,
      };
    } catch {
      // Cookie inválida o expirada: se limpia y se trata como no autenticado.
      cookies.delete(SESSION_COOKIE, { path: '/' });
      locals.user = null;
    }
  }

  // Usuario autenticado que visita /login → mándalo al dashboard.
  if (pathname === '/login' && locals.user) {
    return redirect('/');
  }

  // Ruta privada sin sesión → login.
  if (isPrivate(pathname) && !locals.user) {
    return redirect('/login');
  }

  return next();
});
