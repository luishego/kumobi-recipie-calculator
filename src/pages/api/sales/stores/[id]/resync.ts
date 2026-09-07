// Re-sincronización manual de un rango — épica 02, HU-15.
//
//   POST /api/sales/stores/:id/resync   { desde: "YYYY-MM-DD", hasta: "YYYY-MM-DD" }
//
// Va por SUCURSAL y no por cuenta, a diferencia de "Sincronizar ahora": tapar un
// hueco es una reparación puntual, y disparar la re-descarga de todas las
// sucursales de una cuenta gastaría cuota del proveedor y de D1 en sucursales
// que no tienen ningún problema.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import type { R2Bucket } from '@cloudflare/workers-types';
import { LoyverseAdapter } from '../../../../../lib/sales/loyverse/adapter';
import { decryptToken } from '../../../../../lib/sales/crypto';
import { runManualRange } from '../../../../../lib/sales/sync/manual';
import { resolveTenantId } from '../../../../../lib/sales/tenant';
import {
  HttpError, errorResponse, getDb, getMasterKey, getRepo, json, readJson, requireUser,
} from '../../../../../lib/sales/server';

export const prerender = false;

/** Tope del rango en días. Ver el comentario del refine. */
const MAX_DIAS = 92;

const Rango = z
  .object({
    desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha inicial debe ser YYYY-MM-DD.'),
    hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha final debe ser YYYY-MM-DD.'),
  })
  .refine((r) => r.desde <= r.hasta, {
    message: 'La fecha inicial es posterior a la final.',
    path: ['desde'],
  })
  .refine(
    (r) =>
      (Date.parse(`${r.hasta}T00:00:00Z`) - Date.parse(`${r.desde}T00:00:00Z`)) / 86_400_000 <
      MAX_DIAS,
    {
      // HU-15 es para tapar huecos, no para rehacer el histórico: eso es el
      // backfill, que sí es reanudable y lleva presupuesto por corrida. Un
      // rango enorme aquí correría sin cursor persistido y se toparía con la
      // cuota a mitad, dejando el trabajo sin terminar y sin dónde retomarlo.
      message: `El rango no puede pasar de ${MAX_DIAS} días. Para más, usa la descarga de histórico.`,
      path: ['hasta'],
    },
  );

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = requireUser(locals);
    const repo = getRepo(locals);
    const db = getDb(locals);
    const bucket = (locals.runtime?.env as Record<string, unknown> | undefined)
      ?.kumobi_ventas_raw as R2Bucket | undefined;

    // Mismo `decodeURIComponent` defensivo que `stores/[id].ts`: Astro no
    // decodifica los parámetros de ruta, y este id viaja en la URL.
    const storeId = params.id ? decodeURIComponent(params.id) : undefined;
    if (!storeId) throw new HttpError(400, 'Falta el identificador de la sucursal.');

    const parsed = Rango.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Rango inválido.');
    }
    const { desde, hasta } = parsed.data;

    const sucursal = (await repo.listStores()).find((s) => s.id === storeId);
    if (!sucursal) throw new HttpError(404, 'La sucursal no existe.');

    const cuenta = (await repo.listAccounts()).find((a) => a.id === sucursal.accountId);
    if (!cuenta) throw new HttpError(404, 'La cuenta de la sucursal no existe.');
    if (cuenta.status !== 'ACTIVE') {
      throw new HttpError(409, 'La cuenta requiere reconexión antes de re-sincronizar.');
    }

    const cifrado = await repo.getAccountCipher(cuenta.id);
    if (!cifrado) throw new HttpError(404, 'La cuenta no tiene credenciales guardadas.');
    const token = await decryptToken(cifrado, await getMasterKey(locals));

    const resultado = await runManualRange(
      { provider: new LoyverseAdapter({ token }), repo, db, bucket },
      {
        tenantId: resolveTenantId(user),
        account: { id: cuenta.id, provider: 'loyverse' },
        store: {
          id: sucursal.id,
          providerStoreId: sucursal.providerStoreId,
          timezone: sucursal.timezone,
          businessDayOffsetMinutes: sucursal.businessDayOffsetMinutes,
        },
        rango: { desde, hasta },
        // Quién la disparó queda en la bitácora (HU-15). El uid sale de la
        // sesión, nunca del cuerpo de la petición.
        triggeredBy: user.uid,
      },
    );

    // Un token revocado se detecta igual que en el incremental: la cuenta pasa
    // a INVALID_TOKEN para que HU-13 lo muestre y el cron deje de intentarlo.
    if (resultado.errorCode === 'INVALID_TOKEN') {
      await repo.markAccountInvalid(cuenta.id, new Date().toISOString());
    }

    return json({ sucursal: sucursal.name, rango: { desde, hasta }, ...resultado });
  } catch (err) {
    return errorResponse(err);
  }
};
