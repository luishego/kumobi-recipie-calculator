// Normalización de recibos de Loyverse — épica 02, HU-05.
//
// FUNCIÓN PURA: sin red, sin base de datos, sin reloj. Dado el mismo payload
// produce siempre el mismo resultado. Eso es lo que permite corregir un error
// de interpretación y re-procesar desde el archivo de R2 en vez de volver a
// descargar meses de histórico.
//
// Cada regla de aquí está verificada contra el reporte del Back Office sobre
// los 104 días del histórico de Kumobi, no supuesta. Ver §9.1 de la épica.

import type { NormalizedReceipt, NormalizedReceiptLine, ReceiptType } from '../types';
import { toCents } from '../money';
import { businessDate } from '../businessDate';

// ── Forma cruda que entrega el proveedor ────────────────────────────────────
// Solo se declaran los campos que usamos. El recibo trae más (`payments`,
// `points_*`, `employee_id`…) que hoy no se persisten.

export interface LoyverseLineItem {
  item_id?: string | null;
  variant_id?: string | null;
  sku?: string | null;
  item_name?: string | null;
  variant_name?: string | null;
  quantity?: number | string | null;
  price?: number | string | null;
  gross_total_money?: number | string | null;
  total_money?: number | string | null;
  total_discount?: number | string | null;
  cost?: number | string | null;
  cost_total?: number | string | null;
  line_modifiers?: unknown[] | null;
}

export interface LoyverseTax {
  money_amount?: number | string | null;
}

export interface LoyverseReceipt {
  receipt_number: string;
  receipt_type: string;
  refund_for?: string | null;
  cancelled_at?: string | null;
  receipt_date: string;
  created_at: string;
  updated_at: string;
  store_id: string;
  total_money?: number | string | null;
  total_discount?: number | string | null;
  total_taxes?: LoyverseTax[] | null;
  tip?: number | string | null;
  surcharge?: number | string | null;
  dining_option?: string | null;
  line_items?: LoyverseLineItem[] | null;
}

export interface NormalizeOptions {
  timeZone: string;
  businessDayOffsetMinutes?: number;
  currency?: string;
}

/** Cadena vacía y `null` significan lo mismo viniendo del proveedor. */
function orNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

function normalizeLine(raw: LoyverseLineItem, lineIndex: number): NormalizedReceiptLine {
  return {
    lineIndex,
    providerItemId: orNull(raw.item_id),
    providerVariantId: orNull(raw.variant_id),
    sku: orNull(raw.sku),
    itemName: orNull(raw.item_name) ?? '(sin nombre)',
    variantName: orNull(raw.variant_name),
    quantity: Number(raw.quantity ?? 0),
    unitPriceCents: toCents(raw.price),
    grossTotalCents: toCents(raw.gross_total_money),
    // VERIFICADO: `total_money` del renglón ya incluye los modificadores.
    // Sobre 14 modificadores con precio en el histórico real se cumple
    // `price × quantity + modificadores = gross_total_money = total_money`.
    // Recalcularlo daría de menos justo en los platillos con extras.
    totalCents: toCents(raw.total_money),
    totalDiscountCents: toCents(raw.total_discount),
    costReportedCents: raw.cost == null ? null : toCents(raw.cost),
    costTotalReportedCents: raw.cost_total == null ? null : toCents(raw.cost_total),
  };
}

export function normalizeReceipt(
  raw: LoyverseReceipt,
  opts: NormalizeOptions,
): NormalizedReceipt {
  const tipo = String(raw.receipt_type ?? '').toUpperCase();
  if (tipo !== 'SALE' && tipo !== 'REFUND') {
    throw new TypeError(
      `Tipo de recibo desconocido en ${raw.receipt_number}: ${JSON.stringify(raw.receipt_type)}`,
    );
  }

  const lines = (raw.line_items ?? []).map(normalizeLine);

  // El costo del recibo no es un campo del proveedor: es la suma de sus
  // renglones. `null` solo si NINGÚN renglón reporta costo — un costo de 0.00
  // es un dato real (hay ítems sin costo cargado en el POS), no una ausencia.
  const conCosto = lines.filter((l) => l.costTotalReportedCents !== null);
  const totalCostReportedCents = conCosto.length
    ? conCosto.reduce((a, l) => a + (l.costTotalReportedCents ?? 0), 0)
    : null;

  return {
    providerStoreId: raw.store_id,
    receiptNumber: raw.receipt_number,
    receiptType: tipo as ReceiptType,
    // VERIFICADO: un reembolso es un recibo NUEVO que apunta al original, no
    // una edición. En el histórico, 9 de 11 apuntan a ventas de días anteriores.
    refundForReceiptNumber: orNull(raw.refund_for),
    cancelledAt: orNull(raw.cancelled_at),
    receiptDate: raw.receipt_date,
    businessDate: businessDate(
      raw.receipt_date,
      opts.timeZone,
      opts.businessDayOffsetMinutes ?? 0,
    ),
    // VERIFICADO: ya viene neto de descuento y CON el impuesto incluido.
    totalCents: toCents(raw.total_money),
    totalDiscountCents: toCents(raw.total_discount),
    // VERIFICADO: se LEE de cada recibo. Deducirlo dividiendo entre 1.16
    // fallaría en los 6 recibos del histórico que no traen impuesto.
    totalTaxCents: (raw.total_taxes ?? []).reduce((a, t) => a + toCents(t.money_amount), 0),
    tipCents: toCents(raw.tip),
    surchargeCents: toCents(raw.surcharge),
    totalCostReportedCents,
    diningOption: orNull(raw.dining_option),
    currency: opts.currency ?? 'MXN',
    providerCreatedAt: raw.created_at,
    providerUpdatedAt: raw.updated_at,
    lines,
  };
}

export function normalizeReceipts(
  raws: readonly LoyverseReceipt[],
  opts: NormalizeOptions,
): NormalizedReceipt[] {
  return raws.map((r) => normalizeReceipt(r, opts));
}
