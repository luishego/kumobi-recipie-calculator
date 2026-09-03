-- ────────────────────────────────────────────────────────────────────────────
-- Épica 02 — Sincronización de ventas desde Loyverse
-- Esquema base de la capa de ventas.  Ver 01-requerimientos/epica-02-*.md §7 y §12.
--
-- Convenciones (§5.10, portabilidad a PostgreSQL):
--   · Ids generados por la APLICACIÓN (TEXT), nunca por la base. Sin AUTOINCREMENT.
--   · Fechas y horas en TEXT ISO-8601 UTC ("2026-09-01T14:30:00.000Z").
--     `business_date` es la excepción: fecha local de la sucursal, "YYYY-MM-DD".
--   · DINERO en INTEGER de CENTAVOS, con sufijo `_cents`. Nunca REAL.
--     La única columna decimal es `quantity`: media pieza o 0.75 kg son legítimos.
--   · Booleanos como INTEGER 0/1.
--   · `tenant_id` en TODAS las tablas, incluso donde sería deducible (§5.8):
--     la redundancia permite filtrar sin JOIN y convierte un olvido en un error
--     de esquema en vez de una fuga de datos.
-- ────────────────────────────────────────────────────────────────────────────

-- ── Inquilinos ──────────────────────────────────────────────────────────────
-- Kumobi es el inquilino #1. El alta de un cliente nuevo la hace el equipo.
CREATE TABLE tenants (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  default_timezone  TEXT NOT NULL DEFAULT 'America/Mexico_City',
  currency          TEXT NOT NULL DEFAULT 'MXN',
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ── Cuentas conectadas del POS ──────────────────────────────────────────────
-- El token va cifrado con AES-GCM; la llave maestra es un secret del Worker
-- (SALES_TOKEN_KEY) y nunca vive aquí. `token_last4` es solo para que el
-- administrador identifique cuál token es, en la UI.
CREATE TABLE sales_accounts (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  provider           TEXT NOT NULL CHECK (provider IN ('loyverse')),
  alias              TEXT NOT NULL,
  token_ciphertext   TEXT NOT NULL,
  token_iv           TEXT NOT NULL,
  token_last4        TEXT NOT NULL,
  default_timezone   TEXT NOT NULL DEFAULT 'America/Mexico_City',
  -- Tope del histórico inicial (HU-08). 30 = default del producto.
  -- NULL = sin tope, todo el histórico. Kumobi opera con NULL.
  backfill_max_days  INTEGER DEFAULT 30
                       CHECK (backfill_max_days IS NULL OR backfill_max_days > 0),
  status             TEXT NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE', 'INVALID_TOKEN', 'DISABLED')),
  last_validated_at  TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_accounts_tenant ON sales_accounts (tenant_id, status);

-- ── Sucursales ──────────────────────────────────────────────────────────────
-- Una sucursal que desaparece del POS se marca, NO se borra: sus tickets
-- históricos siguen siendo válidos.
CREATE TABLE sales_stores (
  id                           TEXT PRIMARY KEY,
  tenant_id                    TEXT NOT NULL REFERENCES tenants(id),
  account_id                   TEXT NOT NULL REFERENCES sales_accounts(id),
  provider                     TEXT NOT NULL,
  provider_store_id            TEXT NOT NULL,
  name                         TEXT NOT NULL,
  -- Zona horaria IANA. Base de `business_date` (§5.5): en el histórico real de
  -- Kumobi, el 60 % de los recibos cae en otro día si se agrupa por UTC.
  timezone                     TEXT NOT NULL,
  -- Previsto para cierres después de medianoche. 0 en esta épica, sin implementar.
  business_day_offset_minutes  INTEGER NOT NULL DEFAULT 0,
  active                       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  missing_in_provider_at       TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  UNIQUE (account_id, provider_store_id)
);
CREATE INDEX idx_stores_tenant ON sales_stores (tenant_id, active);

-- ── Tickets ─────────────────────────────────────────────────────────────────
-- `total_cents` viene del proveedor YA neto de descuento y CON el impuesto
-- incluido: no restar `total_discount_cents` (doble conteo) y no deducir el IVA
-- dividiendo — hay recibos sin impuesto en el histórico. Ver §8 y §9.
CREATE TABLE sales_receipts (
  id                         TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
  account_id                 TEXT NOT NULL REFERENCES sales_accounts(id),
  store_id                   TEXT NOT NULL REFERENCES sales_stores(id),
  provider                   TEXT NOT NULL,
  -- Único solo DENTRO de una cuenta (formato "1-0086"): de ahí la llave compuesta.
  receipt_number             TEXT NOT NULL,
  receipt_type               TEXT NOT NULL CHECK (receipt_type IN ('SALE', 'REFUND')),
  -- Número del recibo original. Sin FK a propósito: el original puede quedar
  -- fuera del rango del backfill y aun así el reembolso es válido.
  refund_for_receipt_number  TEXT,
  cancelled_at               TEXT,
  receipt_date               TEXT NOT NULL,
  business_date              TEXT NOT NULL
                               CHECK (business_date LIKE '____-__-__'),
  total_cents                INTEGER NOT NULL,
  total_discount_cents       INTEGER NOT NULL DEFAULT 0,
  total_tax_cents            INTEGER NOT NULL DEFAULT 0,
  tip_cents                  INTEGER NOT NULL DEFAULT 0,
  surcharge_cents            INTEGER NOT NULL DEFAULT 0,
  total_cost_reported_cents  INTEGER,
  dining_option              TEXT,
  currency                   TEXT NOT NULL DEFAULT 'MXN',
  provider_created_at        TEXT NOT NULL,
  -- Base de la sincronización incremental: se filtra por fecha de ACTUALIZACIÓN,
  -- no de creación, para capturar editados, reembolsados y cancelados.
  provider_updated_at        TEXT NOT NULL,
  synced_at                  TEXT NOT NULL,
  -- Clave del objeto en R2 del que salió este recibo (§5.9).
  raw_object_key             TEXT,
  -- Idempotencia garantizada por la BASE, no por lógica de aplicación (§5.4).
  UNIQUE (provider, account_id, store_id, receipt_number)
);
CREATE INDEX idx_receipts_store_date    ON sales_receipts (store_id, business_date);
CREATE INDEX idx_receipts_store_updated ON sales_receipts (store_id, provider_updated_at);
CREATE INDEX idx_receipts_tenant_date   ON sales_receipts (tenant_id, business_date);

-- ── Renglones ───────────────────────────────────────────────────────────────
-- `total_cents` del renglón YA incluye los modificadores (verificado sobre 14
-- modificadores con precio en el histórico real): usar esta columna y NUNCA
-- recalcular `quantity * unit_price_cents`, que daría de menos en los platillos
-- con extras.
CREATE TABLE sales_receipt_lines (
  id                         TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
  receipt_id                 TEXT NOT NULL REFERENCES sales_receipts(id) ON DELETE CASCADE,
  -- Desnormalizados para agrupar por sucursal y día sin JOIN.
  store_id                   TEXT NOT NULL,
  business_date              TEXT NOT NULL,
  line_index                 INTEGER NOT NULL,
  provider_item_id           TEXT,
  provider_variant_id        TEXT,
  sku                        TEXT,
  -- Snapshot: el nombre tal como estaba al momento de la venta.
  item_name                  TEXT NOT NULL,
  variant_name               TEXT,
  quantity                   REAL NOT NULL,
  unit_price_cents           INTEGER NOT NULL,
  gross_total_cents          INTEGER NOT NULL,
  total_cents                INTEGER NOT NULL,
  total_discount_cents       INTEGER NOT NULL DEFAULT 0,
  cost_reported_cents        INTEGER,
  cost_total_reported_cents  INTEGER,
  -- El upsert del ticket REEMPLAZA sus renglones en bloque: así una edición en
  -- el POS no deja renglones huérfanos de la versión anterior.
  UNIQUE (receipt_id, line_index)
);
CREATE INDEX idx_lines_item   ON sales_receipt_lines (provider_item_id, provider_variant_id);
CREATE INDEX idx_lines_date   ON sales_receipt_lines (store_id, business_date);
CREATE INDEX idx_lines_tenant ON sales_receipt_lines (tenant_id, business_date);

-- ── Mapeo POS ↔ recetas de Kumobi ───────────────────────────────────────────
-- Única tabla que cruza la frontera con Firestore (`recipe_id` → /recipes/{id}).
-- El mapeo se aplica EN LA CONSULTA, no se congela en el renglón: corregir un
-- mapeo mal hecho no obliga a re-descargar el histórico.
CREATE TABLE pos_item_map (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  account_id           TEXT NOT NULL REFERENCES sales_accounts(id),
  provider_item_id     TEXT NOT NULL,
  -- NOT NULL con '' para "sin variante": en SQLite y en PostgreSQL los NULL se
  -- consideran distintos entre sí, así que un UNIQUE con NULL permitiría filas
  -- duplicadas para el mismo ítem. El centinela vacío evita ese agujero.
  provider_variant_id  TEXT NOT NULL DEFAULT '',
  recipe_id            TEXT NOT NULL,
  method               TEXT NOT NULL CHECK (method IN ('auto_sku', 'auto_name', 'manual')),
  confirmed_by_user    INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_by_user IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (account_id, provider_item_id, provider_variant_id)
);
CREATE INDEX idx_map_tenant ON pos_item_map (tenant_id, recipe_id);

-- ── Estado de sincronización, uno por sucursal ──────────────────────────────
-- `last_synced_at` es el checkpoint y SOLO avanza tras un éxito completo:
-- un fallo parcial nunca lo mueve (§5.6, HU-09).
CREATE TABLE sync_state (
  store_id              TEXT PRIMARY KEY REFERENCES sales_stores(id),
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  last_synced_at        TEXT,
  last_success_at       TEXT,
  last_run_status       TEXT CHECK (last_run_status IS NULL
                          OR last_run_status IN ('SUCCESS', 'ERROR', 'RUNNING')),
  last_run_error        TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  backfill_status       TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (backfill_status IN
                            ('PENDING', 'RUNNING', 'PAUSED_BUDGET', 'COMPLETE', 'FAILED')),
  backfill_from         TEXT,
  -- Cursor persistido: es lo que hace REANUDABLE el histórico (HU-08).
  backfill_cursor       TEXT,
  backfill_through      TEXT,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_syncstate_tenant ON sync_state (tenant_id, backfill_status);

-- ── Bitácora de corridas ────────────────────────────────────────────────────
CREATE TABLE sync_runs (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  store_id           TEXT NOT NULL REFERENCES sales_stores(id),
  kind               TEXT NOT NULL CHECK (kind IN ('BACKFILL', 'INCREMENTAL', 'MANUAL')),
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  status             TEXT NOT NULL CHECK (status IN ('SUCCESS', 'ERROR', 'RUNNING')),
  requested_from     TEXT NOT NULL,
  -- Corte capturado AL INICIO de la corrida (§5.6): tomarlo al final abriría un
  -- hueco con todo lo que el proveedor escribió mientras el job corría.
  cutoff_at          TEXT NOT NULL,
  pages_fetched      INTEGER NOT NULL DEFAULT 0,
  receipts_upserted  INTEGER NOT NULL DEFAULT 0,
  lines_upserted     INTEGER NOT NULL DEFAULT 0,
  error_code         TEXT CHECK (error_code IS NULL OR error_code IN
                       ('INVALID_TOKEN', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'UNKNOWN')),
  error_detail       TEXT,
  -- uid del administrador en corridas manuales; NULL si la disparó el cron.
  triggered_by       TEXT
);
CREATE INDEX idx_runs_store_started ON sync_runs (store_id, started_at DESC);
CREATE INDEX idx_runs_tenant        ON sync_runs (tenant_id, started_at DESC);

-- ── Presupuesto diario de escritura ─────────────────────────────────────────
-- La cuota de D1 del plan gratuito es de 100 000 filas escritas por día, y al
-- agotarla la base DEJA DE ACEPTAR CONSULTAS, no solo escrituras. El contador
-- tiene que sobrevivir entre invocaciones del Worker, así que vive aquí.
-- La cuota es de la base, no del inquilino: por eso no lleva `tenant_id`.
-- El día es UTC, que es como Cloudflare cuenta la cuota.
CREATE TABLE d1_write_budget (
  day           TEXT PRIMARY KEY CHECK (day LIKE '____-__-__'),
  rows_written  INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);
