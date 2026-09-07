import { describe, it, expect } from 'vitest';
import {
  businessDate,
  inicioDelDiaUtc,
  diaSiguiente,
  rangoUtcDeDiasLocales,
} from './businessDate';

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


// ── Conversión inversa: fecha local → instante UTC (HU-15) ──────────────────

describe('inicioDelDiaUtc', () => {
  it('México es UTC−6 todo el año: el día local empieza a las 06:00Z', () => {
    expect(inicioDelDiaUtc('2026-08-01', 'America/Mexico_City')).toBe(
      '2026-08-01T06:00:00.000Z',
    );
    // En enero da lo mismo, porque no hay horario de verano desde 2022.
    expect(inicioDelDiaUtc('2026-01-15', 'America/Mexico_City')).toBe(
      '2026-01-15T06:00:00.000Z',
    );
  });

  it('es el inverso exacto de businessDate: el instante devuelto ES ese día', () => {
    // La prueba que de verdad importa. Si esta pasa para varias zonas y varias
    // fechas, la conversión no puede estar desplazada por una hora ni por un
    // día, que son los dos errores que producirían un reporte creíble y falso.
    const zonas = ['America/Mexico_City', 'UTC', 'Europe/Madrid', 'Asia/Tokyo', 'America/New_York'];
    const fechas = ['2026-01-01', '2026-03-29', '2026-07-15', '2026-10-25', '2026-12-31'];

    for (const tz of zonas) {
      for (const f of fechas) {
        const inicio = inicioDelDiaUtc(f, tz);
        expect(businessDate(inicio, tz), `${f} en ${tz}`).toBe(f);

        // Y un milisegundo antes tiene que ser el día ANTERIOR: eso fija el
        // límite exactamente, no "por ahí".
        const justoAntes = new Date(Date.parse(inicio) - 1).toISOString();
        expect(businessDate(justoAntes, tz), `límite de ${f} en ${tz}`).not.toBe(f);
      }
    }
  });

  it('sobrevive a un cambio de horario de verano', () => {
    // Madrid adelanta el reloj el 29 de marzo de 2026 a las 02:00 locales.
    // El día empieza antes de la transición, así que sigue siendo UTC+1.
    expect(inicioDelDiaUtc('2026-03-29', 'Europe/Madrid')).toBe('2026-03-28T23:00:00.000Z');
    // Y el día siguiente ya corre en UTC+2.
    expect(inicioDelDiaUtc('2026-03-30', 'Europe/Madrid')).toBe('2026-03-29T22:00:00.000Z');
  });

  it('rechaza una fecha que no tenga la forma esperada', () => {
    expect(() => inicioDelDiaUtc('1 de agosto', 'UTC')).toThrow(TypeError);
    expect(() => inicioDelDiaUtc('2026-8-1', 'UTC')).toThrow(TypeError);
  });
});

describe('diaSiguiente', () => {
  it('cruza fin de mes y fin de año', () => {
    expect(diaSiguiente('2026-01-31')).toBe('2026-02-01');
    expect(diaSiguiente('2026-12-31')).toBe('2027-01-01');
  });

  it('conoce los años bisiestos', () => {
    expect(diaSiguiente('2028-02-28')).toBe('2028-02-29');
    expect(diaSiguiente('2026-02-28')).toBe('2026-03-01');
  });
});

describe('rangoUtcDeDiasLocales', () => {
  it('el límite superior es exclusivo, en el inicio del día siguiente', () => {
    const r = rangoUtcDeDiasLocales('2026-08-01', '2026-08-03', 'America/Mexico_City');
    expect(r.desdeUtc).toBe('2026-08-01T06:00:00.000Z');
    // Si fuera el inicio del 3, se perdería el día 3 completo.
    expect(r.hastaUtcExclusivo).toBe('2026-08-04T06:00:00.000Z');
  });

  it('el último día pedido queda dentro, hasta su último instante', () => {
    const { hastaUtcExclusivo } = rangoUtcDeDiasLocales(
      '2026-08-01', '2026-08-03', 'America/Mexico_City',
    );
    const ultimoInstante = new Date(Date.parse(hastaUtcExclusivo) - 1).toISOString();
    expect(businessDate(ultimoInstante, 'America/Mexico_City')).toBe('2026-08-03');
  });

  it('rechaza un rango invertido', () => {
    expect(() =>
      rangoUtcDeDiasLocales('2026-08-05', '2026-08-01', 'America/Mexico_City'),
    ).toThrow(RangeError);
  });
});
