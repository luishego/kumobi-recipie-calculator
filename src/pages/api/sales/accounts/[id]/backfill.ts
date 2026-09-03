// Descarga inicial del histórico, disparada a mano — épica 02, HU-08.
//
//   POST /api/sales/accounts/:id/backfill
//
// Corre el backfill de todas las sucursales ACTIVAS de la cuenta, en serie: el
// límite de solicitudes de Loyverse es por token, así que paralelizar sucursales
// de la misma cuenta solo serviría para chocar contra él.
//
// Se ejecuta dentro de la petición. Para una cuenta grande eso puede no alcanzar
// a terminar, y no pasa nada: el backfill es reanudable, así que volver a pulsar
// continúa donde quedó. La corrida automática llega en la fase 5.
import type { APIRoute } from 'astro';
import { LoyverseAdapter } from '../../../../../lib/sales/loyverse/adapter';
import { SalesProviderError } from '../../../../../lib/sales/provider';
import { decryptToken } from '../../../../../lib/sales/crypto';
import { runBackfill, type BackfillResult } from '../../../../../lib/sales/sync/backfill';
import { resolveTenantId } from '../../../../../lib/sales/tenant';
import {
  HttpError, errorResponse, getDb, getMasterKey, getRepo, json, requireUser,
} from '../../../../../lib/sales/server';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
  try {
    const user = requireUser(locals);
    const repo = getRepo(locals);
    const db = getDb(locals);
    const bucket = (locals.runtime?.env as Record<string, unknown> | undefined)
      ?.kumobi_ventas_raw as import('@cloudflare/workers-types').R2Bucket | undefined;

    const accountId = params.id;
    if (!accountId) throw new HttpError(400, 'Falta el identificador de la cuenta.');

    const cuenta = (await repo.listAccounts()).find((a) => a.id === accountId);
    if (!cuenta) throw new HttpError(404, 'La cuenta no existe.');
    if (cuenta.status !== 'ACTIVE') {
      throw new HttpError(
        409,
        'La cuenta no está activa. Reconéctala con un token válido antes de descargar el histórico.',
      );
    }

    const cifrado = await repo.getAccountCipher(accountId);
    if (!cifrado) throw new HttpError(404, 'La cuenta no tiene credenciales guardadas.');
    const token = await decryptToken(cifrado, await getMasterKey(locals));

    const sucursales = (await repo.listStores(accountId)).filter((s) => s.active);
    if (!sucursales.length) {
      throw new HttpError(409, 'La cuenta no tiene sucursales activas que sincronizar.');
    }

    const provider = new LoyverseAdapter({ token });
    const tenantId = resolveTenantId(user);
    const resultados: Array<{ store: string; nombre: string } & BackfillResult> = [];

    for (const s of sucursales) {
      const r = await runBackfill(
        { provider, repo, db, bucket },
        {
          tenantId,
          account: {
            id: cuenta.id,
            provider: 'loyverse',
            backfillMaxDays: cuenta.backfillMaxDays,
          },
          store: {
            id: s.id,
            providerStoreId: s.providerStoreId,
            timezone: s.timezone,
            businessDayOffsetMinutes: s.businessDayOffsetMinutes,
          },
        },
        { triggeredBy: user.uid },
      );
      resultados.push({ store: s.id, nombre: s.name, ...r });

      // Si el token dejó de servir, no tiene sentido seguir con las demás.
      if (r.outcome === 'FAILED' && r.error?.includes('credenciales')) {
        await repo.markAccountInvalid(accountId, new Date().toISOString());
        break;
      }
    }

    return json({ resultados });
  } catch (err) {
    if (err instanceof SalesProviderError) {
      return errorResponse(new HttpError(502, err.message, err.code));
    }
    return errorResponse(err);
  }
};
