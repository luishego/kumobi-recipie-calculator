// Estado de sincronización y bitácora de corridas — épica 02, HU-08/09/14.
//
// Dos invariantes que esta capa hace cumplir:
//   · El checkpoint (`last_synced_at`) SOLO avanza tras un éxito completo. Un
//     fallo parcial nunca lo mueve, porque moverlo dejaría un hueco que ninguna
//     corrida futura vuelve a mirar.
//   · El corte se captura al INICIO de la corrida y se guarda en la bitácora;
//     tomarlo al final perdería todo lo que el proveedor escribió mientras el
//     job corría.

import type { D1Database } from '@cloudflare/workers-types';

export type RunStatus = 'SUCCESS' | 'ERROR' | 'RUNNING';
export type RunKind = 'BACKFILL' | 'INCREMENTAL' | 'MANUAL';
export type BackfillStatus =
  | 'PENDING' | 'RUNNING' | 'PAUSED_BUDGET' | 'COMPLETE' | 'FAILED';

export interface SyncStateRow {
  storeId: string;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  lastRunStatus: RunStatus | null;
  lastRunError: string | null;
  consecutiveFailures: number;
  backfillStatus: BackfillStatus;
  backfillFrom: string | null;
  backfillCursor: string | null;
  backfillThrough: string | null;
}

export interface RunCounts {
  pagesFetched: number;
  receiptsUpserted: number;
  linesUpserted: number;
}

const VACIO = (storeId: string): SyncStateRow => ({
  storeId,
  lastSyncedAt: null,
  lastSuccessAt: null,
  lastRunStatus: null,
  lastRunError: null,
  consecutiveFailures: 0,
  backfillStatus: 'PENDING',
  backfillFrom: null,
  backfillCursor: null,
  backfillThrough: null,
});

