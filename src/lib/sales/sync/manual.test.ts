// Re-sincronización manual de un rango — épica 02, HU-15.
//
// Las tres propiedades que definen esta historia, y que son justo las que la
// distinguen del incremental:
//   · Pide por fecha de CREACIÓN y con límite superior (no arrastra el resto).
//   · NO mueve el checkpoint ni marca la sucursal, pase lo que pase.
//   · Queda en la bitácora con quién la disparó y qué rango pidió.
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
import { runManualRange } from './manual';
import { DAILY_WRITE_BUDGET, consumeBudget } from './budget';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(AQUI, '../../../../migrations');
const FIXTURES = join(AQUI, '../../../../fixtures');

const TENANT = 'tnt_kumobi';
const ACCOUNT = 'acc_kumobi';
const PROVIDER_STORE = '25d1edc7-527e-432b-9b3f-61d06df6fd88';
const STORE = makeStoreId(ACCOUNT, PROVIDER_STORE);
const T0 = '2026-09-02T10:00:00.000Z';
const T1 = '2026-09-03T10:00:00.000Z';
const ADMIN = 'uid-admin-kumobi';

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
  rango: { desde: '2026-08-01', hasta: '2026-08-03' },
  triggeredBy: ADMIN,
};

interface ProveedorFalso extends SalesProvider {
  peticiones: FetchReceiptsParams[];
}

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

beforeEach(async () => {
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
  await runBackfill(
    { provider: proveedorFalso(HISTORICO), repo, db: db.d1, now: () => new Date(T0) },
    {
      tenantId: TENANT,
      account: { id: ACCOUNT, provider: 'loyverse', backfillMaxDays: null },
      store: { id: STORE, providerStoreId: PROVIDER_STORE, timezone: 'America/Mexico_City' },
    },
  );
});

describe('la ventana que se le pide al proveedor', () => {
  it('filtra por creación y ACOTA por arriba: un rango no arrastra el resto', async () => {
    const p = proveedorFalso([]);
    await runManualRange({ provider: p, repo, db: db.d1, now: () => new Date(T1) }, TARGET);

    const pedida = p.peticiones[0]!;
    // Por CREACIÓN, no por actualización: la pregunta es "qué se vendió estos
    // días", y un ticket creado en el rango y editado después tiene su
    // `updated_at` fuera —sería justo el que falta—.
    expect(pedida.createdSince).toBeDefined();
    expect(pedida.updatedSince).toBeUndefined();
    // Y con techo: sin él, "repara del 1 al 3" bajaría de agosto en adelante.
    expect(pedida.createdBefore).toBeDefined();
  });

  it('convierte los días LOCALES a instantes UTC con la zona de la sucursal', async () => {
    const p = proveedorFalso([]);
    await runManualRange({ provider: p, repo, db: db.d1, now: () => new Date(T1) }, TARGET);

    const { createdSince, createdBefore } = p.peticiones[0]!;
    // México es UTC−6 todo el año: el 1 de agosto local empieza a las 06:00Z.
    expect(createdSince).toBe('2026-08-01T06:00:00.000Z');
    // Techo EXCLUSIVO en el inicio del día siguiente al último pedido, para que
    // el 3 de agosto entre COMPLETO. Con '2026-08-03T06:00:00Z' se perderían
    // las 24 horas del último día, y el reporte se vería perfectamente bien.
    expect(createdBefore).toBe('2026-08-04T06:00:00.000Z');
  });

  it('un rango de un solo día pide exactamente 24 horas', async () => {
    const p = proveedorFalso([]);
    await runManualRange(
      { provider: p, repo, db: db.d1, now: () => new Date(T1) },
      { ...TARGET, rango: { desde: '2026-08-15', hasta: '2026-08-15' } },
    );
    const { createdSince, createdBefore } = p.peticiones[0]!;
    expect(Date.parse(createdBefore!) - Date.parse(createdSince!)).toBe(86_400_000);
  });
});

