// Formateo de moneda y números — español (México), MXN.
// Regla de diseño (§3.6): 2 decimales en montos mostrados; costos unitarios
// admiten más decimales para no perder precisión; porcentajes con 1 decimal.

const mxn = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Monto mostrado, 2 decimales: `$1,234.50`. */
export function formatMXN(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return mxn.format(value);
}

/**
 * Costo unitario con más precisión (ej. `$0.0391/g`). Recorta ceros finales
 * pero garantiza al menos 2 decimales.
 */
export function formatUnitCost(
  value: number | null | undefined,
  symbol?: string,
): string {
  if (value == null || Number.isNaN(value)) return '—';
  const decimals = value !== 0 && Math.abs(value) < 1 ? 4 : 2;
  const fmt = new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
  const base = fmt.format(value);
  return symbol ? `${base}/${symbol}` : base;
}

/** Porcentaje con 1 decimal: `28.4%`. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toLocaleString('es-MX', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

/** Número simple (cantidades de rendimiento, factores). */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toLocaleString('es-MX', { maximumFractionDigits: 4 });
}
