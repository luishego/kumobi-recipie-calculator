// Sincronización incremental y corrida nocturna — épica 02, HU-09/12/13.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestD1, type TestDb } from '../repo/d1-sqlite.testing';
import { createRepo, type SalesRepo } from '../repo';
import { storeId as makeStoreId } from '../repo/ids';
import { normalizeReceipts, type LoyverseReceipt } from '../loyverse/normalize';
import { SalesProviderError, type SalesProvider, type FetchReceiptsParams } from '../provider';
import type { NormalizedReceipt } from '../types';
import { runBackfill } from './backfill';
import { runIncremental, SYNC_OVERLAP_MINUTES } from './incremental';
import { runNightlySync } from './runAll';
import { importMasterKey, encryptToken } from '../crypto';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(AQUI, '../../../../migrations');
const FIXTURES = join(AQUI, '../../../../fixtures');

const TENANT = 'tnt_kumobi';
const ACCOUNT = 'acc_kumobi';
const PROVIDER_STORE = '25d1edc7-527e-432b-9b3f-61d06df6fd88';
const STORE = makeStoreId(ACCOUNT, PROVIDER_STORE);
const LLAVE = 'bGxhdmUtZGUtcHJ1ZWJhcy1udW1lcm8tdW5vLi4uLi4';
const T0 = '2026-09-02T10:00:00.000Z';
const T1 = '2026-09-03T10:00:00.000Z';

const crudos: LoyverseReceipt[] = JSON.parse(
  readFileSync(join(FIXTURES, 'loyverse-historico-2026-05-21_2026-09-01.json'), 'utf8'),
).receipts;
const HISTORICO: NormalizedReceipt[] = normalizeReceipts(crudos, {
  timeZone: 'America/Mexico_City',
});

const TARGET = {
  tenantId: TENANT,
  account: { id: ACCOUNT, provider: 'loyverse' as const },
  store: { id: STORE, providerStoreId: PROVIDER_STORE, timezone: 'America/Mexico_City' },
};

interface ProveedorFalso extends SalesProvider {
  peticiones: FetchReceiptsParams[];
}

/** Devuelve `entrega` en cada llamada; opcionalmente falla las primeras veces. */
function proveedorFalso(
  entrega: NormalizedReceipt[],
  fallos: SalesProviderError[] = [],
): ProveedorFalso {
  const peticiones: FetchReceiptsParams[] = [];
  let llamadas = 0;
  return {
    providerId: 'loyverse',
    peticiones,
    async validateCredentials() {},
    async listStores() {
      return [{ providerStoreId: PROVIDER_STORE, name: 'KUMOBI' }];
    },
    async fetchReceipts(params) {
      peticiones.push(params);
      if (llamadas < fallos.length) throw fallos[llamadas++]!;
      llamadas++;
      return { receipts: entrega, cursor: null, raw: { n: entrega.length } };
    },
  };
}

let db: TestDb;
let repo: SalesRepo;

async function sembrarConHistorico() {
  db = createTestD1(
    readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')),
  );
  repo = createRepo(db.d1, TENANT);

  const key = await importMasterKey(LLAVE);
  const cifrado = await encryptToken('token-real', key);
  await repo.upsertAccount(
    {
      id: ACCOUNT, provider: 'loyverse', alias: 'Kumobi',
      tokenCiphertext: cifrado.ciphertext, tokenIv: cifrado.iv, tokenLast4: '32fd',
      defaultTimezone: 'America/Mexico_City', backfillMaxDays: null,
    },
    T0,
  );
  await repo.syncStores(
    ACCOUNT, 'loyverse', [{ providerStoreId: PROVIDER_STORE, name: 'KUMOBI' }],
    { timezone: 'America/Mexico_City' }, T0,
  );

  // Histórico ya descargado: el incremental solo entra después del backfill.
  await runBackfill(
    {
      provider: proveedorFalso(HISTORICO), repo, db: db.d1, now: () => new Date(T0),
    },
    { ...TARGET, account: { ...TARGET.account, backfillMaxDays: null } },
  );
}