export function createSyncStateRepo(db: D1Database, tenantId: string) {
  // Función nombrada, no método: al fusionar los repositorios con spread, un
  // `this.getSyncState()` dependería de cómo se invoque el objeto resultante.
  async function getSyncState(storeId: string): Promise<SyncStateRow> {
      const r = await db
        .prepare(
          `SELECT store_id, last_synced_at, last_success_at, last_run_status, last_run_error,
                  consecutive_failures, backfill_status, backfill_from, backfill_cursor,
                  backfill_through
             FROM sync_state WHERE store_id = ? AND tenant_id = ?`,
        )
        .bind(storeId, tenantId)
        .first<Record<string, unknown>>();

      if (!r) return VACIO(storeId);
      return {
        storeId: r.store_id as string,
        lastSyncedAt: (r.last_synced_at as string) ?? null,
        lastSuccessAt: (r.last_success_at as string) ?? null,
        lastRunStatus: (r.last_run_status as RunStatus) ?? null,
        lastRunError: (r.last_run_error as string) ?? null,
        consecutiveFailures: (r.consecutive_failures as number) ?? 0,
        backfillStatus: (r.backfill_status as BackfillStatus) ?? 'PENDING',
        backfillFrom: (r.backfill_from as string) ?? null,
        backfillCursor: (r.backfill_cursor as string) ?? null,
        backfillThrough: (r.backfill_through as string) ?? null,
      };
  }

  return {
    getSyncState,

    async listSyncState(): Promise<SyncStateRow[]> {
      const res = await db
        .prepare(`SELECT store_id FROM sync_state WHERE tenant_id = ? ORDER BY store_id`)
        .bind(tenantId)
        .all<{ store_id: string }>();
      const out: SyncStateRow[] = [];
      for (const { store_id } of res.results ?? []) out.push(await getSyncState(store_id));
      return out;
    },

    /** Guarda el avance del histórico. Es lo que hace REANUDABLE el backfill. */
    async saveBackfillProgress(
      storeId: string,
      p: {
        status: BackfillStatus;
        from?: string | null;
        cursor?: string | null;
        through?: string | null;
      },
      now: string,
    ): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sync_state (store_id, tenant_id, backfill_status, backfill_from,
                                   backfill_cursor, backfill_through, updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT (store_id) DO UPDATE SET
             backfill_status  = excluded.backfill_status,
             backfill_from    = COALESCE(excluded.backfill_from, sync_state.backfill_from),
             backfill_cursor  = excluded.backfill_cursor,
             backfill_through = COALESCE(excluded.backfill_through, sync_state.backfill_through),
             updated_at       = excluded.updated_at`,
        )
        .bind(
          storeId, tenantId, p.status, p.from ?? null,
          p.cursor ?? null, p.through ?? null, now,
        )
        .run();
    },

    /**
     * Cierra el histórico y fija el checkpoint.
     *
     * `cutoffAt` es el instante capturado al INICIO de la primera corrida del
     * backfill, no el de ahora: lo que el proveedor haya escrito mientras el
     * job corría tiene que quedar dentro del rango de la siguiente corrida.
     */
    async completeBackfill(storeId: string, cutoffAt: string, now: string): Promise<void> {
      await db
        .prepare(
          `UPDATE sync_state
              SET backfill_status = 'COMPLETE', backfill_cursor = NULL,
                  last_synced_at = ?, last_success_at = ?, last_run_status = 'SUCCESS',
                  last_run_error = NULL, consecutive_failures = 0, updated_at = ?
            WHERE store_id = ? AND tenant_id = ?`,
        )
        .bind(cutoffAt, now, now, storeId, tenantId)
        .run();
    },

    /**
     * Avanza el checkpoint tras una sincronización incremental exitosa.
     *
     * `cutoffAt` es el instante capturado al INICIO de la corrida. Usar "ahora"
     * dejaría fuera todo lo que el proveedor escribió mientras descargábamos.
     */
    async advanceCheckpoint(storeId: string, cutoffAt: string, now: string): Promise<void> {
      await db
        .prepare(
          `UPDATE sync_state
              SET last_synced_at = ?, last_success_at = ?, last_run_status = 'SUCCESS',
                  last_run_error = NULL, consecutive_failures = 0, updated_at = ?
            WHERE store_id = ? AND tenant_id = ?`,
        )
        .bind(cutoffAt, now, now, storeId, tenantId)
        .run();
    },

    /** Registra un fallo SIN mover el checkpoint. */
    async recordFailure(storeId: string, error: string, now: string): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sync_state (store_id, tenant_id, last_run_status, last_run_error,
                                   consecutive_failures, backfill_status, updated_at)
           VALUES (?,?, 'ERROR', ?, 1, 'FAILED', ?)
           ON CONFLICT (store_id) DO UPDATE SET
             last_run_status      = 'ERROR',
             last_run_error       = excluded.last_run_error,
             consecutive_failures = sync_state.consecutive_failures + 1,
             updated_at           = excluded.updated_at`,
        )
        .bind(storeId, tenantId, error.slice(0, 500), now)
        .run();
    },

    // ── Bitácora ────────────────────────────────────────────────────────────

    async startRun(
      r: {
        id: string; storeId: string; kind: RunKind;
        requestedFrom: string; cutoffAt: string; triggeredBy?: string | null;
      },
      now: string,
    ): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sync_runs (id, tenant_id, store_id, kind, started_at, status,
                                  requested_from, cutoff_at, triggered_by)
           VALUES (?,?,?,?,?, 'RUNNING', ?,?,?)`,
        )
        .bind(
          r.id, tenantId, r.storeId, r.kind, now,
          r.requestedFrom, r.cutoffAt, r.triggeredBy ?? null,
        )
        .run();
    },

    async finishRun(
      runId: string,
      status: Exclude<RunStatus, 'RUNNING'>,
      counts: RunCounts,
      now: string,
      error?: { code: string; detail: string } | null,
    ): Promise<void> {
      await db
        .prepare(
          `UPDATE sync_runs
              SET finished_at = ?, status = ?, pages_fetched = ?, receipts_upserted = ?,
                  lines_upserted = ?, error_code = ?, error_detail = ?
            WHERE id = ? AND tenant_id = ?`,
        )
        .bind(
          now, status, counts.pagesFetched, counts.receiptsUpserted, counts.linesUpserted,
          error?.code ?? null, error?.detail?.slice(0, 500) ?? null, runId, tenantId,
        )
        .run();
    },

    async listRuns(storeId: string, limit = 20) {
      const res = await db
        .prepare(
          `SELECT id, kind, started_at, finished_at, status, requested_from, cutoff_at,
                  pages_fetched, receipts_upserted, lines_upserted, error_code, error_detail,
                  triggered_by
             FROM sync_runs WHERE store_id = ? AND tenant_id = ?
            ORDER BY started_at DESC LIMIT ?`,
        )
        .bind(storeId, tenantId, limit)
        .all<Record<string, unknown>>();
      return res.results ?? [];
    },
  };
}
