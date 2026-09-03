// Reglas de negocio de ventas — épica 02 §8.
//
// Estas seis cifras cuadraron con diferencia de $0.00 contra el reporte
// agregado del Back Office de Loyverse sobre los 104 días del histórico
// completo de Kumobi. Cada regla de aquí está verificada, no supuesta:
// ver `01-requerimientos/conciliacion-base-2026-09-01.md`.
//
// Tres trampas que esta función evita a propósito:
//   1. NO resta `totalDiscountCents`: el total del proveedor YA viene neto de
//      descuento. Restarlo otra vez es el doble conteo más fácil de cometer.
//   2. NO deduce el impuesto dividiendo entre 1.16: lo lee de cada recibo,
//      porque hay recibos sin impuesto en el histórico.
//   3. Agrupa por `businessDate` (hora local) y nunca por fecha UTC.

import type { NormalizedReceipt } from './types';

export interface DailyTotals {
  businessDate: string;
  /** Tickets netos: las ventas suman, los reembolsos restan. Puede ser negativo. */
  netTickets: number;
  /** Ventas netas CON impuestos incluidos. Es la cifra oficial del producto. */
  netSalesCents: number;
  /** Ventas netas SIN impuestos. Base correcta para el Food Cost. */
  netSalesExTaxCents: number;
  grossSalesCents: number;
  refundsCents: number;
  discountsCents: number;
  taxCents: number;
  /** Costo que reporta el POS. Segunda fuente para contrastar con las recetas. */
  costReportedCents: number;
}

function empty(businessDate: string): DailyTotals {
  return {
    businessDate,
    netTickets: 0,
    netSalesCents: 0,
    netSalesExTaxCents: 0,
    grossSalesCents: 0,
    refundsCents: 0,
    discountsCents: 0,
    taxCents: 0,
    costReportedCents: 0,
  };
}

/**
 * Totales por fecha de negocio.
 *
 * Los recibos cancelados se excluyen por completo — incluido el caso de una
 * venta y su reembolso cancelados en par, que al excluirse ambos no altera
 * ningún total.
 *
 * Un reembolso resta el día en que se REGISTRÓ, no el de la venta original.
 * En el histórico real, 9 de 11 reembolsos apuntan a ventas de días anteriores
 * y por eso hay días con ventas netas negativas: es correcto, no es basura.
 */
export function dailyTotals(receipts: readonly NormalizedReceipt[]): Map<string, DailyTotals> {
  const out = new Map<string, DailyTotals>();

  for (const r of receipts) {
    if (r.cancelledAt) continue;

    const day = out.get(r.businessDate) ?? empty(r.businessDate);
    const sign = r.receiptType === 'REFUND' ? -1 : 1;
    const cost = r.totalCostReportedCents ?? 0;

    day.netTickets += sign;
    day.netSalesCents += r.totalCents * sign;
    day.taxCents += r.totalTaxCents * sign;
    day.costReportedCents += cost * sign;
    day.netSalesExTaxCents += (r.totalCents - r.totalTaxCents) * sign;

    if (sign === 1) {
      // Ventas brutas = suma del bruto de los renglones, antes de descuentos.
      day.grossSalesCents += r.lines.reduce((a, l) => a + l.grossTotalCents, 0);
      day.discountsCents += r.totalDiscountCents;
    } else {
      // El reembolso se acumula en positivo, igual que en el reporte del POS.
      day.refundsCents += r.totalCents;
    }

    out.set(r.businessDate, day);
  }

  return out;
}

/** Suma de un conjunto de totales diarios, para el renglón de TOTAL. */
export function sumTotals(days: Iterable<DailyTotals>): Omit<DailyTotals, 'businessDate'> {
  const t = empty('');
  for (const d of days) {
    t.netTickets += d.netTickets;
    t.netSalesCents += d.netSalesCents;
    t.netSalesExTaxCents += d.netSalesExTaxCents;
    t.grossSalesCents += d.grossSalesCents;
    t.refundsCents += d.refundsCents;
    t.discountsCents += d.discountsCents;
    t.taxCents += d.taxCents;
    t.costReportedCents += d.costReportedCents;
  }
  const { businessDate: _omit, ...rest } = t;
  return rest;
}
