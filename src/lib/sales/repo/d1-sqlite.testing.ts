// Puente D1 → node:sqlite. SOLO PARA PRUEBAS.
//
// El código del repositorio se escribe contra la API real de D1 (`prepare`,
// `bind`, `run`, `all`, `first`, `batch`) y no contra una abstracción propia:
// así lo que se prueba es exactamente lo que va a correr en producción. Este
// puente implementa esa superficie sobre SQLite en memoria, que es el mismo
// motor que hay debajo de D1.
//
// No se importa desde ningún código de aplicación, así que no entra al bundle.

import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1Result } from '@cloudflare/workers-types';

type Bindable = null | number | bigint | string | Uint8Array;

/** node:sqlite no acepta `undefined` ni booleanos como parámetros. */
function normalizar(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  throw new TypeError(`Parámetro no vinculable a SQL: ${typeof v}`);
}

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  private args(): Bindable[] {
    return this.params.map(normalizar);
  }

  async run(): Promise<D1Result> {
    const r = this.db.prepare(this.sql).run(...this.args());
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(r.changes ?? 0),
        last_row_id: Number(r.lastInsertRowid ?? 0),
        duration: 0,
        rows_read: 0,
        rows_written: Number(r.changes ?? 0),
      },
    } as unknown as D1Result;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...this.args()) as T[];
    return {
      success: true,
      results: rows,
      meta: { changes: 0, last_row_id: 0, duration: 0, rows_read: rows.length, rows_written: 0 },
    } as unknown as D1Result<T>;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args());
    return (row ?? null) as T | null;
  }
}

class SqliteD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  /** D1 aplica el lote de forma atómica: aquí se replica con una transacción. */
  async batch<T = unknown>(statements: SqliteStatement[]): Promise<D1Result<T>[]> {
    this.db.exec('BEGIN');
    try {
      const out: D1Result<T>[] = [];
      for (const s of statements) out.push((await s.run()) as unknown as D1Result<T>);
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

export interface TestDb {
  d1: D1Database;
  raw: DatabaseSync;
}

/** Base en memoria con las migraciones aplicadas y claves foráneas activas. */
export function createTestD1(migrations: readonly string[]): TestDb {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of migrations) db.exec(sql);
  return { d1: new SqliteD1(db) as unknown as D1Database, raw: db };
}
