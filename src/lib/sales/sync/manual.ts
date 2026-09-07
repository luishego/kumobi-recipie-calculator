// Re-sincronización manual de un rango — épica 02, HU-15.
//
// Sirve para tapar un hueco detectado (un día que quedó sin bajar, una corrida
// que falló y nadie revisó) sin rehacer el histórico completo.
//
// ── Por qué filtra por fecha de CREACIÓN y no de actualización ──────────────
// El incremental filtra por actualización, porque su pregunta es "¿qué cambió
// desde la última vez?". La pregunta de aquí es distinta: "¿qué se vendió en
// estos días?". Un ticket creado el 2 de agosto y editado el 20 tiene
// `updated_at` fuera del rango y quedaría fuera con el filtro del incremental
// —justo el ticket que más probablemente falte—. Por eso se acota con
// `created_at_min`/`created_at_max`.
//
// ── Por qué NO toca `sync_state` ────────────────────────────────────────────
// Ni al terminar bien ni al fallar. `sync_state` describe la salud del
// pipeline AUTOMÁTICO: su checkpoint, sus fallos consecutivos, su backfill.
// Una reparación hacia atrás no es un avance —moverle el checkpoint abriría un
// hueco entre el rango reparado y el presente—, y un fallo suyo tampoco debería
// marcar la sucursal como rota ni tocar `backfill_status`: la sincronización
// nocturna puede estar perfectamente sana. Todo lo que pasa aquí queda en la
// BITÁCORA, con quién lo disparó y qué rango pidió.

import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { SalesProvider } from '../provider';
import { SalesProviderError } from '../provider';
import type { SalesRepo } from '../repo';
import type { ProviderId } from '../types';
import { archiveRawPage, rawObjectKey } from '../archive';
import { MAX_LIMIT } from '../loyverse/adapter';
import { rangoUtcDeDiasLocales } from '../businessDate';
import { consumeBudget, hayEspacioPara } from './budget';
import { conReintentos, type RetryOptions } from './retry';

const FILAS_POR_PAGINA = MAX_LIMIT * 4;

export interface ManualDeps {
  provider: SalesProvider;
  repo: SalesRepo;
  db: D1Database;
  bucket?: R2Bucket;
  now?: () => Date;
  newId?: () => string;
  retry?: RetryOptions;
}

export interface ManualTarget {
  tenantId: string;
  account: { id: string; provider: ProviderId };
  store: {
    id: string;
    providerStoreId: string;
    timezone: string;
    businessDayOffsetMinutes?: number;
  };
  /** Días LOCALES de la sucursal, ambos inclusive. */
  rango: { desde: string; hasta: string };
  /** uid del administrador que la disparó. Queda en la bitácora. */
  triggeredBy: string;
}

export type ManualOutcome = 'SUCCESS' | 'PAUSED_BUDGET' | 'FAILED';

export interface ManualResult {
  outcome: ManualOutcome;
  pages: number;
  receipts: number;
  lines: number;
  /** Ventana UTC realmente pedida al proveedor. */
  desdeUtc: string;
  hastaUtc: string;
  errorCode?: string;
  error?: string;
}

export async function runManualRange(
  deps: ManualDeps,
  target: ManualTarget,
): Promise<ManualResult> {
  const { provider, repo, db, bucket } = deps;
  const ahora = deps.now ?? (() => new Date());
  const nuevoId = deps.newId ?? (() => crypto.randomUUID());
  const { store, account, rango } = target;

  // La conversión usa la zona de la SUCURSAL, no la del navegador ni UTC: el
  // administrador escribe días de negocio y el proveedor filtra por instantes.
  const { desdeUtc, hastaUtcExclusivo } = rangoUtcDeDiasLocales(
    rango.desde,
    rango.hasta,
    store.timezone,
  );

  const inicio = ahora();
  const cutoffAt = inicio.toISOString();
  const runId = nuevoId();

  await repo.startRun(
    {
      id: runId,
      storeId: store.id,
      kind: 'MANUAL',
      // Se guarda la ventana UTC efectiva, no las fechas que se tecleraon: es
      // lo que de verdad se le pidió al proveedor, y es lo que hace falta para
      // entender después por qué entró lo que entró.
      requestedFrom: desdeUtc,
      cutoffAt: hastaUtcExclusivo,
      triggeredBy: target.triggeredBy,
    },
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
        // Se cierra como SUCCESS con lo que alcanzó a entrar: no es un error,
        // es cuota agotada. Repetir el mismo rango mañana es inocuo porque el
        // upsert es idempotente, así que no hace falta persistir un cursor.
        await repo.finishRun(
          runId, 'SUCCESS',
          { pagesFetched: pages, receiptsUpserted: receipts, linesUpserted: lines }, t,
        );
        return {
          outcome: 'PAUSED_BUDGET', pages, receipts, lines,
          desdeUtc, hastaUtc: hastaUtcExclusivo,
        };
      }

      const pagina = await conReintentos(
        () =>
          provider.fetchReceipts({
            providerStoreId: store.providerStoreId,
            timeZone: store.timezone,
            businessDayOffsetMinutes: store.businessDayOffsetMinutes ?? 0,
            limit: MAX_LIMIT,
            ...(cursor
              ? { cursor }
              : { createdSince: desdeUtc, createdBefore: hastaUtcExclusivo }),
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
        // El MISMO upsert idempotente que usan el backfill y el incremental:
        // repetir un rango ya sincronizado no duplica ni corrompe nada.
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

    await repo.finishRun(
      runId, 'SUCCESS',
      { pagesFetched: pages, receiptsUpserted: receipts, linesUpserted: lines },
      ahora().toISOString(),
    );
    return {
      outcome: 'SUCCESS', pages, receipts, lines,
      desdeUtc, hastaUtc: hastaUtcExclusivo,
    };
  } catch (err) {
    const code = err instanceof SalesProviderError ? err.code : 'UNKNOWN';
    const detail = err instanceof Error ? err.message : String(err);
    // Sin `recordFailure`: ver la cabecera. El fallo vive en la bitácora.
    await repo.finishRun(
      runId, 'ERROR',
      { pagesFetched: pages, receiptsUpserted: receipts, linesUpserted: lines },
      ahora().toISOString(), { code, detail },
    );
    return {
      outcome: 'FAILED', pages, receipts, lines,
      desdeUtc, hastaUtc: hastaUtcExclusivo, errorCode: code, error: detail,
    };
  }
}
