// Corrida nocturna completa — épica 02, HU-09, HU-12 y HU-13.
//
// Recorre todos los inquilinos, sus cuentas activas y las sucursales de cada
// una. Dos reglas de aislamiento gobiernan el recorrido:
//
//   · Las sucursales de una MISMA cuenta se procesan en SERIE: el límite de
//     solicitudes de Loyverse es por token, así que paralelizarlas solo serviría
//     para chocar contra él más rápido.
//   · El fallo de una sucursal no detiene a las demás, y el de una cuenta no
//     detiene a las otras cuentas. Cada checkpoint es independiente.

import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { createRepo } from '../repo';
import { listAllTenantIds } from '../repo/tenants';
import { decryptToken, SalesCryptoError } from '../crypto';
import { LoyverseAdapter } from '../loyverse/adapter';
import type { SalesProvider } from '../provider';
import type { ProviderId } from '../types';
import { runIncremental, type IncrementalOutcome } from './incremental';
import type { RetryOptions } from './retry';

export interface NightlyDeps {
  db: D1Database;
  masterKey: CryptoKey;
  bucket?: R2Bucket;
  now?: () => Date;
  newId?: () => string;
  retry?: RetryOptions;
  /** Inyectable para pruebas; por defecto construye el adapter de Loyverse. */
  makeProvider?: (args: { provider: ProviderId; token: string }) => SalesProvider;
}

export interface StoreOutcome {
  tenantId: string;
  accountId: string;
  alias: string;
  storeId: string;
  nombre: string;
  outcome: IncrementalOutcome | 'SIN_CREDENCIALES';
  receipts: number;
  lines: number;
  error?: string;
}

export interface NightlySummary {
  inquilinos: number;
  cuentas: number;
  sucursales: number;
  receipts: number;
  lines: number;
  fallidas: number;
  cuentasInvalidadas: string[];
  detalle: StoreOutcome[];
}

export async function runNightlySync(deps: NightlyDeps): Promise<NightlySummary> {
  const ahora = deps.now ?? (() => new Date());
  const crearProveedor =
    deps.makeProvider ?? (({ token }) => new LoyverseAdapter({ token }));

  const resumen: NightlySummary = {
    inquilinos: 0, cuentas: 0, sucursales: 0, receipts: 0, lines: 0,
    fallidas: 0, cuentasInvalidadas: [], detalle: [],
  };

  const inquilinos = await listAllTenantIds(deps.db);
  resumen.inquilinos = inquilinos.length;

  for (const tenantId of inquilinos) {
    const repo = createRepo(deps.db, tenantId);
    const cuentas = (await repo.listAccounts()).filter((a) => a.status === 'ACTIVE');

    for (const cuenta of cuentas) {
      resumen.cuentas++;

      const cifrado = await repo.getAccountCipher(cuenta.id);
      let token: string;
      try {
        if (!cifrado) throw new Error('la cuenta no tiene credenciales guardadas');
        token = await decryptToken(cifrado, deps.masterKey);
      } catch (err) {
        // Una llave que no corresponde es problema NUESTRO, no del cliente: no
        // se marca la cuenta como inválida, se registra y se salta.
        const detalle = err instanceof SalesCryptoError ? err.message : String(err);
        console.error(`[sync] ${cuenta.alias}: no se pudo descifrar el token — ${detalle}`);
        resumen.detalle.push({
          tenantId, accountId: cuenta.id, alias: cuenta.alias,
          storeId: '', nombre: '', outcome: 'SIN_CREDENCIALES',
          receipts: 0, lines: 0, error: detalle,
        });
        resumen.fallidas++;
        continue;
      }

      const provider = crearProveedor({ provider: 'loyverse', token });
      const sucursales = (await repo.listStores(cuenta.id)).filter((s) => s.active);

      for (const s of sucursales) {
        const r = await runIncremental(
          {
            provider, repo, db: deps.db, bucket: deps.bucket,
            now: deps.now, newId: deps.newId, retry: deps.retry,
          },
          {
            tenantId,
            account: { id: cuenta.id, provider: 'loyverse' },
            store: {
              id: s.id, providerStoreId: s.providerStoreId,
              timezone: s.timezone, businessDayOffsetMinutes: s.businessDayOffsetMinutes,
            },
          },
        );

        if (r.outcome !== 'SKIPPED_SIN_BACKFILL') resumen.sucursales++;
        resumen.receipts += r.receipts;
        resumen.lines += r.lines;
        if (r.outcome === 'FAILED') resumen.fallidas++;

        resumen.detalle.push({
          tenantId, accountId: cuenta.id, alias: cuenta.alias,
          storeId: s.id, nombre: s.name, outcome: r.outcome,
          receipts: r.receipts, lines: r.lines, error: r.error,
        });

        // Token revocado: la cuenta entera queda detenida hasta reconectarse
        // (HU-13). Seguir con sus otras sucursales solo gastaría solicitudes.
        if (r.errorCode === 'INVALID_TOKEN') {
          await repo.markAccountInvalid(cuenta.id, ahora().toISOString());
          resumen.cuentasInvalidadas.push(cuenta.id);
          break;
        }
      }
    }
  }

  return resumen;
}
