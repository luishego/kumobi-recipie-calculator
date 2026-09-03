import { describe, it, expect } from 'vitest';
import { conReintentos, esperaPara } from './retry';
import { SalesProviderError } from '../provider';

const sinEspera = async () => {};
const randomFijo = () => 0.5; // factor 1.0: sin variación

describe('qué se reintenta', () => {
  it('reintenta el límite de solicitudes y termina bien', async () => {
    let intentos = 0;
    const r = await conReintentos(
      async () => {
        if (++intentos < 3) throw new SalesProviderError('RATE_LIMITED', '429');
        return 'listo';
      },
      { sleep: sinEspera, random: randomFijo },
    );
    expect(r).toBe('listo');
    expect(intentos).toBe(3);
  });

  it('reintenta los fallos transitorios del proveedor', async () => {
    let intentos = 0;
    await conReintentos(
      async () => {
        if (++intentos < 2) throw new SalesProviderError('PROVIDER_UNAVAILABLE', '503');
        return null;
      },
      { sleep: sinEspera, random: randomFijo },
    );
    expect(intentos).toBe(2);
  });

  it('NO reintenta un token inválido: esperar no lo arregla', async () => {
    let intentos = 0;
    await expect(
      conReintentos(
        async () => {
          intentos++;
          throw new SalesProviderError('INVALID_TOKEN', 'revocado');
        },
        { sleep: sinEspera, random: randomFijo },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(intentos).toBe(1);
  });

  it('NO reintenta un error que no sea del proveedor', async () => {
    let intentos = 0;
    await expect(
      conReintentos(
        async () => {
          intentos++;
          throw new TypeError('bug de programación');
        },
        { sleep: sinEspera },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(intentos).toBe(1);
  });

  it('se rinde tras el máximo de intentos y propaga el último error', async () => {
    let intentos = 0;
    await expect(
      conReintentos(
        async () => {
          intentos++;
          throw new SalesProviderError('RATE_LIMITED', 'sigue saturado');
        },
        { maxIntentos: 3, sleep: sinEspera, random: randomFijo },
      ),
    ).rejects.toThrow('sigue saturado');
    expect(intentos).toBe(3);
  });
});

describe('cuánto se espera', () => {
  const base = { baseMs: 1000, maxMs: 30_000, random: randomFijo };

  it('crece exponencialmente', () => {
    const err = new SalesProviderError('RATE_LIMITED', 'x');
    expect(esperaPara(1, err, base)).toBe(1000);
    expect(esperaPara(2, err, base)).toBe(2000);
    expect(esperaPara(3, err, base)).toBe(4000);
  });

  it('se topa en el máximo', () => {
    const err = new SalesProviderError('RATE_LIMITED', 'x');
    expect(esperaPara(20, err, base)).toBe(30_000);
  });

  it('hace caso al Retry-After del proveedor', () => {
    const err = new SalesProviderError('RATE_LIMITED', 'x', 5_000);
    expect(esperaPara(1, err, base)).toBe(5_000);
  });

  it('la variación aleatoria desincroniza reintentos simultáneos', () => {
    const err = new SalesProviderError('RATE_LIMITED', 'x');
    const bajo = esperaPara(2, err, { ...base, random: () => 0 });
    const alto = esperaPara(2, err, { ...base, random: () => 1 });
    // Sin variación, dos sucursales que chocan a la vez volverían a chocar.
    expect(bajo).toBeLessThan(alto);
    expect(bajo).toBe(1400); // 2000 × 0.7
    expect(alto).toBe(2600); // 2000 × 1.3
  });
});