beforeEach(sembrarConHistorico);

describe('precondiciones', () => {
  it('una sucursal sin histórico descargado no entra al incremental', async () => {
    // Sucursal nueva, sin backfill.
    await repo.syncStores(
      ACCOUNT, 'loyverse',
      [
        { providerStoreId: PROVIDER_STORE, name: 'KUMOBI' },
        { providerStoreId: 'otra-sucursal', name: 'Segunda' },
      ],
      { timezone: 'America/Mexico_City' }, T1,
    );

    const r = await runIncremental(
      { provider: proveedorFalso([]), repo, db: db.d1, now: () => new Date(T1) },
      { ...TARGET, store: { ...TARGET.store, id: makeStoreId(ACCOUNT, 'otra-sucursal'),
        providerStoreId: 'otra-sucursal' } },
    );
    expect(r.outcome).toBe('SKIPPED_SIN_BACKFILL');
  });
});

describe('ventana de consulta', () => {
  it('pide desde el checkpoint MENOS el colchón, por fecha de actualización', async () => {
    const p = proveedorFalso([]);
    await runIncremental(
      { provider: p, repo, db: db.d1, now: () => new Date(T1) },
      TARGET,
    );

    const esperado = new Date(Date.parse(T0) - SYNC_OVERLAP_MINUTES * 60_000).toISOString();
    expect(p.peticiones[0]!.updatedSince).toBe(esperado);
    // Por fecha de ACTUALIZACIÓN: un ticket viejo editado anoche tiene que volver.
    expect(p.peticiones[0]!.createdSince).toBeUndefined();
  });

  it('el colchón vuelve a traer tickets ya vistos sin duplicarlos', async () => {
    const antes = await repo.countReceipts();
    await runIncremental(
      { provider: proveedorFalso(HISTORICO.slice(0, 20)), repo, db: db.d1, now: () => new Date(T1) },
      TARGET,
    );
    expect(await repo.countReceipts()).toBe(antes);
  });
});

describe('checkpoint', () => {
  it('avanza al corte capturado al INICIO cuando la corrida termina bien', async () => {
    const r = await runIncremental(
      { provider: proveedorFalso([]), repo, db: db.d1, now: () => new Date(T1) },
      TARGET,
    );
    expect(r.outcome).toBe('SUCCESS');
    expect((await repo.getSyncState(STORE)).lastSyncedAt).toBe(T1);
  });

  it('NO se mueve si la corrida falla', async () => {
    const fallo = new SalesProviderError('PROVIDER_UNAVAILABLE', 'caída');
    const r = await runIncremental(
      {
        provider: proveedorFalso([], [fallo, fallo, fallo, fallo]),
        repo, db: db.d1, now: () => new Date(T1),
        retry: { sleep: async () => {}, random: () => 0.5 },
      },
      TARGET,
    );

    expect(r.outcome).toBe('FAILED');
    const estado = await repo.getSyncState(STORE);
    expect(estado.lastSyncedAt).toBe(T0); // ← intacto
    expect(estado.lastRunStatus).toBe('ERROR');
    expect(estado.consecutiveFailures).toBe(1);
    // Y el histórico sigue marcado como completo: fallar el incremental no
    // invalida el backfill.
    expect(estado.backfillStatus).toBe('COMPLETE');
  });

  it('tampoco avanza si se agotó el presupuesto', async () => {
    const { consumeBudget, DAILY_WRITE_BUDGET } = await import('./budget');
    await consumeBudget(db.d1, DAILY_WRITE_BUDGET, new Date(T1));
    const r = await runIncremental(
      { provider: proveedorFalso([]), repo, db: db.d1, now: () => new Date(T1) },
      TARGET,
    );
    expect(r.outcome).toBe('PAUSED_BUDGET');
    expect((await repo.getSyncState(STORE)).lastSyncedAt).toBe(T0);
  });
});

