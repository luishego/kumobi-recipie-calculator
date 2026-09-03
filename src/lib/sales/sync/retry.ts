// Reintentos con espera creciente — épica 02, HU-12.
//
// Solo se reintenta lo que puede resolverse esperando: el límite de solicitudes
// (429) y los fallos transitorios del proveedor (5xx, red). Un token inválido
// no mejora con el tiempo, así que falla de inmediato y la cuenta se marca.
//
// La espera crece exponencialmente y lleva una variación aleatoria: si varias
// sucursales chocaran contra el límite a la vez, reintentar todas al mismo
// instante volvería a saturarlo.

import { SalesProviderError } from '../provider';

export interface RetryOptions {
  /** Intentos totales, incluido el primero. */
  maxIntentos?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Inyectable para que las pruebas sean deterministas. */
  random?: () => number;
  onRetry?: (intento: number, esperaMs: number, err: SalesProviderError) => void;
}

const REINTENTABLES = new Set(['RATE_LIMITED', 'PROVIDER_UNAVAILABLE']);

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function esperaPara(
  intento: number,
  err: SalesProviderError,
  o: { baseMs: number; maxMs: number; random: () => number },
): number {
  // Si el proveedor dice cuánto esperar, se le hace caso.
  if (err.retryAfterMs !== undefined) return Math.min(err.retryAfterMs, o.maxMs);
  const exponencial = Math.min(o.baseMs * 2 ** (intento - 1), o.maxMs);
  // Variación de hasta ±30 % para desincronizar reintentos simultáneos.
  const factor = 0.7 + o.random() * 0.6;
  return Math.round(Math.min(exponencial * factor, o.maxMs));
}

export async function conReintentos<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxIntentos = opts.maxIntentos ?? 4;
  const baseMs = opts.baseMs ?? 1_000;
  const maxMs = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? dormir;
  const random = opts.random ?? Math.random;

  let ultimo: unknown;
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      return await fn();
    } catch (err) {
      ultimo = err;
      const esProveedor = err instanceof SalesProviderError;
      // Un error no reintentable —token inválido, respuesta inesperada— se
      // propaga tal cual: insistir solo gastaría solicitudes.
      if (!esProveedor || !REINTENTABLES.has(err.code)) throw err;
      if (intento === maxIntentos) break;

      const espera = esperaPara(intento, err, { baseMs, maxMs, random });
      opts.onRetry?.(intento, espera, err);
      await sleep(espera);
    }
  }
  throw ultimo;
}
