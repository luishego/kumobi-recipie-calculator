// Pruebas del esquema de la capa de ventas (épica 02, migraciones 0001/0002).
//
// Aplica las migraciones sobre SQLite en memoria (`node:sqlite`, el mismo motor
// que hay debajo de D1) y verifica que las garantías del esquema son reales, no
// intenciones escritas en un comentario: idempotencia por llave compuesta,
// rechazo de valores inválidos, el centinela de variante en el mapeo y el
// borrado en cascada de renglones.
//
// Nota: `node:sqlite` es de pruebas. En runtime (Workers) se usa D1.
import { describe, it, expect, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

/** Todas las migraciones, en orden. Una nueva entra sola a las pruebas. */
export function leerMigraciones(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'));
}
const T = '2026-09-01T00:00:00.000Z';

let db: DatabaseSync;

/** Lee una fila que debe existir. `get()` devuelve `undefined` si no hay ninguna. */
function one<T>(sql: string): T {
  const row = db.prepare(sql).get();
  if (!row) throw new Error(`la consulta no devolvió filas: ${sql}`);
  return row as T;
}

function insertReceipt(id: string, num: string, accountId: string, type = 'SALE') {
  db.prepare(
    `INSERT INTO sales_receipts
      (id,tenant_id,account_id,store_id,provider,receipt_number,receipt_type,receipt_date,
       business_date,total_cents,provider_created_at,provider_updated_at,synced_at)
     VALUES (?,'tnt_kumobi',?,'st1','loyverse',?,?,'2026-08-31T01:27:27.000Z','2026-08-30',
             20938,?,?,?)`,
  ).run(id, accountId, num, type, T, T, T);
}

beforeAll(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of leerMigraciones()) db.exec(sql);

  db.prepare(
    `INSERT INTO sales_accounts
      (id,tenant_id,provider,alias,token_ciphertext,token_iv,token_last4,
       default_timezone,backfill_max_days,status,created_at,updated_at)
     VALUES ('acc1','tnt_kumobi','loyverse','Kumobi','xx','yy','ab12',
             'America/Mexico_City',NULL,'ACTIVE',?,?)`,
  ).run(T, T);
  db.prepare(
    `INSERT INTO sales_stores
      (id,tenant_id,account_id,provider,provider_store_id,name,timezone,created_at,updated_at)
     VALUES ('st1','tnt_kumobi','acc1','loyverse','25d1edc7','KUMOBI','America/Mexico_City',?,?)`,
  ).run(T, T);
});

describe('migraciones', () => {
  it('crean las 9 tablas de la capa de ventas', () => {
    const tablas = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name as string);
    expect(tablas).toEqual(
      expect.arrayContaining([
        'tenants', 'sales_accounts', 'sales_stores', 'sales_receipts',
        'sales_receipt_lines', 'pos_item_map', 'sync_state', 'sync_runs',
        'd1_write_budget',
      ]),
    );
  });

  it('la semilla del inquilino es idempotente', () => {
    db.exec(readFileSync(join(MIGRATIONS, '0002_seed_tenant_kumobi.sql'), 'utf8'));
    expect(one<{ c: number }>("SELECT count(*) c FROM tenants WHERE id='tnt_kumobi'").c).toBe(1);
  });

  it('Kumobi opera sin tope de backfill', () => {
    const r = one<{ b: number | null }>(
      "SELECT backfill_max_days b FROM sales_accounts WHERE id='acc1'",
    );
    expect(r.b).toBeNull();
  });
});

describe('idempotencia del ticket (§5.4)', () => {
  it('el upsert sobre la llave compuesta no duplica', () => {
    insertReceipt('r1', '1-0086', 'acc1');
    db.prepare(
      `INSERT INTO sales_receipts
        (id,tenant_id,account_id,store_id,provider,receipt_number,receipt_type,receipt_date,
         business_date,total_cents,provider_created_at,provider_updated_at,synced_at)
       VALUES ('r1-bis','tnt_kumobi','acc1','st1','loyverse','1-0086','SALE',
               '2026-08-31T01:27:27.000Z','2026-08-30',20938,?,?,?)
       ON CONFLICT (provider,account_id,store_id,receipt_number) DO UPDATE SET
         total_cents = excluded.total_cents, synced_at = excluded.synced_at
       WHERE excluded.provider_updated_at >= sales_receipts.provider_updated_at`,
    ).run(T, T, T);
    const r = one<{ c: number }>(
      "SELECT count(*) c FROM sales_receipts WHERE receipt_number='1-0086'",
    );
    expect(r.c).toBe(1);
  });

  it('rechaza el mismo receipt_number dentro de la misma cuenta', () => {
    expect(() => insertReceipt('r2', '1-0086', 'acc1')).toThrow();
  });

  it('permite el mismo receipt_number en otra cuenta: por eso la llave es compuesta', () => {
    db.prepare(
      `INSERT INTO sales_accounts
        (id,tenant_id,provider,alias,token_ciphertext,token_iv,token_last4,created_at,updated_at)
       VALUES ('acc2','tnt_kumobi','loyverse','Otra','x','y','cd34',?,?)`,
    ).run(T, T);
    expect(() => insertReceipt('r3', '1-0086', 'acc2')).not.toThrow();
  });
});

