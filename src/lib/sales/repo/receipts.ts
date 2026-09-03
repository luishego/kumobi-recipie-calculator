// Persistencia de tickets y renglones — épica 02, HU-08/HU-09/HU-11.
//
// La idempotencia NO la garantiza esta lógica: la garantiza la BASE, con el
// índice único sobre (provider, account_id, store_id, receipt_number). Aquí
// solo se escribe el upsert que se apoya en él.
//
// SQL portable a PostgreSQL (§5.10): `ON CONFLICT … DO UPDATE`, nunca el
// `INSERT OR REPLACE` propio de SQLite.

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { NormalizedReceipt, ProviderId } from '../types';
import { receiptId, receiptLineId } from './ids';

/** Tickets por lote. Cada uno son 2 sentencias + una por renglón. */
const RECEIPTS_POR_LOTE = 20;

export interface UpsertResult {
  receipts: number;
  lines: number;
}

const UPSERT_RECEIPT = `
INSERT INTO sales_receipts (
  id, tenant_id, account_id, store_id, provider, receipt_number, receipt_type,
  refund_for_receipt_number, cancelled_at, receipt_date, business_date,
  total_cents, total_discount_cents, total_tax_cents, tip_cents, surcharge_cents,
  total_cost_reported_cents, dining_option, currency,
  provider_created_at, provider_updated_at, synced_at, raw_object_key
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT (provider, account_id, store_id, receipt_number) DO UPDATE SET
  receipt_type              = excluded.receipt_type,
  refund_for_receipt_number = excluded.refund_for_receipt_number,
  cancelled_at              = excluded.cancelled_at,
  receipt_date              = excluded.receipt_date,
  business_date             = excluded.business_date,
  total_cents               = excluded.total_cents,
  total_discount_cents      = excluded.total_discount_cents,
  total_tax_cents           = excluded.total_tax_cents,
  tip_cents                 = excluded.tip_cents,
  surcharge_cents           = excluded.surcharge_cents,
  total_cost_reported_cents = excluded.total_cost_reported_cents,
  dining_option             = excluded.dining_option,
  provider_updated_at       = excluded.provider_updated_at,
  synced_at                 = excluded.synced_at,
  raw_object_key            = COALESCE(excluded.raw_object_key, sales_receipts.raw_object_key)
-- Solo se pisa con datos IGUAL O MÁS NUEVOS que los guardados. Evita que una
-- corrida atrasada (un reintento, una re-sincronización manual de un rango
-- viejo) revierta una corrección que ya había llegado.
WHERE excluded.provider_updated_at >= sales_receipts.provider_updated_at`;

const DELETE_LINES = `DELETE FROM sales_receipt_lines WHERE receipt_id = ? AND tenant_id = ?`;

const INSERT_LINE = `
INSERT INTO sales_receipt_lines (
  id, tenant_id, receipt_id, store_id, business_date, line_index,
  provider_item_id, provider_variant_id, sku, item_name, variant_name,
  quantity, unit_price_cents, gross_total_cents, total_cents,
  total_discount_cents, cost_reported_cents, cost_total_reported_cents
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export function createReceiptsRepo(db: D1Database, tenantId: string) {
  return {
    /**
     * Guarda tickets con sus renglones, de forma idempotente.
     *
     * Los renglones se REEMPLAZAN en bloque (borrar + insertar) en vez de
     * actualizarse uno a uno: si el ticket se editó en el POS y ahora tiene
     * menos renglones, la actualización dejaría huérfanos los sobrantes.
     */
    async upsertReceipts(
      target: { provider: ProviderId; accountId: string; storeId: string },
      receipts: readonly NormalizedReceipt[],
      opts: { syncedAt: string; rawObjectKey?: string | null },
    ): Promise<UpsertResult> {
      const { provider, accountId, storeId: storeIdValue } = target;
      let lines = 0;
      const statements: D1PreparedStatement[] = [];

      const flush = async () => {
        if (!statements.length) return;
        await db.batch(statements.splice(0, statements.length));
      };

      let enLote = 0;
      for (const r of receipts) {
        // El id se deriva de la llave natural (provider_store_id), mientras que
        // la columna `store_id` guarda la referencia a nuestra fila de sucursal.
        const id = receiptId(provider, accountId, r.providerStoreId, r.receiptNumber);

        statements.push(
          db.prepare(UPSERT_RECEIPT).bind(
            id, tenantId, accountId, storeIdValue, provider, r.receiptNumber, r.receiptType,
            r.refundForReceiptNumber, r.cancelledAt, r.receiptDate, r.businessDate,
            r.totalCents, r.totalDiscountCents, r.totalTaxCents, r.tipCents, r.surchargeCents,
            r.totalCostReportedCents, r.diningOption, r.currency,
            r.providerCreatedAt, r.providerUpdatedAt, opts.syncedAt, opts.rawObjectKey ?? null,
          ),
          db.prepare(DELETE_LINES).bind(id, tenantId),
        );

        for (const l of r.lines) {
          statements.push(
            db.prepare(INSERT_LINE).bind(
              receiptLineId(id, l.lineIndex), tenantId, id, storeIdValue, r.businessDate, l.lineIndex,
              l.providerItemId, l.providerVariantId, l.sku, l.itemName, l.variantName,
              l.quantity, l.unitPriceCents, l.grossTotalCents, l.totalCents,
              l.totalDiscountCents, l.costReportedCents, l.costTotalReportedCents,
            ),
          );
          lines++;
        }

        if (++enLote >= RECEIPTS_POR_LOTE) {
          await flush();
          enLote = 0;
        }
      }
      await flush();

      return { receipts: receipts.length, lines };
    },

    async countReceipts(): Promise<number> {
      const row = await db
        .prepare('SELECT count(*) AS c FROM sales_receipts WHERE tenant_id = ?')
        .bind(tenantId)
        .first<{ c: number }>();
      return row?.c ?? 0;
    },

    async countLines(): Promise<number> {
      const row = await db
        .prepare('SELECT count(*) AS c FROM sales_receipt_lines WHERE tenant_id = ?')
        .bind(tenantId)
        .first<{ c: number }>();
      return row?.c ?? 0;
    },
  };
}