describe('resiliencia', () => {
  it('reintenta un 429 y termina bien', async () => {
    const p = proveedorFalso([], [new SalesProviderError('RATE_LIMITED', '429', 10)]);
    const r = await runIncremental(
      {
        provider: p, repo, db: db.d1, now: () => new Date(T1),
        retry: { sleep: async () => {}, random: () => 0.5 },
      },
      TARGET,
    );
    expect(r.outcome).toBe('SUCCESS');
    expect(p.peticiones).toHaveLength(2);
    expect((await repo.getSyncState(STORE)).lastSyncedAt).toBe(T1);
  });

  it('un token revocado no se reintenta', async () => {
    const p = proveedorFalso([], [new SalesProviderError('INVALID_TOKEN', 'revocado')]);
    const r = await runIncremental(
      {
        provider: p, repo, db: db.d1, now: () => new Date(T1),
        retry: { sleep: async () => {} },
      },
      TARGET,
    );
    expect(r.outcome).toBe('FAILED');
    expect(r.errorCode).toBe('INVALID_TOKEN');
    expect(p.peticiones).toHaveLength(1);
  });
});

describe('corrida nocturna completa', () => {
  it('recorre inquilino, cuenta y sucursal, y avanza el checkpoint', async () => {
    const key = await importMasterKey(LLAVE);
    const resumen = await runNightlySync({
      db: db.d1, masterKey: key, now: () => new Date(T1),
      makeProvider: () => proveedorFalso([]),
    });

    expect(resumen.inquilinos).toBe(1);
    expect(resumen.cuentas).toBe(1);
    expect(resumen.sucursales).toBe(1);
    expect(resumen.fallidas).toBe(0);
    expect((await repo.getSyncState(STORE)).lastSyncedAt).toBe(T1);
  });

  it('un token revocado detiene esa cuenta y la deja marcada', async () => {
    const key = await importMasterKey(LLAVE);
    const resumen = await runNightlySync({
      db: db.d1, masterKey: key, now: () => new Date(T1),
      retry: { sleep: async () => {} },
      makeProvider: () =>
        proveedorFalso([], [new SalesProviderError('INVALID_TOKEN', 'revocado')]),
    });

    expect(resumen.cuentasInvalidadas).toEqual([ACCOUNT]);
    const cuenta = (await repo.listAccounts())[0]!;
    expect(cuenta.status).toBe('INVALID_TOKEN');
    // El checkpoint se conserva: al reconectar, la siguiente corrida recupera
    // el rango perdido sin huecos.
    expect((await repo.getSyncState(STORE)).lastSyncedAt).toBe(T0);
  });

  it('una llave que no descifra no marca la cuenta como inválida: el problema es nuestro', async () => {
    const otraLlave = await importMasterKey('bGxhdmUtZGUtcHJ1ZWJhcy1udW1lcm8tZG9zLi4uLi4');
    const resumen = await runNightlySync({
      db: db.d1, masterKey: otraLlave, now: () => new Date(T1),
      makeProvider: () => proveedorFalso([]),
    });

    expect(resumen.detalle[0]!.outcome).toBe('SIN_CREDENCIALES');
    expect(resumen.fallidas).toBe(1);
    expect((await repo.listAccounts())[0]!.status).toBe('ACTIVE');
  });

  it('salta las cuentas que ya requieren reconexión', async () => {
    await repo.markAccountInvalid(ACCOUNT, T1);
    const key = await importMasterKey(LLAVE);
    const resumen = await runNightlySync({
      db: db.d1, masterKey: key, now: () => new Date(T1),
      makeProvider: () => proveedorFalso([]),
    });
    expect(resumen.cuentas).toBe(0);
    expect(resumen.sucursales).toBe(0);
  });
});