describe('no toca el estado del pipeline automático', () => {
  it('una corrida exitosa NO mueve el checkpoint', async () => {
    const antes = await repo.getSyncState(STORE);
    const r = await runManualRange(
      { provider: proveedorFalso(HISTORICO.slice(0, 3)), repo, db: db.d1, now: () => new Date(T1) },
      TARGET,
    );
    expect(r.outcome).toBe('SUCCESS');

    const despues = await repo.getSyncState(STORE);
    // Moverlo abriría un hueco entre el rango reparado y el presente: todo lo
    // ocurrido entre el checkpoint viejo y el nuevo se daría por sincronizado
    // sin haberlo pedido nunca.
    expect(despues.lastSyncedAt).toBe(antes.lastSyncedAt);
    expect(despues.lastSuccessAt).toBe(antes.lastSuccessAt);
    expect(despues.backfillStatus).toBe('COMPLETE');
  });

  it('un fallo NO marca la sucursal ni rompe su backfill', async () => {
    const antes = await repo.getSyncState(STORE);
    const r = await runManualRange(
      {
        provider: proveedorFalso([], [new SalesProviderError('INVALID_TOKEN', 'token muerto')]),
        repo, db: db.d1, now: () => new Date(T1),
        retry: { maxIntentos: 1, baseMs: 0 },
      },
      TARGET,
    );
    expect(r.outcome).toBe('FAILED');
    expect(r.errorCode).toBe('INVALID_TOKEN');

    const despues = await repo.getSyncState(STORE);
    // La sincronización nocturna puede estar perfectamente sana: que falle una
    // reparación a mano no es motivo para declararla rota.
    expect(despues.consecutiveFailures).toBe(antes.consecutiveFailures);
    expect(despues.lastRunStatus).toBe(antes.lastRunStatus);
    expect(despues.backfillStatus).toBe('COMPLETE');
    expect(despues.lastSyncedAt).toBe(antes.lastSyncedAt);
  });
});

describe('bitácora', () => {
  it('registra tipo MANUAL, quién la disparó y la ventana pedida', async () => {
    await runManualRange(
      { provider: proveedorFalso(HISTORICO.slice(0, 2)), repo, db: db.d1, now: () => new Date(T1) },
      TARGET,
    );

    const corridas = await repo.listAllRuns();
    const manual = corridas.find((c) => c.kind === 'MANUAL');
    expect(manual).toBeDefined();
    expect(manual!.status).toBe('SUCCESS');
    expect(manual!.triggeredBy).toBe(ADMIN);
    expect(manual!.requestedFrom).toBe('2026-08-01T06:00:00.000Z');
    expect(manual!.cutoffAt).toBe('2026-08-04T06:00:00.000Z');
    expect(manual!.receiptsUpserted).toBe(2);
  });

  it('un fallo también queda registrado, con su código y su detalle', async () => {
    await runManualRange(
      {
        provider: proveedorFalso([], [new SalesProviderError('PROVIDER_UNAVAILABLE', 'caído')]),
        repo, db: db.d1, now: () => new Date(T1),
        retry: { maxIntentos: 1, baseMs: 0 },
      },
      TARGET,
    );

    const manual = (await repo.listAllRuns()).find((c) => c.kind === 'MANUAL')!;
    expect(manual.status).toBe('ERROR');
    expect(manual.errorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(manual.errorDetail).toContain('caído');
    // Aun fallando, se sabe qué se pidió: sin eso no se puede repetir.
    expect(manual.requestedFrom).toBe('2026-08-01T06:00:00.000Z');
  });
});

describe('idempotencia y cuota', () => {
  it('repetir el mismo rango no duplica tickets ni renglones', async () => {
    const contar = async () => {
      const r = db.raw
        .prepare(
          `SELECT (SELECT COUNT(*) FROM sales_receipts) AS recibos,
                  (SELECT COUNT(*) FROM sales_receipt_lines) AS renglones`,
        )
        .get() as { recibos: number; renglones: number };
      return r;
    };

    const deps = {
      provider: proveedorFalso(HISTORICO), repo, db: db.d1, now: () => new Date(T1),
    };
    await runManualRange(deps, TARGET);
    const primera = await contar();
    await runManualRange(deps, TARGET);
    const segunda = await contar();

    // El MISMO upsert que el backfill y el incremental: reparar dos veces el
    // mismo rango es inocuo, que es lo que permite hacerlo sin miedo.
    expect(segunda).toEqual(primera);
  });

  it('sin cuota disponible no pide ni una página y no marca error', async () => {
    await consumeBudget(db.d1, DAILY_WRITE_BUDGET, new Date(T1));

    const p = proveedorFalso(HISTORICO);
    const r = await runManualRange(
      { provider: p, repo, db: db.d1, now: () => new Date(T1) },
      TARGET,
    );

    expect(r.outcome).toBe('PAUSED_BUDGET');
    expect(p.peticiones).toHaveLength(0);
    // Cuota agotada no es un fallo del proveedor: la corrida se cierra bien y
    // el rango se puede repetir mañana sin consecuencias.
    const manual = (await repo.listAllRuns()).find((c) => c.kind === 'MANUAL')!;
    expect(manual.status).toBe('SUCCESS');
    expect(manual.errorCode).toBeNull();
  });
});
