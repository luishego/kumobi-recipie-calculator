import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseBackOfficeCsv, conciliar, BackOfficeCsvError, ETIQUETAS,
} from './backOfficeCsv';
import { normalizeReceipts, type LoyverseReceipt } from './loyverse/normalize';
import { dailyTotals } from './aggregate';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const CSV = readFileSync(join(FIXTURES, 'back-office-2026-05-21_2026-09-01.csv'), 'utf8');
const crudos: LoyverseReceipt[] = JSON.parse(
  readFileSync(join(FIXTURES, 'loyverse-historico-2026-05-21_2026-09-01.json'), 'utf8'),
).receipts;
const NUESTROS = [
  ...dailyTotals(normalizeReceipts(crudos, { timeZone: 'America/Mexico_City' })).values(),
];

describe('lectura del reporte', () => {
  it('lee el export real del Back Office', () => {
    const filas = parseBackOfficeCsv(CSV);
    expect(filas).toHaveLength(104);
    const uno = filas.find((f) => f.businessDate === '2026-08-30')!;
    expect(uno.netas).toBe(20938);
    expect(uno.impuestos).toBe(2888);
  });

  it('convierte dd/mm/aa a fecha ISO', () => {
    const filas = parseBackOfficeCsv(CSV);
    expect(filas[0]!.businessDate).toBe('2026-09-01');
    expect(filas.at(-1)!.businessDate).toBe('2026-05-21');
  });

  it('ubica las columnas por nombre, no por posición', () => {
    // Se agrega una columna al inicio y otra al final: debe seguir funcionando.
    const conExtras = CSV.split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l, i) => (i === 0 ? `Sucursal,${l},Notas` : `KUMOBI,${l},`))
      .join('\n');
    const filas = parseBackOfficeCsv(conExtras);
    expect(filas.find((f) => f.businessDate === '2026-08-30')!.netas).toBe(20938);
  });

  it('dice qué columna falta si el archivo no es el reporte esperado', () => {
    expect(() => parseBackOfficeCsv('a,b,c\n1,2,3')).toThrow(BackOfficeCsvError);
    // Nombra la columna concreta que falta y orienta sobre qué archivo se espera.
    expect(() => parseBackOfficeCsv('a,b,c\n1,2,3')).toThrow(/falta la columna/i);
    expect(() => parseBackOfficeCsv('a,b,c\n1,2,3')).toThrow(/Back Office/i);
    // Y si solo falta una de las de importe, la nombra a ella.
    const sinImpuestos = 'Fecha,Ventas brutas,Reembolsos,Descuentos,Ventas netas,Costo de los bienes\n01/09/26,0,0,0,0,0';
    expect(() => parseBackOfficeCsv(sinImpuestos)).toThrow(/impuestos/i);
  });

  it('rechaza un archivo vacío', () => {
    expect(() => parseBackOfficeCsv('')).toThrow(/vacío/i);
  });
});

describe('conciliación', () => {
  const resultado = conciliar(NUESTROS, parseBackOfficeCsv(CSV));

  it('CUADRA sobre el histórico completo', () => {
    expect(resultado.cuadra).toBe(true);
    expect(resultado.diasConDiferencia).toEqual([]);
  });

  it('y la verificación es completa: no queda nada sin mirar', () => {
    expect(resultado.verificacionCompleta).toBe(true);
  });

  it('los seis totales coinciden', () => {
    for (const campo of Object.keys(ETIQUETAS) as (keyof typeof ETIQUETAS)[]) {
      expect(resultado.totales[campo].diff, ETIQUETAS[campo]).toBe(0);
    }
    expect(resultado.totales.netas.nuestro).toBe(3548133);
  });

  it('la cobertura de días es idéntica', () => {
    expect(resultado.cobertura.nuestros).toBe(42);
    expect(resultado.cobertura.suyos).toBe(42);
    expect(resultado.cobertura.soloNuestros).toEqual([]);
    expect(resultado.cobertura.soloSuyos).toEqual([]);
  });

  it('no deja días nuestros fuera del rango del reporte', () => {
    expect(resultado.fueraDeRango).toEqual([]);
  });
});

describe('cuando NO cuadra, señala dónde', () => {
  it('detecta una diferencia en un solo campo y un solo día', () => {
    const alterado = NUESTROS.map((d) =>
      d.businessDate === '2026-08-30' ? { ...d, taxCents: d.taxCents + 1 } : d,
    );
    const r = conciliar(alterado, parseBackOfficeCsv(CSV));

    expect(r.cuadra).toBe(false);
    expect(r.diasConDiferencia).toHaveLength(1);
    expect(r.diasConDiferencia[0]!.businessDate).toBe('2026-08-30');
    expect(r.diasConDiferencia[0]!.campos.impuestos.diff).toBe(1);
    // Los demás campos de ese día siguen cuadrando: la diferencia queda acotada.
    expect(r.diasConDiferencia[0]!.campos.netas.diff).toBe(0);
  });

  it('un día nuestro con ventas que el reporte no tiene aparece en la cobertura', () => {
    const inventado = [
      ...NUESTROS,
      {
        businessDate: '2026-08-31', netTickets: 1, netSalesCents: 100,
        netSalesExTaxCents: 100, grossSalesCents: 100, refundsCents: 0,
        discountsCents: 0, taxCents: 0, costReportedCents: 0,
      },
    ];
    const r = conciliar(inventado, parseBackOfficeCsv(CSV));
    expect(r.cuadra).toBe(false);
    expect(r.cobertura.soloNuestros).toContain('2026-08-31');
  });

  it('avisa de los días nuestros que el reporte no cubre', () => {
    const recortado = parseBackOfficeCsv(CSV).filter((f) => f.businessDate >= '2026-06-10');
    const r = conciliar(NUESTROS, recortado);
    // Los 7 días de mayo y principios de junio no se pueden conciliar con un
    // reporte que empieza el 10 de junio.
    expect(r.fueraDeRango).toContain('2026-05-21');
    expect(r.fueraDeRango).toContain('2026-06-09');
  });

  it('cuadrar NO es lo mismo que estar verificado', () => {
    // Un reporte recortado puede cuadrar perfectamente en lo que trae y aun así
    // dejar días enteros sin comprobar. La compuerta no debe darlo por bueno.
    const recortado = parseBackOfficeCsv(CSV).filter((f) => f.businessDate >= '2026-06-10');
    const r = conciliar(NUESTROS, recortado);
    expect(r.cuadra).toBe(true);
    expect(r.verificacionCompleta).toBe(false);
  });

  it('una cobertura dispar tampoco cuenta como verificación completa', () => {
    const conDiaExtra = [
      ...NUESTROS,
      {
        businessDate: '2026-08-31', netTickets: 1, netSalesCents: 0,
        netSalesExTaxCents: 0, grossSalesCents: 0, refundsCents: 0,
        discountsCents: 0, taxCents: 0, costReportedCents: 0,
      },
    ];
    const r = conciliar(conDiaExtra, parseBackOfficeCsv(CSV));
    // Los importes cuadran (todos en cero ese día), pero nosotros contamos un
    // ticket donde Loyverse no cuenta ninguno.
    expect(r.cuadra).toBe(true);
    expect(r.cobertura.soloNuestros).toContain('2026-08-31');
    expect(r.verificacionCompleta).toBe(false);
  });
});
