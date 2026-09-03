// Sincronización incremental — épica 02, HU-09.
//
// Tres decisiones que parecen detalles y no lo son:
//
//   FILTRA POR FECHA DE ACTUALIZACIÓN, no de creación. Un ticket creado hace
//   una semana y editado anoche tiene que volver a bajar; filtrando por
//   creación se perdería. Lo mismo con reembolsos y cancelaciones.
//
//   COLCHÓN HACIA ATRÁS sobre el checkpoint. El proveedor puede no haber
//   terminado de escribir un ticket cuando la corrida anterior tomó su corte.
//   Volver a pedir unos minutos ya vistos no cuesta nada porque el upsert es
//   idempotente; perderlos sí cuesta.
//
//   EL CORTE SE TOMA AL INICIO. Si se tomara al final, todo lo que el proveedor
//   escribiera durante la descarga caería en un hueco que ninguna corrida
//   futura vuelve a mirar.

import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { SalesProvider } from '../provider';
import { SalesProviderError } from '../provider';
import type { SalesRepo } from '../repo';
import type { ProviderId } from '../types';
import { archiveRawPage, rawObjectKey } from '../archive';
import { MAX_LIMIT } from '../loyverse/adapter';
import { consumeBudget, hayEspacioPara } from './budget';
import { conReintentos, type RetryOptions } from './retry';

/** Minutos que se re-piden hacia atrás sobre el checkpoint. */
export const SYNC_OVERLAP_MINUTES = 10;

const FILAS_POR_PAGINA = MAX_LIMIT * 4;

export interface IncrementalDeps {
  provider: SalesProvider;
  repo: SalesRepo;
  db: D1Database;
  bucket?: R2Bucket;
  now?: () => Date;
  newId?: () => string;
  retry?: RetryOptions;
}

export interface IncrementalTarget {
  tenantId: string;
  account: { id: string; provider: ProviderId };
  store: {
    id: string;
    providerStoreId: string;
    timezone: string;
    businessDayOffsetMinutes?: number;
  };
}

export type IncrementalOutcome =
  | 'SUCCESS'
  | 'SKIPPED_SIN_BACKFILL'
  | 'PAUSED_BUDGET'
  | 'FAILED';

export interface IncrementalResult {
  outcome: IncrementalOutcome;
  pages: number;
  receipts: number;
  lines: number;
  from: string | null;
  cutoffAt: string;
  errorCode?: string;
  error?: string;
}

export async function runIncremental(
  deps: IncrementalDeps,
  target: IncrementalTarget,
): Promise<IncrementalResult> {
  const { provider, repo, db, bucket } = deps;
  const ahora = deps.now ?? (() => new Date());
  const nuevoId = deps.newId ?? (() => crypto.randomUUID());
  const { store, account } = target;

  const estado = await repo.getSyncState(store.id);

  // Una sucursal a la que le falta el histórico no entra al incremental: su
  // checkpoint no significa nada todavía (HU-08).
  if (estado.backfillStatus !== 'COMPLETE' || !estado.lastSyncedAt) {
    return {
      outcome: 'SKIPPED_SIN_BACKFILL', pages: 0, receipts: 0, lines: 0,
      from: null, cutoffAt: '',
    };
  }

  const inicio = ahora();
  const cutoffAt = inicio.toISOString();
  const desde = new Date(
    Date.parse(estado.lastSyncedAt) - SYNC_OVERLAP_MINUTES * 60_000,
  ).toISOString();

  const runId = nuevoId();
  await repo.startRun(
    { id: runId, storeId: store.id, kind: 'INCREMENTAL', requestedFrom: desde, cutoffAt },
    cutoffAt,
  );

  let cursor: string | null = null;
  let pages = 0;
  let receipts = 0;
  let lines = 0;

  try {
    for (;;) {
      if (!(await hayEspacioPara(db, FILAS_POR_PAGINA, ahora()))) {
        const t = ahora().toISOString();
        await repo.finishRun(
          runId, 'SUCCESS',
          { pagesFetched: pages, receiptsUpserted: receipts, linesUpserted: lines }, t,
        );
        // El checkpoint NO avanza: lo que falte se re-pedirá mañana.
        return { outcome: 'PAUSED_BUDGET', pages, receipts, lines, from: desde, cutoffAt };
      }

      const pagina = await conReintentos(
        () =>
          provider.fetchReceipts({
            providerStoreId: store.providerStoreId,
            timeZone: store.timezone,
            businessDayOffsetMinutes: store.businessDayOffsetMinutes ?? 0,
            limit: MAX_LIMIT,
            ...(cursor ? { cursor } : { updatedSince: desde }),
          }),
        deps.retry,
      );
      pages++;

      const key = await archiveRawPage(
        bucket,
        rawObjectKey(
          {
            tenantId: target.tenantId,
            accountId: account.id,
            providerStoreId: store.providerStoreId,
          },
          runId, pages, inicio,
        ),
        pagina.raw,
      );

      if (pagina.receipts.length) {
        const res = await repo.upsertReceipts(
          { provider: account.provider, accountId: account.id, storeId: store.id },
          pagina.receipts,
          { syncedAt: ahora().toISOString(), rawObjectKey: key },
        );
        receipts += res.receipts;
        lines += res.lines;
        await consumeBudget(db, res.receipts + res.lines, ahora());
      }

      cursor = pagina.cursor;
      if (!cursor) break;
    }

    const fin = ahora().toISOString();
    await repo.advanceCheckpoint(store.id, cutoffAt, fin);
    await repo.finishRun(
      runId, 'SUCCESS',
      { pagesFetched: pages, receiptsUpserted: receipts, linesUpserted: lines }, fin,
    );
    return { outcome: 'SUCCESS', pages, receipts, lines, from: desde, cutoffAt };
  } catch (err) {
    const fin = ahora().toISOString();
    const code = err instanceof SalesProviderError ? err.code : 'UNKNOWN';
    const detail = err instanceof Error ? err.message : String(err);

    // El checkpoint se queda donde estaba: la siguiente corrida vuelve a pedir
    // este rango completo, y el upsert idempotente hace que eso sea inocuo.
    await repo.recordFailure(store.id, `${code}: ${detail}`, fin);
    await repo.finishRun(
      runId, 'ERROR',
      { pagesFetched: pages, receiptsUpserted: receipts, linesUpserted: lines },
      fin, { code, detail },
    );
    return {
      outcome: 'FAILED', pages, receipts, lines, from: desde, cutoffAt,
      errorCode: code, error: detail,
    };
  }
}
