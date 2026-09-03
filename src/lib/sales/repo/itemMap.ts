// Ítems vendidos y su mapeo a recetas — épica 02, HU-11.
//
// El mapeo se aplica EN LA CONSULTA (LEFT JOIN), nunca se congela en el
// renglón: corregir un mapeo mal hecho no obliga a re-descargar el histórico.
// Es la razón de que `sales_receipt_lines` no tenga `recipe_id`.
//
// Nota de portabilidad (§5.10): el nombre del ítem se toma del renglón MÁS
// RECIENTE con `ROW_NUMBER()`, no dejando la columna suelta en un `GROUP BY`.
// SQLite acepta lo segundo —toma el valor de la fila que ganó el MAX()— pero
// PostgreSQL lo rechaza, así que sería una consulta que solo funciona aquí.

import type { D1Database } from '@cloudflare/workers-types';
import { posItemMapId } from './ids';
import type { RangoFechas } from './totals';

/** Un ítem/variante del POS con lo que se vendió y su decisión de mapeo. */
export interface PosItemVendido {
  /** Llave compuesta; es también el id de la fila de `pos_item_map`. */
  clave: string;
  accountId: string;
  /** `null` en ítems abiertos del POS (venta sin producto de catálogo). */
  providerItemId: string | null;
  providerVariantId: string | null;
  sku: string | null;
  /** Nombre del renglón más reciente, no el primero que apareció. */
  itemName: string;
  variantName: string | null;
  /** Neto de reembolsos: puede ser negativo o cero. */
  unitsSold: number;
  revenueCents: number;
  lineCount: number;
  lastSoldDate: string;
  mapeo: MapeoItem | null;
}

export interface MapeoItem {
  kind: 'RECIPE' | 'IGNORED';
  /** `null` exactamente cuando `kind === 'IGNORED'`. */
  recipeId: string | null;
  method: 'auto_sku' | 'auto_name' | 'manual';
  confirmedByUser: boolean;
}

/** Alta o corrección de un mapeo. */
export interface EntradaMapeo {
  accountId: string;
  providerItemId: string;
  providerVariantId?: string | null;
  kind: 'RECIPE' | 'IGNORED';
  recipeId?: string | null;
  method: 'auto_sku' | 'auto_name' | 'manual';
  confirmedByUser?: boolean;
}

export interface CoberturaMapeo {
  /** Ingreso con receta asignada, en centavos. */
  mapeadoCents: number;
  /** Ingreso de ítems marcados "no aplica". */
  ignoradoCents: number;
  /** Ingreso todavía sin decidir: el hueco que impide cerrar el Food Cost. */
  sinMapearCents: number;
  itemsMapeados: number;
  itemsIgnorados: number;
  itemsSinMapear: number;
  /** Ítems sin id de producto en el POS: no son mapeables. */
  itemsNoMapeables: number;
  /**
   * Fracción del ingreso ya decidido (mapeado + ignorado) sobre el total, 0..1.
   * `null` cuando no hay ingreso en el rango y el porcentaje no significaría nada.
   */
  fraccionDecidida: number | null;
}

// El signo del recibo, igual que en `totals.ts`: las ventas suman, los
// reembolsos restan. Los renglones de un reembolso vienen en POSITIVO —
// verificado en el histórico real— así que el signo tiene que aplicarse aquí.
const SIGNO = `CASE WHEN r.receipt_type = 'REFUND' THEN -1 ELSE 1 END`;

const ITEMS_VENDIDOS = `
WITH lineas AS (
  SELECT
    l.id                                 AS line_id,
    r.account_id                         AS account_id,
    COALESCE(l.provider_item_id, '')     AS item_id,
    COALESCE(l.provider_variant_id, '')  AS variant_id,
    l.sku                                AS sku,
    l.item_name                          AS item_name,
    l.variant_name                       AS variant_name,
    l.business_date                      AS business_date,
    l.quantity * (${SIGNO})              AS qty,
    l.total_cents * (${SIGNO})           AS total_cents
  FROM sales_receipt_lines l
  JOIN sales_receipts r ON r.id = l.receipt_id
  WHERE l.tenant_id = ?1
    -- Los cancelados se excluyen por completo, igual que en los totales (§8).
    AND r.cancelled_at IS NULL
    AND l.business_date >= ?2 AND l.business_date <= ?3{{FILTRO}}
),
agregado AS (
  SELECT account_id, item_id, variant_id,
         SUM(qty)           AS units_sold,
         SUM(total_cents)   AS revenue_cents,
         COUNT(*)           AS line_count,
         MAX(business_date) AS last_sold_date
  FROM lineas
  GROUP BY account_id, item_id, variant_id
),
reciente AS (
  SELECT account_id, item_id, variant_id, sku, item_name, variant_name,
         ROW_NUMBER() OVER (
           PARTITION BY account_id, item_id, variant_id
           -- line_id desempata para que el resultado sea determinista
           -- cuando dos renglones del mismo día traen nombres distintos.
           ORDER BY business_date DESC, line_id DESC
         ) AS rn
  FROM lineas
)
SELECT
  a.account_id, a.item_id, a.variant_id,
  n.sku, n.item_name, n.variant_name,
  a.units_sold, a.revenue_cents, a.line_count, a.last_sold_date,
  m.recipe_id, m.kind, m.method, m.confirmed_by_user
FROM agregado a
JOIN reciente n
  ON  n.account_id = a.account_id
  AND n.item_id    = a.item_id
  AND n.variant_id = a.variant_id
  AND n.rn = 1
LEFT JOIN pos_item_map m
  ON  m.tenant_id           = ?1
  AND m.account_id          = a.account_id
  AND m.provider_item_id    = a.item_id
  AND m.provider_variant_id = a.variant_id
ORDER BY a.revenue_cents DESC, n.item_name ASC`;

