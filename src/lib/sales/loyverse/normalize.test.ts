// Casos de normalización, sobre recibos REALES del histórico de Kumobi.
//
// Cada caso es un recibo concreto identificado por su número, no un ejemplo
// inventado: si el proveedor cambia algo, el test falla contra datos que de
// verdad existieron.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeReceipt, type LoyverseReceipt } from './normalize';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const RAW: LoyverseReceipt[] = JSON.parse(
  readFileSync(join(FIXTURES, 'loyverse-historico-2026-05-21_2026-09-01.json'), 'utf8'),
).receipts;

const OPTS = { timeZone: 'America/Mexico_City' };

function recibo(numero: string): LoyverseReceipt {
  const r = RAW.find((x) => x.receipt_number === numero);
  if (!r) throw new Error(`El fixture no tiene el recibo ${numero}`);
  return r;
}

describe('venta simple', () => {
  it('mapea el ticket 1-0086 completo', () => {
    const n = normalizeReceipt(recibo('1-0086'), OPTS);
    expect(n.receiptType).toBe('SALE');
    expect(n.totalCents).toBe(20938);
    expect(n.totalTaxCents).toBe(2888);
    expect(n.businessDate).toBe('2026-08-30'); // vendido a las 19:27 locales
    expect(n.refundForReceiptNumber).toBeNull();
    expect(n.cancelledAt).toBeNull();
    expect(n.currency).toBe('MXN');
  });
});

describe('modificadores con precio', () => {
  it('el total del renglón ya los incluye: no hay que sumarlos aparte', () => {
    // 1-0065: "Clásica 1/4 lb" a $99 con extra de $35 → $134.
    const n = normalizeReceipt(recibo('1-0065'), OPTS);
    const linea = n.lines.find((l) => l.itemName.includes('Clásica'));
    expect(linea).toBeDefined();
    expect(linea!.unitPriceCents).toBe(9900);
    expect(linea!.totalCents).toBe(13400);
    // La trampa: recalcular cantidad × precio da de menos.
    expect(linea!.quantity * linea!.unitPriceCents).toBe(9900);
    expect(linea!.quantity * linea!.unitPriceCents).not.toBe(linea!.totalCents);
  });

  it('la suma de los renglones cuadra con el total del recibo, siempre', () => {
    for (const raw of RAW) {
      const n = normalizeReceipt(raw, OPTS);
      const suma = n.lines.reduce((a, l) => a + l.totalCents, 0);
      expect(suma, `recibo ${n.receiptNumber}`).toBe(n.totalCents);
    }
  });
});

describe('descuentos', () => {
  it('el total ya viene neto: restar el descuento otra vez sería doble conteo', () => {
    // 1-0063: bruto $234, descuento $234, total $0.
    const n = normalizeReceipt(recibo('1-0063'), OPTS);
    expect(n.totalDiscountCents).toBe(23400);
    expect(n.totalCents).toBe(0);
    expect(n.totalCents - n.totalDiscountCents).toBe(-23400); // lo que NO hay que hacer
  });
});

describe('reembolsos', () => {
  it('es un recibo nuevo que apunta al original, no una edición', () => {
    // 1-0027 reembolsa el 9 de junio una venta del 21 de mayo.
    const n = normalizeReceipt(recibo('1-0027'), OPTS);
    expect(n.receiptType).toBe('REFUND');
    expect(n.refundForReceiptNumber).toBe('1-0001');
    expect(n.businessDate).toBe('2026-06-09');
    const original = normalizeReceipt(recibo('1-0001'), OPTS);
    expect(original.businessDate).toBe('2026-05-21');
    expect(n.businessDate).not.toBe(original.businessDate);
  });
});

describe('cancelaciones', () => {
  it('marca la venta y el reembolso cancelados del par de prueba', () => {
    expect(normalizeReceipt(recibo('2-0021'), OPTS).cancelledAt).not.toBeNull();
    expect(normalizeReceipt(recibo('2-0022'), OPTS).cancelledAt).not.toBeNull();
  });
});

describe('impuestos', () => {
  it('los lee de cada recibo: hay recibos sin impuesto en el histórico', () => {
    // 1-0001: $240.00 sin impuesto. Deducir el IVA dividiendo entre 1.16
    // habría inventado $33.10 que no existen.
    const sinIva = normalizeReceipt(recibo('1-0001'), OPTS);
    expect(sinIva.totalCents).toBe(24000);
    expect(sinIva.totalTaxCents).toBe(0);

    const conIva = normalizeReceipt(recibo('1-0086'), OPTS);
    expect(conIva.totalTaxCents).toBeGreaterThan(0);
  });
});

describe('propina y recargo', () => {
  it('en el histórico real siempre son cero', () => {
    for (const raw of RAW) {
      const n = normalizeReceipt(raw, OPTS);
      expect(n.tipCents, `recibo ${n.receiptNumber}`).toBe(0);
      expect(n.surchargeCents, `recibo ${n.receiptNumber}`).toBe(0);
    }
  });

  it('se mapean cuando aparecen (caso sintético: no hay datos reales)', () => {
    // Único riesgo semántico vivo de la épica. Este test fija el mapeo; lo que
    // no puede verificar es si el total del recibo incluye o no la propina.
    const base = structuredClone(recibo('1-0086'));
    base.tip = 25.5;
    base.surcharge = 10;
    const n = normalizeReceipt(base, OPTS);
    expect(n.tipCents).toBe(2550);
    expect(n.surchargeCents).toBe(1000);
  });
});

describe('robustez', () => {
  it('normaliza el histórico completo sin lanzar', () => {
    expect(RAW).toHaveLength(108);
    expect(() => RAW.map((r) => normalizeReceipt(r, OPTS))).not.toThrow();
  });

  it('rechaza un tipo de recibo desconocido', () => {
    const raro = { ...structuredClone(recibo('1-0086')), receipt_type: 'COTIZACION' };
    expect(() => normalizeReceipt(raro, OPTS)).toThrow(/desconocido/i);
  });
});
