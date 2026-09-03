// Re-sincronización de sucursales — épica 02, HU-07.
//
//   POST /api/sales/accounts/:id/stores   → vuelve a leer las sucursales del POS
//
// Agrega las nuevas y marca inactivas las que ya no existen allá. Nunca borra:
// los tickets históricos de una sucursal cerrada siguen siendo válidos y sus
// totales tienen que seguir cuadrando.
import type { APIRoute } from 'astro';
import { LoyverseAdapter } from '../../../../../lib/sales/loyverse/adapter';
import { SalesProviderError } from '../../../../../lib/sales/provider';
import { decryptToken } from '../../../../../lib/sales/crypto';
import {
  HttpError, errorResponse, getMasterKey, getRepo, json,
} from '../../../../../lib/sales/server';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
  try {
    const repo = getRepo(locals);
    const accountId = params.id;
    if (!accountId) throw new HttpError(400, 'Falta el identificador de la cuenta.');

    const cuenta = (await repo.listAccounts()).find((a) => a.id === accountId);
    if (!cuenta) throw new HttpError(404, 'La cuenta no existe.');

    const cifrado = await repo.getAccountCipher(accountId);
    if (!cifrado) throw new HttpError(404, 'La cuenta no tiene credenciales guardadas.');

    const key = await getMasterKey(locals);
    // Si la llave no corresponde, el mensaje del error lo dice explícitamente.
    const token = await decryptToken(cifrado, key);

    const now = new Date().toISOString();
    try {
      const encontradas = await new LoyverseAdapter({ token }).listStores();
      const res = await repo.syncStores(
        accountId, 'loyverse', encontradas,
        { timezone: cuenta.defaultTimezone }, now,
      );
      return json({
        ...res,
        cupo: await repo.cupoSucursales(),
        stores: await repo.listStores(accountId),
      });
    } catch (err) {
      if (err instanceof SalesProviderError && err.code === 'INVALID_TOKEN') {
        // El token dejó de servir: la cuenta queda marcada y visible (HU-13).
        await repo.markAccountInvalid(accountId, now);
        throw new HttpError(
          400,
          'Loyverse rechazó el token guardado. La cuenta quedó marcada como ' +
            '"requiere reconexión": captura un token nuevo para reactivarla.',
          'INVALID_TOKEN',
        );
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
};
