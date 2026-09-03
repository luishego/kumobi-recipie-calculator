// COMPUERTA HU-16 — conciliación contra el reporte agregado del Back Office.
//
// Esta prueba es la conciliación manual del 2026-09-01 convertida en regresión
// permanente. Normaliza el histórico completo de Kumobi con las reglas de §8 y
// exige **$0.00 de diferencia en seis campos sobre los 104 días naturales**
// contra el reporte que exportó el propio Loyverse.
//
// Se comparan seis campos y no solo el total a propósito: cuadrar un total por
// compensación de dos errores es posible; cuadrar los seis, no.
//
// Si algún día esta prueba falla, alguien rompió una de las reglas verificadas:
//   · restar el descuento del total (ya viene neto) → falla "Ventas netas"
//   · deducir el IVA dividiendo entre 1.16      → fallan los días sin impuesto
//   · agrupar por fecha UTC                     → fallan ~60 % de los días
//   · imputar el reembolso al día de la venta   → falla el 2026-06-09
//   · incluir los recibos cancelados            → falla el 2026-09-01
//   · recalcular el renglón como cantidad×precio → falla "Ventas brutas"
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeReceipts, type LoyverseReceipt } from './loyverse/normalize';
import { dailyTotals, sumTotals, type DailyTotals } from './aggregate';
import { toCents, formatMxn } from './money';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

interface FilaReporte {
  brutas: number;
  reembolsos: number;
  descuentos: number;
  netas: number;
  costo: number;
  impuestos: number;
}

/** Reporte del Back Office: "Fecha,Ventas brutas,Reembolsos,Descuentos,Ventas netas,Costo…,…,…,Impuestos" */
function leerReporte(csv: string): Map<string, FilaReporte> {
  const out = new Map<string, FilaReporte>();
  for (const linea of csv.trim().split(/\r?\n/).slice(1)) {
    if (!linea.trim()) continue;
    const c = linea.split(',');
    const [d, m, y] = c[0]!.split('/');
    out.set(`20${y}-${m}-${d}`, {
      brutas: toCents(c[1]),
      reembolsos: toCents(c[2]),
      descuentos: toCents(c[3]),
      netas: toCents(c[4]),
      costo: toCents(c[5]),
      impuestos: toCents(c[8]),
    });
  }
  return out;
}

const crudos: LoyverseReceipt[] = JSON.parse(
  readFileSync(join(FIXTURES, 'loyverse-historico-2026-05-21_2026-09-01.json'), 'utf8'),
).receipts;

const reporte = leerReporte(
  readFileSync(join(FIXTURES, 'back-office-2026-05-21_2026-09-01.csv'), 'utf8'),
);

// La sucursal KUMOBI opera en hora de la Ciudad de México.
const normalizados = normalizeReceipts(crudos, { timeZone: 'America/Mexico_City' });
const nuestros = dailyTotals(normalizados);
const dias = [...reporte.keys()].sort();

const CAMPOS: ReadonlyArray<[string, (d: DailyTotals) => number, (f: FilaReporte) => number]> = [
  ['Ventas netas', (d) => d.netSalesCents, (f) => f.netas],
  ['Ventas brutas', (d) => d.grossSalesCents, (f) => f.brutas],
  ['Reembolsos', (d) => d.refundsCents, (f) => f.reembolsos],
  ['Descuentos', (d) => d.discountsCents, (f) => f.descuentos],
  ['Impuestos', (d) => d.taxCents, (f) => f.impuestos],
  ['Costo de los bienes', (d) => d.costReportedCents, (f) => f.costo],
];

const VACIO: DailyTotals = {
  businessDate: '',
  netTickets: 0,
  netSalesCents: 0,
  netSalesExTaxCents: 0,
  grossSalesCents: 0,
  refundsCents: 0,
  discountsCents: 0,
  taxCents: 0,
  costReportedCents: 0,
};

describe('conciliación contra el Back Office de Loyverse', () => {
  it('el histórico completo entra en el rango del reporte', () => {
    expect(crudos).toHaveLength(108);
    expect(dias).toHaveLength(104);
    const fuera = [...nuestros.keys()].filter((d) => !reporte.has(d));
    expect(fuera, 'días nuestros fuera del rango del reporte').toEqual([]);
  });

  describe.each(CAMPOS)('%s', (nombre, nuestro, suyo) => {
    it('cuadra día por día', () => {
      const difs = dias
        .map((dia) => {
          const a = nuestro(nuestros.get(dia) ?? VACIO);
          const b = suyo(reporte.get(dia)!);
          return a === b ? null : `${dia}: nuestro ${formatMxn(a)} vs Loyverse ${formatMxn(b)}`;
        })
        .filter((x): x is string => x !== null);
      expect(difs, `${nombre} — días con diferencia`).toEqual([]);
    });

    it('cuadra en el total del periodo', () => {
      const a = dias.reduce((s, d) => s + nuestro(nuestros.get(d) ?? VACIO), 0);
      const b = dias.reduce((s, d) => s + suyo(reporte.get(d)!), 0);
      expect(formatMxn(a)).toBe(formatMxn(b));
    });
  });

  it('la cobertura de días con actividad es idéntica', () => {
    const conActividadNuestra = dias.filter((d) => (nuestros.get(d)?.netTickets ?? 0) !== 0);
    const conActividadSuya = dias.filter((d) => {
      const f = reporte.get(d)!;
      return f.netas !== 0 || f.brutas !== 0;
    });
    expect(conActividadNuestra).toEqual(conActividadSuya);
    expect(conActividadNuestra).toHaveLength(42);
  });

  it('reproduce las cifras de referencia de la épica', () => {
    const t = sumTotals(nuestros.values());
    expect(formatMxn(t.netSalesCents)).toBe(formatMxn(3548133));
    expect(formatMxn(t.grossSalesCents)).toBe(formatMxn(4362238));
    expect(formatMxn(t.refundsCents)).toBe(formatMxn(670000));
    expect(formatMxn(t.discountsCents)).toBe(formatMxn(144105));
    expect(formatMxn(t.taxCents)).toBe(formatMxn(489389));
    expect(formatMxn(t.costReportedCents)).toBe(formatMxn(777351));
    // Ventas sin impuestos: base del Food Cost, no cuadra contra el reporte
    // porque Loyverse no publica esa cifra — la publica con IVA incluido.
    expect(formatMxn(t.netSalesExTaxCents)).toBe(formatMxn(3058744));
  });
});

describe('los casos difíciles del histórico', () => {
  it('un día puede dar negativo: el 9 de junio tiene 10 reembolsos de días anteriores', () => {
    const d = nuestros.get('2026-06-09')!;
    expect(d.netSalesCents).toBe(-585200);
    expect(d.netTickets).toBeLessThan(0);
    expect(d.netSalesCents).toBe(reporte.get('2026-06-09')!.netas);
  });

  it('el par cancelado del 1 de septiembre no altera ningún total', () => {
    expect(nuestros.get('2026-09-01')?.netSalesCents ?? 0).toBe(0);
    expect(reporte.get('2026-09-01')!.netas).toBe(0);
  });

  it('los días sin impuesto cuadran sin inventar IVA', () => {
    for (const dia of ['2026-05-21', '2026-06-02']) {
      expect(nuestros.get(dia)!.taxCents, dia).toBe(0);
      expect(reporte.get(dia)!.impuestos, dia).toBe(0);
      expect(nuestros.get(dia)!.netSalesCents).toBe(reporte.get(dia)!.netas);
    }
  });
});
