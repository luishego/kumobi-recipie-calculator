// Backfill reanudable — épica 02, HU-08.
//
// Se ejercita contra el histórico REAL de Kumobi (108 recibos) servido por un
// proveedor simulado, sobre SQLite con las migraciones aplicadas. Lo que se
// comprueba no es que "corra", sino las tres propiedades que lo definen:
// reanudable, idempotente, y que el checkpoint solo avance al terminar.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { R2Bucket } from '@cloudflare/workers-types';
import { createTestD1, type TestDb } from '../repo/d1-sqlite.testing';
import { createRepo, type SalesRepo } from '../repo';
import { storeId as makeStoreId } from '../repo/ids';
import { normalizeReceipts, type LoyverseReceipt } from '../loyverse/normalize';
import { SalesProviderError, type SalesProvider } from '../provider';
import type { NormalizedReceipt } from '../types';
import { runBackfill, type BackfillTarget } from './backfill';
import { consumeBudget, DAILY_WRITE_BUDGET } from './budget';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(AQUI, '../../../../migrations');
const FIXTURES = join(AQUI, '../../../../fixtures');

const TENANT = 'tnt_kumobi';
const ACCOUNT = 'acc_kumobi';
const PROVIDER_STORE = '25d1edc7-527e-432b-9b3f-61d06df6fd88';
const STORE = makeStoreId(ACCOUNT, PROVIDER_STORE);
const T0 = '2026-09-02T10:00:00.000Z';

const crudos: LoyverseReceipt[] = JSON.parse(
  readFileSync(join(FIXTURES, 'loyverse-historico-2026-05-21_2026-09-01.json'), 'utf8'),
).receipts;
const HISTORICO: NormalizedReceipt[] = normalizeReceipts(crudos, {
  timeZone: 'America/Mexico_City',
});

const TARGET: BackfillTarget = {
  tenantId: TENANT,
  account: { id: ACCOUNT, provider: 'loyverse', backfillMaxDays: null },
  store: { id: STORE, providerStoreId: PROVIDER_STORE, timezone: 'America/Mexico_City' },
};

/** Proveedor simulado: pagina el histórico y puede fallar en una página dada. */
function proveedorFalso(pageSize: number, fallarEnPagina?: number): SalesProvider {
  let llamadas = 0;
  return {
    providerId: 'loyverse',
    async validateCredentials() {},
    async listStores() {
      return [{ providerStoreId: PROVIDER_STORE, name: 'KUMOBI' }];
    },
    async fetchReceipts(params) {
      llamadas++;
      if (fallarEnPagina === llamadas) {
        throw new SalesProviderError('PROVIDER_UNAVAILABLE', 'caída simulada del proveedor');
      }
      const desde = params.cursor ? Number(params.cursor) : 0;
      const trozo = HISTORICO.slice(desde, desde + pageSize);
      const siguiente = desde + pageSize < HISTORICO.length ? String(desde + pageSize) : null;
      return { receipts: trozo, cursor: siguiente, raw: { pagina: llamadas, n: trozo.length } };
    },
  };
}

function bucketFalso() {
  const objetos = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      objetos.set(key, String(value));
    },
  } as unknown as R2Bucket;
  return { objetos, bucket };
}

let db: TestDb;
let repo: SalesRepo;

async function sembrar() {
  db = createTestD1(
    readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')),
  );
  repo = createRepo(db.d1, TENANT);
  await repo.upsertAccount(
    {
      id: ACCOUNT, provider: 'loyverse', alias: 'Kumobi',
      tokenCiphertext: 'x', tokenIv: 'y', tokenLast4: '32fd',
      defaultTimezone: 'America/Mexico_City', backfillMaxDays: null,
    },
    T0,
  );
  await repo.syncStores(
    ACCOUNT, 'loyverse', [{ providerStoreId: PROVIDER_STORE, name: 'KUMOBI' }],
    { timezone: 'America/Mexico_City' }, T0,
  );
}

beforeEach(sembrar);

