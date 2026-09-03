-- ────────────────────────────────────────────────────────────────────────────
-- Mapeo ítem del POS ↔ receta de Kumobi — HU-11, tercera parte.
--
-- Reconstruye `pos_item_map` para admitir un tercer estado que la v1 no
-- contemplaba: **ítem excluido a propósito**.
--
-- El motivo sale del catálogo real de Kumobi. De sus 28 ítems vendidos, varios
-- no son ni serán recetas: "Envio", "Cerveza modelo", "Coca cola regular
-- 355ml", "Agua mineral". Son reventa o servicio, no producción de cocina.
-- Con solo dos estados (mapeado / sin mapear) esos ítems se quedan para siempre
-- en "sin mapear", y entonces la cobertura del mapeo no puede llegar nunca a un
-- número interpretable: nadie distingue "falta mapear esto" de "esto no aplica".
-- Eso rompe justo la métrica que la épica 03 necesita para cerrar el Food Cost.
--
-- Con `kind` la diferencia es explícita:
--   · RECIPE   → vinculado a `recipes/{id}` en Firestore.
--   · IGNORED  → decisión tomada: este ítem no tiene receta. Cuenta como
--                resuelto para la cobertura, y su venta se reporta aparte.
--
-- Se reconstruye en vez de hacer ALTER porque `recipe_id` tiene que pasar a
-- admitir NULL, y SQLite no permite quitar un NOT NULL con ALTER TABLE. Es
-- seguro: hasta hoy NINGÚN código escribe en esta tabla —el mapeo es
-- precisamente lo que se implementa aquí— así que en producción está vacía.
-- El INSERT ... SELECT de abajo preserva cualquier fila que existiera de todos
-- modos, para que la migración no dependa de esa suposición.
--
-- La invariante entre `kind` y `recipe_id` se declara como CHECK y no como
-- convención de la aplicación: un error de programación se vuelve un error de
-- esquema en vez de una fila incoherente que nadie nota hasta el reporte.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE pos_item_map_nueva (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  account_id           TEXT NOT NULL REFERENCES sales_accounts(id),
  provider_item_id     TEXT NOT NULL,
  -- Centinela '' para "sin variante": en SQLite y en PostgreSQL dos NULL se
  -- consideran distintos, así que un UNIQUE con NULL admitiría duplicados del
  -- mismo ítem. Ver §7 de la épica.
  provider_variant_id  TEXT NOT NULL DEFAULT '',
  -- NULL exactamente cuando kind = 'IGNORED'.
  recipe_id            TEXT,
  kind                 TEXT NOT NULL DEFAULT 'RECIPE'
                         CHECK (kind IN ('RECIPE', 'IGNORED')),
  -- Cómo se originó la fila. 'auto_sku' queda declarado pero hoy no se emite:
  -- las recetas de Firestore no tienen código de POS con el que empatar.
  method               TEXT NOT NULL CHECK (method IN ('auto_sku', 'auto_name', 'manual')),
  confirmed_by_user    INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_by_user IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (account_id, provider_item_id, provider_variant_id),
  CHECK (
    (kind = 'RECIPE'  AND recipe_id IS NOT NULL AND recipe_id <> '') OR
    (kind = 'IGNORED' AND recipe_id IS NULL)
  )
);

INSERT INTO pos_item_map_nueva (
  id, tenant_id, account_id, provider_item_id, provider_variant_id,
  recipe_id, kind, method, confirmed_by_user, created_at, updated_at
)
SELECT
  id, tenant_id, account_id, provider_item_id, provider_variant_id,
  recipe_id, 'RECIPE', method, confirmed_by_user, created_at, updated_at
FROM pos_item_map;

DROP TABLE pos_item_map;

ALTER TABLE pos_item_map_nueva RENAME TO pos_item_map;

-- Consulta de la épica 03: "dame las recetas vendidas en este rango".
CREATE INDEX idx_map_tenant ON pos_item_map (tenant_id, recipe_id);
-- Consulta del panel de mapeo: el estado de todos los ítems de una cuenta.
CREATE INDEX idx_map_cuenta ON pos_item_map (account_id, kind);
