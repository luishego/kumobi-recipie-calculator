// Dinero en centavos enteros — épica 02 §5.10.
//
// Por qué enteros y no coma flotante:
//   · El criterio de la compuerta HU-16 es una diferencia de $0.00 EXACTOS
//     contra el reporte del Back Office. Sumar cientos de flotantes de 64 bits
//     no lo garantiza.
//   · `REAL` es afinidad de SQLite: al migrar a otro motor obligaría a decidir
//     entre NUMERIC y double precision sobre datos ya cargados. Los enteros
//     migran sin decisión.
//
// Del adapter hacia adentro del sistema NO circula dinero en coma flotante.

/**
 * Convierte un importe del proveedor a centavos enteros.
 *
 * Acepta número (como lo entrega `JSON.parse`) o cadena decimal. Loyverse
 * entrega dos decimales exactos, pero la ruta de cadena redondea el tercero
 * por si algún proveedor futuro trae más precisión.
 */
export function toCents(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Importe no finito: ${value}`);
    }
    return Math.round(value * 100);
  }

  if (typeof value === 'string') {
    const m = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/.exec(value);
    if (!m) throw new TypeError(`Importe no reconocido: ${JSON.stringify(value)}`);
    const sign = m[1] ? -1 : 1;
    const whole = Number(m[2]);
    const frac = m[3] ?? '';
    const centavos = Number((frac + '00').slice(0, 2));
    const tercerDecimal = Number(frac[2] ?? '0');
    return sign * (whole * 100 + centavos + (tercerDecimal >= 5 ? 1 : 0));
  }

  throw new TypeError(`Tipo de importe no soportado: ${typeof value}`);
}

/** Centavos → pesos. Solo para presentar; nunca para acumular. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** Formato de presentación en MXN. */
export function formatMxn(cents: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
  }).format(fromCents(cents));
}
