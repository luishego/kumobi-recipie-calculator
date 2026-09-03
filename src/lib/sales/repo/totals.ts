// Totales de ventas en SQL — épica 02 §8.
//
// Es la MISMA regla de negocio que `aggregate.ts`, expresada en SQL para que la
// consulta no tenga que traerse los tickets a memoria. Las dos rutas deben dar
// exactamente lo mismo, y hay una prueba que lo exige sobre el histórico real:
// si alguien toca una y no la otra, falla.
//
// Los alias van en snake_case a propósito: PostgreSQL pliega a minúsculas los
// identificadores sin comillas, así que un alias camelCase dejaría de ser
// portable el día de la migración (§5.10).

import type { D1Database } from '@cloudflare/workers-types';
import type { DailyTotals } from '../aggregate';

// El signo del recibo: las ventas suman, los reembolsos restan.
const SIGNO = `CASE WHEN receipt_type = 'REFUND' THEN -1 ELSE 1 END`;

const POR_RECIBO = `
SELECT
  business_date                                                        AS business_date,
  SUM(${SIGNO})                                                        AS net_tickets,
  SUM(total_cents * ${SIGNO})                                          AS net_sales_cents,
  SUM((total_cents - total_tax_cents) * ${SIGNO})                      AS net_sales_ex_tax_cents,
  SUM(total_tax_cents * ${SIGNO})                                      AS tax_cents,
  SUM(COALESCE(total_cost_reported_cents, 0) * ${SIGNO})               AS cost_reported_cents,
  SUM(CASE WHEN receipt_type = 'REFUND' THEN total_cents ELSE 0 END)   AS refunds_cents,
  SUM(CASE WHEN receipt_type = 'SALE' THEN total_discount_cents ELSE 0 END) AS discounts_cents
FROM sales_receipts
WHERE tenant_id = ?
  -- Los cancelados se excluyen por completo, incluido el par venta+reembolso.
  AND cancelled_at IS NULL
  AND business_date >= ? AND business_date <= ?{{FILTRO}}
GROUP BY business_date`;

// Las ventas brutas viven en los renglones, así que van en una consulta aparte:
// unirlas a la anterior multiplicaría las sumas de nivel recibo por el número
// de renglones de cada ticket.
const BRUTAS_POR_DIA = `
SELECT l.business_date AS business_date, SUM(l.gross_total_cents) AS gross_sales_cents
FROM sales_receipt_lines l
JOIN sales_receipts r ON r.id = l.receipt_id
WHERE l.tenant_id = ?
  AND r.cancelled_at IS NULL
  AND r.receipt_type = 'SALE'
  AND l.business_date >= ? AND l.business_date <= ?{{FILTRO}}
GROUP BY l.business_date`;

interface FilaRecibo {
  business_date: string;
  net_tickets: number;
  net_sales_cents: number;
  net_sales_ex_tax_cents: number;
  tax_cents: number;
  cost_reported_cents: number;
  refunds_cents: number;
  discounts_cents: number;
}

interface FilaBrutas {
  business_date: string;
  gross_sales_cents: number;
}

export interface RangoFechas {
  /** "YYYY-MM-DD" inclusive. */
  desde: string;
  /** "YYYY-MM-DD" inclusive. */
  hasta: string;
}

export function createTotalsRepo(db: D1Database, tenantId: string) {
  return {
    /** Primer y último día con ventas. `null` si todavía no hay nada. */
    async salesDateRange(): Promise<{ desde: string; hasta: string } | null> {
      const r = await db
        .prepare(
          `SELECT MIN(business_date) AS desde, MAX(business_date) AS hasta
             FROM sales_receipts WHERE tenant_id = ?`,
        )
        .bind(tenantId)
        .first<{ desde: string | null; hasta: string | null }>();
      return r?.desde && r.hasta ? { desde: r.desde, hasta: r.hasta } : null;
    },

    /**
     * Totales por fecha de negocio, ordenados. Los días sin actividad no aparecen.
     *
     * `storeId` acota a una sucursal; sin él suma todas las del inquilino.
     */
    async dailyTotals(
      rango: RangoFechas,
      opts: { storeId?: string } = {},
    ): Promise<DailyTotals[]> {
      const filtro = opts.storeId ? ' AND store_id = ?' : '';
      const filtroLineas = opts.storeId ? ' AND l.store_id = ?' : '';
      const args = opts.storeId
        ? [tenantId, rango.desde, rango.hasta, opts.storeId]
        : [tenantId, rango.desde, rango.hasta];

      const [recibos, brutas] = await Promise.all([
        db.prepare(POR_RECIBO.replace('{{FILTRO}}', filtro)).bind(...args).all<FilaRecibo>(),
        db.prepare(BRUTAS_POR_DIA.replace('{{FILTRO}}', filtroLineas)).bind(...args).all<FilaBrutas>(),
      ]);

      const brutasPorDia = new Map<string, number>();
      for (const f of brutas.results ?? []) {
        brutasPorDia.set(f.business_date, f.gross_sales_cents ?? 0);
      }

      return (recibos.results ?? [])
        .map((f) => ({
          businessDate: f.business_date,
          netTickets: f.net_tickets ?? 0,
          netSalesCents: f.net_sales_cents ?? 0,
          netSalesExTaxCents: f.net_sales_ex_tax_cents ?? 0,
          grossSalesCents: brutasPorDia.get(f.business_date) ?? 0,
          refundsCents: f.refunds_cents ?? 0,
          discountsCents: f.discounts_cents ?? 0,
          taxCents: f.tax_cents ?? 0,
          costReportedCents: f.cost_reported_cents ?? 0,
        }))
        .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
    },
  };
}
