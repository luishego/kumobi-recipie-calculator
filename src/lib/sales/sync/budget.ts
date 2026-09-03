// Presupuesto diario de escritura en D1 — épica 02 §5.1 y HU-08.
//
// El plan gratuito de D1 permite 100 000 filas escritas por día, y al agotarlo
// **la base deja de aceptar consultas, no solo escrituras**. Un backfill largo
// sin control no se limita a tardar más: deja la aplicación sin base de datos
// por el resto del día.
//
// Con Kumobi esto no se va a activar —su histórico completo son ~400 filas—
// pero es lo que permite ofrecer "todo el histórico" a una cuenta con volumen
// real sin arriesgar el panel.
//
// El contador vive en D1 porque tiene que sobrevivir entre invocaciones del
// Worker. La cuota es de la BASE, no del inquilino, así que la tabla no lleva
// `tenant_id`, y el día es UTC, que es como Cloudflare la cuenta.

import type { D1Database } from '@cloudflare/workers-types';

/** 80 % de la cuota diaria: deja margen para que la app siga operando. */
export const DAILY_WRITE_BUDGET = 80_000;

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Filas ya escritas hoy. */
export async function rowsWrittenToday(db: D1Database, now = new Date()): Promise<number> {
  const row = await db
    .prepare('SELECT rows_written AS n FROM d1_write_budget WHERE day = ?')
    .bind(utcDay(now))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Filas que todavía se pueden escribir hoy. Nunca negativo. */
export async function remainingBudget(db: D1Database, now = new Date()): Promise<number> {
  return Math.max(0, DAILY_WRITE_BUDGET - (await rowsWrittenToday(db, now)));
}

/** Suma al contador del día. Se llama DESPUÉS de escribir, con lo realmente escrito. */
export async function consumeBudget(
  db: D1Database,
  rows: number,
  now = new Date(),
): Promise<void> {
  if (rows <= 0) return;
  await db
    .prepare(
      `INSERT INTO d1_write_budget (day, rows_written, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET
         rows_written = rows_written + excluded.rows_written,
         updated_at   = excluded.updated_at`,
    )
    .bind(utcDay(now), rows, now.toISOString())
    .run();
}

/**
 * ¿Cabe una página más?
 *
 * Se consulta ANTES de pedirla, con una estimación por lo alto: quedarse sin
 * cuota a mitad de una página dejaría el lote a medias.
 */
export async function hayEspacioPara(
  db: D1Database,
  filasEstimadas: number,
  now = new Date(),
): Promise<boolean> {
  return (await remainingBudget(db, now)) >= filasEstimadas;
}
