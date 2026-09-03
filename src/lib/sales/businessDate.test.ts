import { describe, it, expect } from 'vitest';
import { businessDate } from './businessDate';

const MX = 'America/Mexico_City';

describe('businessDate', () => {
  it('imputa al día local, no al día UTC', () => {
    // Recibo real 1-0086 del histórico de Kumobi: vendido el 30 de agosto a las
    // 19:27 hora de México. Agrupado por UTC caería en el 31: el día equivocado.
    expect(businessDate('2026-08-31T01:27:27.000Z', MX)).toBe('2026-08-30');
    expect('2026-08-31T01:27:27.000Z'.slice(0, 10)).toBe('2026-08-31');
  });

  it('deja igual los recibos anteriores al corte UTC', () => {
    // Recibo real 1-0001: 21 de mayo a las 17:05 hora de México.
    expect(businessDate('2026-05-21T22:05:53.000Z', MX)).toBe('2026-05-21');
  });

  it('México no observa horario de verano: el desfase es el mismo todo el año', () => {
    // Si hubiera DST, una de estas dos daría un día distinto.
    expect(businessDate('2026-01-15T05:30:00.000Z', MX)).toBe('2026-01-14');
    expect(businessDate('2026-07-15T05:30:00.000Z', MX)).toBe('2026-07-14');
  });

  it('respeta la zona horaria de cada sucursal', () => {
    const instante = '2026-08-31T01:27:27.000Z';
    expect(businessDate(instante, 'America/Mexico_City')).toBe('2026-08-30');
    expect(businessDate(instante, 'UTC')).toBe('2026-08-31');
    expect(businessDate(instante, 'Asia/Tokyo')).toBe('2026-08-31');
  });

  it('aplica el desfase de cierre después de medianoche', () => {
    // Previsto en el esquema, sin usar en esta épica (siempre 0).
    // Un ticket de la 1:00 AM local con desfase de 4 h cuenta al día anterior.
    expect(businessDate('2026-08-31T07:00:00.000Z', MX, 0)).toBe('2026-08-31');
    expect(businessDate('2026-08-31T07:00:00.000Z', MX, 240)).toBe('2026-08-30');
  });

  it('rechaza una fecha ilegible', () => {
    expect(() => businessDate('ayer', MX)).toThrow();
  });
});
