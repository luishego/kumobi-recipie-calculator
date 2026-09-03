// Cuentas conectadas y sucursales — épica 02, HU-06/HU-07.
//
// Esta capa NO cifra ni descifra: recibe el token ya cifrado y lo guarda tal
// cual. El cifrado vive en `../crypto.ts` (fase 3), para que el único lugar que
// toca la llave maestra sea ese y no se disperse por el acceso a datos.

import type { D1Database } from '@cloudflare/workers-types';
import type { ProviderId, ProviderStore } from '../types';
import { storeId as makeStoreId } from './ids';

export interface AccountInput {
  id: string;
  provider: ProviderId;
  alias: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenLast4: string;
  defaultTimezone: string;
  /** 30 = default del producto; null = sin tope (Kumobi). */
  backfillMaxDays: number | null;
}

export interface StoreRow {
  id: string;
  accountId: string;
  provider: string;
  providerStoreId: string;
  name: string;
  timezone: string;
  businessDayOffsetMinutes: number;
  active: boolean;
}

const UPSERT_ACCOUNT = `
INSERT INTO sales_accounts (
  id, tenant_id, provider, alias, token_ciphertext, token_iv, token_last4,
  default_timezone, backfill_max_days, status, last_validated_at, created_at, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?)
ON CONFLICT (id) DO UPDATE SET
  alias             = excluded.alias,
  token_ciphertext  = excluded.token_ciphertext,
  token_iv          = excluded.token_iv,
  token_last4       = excluded.token_last4,
  default_timezone  = excluded.default_timezone,
  backfill_max_days = excluded.backfill_max_days,
  status            = 'ACTIVE',
  last_validated_at = excluded.last_validated_at,
  updated_at        = excluded.updated_at`;

const UPSERT_STORE = `
INSERT INTO sales_stores (
  id, tenant_id, account_id, provider, provider_store_id, name, timezone,
  business_day_offset_minutes, active, missing_in_provider_at, created_at, updated_at
) VALUES (?,?,?,?,?,?,?,0,?,NULL,?,?)
ON CONFLICT (account_id, provider_store_id) DO UPDATE SET
  name = excluded.name,
  -- Solo se reactiva lo que NOSOTROS desactivamos por haber desaparecido del
  -- POS. Si el administrador la desactivó a mano, re-sincronizar no debe
  -- deshacer su decisión.
  active = CASE
             WHEN sales_stores.missing_in_provider_at IS NOT NULL THEN excluded.active
             ELSE sales_stores.active
           END,
  missing_in_provider_at = NULL,
  updated_at = excluded.updated_at`;

export interface AccountRow {
  id: string;
  provider: string;
  alias: string;
  /** Lo ÚNICO del token que puede ver la UI. */
  tokenLast4: string;
  defaultTimezone: string;
  backfillMaxDays: number | null;
  status: 'ACTIVE' | 'INVALID_TOKEN' | 'DISABLED';
  lastValidatedAt: string | null;
}

export interface CupoSucursales {
  /** Máximo de sucursales ACTIVAS que admite el inquilino. */
  limite: number;
  activas: number;
  disponibles: number;
}

