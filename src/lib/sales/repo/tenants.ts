// Acceso entre inquilinos — LA ÚNICA EXCEPCIÓN al aislamiento de §5.8.
//
// El job de sincronización corre desde un Cron Trigger, sin sesión y sin
// inquilino: tiene que recorrerlos todos. En vez de debilitar `createRepo`
// —que se niega a construirse sin `tenantId` y es lo que garantiza que ningún
// endpoint pueda olvidar el filtro— la excepción vive aquí, sola, con nombre
// explícito y documentada.
//
// Regla: este módulo NO debe importarse desde `src/pages/`. Lo que sirve a una
// petición HTTP siempre tiene sesión, y por lo tanto inquilino.

import type { D1Database } from '@cloudflare/workers-types';

export async function listAllTenantIds(db: D1Database): Promise<string[]> {
  const res = await db
    .prepare(`SELECT id FROM tenants WHERE status = 'ACTIVE' ORDER BY id`)
    .all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}
