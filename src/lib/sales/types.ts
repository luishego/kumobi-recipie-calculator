// Modelo normalizado de ventas — épica 02 §7.
//
// AGNÓSTICO AL PROVEEDOR: ningún nombre de campo de Loyverse llega hasta aquí.
// Lo que el adapter devuelve ya está en estos tipos; el resto del sistema no
// sabe de qué POS vinieron los datos.

export type ProviderId = 'loyverse';

export type ReceiptType = 'SALE' | 'REFUND';

/** Sucursal tal como la reporta el proveedor, antes de asociarla a un inquilino. */
export interface ProviderStore {
  providerStoreId: string;
  name: string;
}

export interface NormalizedReceiptLine {
  lineIndex: number;
  providerItemId: string | null;
  providerVariantId: string | null;
  sku: string | null;
  /** Snapshot: el nombre tal como estaba al momento de la venta. */
  itemName: string;
  variantName: string | null;
  /** Decimal a propósito: media pieza o 0.75 kg son cantidades legítimas. */
  quantity: number;
  unitPriceCents: number;
  grossTotalCents: number;
  /**
   * Neto del renglón. YA incluye los modificadores y YA viene neto de
   * descuento: usar esta cifra y nunca recalcular `quantity * unitPriceCents`.
   */
  totalCents: number;
  totalDiscountCents: number;
  costReportedCents: number | null;
  costTotalReportedCents: number | null;
}

export interface NormalizedReceipt {
  providerStoreId: string;
  /** Único solo DENTRO de una cuenta (formato "1-0086"). */
  receiptNumber: string;
  receiptType: ReceiptType;
  /** Número del recibo original, si este es un reembolso. */
  refundForReceiptNumber: string | null;
  cancelledAt: string | null;
  /** Instante de la venta, ISO-8601 UTC. */
  receiptDate: string;
  /** Fecha local de la sucursal, "YYYY-MM-DD". Base de todo agrupamiento. */
  businessDate: string;
  /** Total cobrado: con impuestos incluidos y ya neto de descuento. */
  totalCents: number;
  /** Informativo. NO restarlo de `totalCents`: sería doble conteo. */
  totalDiscountCents: number;
  totalTaxCents: number;
  tipCents: number;
  surchargeCents: number;
  /** Suma del costo reportado por el POS en los renglones. */
  totalCostReportedCents: number | null;
  diningOption: string | null;
  currency: string;
  providerCreatedAt: string;
  /** Base de la sincronización incremental: se filtra por actualización. */
  providerUpdatedAt: string;
  lines: NormalizedReceiptLine[];
}