describe('restricciones de dominio', () => {
  it('rechaza un receipt_type que no sea SALE o REFUND', () => {
    expect(() => insertReceipt('rx', '9-0001', 'acc1', 'VENTA')).toThrow();
  });

  it('rechaza una business_date mal formada', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO sales_receipts
          (id,tenant_id,account_id,store_id,provider,receipt_number,receipt_type,receipt_date,
           business_date,total_cents,provider_created_at,provider_updated_at,synced_at)
         VALUES ('ry','tnt_kumobi','acc1','st1','loyverse','9-0002','SALE',?,'2026-8-3',100,?,?,?)`,
      ).run(T, T, T, T),
    ).toThrow();
  });

  it('rechaza un estado de cuenta desconocido', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO sales_accounts
          (id,tenant_id,provider,alias,token_ciphertext,token_iv,token_last4,status,created_at,updated_at)
         VALUES ('accx','tnt_kumobi','loyverse','X','a','b','cd','APAGADA',?,?)`,
      ).run(T, T),
    ).toThrow();
  });

  it('acepta PAUSED_BUDGET como estado de backfill y rechaza los inventados', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO sync_state (store_id,tenant_id,backfill_status,updated_at)
         VALUES ('st1','tnt_kumobi','PAUSED_BUDGET',?)`,
      ).run(T),
    ).not.toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO sync_state (store_id,tenant_id,backfill_status,updated_at)
         VALUES ('st9','tnt_kumobi','EN_CURSO',?)`,
      ).run(T),
    ).toThrow();
  });
});

describe('mapeo POS ↔ receta', () => {
  const ins = (id: string, item: string, variant: string | null, recipe: string) =>
    variant === null
      ? db.prepare(
          `INSERT INTO pos_item_map (id,tenant_id,account_id,provider_item_id,recipe_id,method,created_at,updated_at)
           VALUES (?,'tnt_kumobi','acc1',?,?,'auto_sku',?,?)`,
        ).run(id, item, recipe, T, T)
      : db.prepare(
          `INSERT INTO pos_item_map (id,tenant_id,account_id,provider_item_id,provider_variant_id,recipe_id,method,created_at,updated_at)
           VALUES (?,'tnt_kumobi','acc1',?,?,?,'manual',?,?)`,
        ).run(id, item, variant, recipe, T, T);

  it('impide mapear dos veces el mismo ítem sin variante', () => {
    // El centinela '' en lugar de NULL es lo que hace efectivo el UNIQUE:
    // tanto SQLite como PostgreSQL consideran distintos entre sí a los NULL.
    ins('m1', 'item-a', null, 'rec-1');
    expect(() => ins('m2', 'item-a', null, 'rec-2')).toThrow();
  });

  it('permite el mismo ítem con variantes distintas', () => {
    expect(() => ins('m3', 'item-a', 'var-1', 'rec-2')).not.toThrow();
  });
});

describe('integridad referencial', () => {
  it('borrar un ticket se lleva sus renglones', () => {
    const line = db.prepare(
      `INSERT INTO sales_receipt_lines
        (id,tenant_id,receipt_id,store_id,business_date,line_index,item_name,quantity,
         unit_price_cents,gross_total_cents,total_cents)
       VALUES (?,'tnt_kumobi','r1','st1','2026-08-30',?,?,1,9900,13400,13400)`,
    );
    line.run('l1', 0, 'Clásica 1/4 lb');
    line.run('l2', 1, 'Agua mineral');

    db.prepare("DELETE FROM sales_receipts WHERE id='r1'").run();
    const r = one<{ c: number }>(
      "SELECT count(*) c FROM sales_receipt_lines WHERE receipt_id='r1'",
    );
    expect(r.c).toBe(0);
  });
});

describe('presupuesto diario de escritura', () => {
  it('el contador acumula sobre el mismo día', () => {
    const s = db.prepare(
      `INSERT INTO d1_write_budget (day,rows_written,updated_at) VALUES ('2026-09-01',?,?)
       ON CONFLICT (day) DO UPDATE SET
         rows_written = rows_written + excluded.rows_written, updated_at = excluded.updated_at`,
    );
    s.run(1000, T);
    s.run(500, T);
    const r = one<{ w: number }>(
      "SELECT rows_written w FROM d1_write_budget WHERE day='2026-09-01'",
    );
    expect(r.w).toBe(1500);
  });
});
