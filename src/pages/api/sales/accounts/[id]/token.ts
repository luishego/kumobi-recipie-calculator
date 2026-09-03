// Rotación del token de una cuenta — épica 02, HU-06 y HU-13.
//
//   PUT /api/sales/accounts/:id/token   → valida el token nuevo y lo reemplaza
//
// Rotar NO pierde sucursales, tickets ni checkpoints: es el camino de vuelta
// cuando una cuenta quedó en INVALID_TOKEN, y la siguiente sincronización
// recupera el rango perdido desde el checkpoint intacto.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { LoyverseAdapter } from '../../../../../lib/sales/loyverse/adapter';
import { SalesProviderError } from '../../../../../lib/sales/provider';
import { encryptToken, tokenLast4 } from '../../../../../lib/sales/crypto';
import {
  HttpError, errorResponse, getMasterKey, getRepo, json, readJson,
} from '../../../../../lib/sales/server';

export const prerender = false;

const Rotacion = z.object({
  token: z.string().trim().min(8, 'El token parece demasiado corto.'),
});

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    const repo = getRepo(locals);
    const accountId = params.id;
    if (!accountId) throw new HttpError(400, 'Falta el identificador de la cuenta.');

    const existente = (await repo.listAccounts()).find((a) => a.id === accountId);
    if (!existente) throw new HttpError(404, 'La cuenta no existe.');

    const parsed = Rotacion.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    }
    const { token } = parsed.data;

    try {
      await new LoyverseAdapter({ token }).validateCredentials();
    } catch (err) {
      if (err instanceof SalesProviderError && err.code === 'INVALID_TOKEN') {
        throw new HttpError(
          400,
          'Loyverse rechazó ese token. La cuenta conserva el anterior.',
          'INVALID_TOKEN',
        );
      }
      console.error('[api/sales/accounts/:id/token] fallo al validar el token:', err);
      const detalle = err instanceof SalesProviderError ? ` ${err.message}` : '';
      throw new HttpError(502, `No se pudo contactar a Loyverse para validar el token.${detalle}`);
    }

    const key = await getMasterKey(locals);
    const cifrado = await encryptToken(token, key);
    const now = new Date().toISOString();

    // `upsertAccount` sobre el mismo id conserva alias y configuración, cambia
    // las credenciales y devuelve la cuenta a ACTIVE.
    await repo.upsertAccount(
      {
        id: accountId,
        provider: 'loyverse',
        alias: existente.alias,
        tokenCiphertext: cifrado.ciphertext,
        tokenIv: cifrado.iv,
        tokenLast4: tokenLast4(token),
        defaultTimezone: existente.defaultTimezone,
        backfillMaxDays: existente.backfillMaxDays,
      },
      now,
    );

    return json({ ok: true, tokenLast4: tokenLast4(token), status: 'ACTIVE' });
  } catch (err) {
    return errorResponse(err);
  }
};