export function createStoresRepo(db: D1Database, tenantId: string) {
  /**
   * Cupo de sucursales activas — lo que sincroniza es lo que consume la base.
   *
   * Se cuenta lo ACTIVO, no lo descubierto: una sucursal inactiva no sincroniza.
   */
  async function cupoSucursales(): Promise<CupoSucursales> {
    const r = await db
      .prepare(
        `SELECT
           (SELECT max_active_stores FROM tenants WHERE id = ?1) AS limite,
           (SELECT count(*) FROM sales_stores WHERE tenant_id = ?1 AND active = 1) AS activas`,
      )
      .bind(tenantId)
      .first<{ limite: number | null; activas: number }>();

    const limite = r?.limite ?? 0;
    const activas = r?.activas ?? 0;
    return { limite, activas, disponibles: Math.max(0, limite - activas) };
  }

  return {
    cupoSucursales,

    /** Cuentas del inquilino. NUNCA devuelve el token, ni cifrado. */
    async listAccounts(): Promise<AccountRow[]> {
      const res = await db
        .prepare(
          `SELECT id, provider, alias, token_last4, default_timezone,
                  backfill_max_days, status, last_validated_at
             FROM sales_accounts WHERE tenant_id = ? ORDER BY alias`,
        )
        .bind(tenantId)
        .all<{
          id: string; provider: string; alias: string; token_last4: string;
          default_timezone: string; backfill_max_days: number | null;
          status: string; last_validated_at: string | null;
        }>();

      return (res.results ?? []).map((r) => ({
        id: r.id,
        provider: r.provider,
        alias: r.alias,
        tokenLast4: r.token_last4,
        defaultTimezone: r.default_timezone,
        backfillMaxDays: r.backfill_max_days,
        status: r.status as AccountRow['status'],
        lastValidatedAt: r.last_validated_at,
      }));
    },

    /**
     * Credenciales cifradas de una cuenta, para descifrarlas y llamar al POS.
     * Separado de `listAccounts` a propósito: lo que sale de aquí no debe
     * acercarse nunca a una respuesta HTTP.
     */
    async getAccountCipher(
      accountId: string,
    ): Promise<{ provider: string; ciphertext: string; iv: string } | null> {
      const row = await db
        .prepare(
          `SELECT provider, token_ciphertext, token_iv FROM sales_accounts
            WHERE id = ? AND tenant_id = ?`,
        )
        .bind(accountId, tenantId)
        .first<{ provider: string; token_ciphertext: string; token_iv: string }>();
      return row
        ? { provider: row.provider, ciphertext: row.token_ciphertext, iv: row.token_iv }
        : null;
    },

    /**
     * Activa o desactiva una sucursal sin desconectar la cuenta (HU-07).
     *
     * Activar consume cupo, así que es el punto donde el límite se hace valer:
     * sin esta comprobación bastaría con desactivar y volver a activar para
     * saltárselo.
     */
    async setStoreActive(
      storeIdValue: string,
      active: boolean,
      now: string,
    ): Promise<
      { ok: true; cupo: CupoSucursales } | { ok: false; motivo: 'NO_EXISTE' | 'SIN_CUPO'; cupo: CupoSucursales }
    > {
      const cupo = await cupoSucursales();

      if (active) {
        const actual = await db
          .prepare(`SELECT active FROM sales_stores WHERE id = ? AND tenant_id = ?`)
          .bind(storeIdValue, tenantId)
          .first<{ active: number }>();
        if (!actual) return { ok: false, motivo: 'NO_EXISTE', cupo };
        // Reactivar una que ya está activa no consume cupo nuevo.
        if (actual.active !== 1 && cupo.disponibles === 0) {
          return { ok: false, motivo: 'SIN_CUPO', cupo };
        }
      }

      const res = await db
        .prepare(
          `UPDATE sales_stores SET active = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?`,
        )
        .bind(active ? 1 : 0, now, storeIdValue, tenantId)
        .run();

      if ((res.meta?.changes ?? 0) === 0) return { ok: false, motivo: 'NO_EXISTE', cupo };
      return { ok: true, cupo: await cupoSucursales() };
    },

    /** Alta o rotación de credenciales de una cuenta. La deja ACTIVE. */
    async upsertAccount(a: AccountInput, now: string): Promise<void> {
      await db
        .prepare(UPSERT_ACCOUNT)
        .bind(
          a.id, tenantId, a.provider, a.alias, a.tokenCiphertext, a.tokenIv, a.tokenLast4,
          a.defaultTimezone, a.backfillMaxDays, now, now, now,
        )
        .run();
    },

    /** Marca una cuenta como no utilizable hasta que se reconecte (HU-13). */
    async markAccountInvalid(accountId: string, now: string): Promise<void> {
      await db
        .prepare(
          `UPDATE sales_accounts SET status='INVALID_TOKEN', updated_at=?
           WHERE id=? AND tenant_id=?`,
        )
        .bind(now, accountId, tenantId)
        .run();
    },

    /**
     * Sincroniza la lista de sucursales de una cuenta (HU-07).
     *
     * Las que ya no vienen del proveedor se MARCAN, nunca se borran: sus
     * tickets históricos siguen siendo válidos y sus totales tienen que seguir
     * cuadrando.
     */
    async syncStores(
      accountId: string,
      provider: ProviderId,
      stores: readonly ProviderStore[],
      defaults: { timezone: string },
      now: string,
    ): Promise<{ upserted: number; missing: number; sinCupo: string[] }> {
      // Las sucursales nuevas entran activas solo mientras quede cupo; el resto
      // se guardan INACTIVAS. Nunca se rechaza el descubrimiento: no se pierde
      // información, y es el administrador quien decide cuáles activar.
      const cupo = await cupoSucursales();
      const conocidas = new Set(
        (
          await db
            .prepare(
              `SELECT provider_store_id AS p FROM sales_stores
                WHERE tenant_id = ? AND account_id = ?`,
            )
            .bind(tenantId, accountId)
            .all<{ p: string }>()
        ).results?.map((r) => r.p) ?? [],
      );

      let disponibles = cupo.disponibles;
      const sinCupo: string[] = [];

      if (stores.length) {
        await db.batch(
          stores.map((s) => {
            const esNueva = !conocidas.has(s.providerStoreId);
            let activa = 1;
            if (esNueva) {
              if (disponibles > 0) disponibles--;
              else {
                activa = 0;
                sinCupo.push(s.name);
              }
            }
            return db.prepare(UPSERT_STORE).bind(
              makeStoreId(accountId, s.providerStoreId), tenantId, accountId, provider,
              s.providerStoreId, s.name, defaults.timezone, activa, now, now,
            );
          }),
        );
      }

      const vigentes = stores.map((s) => s.providerStoreId);
      const marcador = vigentes.map(() => '?').join(',') || `''`;
      const res = await db
        .prepare(
          `UPDATE sales_stores
              SET active = 0, missing_in_provider_at = COALESCE(missing_in_provider_at, ?), updated_at = ?
            WHERE tenant_id = ? AND account_id = ?
              AND provider_store_id NOT IN (${marcador})`,
        )
        .bind(now, now, tenantId, accountId, ...vigentes)
        .run();

      return { upserted: stores.length, missing: res.meta?.changes ?? 0, sinCupo };
    },

    async listStores(accountId?: string): Promise<StoreRow[]> {
      const sql = `SELECT id, account_id, provider, provider_store_id, name, timezone,
                          business_day_offset_minutes, active
                     FROM sales_stores
                    WHERE tenant_id = ?${accountId ? ' AND account_id = ?' : ''}
                    ORDER BY name`;
      const stmt = accountId
        ? db.prepare(sql).bind(tenantId, accountId)
        : db.prepare(sql).bind(tenantId);
      const res = await stmt.all<{
        id: string;
        account_id: string;
        provider: string;
        provider_store_id: string;
        name: string;
        timezone: string;
        business_day_offset_minutes: number;
        active: number;
      }>();

      return (res.results ?? []).map((r) => ({
        id: r.id,
        accountId: r.account_id,
        provider: r.provider,
        providerStoreId: r.provider_store_id,
        name: r.name,
        timezone: r.timezone,
        businessDayOffsetMinutes: r.business_day_offset_minutes,
        active: r.active === 1,
      }));
    },
  };
}