// El INSERT toma sus valores de un SELECT con WHERE EXISTS para que la
// pertenencia de la cuenta al inquilino la compruebe la BASE. Pasar el
// `accountId` de otro inquilino no escribe nada, en lugar de crear una fila
// con `tenant_id` propio apuntando a una cuenta ajena.
//
// El WHERE no es opcional por otro motivo: en un `INSERT ... SELECT` con
// UPSERT, SQLite necesita un WHERE para no confundir el `ON CONFLICT` con el
// `ON` de un JOIN. Aquí cumple las dos funciones.
const UPSERT_MAPEO = `
INSERT INTO pos_item_map (
  id, tenant_id, account_id, provider_item_id, provider_variant_id,
  recipe_id, kind, method, confirmed_by_user, created_at, updated_at
)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10
WHERE EXISTS (SELECT 1 FROM sales_accounts WHERE id = ?3 AND tenant_id = ?2)
ON CONFLICT (id) DO UPDATE SET
  recipe_id         = excluded.recipe_id,
  kind              = excluded.kind,
  method            = excluded.method,
  confirmed_by_user = excluded.confirmed_by_user,
  updated_at        = excluded.updated_at`;

interface FilaItem {
  account_id: string;
  item_id: string;
  variant_id: string;
  sku: string | null;
  item_name: string;
  variant_name: string | null;
  units_sold: number;
  revenue_cents: number;
  line_count: number;
  last_sold_date: string;
  recipe_id: string | null;
  kind: 'RECIPE' | 'IGNORED' | null;
  method: 'auto_sku' | 'auto_name' | 'manual' | null;
  confirmed_by_user: number | null;
}

/** `''` es el centinela de "sin variante" en la base; fuera, es `null`. */
function orNull(v: string): string | null {
  return v === '' ? null : v;
}

