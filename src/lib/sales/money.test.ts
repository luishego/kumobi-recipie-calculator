import { describe, it, expect } from 'vitest';
import { toCents, fromCents, formatMxn } from './money';

describe('toCents', () => {
  it('convierte los importes tal como los entrega Loyverse', () => {
    // Valores reales del histórico de Kumobi.
    expect(toCents(209.38)).toBe(20938);
    expect(toCents(100.0)).toBe(10000);
    expect(toCents(1605)).toBe(160500);
    expect(toCents(0)).toBe(0);
  });

  it('no arrastra el error de la coma flotante en los importes que sí lo tienen', () => {
    // 14 importes del histórico real de Kumobi dan un producto no entero al
    // multiplicarlos por 100. Truncar en vez de redondear perdería un centavo
    // en unos y lo inventaría en otros: 38.62 se convertiría en 3861.
    expect(19.17 * 100).not.toBe(1917); // 1917.0000000000002
    expect(38.62 * 100).not.toBe(3862); // 3861.9999999999995
    expect(toCents(19.17)).toBe(1917);
    expect(toCents(38.62)).toBe(3862);
    expect(toCents(69.54)).toBe(6954);
    expect(toCents(34.34)).toBe(3434);

    // Y el caso de manual: acumular en centavos enteros es exacto.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toCents(0.1) + toCents(0.2)).toBe(toCents(0.3));
  });

  it('trata la ausencia como cero', () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents('')).toBe(0);
  });

  it('acepta cadenas decimales y redondea el tercer decimal', () => {
    expect(toCents('209.38')).toBe(20938);
    expect(toCents('1605')).toBe(160500);
    expect(toCents('10.005')).toBe(1001);
    expect(toCents('10.004')).toBe(1000);
    expect(toCents('-50.25')).toBe(-5025);
  });

  it('rechaza lo que no es un importe', () => {
    expect(() => toCents('doscientos')).toThrow();
    expect(() => toCents(Number.NaN)).toThrow();
    expect(() => toCents(Infinity)).toThrow();
  });
});

describe('presentación', () => {
  it('fromCents solo divide', () => {
    expect(fromCents(20938)).toBe(209.38);
  });

  it('formatMxn produce moneda mexicana', () => {
    // El separador de miles y el espacio pueden variar por ICU; se comprueba
    // lo estable: símbolo, dígitos y dos decimales.
    const s = formatMxn(20938);
    expect(s).toContain('$');
    expect(s).toContain('209');
    expect(s).toMatch(/\.38$/);
  });
});