describe('descarga completa', () => {
  it('baja el histórico entero y fija el checkpoint', async () => {
    const { bucket } = bucketFalso();
    const res = await runBackfill(
      { provider: proveedorFalso(250), repo, db: db.d1, bucket, now: () => new Date(T0) },
      TARGET,
    );

    expect(res.outcome).toBe('COMPLETE');
    expect(res.receipts).toBe(108);
    expect(await repo.countReceipts()).toBe(108);

    const estado = await repo.getSyncState(STORE);
    expect(estado.backfillStatus).toBe('COMPLETE');
    expect(estado.backfillCursor).toBeNull();
    // El checkpoint queda en el corte capturado AL INICIO, no en "ahora".
    expect(estado.lastSyncedAt).toBe(T0);
    expect(estado.lastRunStatus).toBe('SUCCESS');
  });

  it('el histórico de Kumobi cabe en una sola página', async () => {
    const res = await runBackfill(
      { provider: proveedorFalso(250), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );
    expect(res.pages).toBe(1);
  });

  it('deja la bitácora con los conteos de la corrida', async () => {
    await runBackfill(
      { provider: proveedorFalso(50), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );
    const corridas = await repo.listRuns(STORE);
    expect(corridas).toHaveLength(1);
    expect(corridas[0]!.status).toBe('SUCCESS');
    expect(corridas[0]!.kind).toBe('BACKFILL');
    expect(corridas[0]!.receipts_upserted).toBe(108);
    expect(corridas[0]!.cutoff_at).toBe(T0);
  });
});

describe('idempotencia', () => {
  it('volver a correrlo no duplica ni vuelve a bajar nada', async () => {
    const deps = { provider: proveedorFalso(250), repo, db: db.d1, now: () => new Date(T0) };
    await runBackfill(deps, TARGET);
    const segunda = await runBackfill(deps, TARGET);

    expect(segunda.outcome).toBe('ALREADY_COMPLETE');
    expect(segunda.pages).toBe(0);
    expect(await repo.countReceipts()).toBe(108);
  });

  it('con `force` vuelve a descargar, y sigue sin duplicar', async () => {
    const deps = { provider: proveedorFalso(250), repo, db: db.d1, now: () => new Date(T0) };
    await runBackfill(deps, TARGET);
    const forzada = await runBackfill(
      { ...deps, provider: proveedorFalso(250) }, TARGET, { force: true },
    );
    expect(forzada.outcome).toBe('COMPLETE');
    expect(await repo.countReceipts()).toBe(108);
  });
});

describe('reanudable', () => {
  it('si el proveedor falla a media descarga, guarda el cursor y NO mueve el checkpoint', async () => {
    const res = await runBackfill(
      { provider: proveedorFalso(30, 3), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );

    expect(res.outcome).toBe('FAILED');
    expect(res.receipts).toBe(60); // dos páginas de 30 antes de caerse

    const estado = await repo.getSyncState(STORE);
    expect(estado.backfillStatus).toBe('FAILED');
    expect(estado.backfillCursor).toBe('60');
    expect(estado.lastSyncedAt).toBeNull(); // ← lo importante
    expect(estado.lastRunStatus).toBe('ERROR');
    expect(estado.consecutiveFailures).toBe(1);
  });

  it('la siguiente corrida continúa donde quedó y termina', async () => {
    await runBackfill(
      { provider: proveedorFalso(30, 3), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );
    const parciales = await repo.countReceipts();

    const segunda = await runBackfill(
      { provider: proveedorFalso(30), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );

    expect(segunda.outcome).toBe('COMPLETE');
    expect(await repo.countReceipts()).toBe(108);
    expect(parciales).toBeLessThan(108);

    const estado = await repo.getSyncState(STORE);
    expect(estado.lastSyncedAt).toBe(T0);
    expect(estado.backfillCursor).toBeNull();
  });

  it('al reanudar conserva el corte original, no toma uno nuevo', async () => {
    await runBackfill(
      { provider: proveedorFalso(30, 3), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );
    // La segunda corrida ocurre horas después.
    const T1 = '2026-09-02T18:00:00.000Z';
    const segunda = await runBackfill(
      { provider: proveedorFalso(30), repo, db: db.d1, now: () => new Date(T1) },
      TARGET,
    );
    // Si tomara un corte nuevo, lo escrito entre T0 y T1 quedaría en un hueco
    // que ninguna corrida futura volvería a mirar.
    expect(segunda.cutoffAt).toBe(T0);
    expect((await repo.getSyncState(STORE)).lastSyncedAt).toBe(T0);
  });
});

describe('presupuesto diario de escritura', () => {
  it('se detiene sin agotar la cuota y deja el cursor para continuar', async () => {
    // La cuota del día ya está casi consumida.
    await consumeBudget(db.d1, DAILY_WRITE_BUDGET - 10, new Date(T0));

    const res = await runBackfill(
      { provider: proveedorFalso(30), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );

    expect(res.outcome).toBe('PAUSED_BUDGET');
    expect(res.pages).toBe(0); // ni siquiera pidió la primera página
    const estado = await repo.getSyncState(STORE);
    expect(estado.backfillStatus).toBe('PAUSED_BUDGET');
    expect(estado.lastSyncedAt).toBeNull();
  });

  it('"pausado por presupuesto" es un estado normal: la corrida no es un error', async () => {
    await consumeBudget(db.d1, DAILY_WRITE_BUDGET, new Date(T0));
    await runBackfill(
      { provider: proveedorFalso(30), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );
    const corridas = await repo.listRuns(STORE);
    expect(corridas[0]!.status).toBe('SUCCESS');
    expect(corridas[0]!.error_code).toBeNull();
  });

  it('al día siguiente hay presupuesto otra vez', async () => {
    await consumeBudget(db.d1, DAILY_WRITE_BUDGET, new Date(T0));
    const manana = '2026-09-03T10:00:00.000Z';
    const res = await runBackfill(
      { provider: proveedorFalso(250), repo, db: db.d1, now: () => new Date(manana) },
      TARGET,
    );
    expect(res.outcome).toBe('COMPLETE');
  });
});

describe('archivo del payload crudo', () => {
  it('guarda una entrada por página, con la clave prevista', async () => {
    const { objetos, bucket } = bucketFalso();
    await runBackfill(
      { provider: proveedorFalso(40), repo, db: db.d1, bucket,
        now: () => new Date(T0), newId: () => 'run-1' },
      TARGET,
    );

    const claves = [...objetos.keys()].sort();
    expect(claves).toHaveLength(3); // 108 recibos en páginas de 40
    expect(claves[0]).toBe(
      `raw/${TENANT}/${ACCOUNT}/${PROVIDER_STORE}/2026-09-02/run-1-0001.json`,
    );
  });

  it('cada ticket apunta al objeto del que salió', async () => {
    const { bucket } = bucketFalso();
    await runBackfill(
      { provider: proveedorFalso(250), repo, db: db.d1, bucket,
        now: () => new Date(T0), newId: () => 'run-1' },
      TARGET,
    );
    const fila = db.raw
      .prepare('SELECT raw_object_key AS k FROM sales_receipts LIMIT 1')
      .get() as { k: string };
    expect(fila.k).toContain('run-1-0001.json');
  });

  it('sin bucket configurado la descarga sigue: los tickets importan más', async () => {
    const res = await runBackfill(
      { provider: proveedorFalso(250), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );
    expect(res.outcome).toBe('COMPLETE');
    expect(await repo.countReceipts()).toBe(108);
  });
});

describe('de punta a punta', () => {
  it('tras el backfill, la base reproduce las cifras conciliadas', async () => {
    await runBackfill(
      { provider: proveedorFalso(250), repo, db: db.d1, now: () => new Date(T0) },
      TARGET,
    );

    const dias = await repo.dailyTotals({ desde: '2026-05-21', hasta: '2026-09-01' });
    const suma = (f: (d: (typeof dias)[number]) => number) => dias.reduce((a, d) => a + f(d), 0);

    // Las mismas seis cifras que cuadraron contra el reporte del Back Office,
    // ahora producidas por el sistema completo: descarga → archivo → upsert → SQL.
    expect(suma((d) => d.netSalesCents)).toBe(3548133);
    expect(suma((d) => d.grossSalesCents)).toBe(4362238);
    expect(suma((d) => d.refundsCents)).toBe(670000);
    expect(suma((d) => d.discountsCents)).toBe(144105);
    expect(suma((d) => d.taxCents)).toBe(489389);
    expect(suma((d) => d.costReportedCents)).toBe(777351);
    expect(dias.filter((d) => d.netTickets !== 0)).toHaveLength(42);
  });
});