export function createItemMapRepo(db: D1Database, tenantId: string) {
  return {
    /**
     * Ítems vendidos en el rango, del que más ingreso trae al que menos, con su
     * mapeo si ya lo tiene.
     *
     * Se ordena por ingreso a propósito: el ítem sin mapear que más factura es
     * el que más distorsiona el Food Cost, y es el que conviene resolver primero.
     */
    async listPosItems(
      rango: RangoFechas,
      opts: { storeId?: string } = {},
    ): Promise<PosItemVendido[]> {
      const sql = ITEMS_VENDIDOS.replace(
        '{{FILTRO}}',
        opts.storeId ? '\n    AND l.store_id = ?4' : '',
      );
      const args: unknown[] = [tenantId, rango.desde, rango.hasta];
      if (opts.storeId) args.push(opts.storeId);

      const { results } = await db.prepare(sql).bind(...args).all<FilaItem>();

      return (results ?? []).map((f) => ({
        clave: posItemMapId(f.account_id, f.item_id, f.variant_id),
        accountId: f.account_id,
        providerItemId: orNull(f.item_id),
        providerVariantId: orNull(f.variant_id),
        sku: f.sku,
        itemName: f.item_name,
        variantName: f.variant_name,
        unitsSold: f.units_sold ?? 0,
        revenueCents: f.revenue_cents ?? 0,
        lineCount: f.line_count ?? 0,
        lastSoldDate: f.last_sold_date,
        mapeo: f.kind
          ? {
              kind: f.kind,
              recipeId: f.recipe_id,
              method: f.method ?? 'manual',
              confirmedByUser: f.confirmed_by_user === 1,
            }
          : null,
      }));
    },

    /**
     * Guarda o corrige mapeos en bloque, en una sola ida a la base.
     *
     * En bloque porque confirmar veinte propuestas de un clic no debe ser
     * veinte peticiones ni veinte escrituras sueltas contra el presupuesto de
     * cuota de D1 (§5.1).
     *
     * Devuelve cuántas filas se escribieron: si el `accountId` no es del
     * inquilino, el WHERE EXISTS no escribe nada y el conteo lo delata.
     */
    async upsertItemMap(entradas: readonly EntradaMapeo[], now: string): Promise<number> {
      if (entradas.length === 0) return 0;

      const sentencias = entradas.map((e) => {
        const variante = e.providerVariantId ?? '';
        // La invariante la impone además un CHECK en el esquema; validarla aquí
        // convierte un error de programación en un mensaje legible en vez de
        // un fallo de constraint sin contexto.
        if (e.kind === 'RECIPE' && !e.recipeId) {
          throw new Error('Un mapeo de tipo RECIPE requiere `recipeId`.');
        }
        if (e.kind === 'IGNORED' && e.recipeId) {
          throw new Error('Un mapeo de tipo IGNORED no puede llevar `recipeId`.');
        }
        return db
          .prepare(UPSERT_MAPEO)
          .bind(
            posItemMapId(e.accountId, e.providerItemId, variante),
            tenantId,
            e.accountId,
            e.providerItemId,
            variante,
            e.kind === 'IGNORED' ? null : e.recipeId,
            e.kind,
            e.method,
            e.confirmedByUser === false ? 0 : 1,
            now,
          );
      });

      const res = await db.batch(sentencias);
      return res.reduce((a, r) => a + (r.meta?.changes ?? 0), 0);
    },

    /** Quita la decisión: el ítem vuelve a "sin mapear". */
    async deleteItemMap(clave: string): Promise<boolean> {
      const res = await db
        .prepare(`DELETE FROM pos_item_map WHERE id = ?1 AND tenant_id = ?2`)
        .bind(clave, tenantId)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },

    /** Mapeos vigentes del inquilino. La épica 03 arranca de aquí. */
    async listItemMap(): Promise<Array<MapeoItem & { clave: string; accountId: string }>> {
      const { results } = await db
        .prepare(
          `SELECT id, account_id, recipe_id, kind, method, confirmed_by_user
             FROM pos_item_map WHERE tenant_id = ?1 ORDER BY id`,
        )
        .bind(tenantId)
        .all<{
          id: string;
          account_id: string;
          recipe_id: string | null;
          kind: 'RECIPE' | 'IGNORED';
          method: 'auto_sku' | 'auto_name' | 'manual';
          confirmed_by_user: number;
        }>();
      return (results ?? []).map((f) => ({
        clave: f.id,
        accountId: f.account_id,
        kind: f.kind,
        recipeId: f.recipe_id,
        method: f.method,
        confirmedByUser: f.confirmed_by_user === 1,
      }));
    },
  };
}

/**
 * Cobertura del mapeo, derivada de la misma lista que ve la pantalla.
 *
 * Se calcula en TypeScript y no con un segundo SQL a propósito: dos consultas
 * que suman lo mismo por caminos distintos acaban divergiendo cuando alguien
 * toca una y no la otra —el riesgo que `totals.ts` documenta y cubre con una
 * prueba—. Aquí no hace falta correrlo: los ítems están acotados por el tamaño
 * de la carta, no por el número de tickets.
 */
export function cobertura(items: readonly PosItemVendido[]): CoberturaMapeo {
  let mapeadoCents = 0, ignoradoCents = 0, sinMapearCents = 0;
  let itemsMapeados = 0, itemsIgnorados = 0, itemsSinMapear = 0, itemsNoMapeables = 0;

  for (const it of items) {
    if (it.mapeo?.kind === 'RECIPE') {
      mapeadoCents += it.revenueCents;
      itemsMapeados++;
    } else if (it.mapeo?.kind === 'IGNORED') {
      ignoradoCents += it.revenueCents;
      itemsIgnorados++;
    } else {
      sinMapearCents += it.revenueCents;
      itemsSinMapear++;
      if (!it.providerItemId) itemsNoMapeables++;
    }
  }

  const total = mapeadoCents + ignoradoCents + sinMapearCents;
  return {
    mapeadoCents,
    ignoradoCents,
    sinMapearCents,
    itemsMapeados,
    itemsIgnorados,
    itemsSinMapear,
    itemsNoMapeables,
    // Con ingreso total 0 (o negativo por reembolsos) un porcentaje no
    // significaría nada: mejor no dar una cifra que dar una engañosa.
    fraccionDecidida: total > 0 ? (mapeadoCents + ignoradoCents) / total : null,
  };
}
