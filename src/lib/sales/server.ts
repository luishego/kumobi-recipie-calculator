// Utilidades de servidor para los endpoints de ventas — épica 02, fase 3.
//
// Concentra tres cosas que si se repiten en cada endpoint terminan divergiendo:
// obtener los bindings con un error claro cuando faltan, exigir sesión, y
// resolver el inquilino. El `tenantId` sale SIEMPRE de la sesión (§5.8).

import type { D1Database } from '@cloudflare/workers-types';
import { createRepo, type SalesRepo } from './repo';
import { resolveTenantId } from './tenant';
import { importMasterKey } from './crypto';

/** Error con estado HTTP, para responder sin `try/catch` anidados. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type Locals = App.Locals;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Convierte cualquier fallo en una respuesta JSON con estado adecuado. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message, code: err.code }, err.status);
  }
  console.error('[api/sales] error no controlado:', err);
  return json({ error: 'Error interno del servidor.' }, 500);
}

/** Sesión obligatoria. El middleware ya protege las páginas; esto cubre la API. */
export function requireUser(locals: Locals) {
  if (!locals.user) throw new HttpError(401, 'Sesión requerida.');
  return locals.user;
}

function binding<T>(locals: Locals, name: string): T {
  const value = (locals.runtime?.env as Record<string, unknown> | undefined)?.[name];
  if (!value) {
    throw new HttpError(
      500,
      `Falta el binding "${name}". En local requiere \`platformProxy\` habilitado ` +
        `en astro.config.mjs; en Cloudflare, la entrada correspondiente en wrangler.jsonc.`,
      'BINDING_MISSING',
    );
  }
  return value as T;
}

export function getDb(locals: Locals): D1Database {
  return binding<D1Database>(locals, 'kumobi_ventas');
}

/** Repositorio ya acotado al inquilino de la sesión. */
export function getRepo(locals: Locals): SalesRepo {
  const user = requireUser(locals);
  return createRepo(getDb(locals), resolveTenantId(user));
}

/** Llave maestra de cifrado. Es el único punto que la lee del entorno. */
export async function getMasterKey(locals: Locals): Promise<CryptoKey> {
  const raw =
    ((locals.runtime?.env as Record<string, unknown> | undefined)?.SALES_TOKEN_KEY as
      | string
      | undefined) ?? (import.meta.env.SALES_TOKEN_KEY as string | undefined);
  return importMasterKey(raw);
}

/** Cuerpo JSON o 400 con mensaje legible. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'El cuerpo de la petición no es JSON válido.');
  }
}
