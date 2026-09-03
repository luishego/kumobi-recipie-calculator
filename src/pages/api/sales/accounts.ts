// Cuentas conectadas de POS — épica 02, HU-06 y HU-07.
//
//   GET   /api/sales/accounts   → cuentas del inquilino, con sus sucursales
//   POST  /api/sales/accounts   → alta: valida el token, lo cifra y descubre sucursales
//
// El token viaja en el POST y NUNCA vuelve: de ahí en adelante la UI solo ve
// sus últimos 4 caracteres.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { LoyverseAdapter } from '../../../lib/sales/loyverse/adapter';
import { SalesProviderError } from '../../../lib/sales/provider';
import { encryptToken, tokenLast4 } from '../../../lib/sales/crypto';
import { storeId as makeStoreId } from '../../../lib/sales/repo/ids';
import {
  HttpError, errorResponse, getMasterKey, getRepo, json, readJson,
} from '../../../lib/sales/server';

export const prerender = false;

const AltaCuenta = z.object({
  alias: z.string().trim().min(1, 'El alias es obligatorio.').max(80),
  token: z.string().trim().min(8, 'El token parece demasiado corto.'),
  defaultTimezone: z.string().trim().min(1).default('America/Mexico_City'),
  // null = sin tope, todo el histórico (es como opera Kumobi).
  backfillMaxDays: z.number().int().positive().max(3650).nullable().default(30),
});

export const GET: APIRoute = async ({ locals }) => {
  try {
    const repo = getRepo(locals);
    const [accounts, stores] = await Promise.all([repo.listAccounts(), repo.listStores()]);

    // Estado de sincronización por sucursal: es lo que permite ver de un vistazo
    // si alguna dejó de sincronizar (HU-14).
    const estados = await Promise.all(
      stores.map(async (s) => [s.id, await repo.getSyncState(s.id)] as const),
    );
    const porSucursal = new Map(estados);

    return json({
      cupo: await repo.cupoSucursales(),
      accounts: accounts.map((a) => ({
        ...a,
        stores: stores
          .filter((s) => s.accountId === a.id)
          .map((s) => ({ ...s, sync: porSucursal.get(s.id) ?? null })),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const repo = getRepo(locals);
    const parsed = AltaCuenta.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    }
    const { alias, token, defaultTimezone, backfillMaxDays } = parsed.data;

    // 1. Validar ANTES de persistir: si el token no sirve, no se guarda nada.
    const adapter = new LoyverseAdapter({ token });
    try {
      await adapter.validateCredentials();
    } catch (err) {
      if (err instanceof SalesProviderError && err.code === 'INVALID_TOKEN') {
        throw new HttpError(
          400,
          'Loyverse rechazó ese token. Revisa que sea un token de acceso del Back Office ' +
            'y que siga vigente.',
          'INVALID_TOKEN',
        );
      }
      if (err instanceof SalesProviderError) {
        // Se conserva el detalle: un mensaje genérico aquí deja sin diagnóstico
        // al que tiene que arreglarlo.
        console.error('[api/sales/accounts] fallo al validar el token:', err);
        throw new HttpError(
          502,
          `No se pudo contactar a Loyverse para validar el token. ${err.message}`,
          err.code,
        );
      }
      throw err;
    }

    // 2. Cifrar y guardar. El token en claro no sale de esta función.
    const key = await getMasterKey(locals);
    const cifrado = await encryptToken(token, key);
    const now = new Date().toISOString();
    const accountId = crypto.randomUUID();

    await repo.upsertAccount(
      {
        id: accountId,
        provider: 'loyverse',
        alias,
        tokenCiphertext: cifrado.ciphertext,
        tokenIv: cifrado.iv,
        tokenLast4: tokenLast4(token),
        defaultTimezone,
        backfillMaxDays,
      },
      now,
    );

    // 3. Descubrir sucursales (HU-07): el administrador no las da de alta a mano.
    const encontradas = await adapter.listStores();
    const sync = await repo.syncStores(
      accountId, 'loyverse', encontradas, { timezone: defaultTimezone }, now,
    );

    return json(
      {
        // Sucursales que se guardaron INACTIVAS por falta de cupo: hay que
        // decirlo, o el administrador creería que se sincronizan.
        sinCupo: sync.sinCupo,
        cupo: await repo.cupoSucursales(),
        account: {
          id: accountId,
          alias,
          provider: 'loyverse',
          tokenLast4: tokenLast4(token),
          defaultTimezone,
          backfillMaxDays,
          status: 'ACTIVE',
          lastValidatedAt: now,
          stores: encontradas.map((s) => ({
            id: makeStoreId(accountId, s.providerStoreId),
            providerStoreId: s.providerStoreId,
            name: s.name,
            timezone: defaultTimezone,
            active: true,
          })),
        },
      },
      201,
    );
  } catch (err) {
    return errorResponse(err);
  }
};
