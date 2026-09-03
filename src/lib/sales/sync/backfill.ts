// Descarga inicial del histórico — épica 02, HU-08.
//
// Tres propiedades que definen esta pieza:
//
//   REANUDABLE. El cursor se persiste después de cada página. Si la corrida se
//   corta —por presupuesto, por un error del proveedor, por un límite de
//   ejecución— la siguiente continúa donde quedó en vez de reiniciar.
//
//   IDEMPOTENTE. Cada ticket se escribe con upsert contra la llave compuesta,
//   así que repetir una página no duplica nada. Eso es lo que hace seguro
//   reintentar sin pensarlo.
//
//   EL CHECKPOINT SOLO AVANZA AL TERMINAR. Y con el corte capturado al INICIO
//   del backfill, no al final: lo que el proveedor escriba mientras corremos
//   tiene que caer dentro del rango de la siguiente sincronización, no en un
//   hueco.

import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { SalesProvider } from '../provider';
import { SalesProviderError } from '../provider';
import type { SalesRepo } from '../repo';
import type { ProviderId } from '../types';
import { archiveRawPage, rawObjectKey } from '../archive';
import { MAX_LIMIT } from '../loyverse/adapter';
import { consumeBudget, hayEspacioPara } from './budget';

/** Filas que puede escribir una página llena: 1 recibo + ~3 renglones cada uno. */
const FILAS_POR_PAGINA = MAX_LIMIT * 4;

export interface BackfillDeps {
  provider: SalesProvider;
  repo: SalesRepo;
  /** Para el contador de presupuesto, que es de la base y no del inquilino. */
  db: D1Database;
  bucket?: R2Bucket;
  now?: () => Date;
  newId?: () => string;
}

export interface BackfillTarget {
  tenantId: string;
  account: { id: string; provider: ProviderId; backfillMaxDays: number | null };
  store: {
    id: string;
    providerStoreId: string;
    timezone: string;
    businessDayOffsetMinutes?: number;
  };
}

export type BackfillOutcome = 'COMPLETE' | 'PAUSED_BUDGET' | 'FAILED' | 'ALREADY_COMPLETE';

export interface BackfillResult {
  outcome: BackfillOutcome;
  pages: number;
  receipts: number;
  lines: number;
  cursor: string | null;
  cutoffAt: string;
  error?: string;
}

function desdeCuando(maxDays: number | null, now: Date): string | undefined {
  // `null` = sin tope: se pide todo el histórico que tenga la cuenta.
  if (maxDays === null) return undefined;
  return new Date(now.getTime() - maxDays * 86_400_000).toISOString();
}

export async function runBackfill(
  deps: BackfillDeps,
  target: BackfillTarget,
  opts: { triggeredBy?: string | null; force?: boolean } = {},
): Promise<BackfillResult> {
  const { provider, repo, db, bucket } = deps;
  const ahora = deps.now ?? (() => new Date());
  const nuevoId = deps.newId ?? (() => crypto.randomUUID());
  const { store, account } = target;

  const estado = await repo.getSyncState(store.id);
  if (estado.backfillStatus === 'COMPLETE' && !opts.force) {
    return {
      outcome: 'ALREADY_COMPLETE', pages: 0, receipts: 0, lines: 0,
      cursor: null, cutoffAt: estado.lastSyncedAt ?? '',
    };
  }

  const inicio = ahora();
  const reanudando = Boolean(estado.backfillCursor);

  // El corte se fija en la PRIMERA corrida del backfill y se reutiliza al
  // reanudar. Guardado en `backfill_through`.
  const cutoffAt = (reanudando && estado.backfillThrough) || inicio.toISOString();
  const createdSince =
    (reanudando && estado.backfillFrom) || desdeCuando(account.backfillMaxDays, inicio);

  const runId = nuevoId();
  await repo.startRun(
    {
      id: runId, storeId: store.id, kind: 'BACKFILL',
      requestedFrom: createdSince ?? '(todo el histórico)',
      cutoffAt, triggeredBy: opts.triggeredBy ?? null,
    },
    inicio.toISOString(),
  );

  await repo.saveBackfillProgress(
    store.id,
    {
      status: 'RUNNING',
      from: createdSince ?? '(todo el histórico)',
      cursor: estado.backfillCursor,
      through: cutoffAt,
    },
    inicio.toISOString(),
  );

  let cursor: string | null = estado.backfillCursor;
  let pages = 0;
  let receipts = 0;
  let lines = 0;

  try {
    for (;;) {
      // Se consulta el presupuesto ANTES de pedir la página: quedarse sin cuota
      // a mitad del lote dejaría la escritura incompleta.
      if (!(await hayEspacioPara(db, FILAS_POR_PAGINA, ahora()))) {
        const t = ahora().toISOString();
        await repo.saveBackfillProgress(store.id, { status: 'PAUSED_BUDGET', cursor }, t);
        await repo.finishRun(
          runId, 'SUCCESS',
          { pagesFetched: pages, receiptsUpserted: receipts, linesUpserted: lines }, t,
        );
        return { outcome: 'PAUSED_BUDGET', pages, receipts, lines, cursor, cutoffAt };
      }

      const pagina = await provider.fetchReceipts({
        providerStoreId: store.providerStoreId,
        timeZone: store.timezone,
        businessDayOffsetMinutes: store.businessDayOffsetMinutes ?? 0,
        limit: MAX_LIMIT,
        ...(cursor ? { cursor } : createdSince ? { createdSince } : {}),
      });
      pages++;

      // Archivar ANTES de normalizar y persistir: si algo falla más adelante,
      // el dato de origen ya está a salvo y el rango es re-procesable.
      const key = await archiveRawPage(
        bucket,
        rawObjectKey(
          { tenantId: target.tenantId, accountId: account.id, providerStoreId: store.providerStoreId },
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
      await repo.saveBackfillProgress(
        store.id, { status: 'RUNNING', cursor }, ahora().toISOString(),
      );

      if (!cursor) break;
    }

    const fin = ahora().toISOString();
    await repo.completeBackfill(store.id, cutoffAt, fin);
    await repo.finishRun(
      runId, 'SUCCESS',
      { pagesFetched: pages, receiptsUpserted: receipts, linesUpserted: lines }, fin,
    );
    return { outcome: 'COMPLETE', pages, receipts, lines, cursor: null, cutoffAt };
  } catch (err) {
    const fin = ahora().toISOString();
    const code = err instanceof SalesProviderError ? err.code : 'UNKNOWN';
    const detail = err instanceof Error ? err.message : String(err);

    // El checkpoint NO se mueve, y el cursor se conserva para reanudar.
    await repo.saveBackfillProgress(store.id, { status: 'FAILED', cursor }, fin);
    await repo.recordFailure(store.id, `${code}: ${detail}`, fin);
    await repo.finishRun(
      runId, 'ERROR',
      { pagesFetched: pages, receiptsUpserted: receipts, linesUpserted: lines },
      fin, { code, detail },
    );

    return { outcome: 'FAILED', pages, receipts, lines, cursor, cutoffAt, error: detail };
  }
}
