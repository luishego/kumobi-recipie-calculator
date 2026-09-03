// Sincronización incremental a demanda — épica 02, HU-09.
//
//   POST /api/sales/accounts/:id/sync
//
// Es la misma lógica que ejecuta el Cron Trigger cada noche, disparada a mano
// para una cuenta. Existe por dos razones:
//   · Poder comprobar el resultado sin esperar a la corrida nocturna.
//   · Recuperar cuanto antes tras arreglar algo —un token rotado, una caída del
//     proveedor— en vez de perder un día entero.
//
// Las sucursales se recorren en SERIE: el límite de solicitudes es por token.
import type { APIRoute } from 'astro';
import { LoyverseAdapter } from '../../../../../lib/sales/loyverse/adapter';
import { decryptToken } from '../../../../../lib/sales/crypto';
import { runIncremental } from '../../../../../lib/sales/sync/incremental';
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
      throw new HttpError(409, 'La cuenta requiere reconexión antes de sincronizar.');
    }

    const cifrado = await repo.getAccountCipher(accountId);
    if (!cifrado) throw new HttpError(404, 'La cuenta no tiene credenciales guardadas.');
    const token = await decryptToken(cifrado, await getMasterKey(locals));

    const provider = new LoyverseAdapter({ token });
    const tenantId = resolveTenantId(user);
    const sucursales = (await repo.listStores(accountId)).filter((s) => s.active);

    const resultados = [];
    for (const s of sucursales) {
      const r = await runIncremental(
        { provider, repo, db, bucket },
        {
          tenantId,
          account: { id: cuenta.id, provider: 'loyverse' },
          store: {
            id: s.id, providerStoreId: s.providerStoreId,
            timezone: s.timezone, businessDayOffsetMinutes: s.businessDayOffsetMinutes,
          },
        },
      );
      resultados.push({ store: s.id, nombre: s.name, ...r });

      if (r.errorCode === 'INVALID_TOKEN') {
        await repo.markAccountInvalid(accountId, new Date().toISOString());
        break;
      }
    }

    return json({ resultados });
  } catch (err) {
    return errorResponse(err);
  }
};
