// Formateo de moneda, números y fechas de interfaz — español (México), MXN.
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

// ── Fechas para los selectores de la interfaz ───────────────────────────────
//
// Van en el día LOCAL de quien mira, no en día UTC. `toISOString()` daría el
// segundo, y en México eso significa que a partir de las 18:00 un selector
// ofrece MAÑANA como fecha máxima y arranca pidiendo un día que todavía no
// ocurre: un rango que no puede traer nada. 'en-CA' produce "YYYY-MM-DD"
// directamente, la misma forma que usa `businessDate`.
//
// Esto vale solo para la interfaz. En el servidor el día se calcula con la zona
// de la SUCURSAL (`businessDate`) o en UTC a propósito (la cuota diaria de D1,
// que Cloudflare cuenta así).

/** Hoy, en el día local de quien mira: "YYYY-MM-DD". */
export function hoyLocal(): string {
  return new Date().toLocaleDateString('en-CA');
}

/** Hace `n` días, en día local: "YYYY-MM-DD". */
export function haceDiasLocal(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA');
}
