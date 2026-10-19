// `receiptsByDay` — tickets de un día para el detalle de la vista de Ventas.
//
// Lo que importa de esta consulta y aquí se fija:
//   · los cancelados NO aparecen (como en los totales del día),
//   · la suma firmada de los tickets de un día == `netSalesCents` de ese día
//     (las dos lecturas, detalle y total, no pueden separarse),
//   · trae el nombre de la sucursal, y con varias sucursales las distingue y
//     el filtro por sucursal acota de verdad,
//   · aísla por inquilino.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestD1, type TestDb } from './d1-sqlite.testing';
import { createRepo, type SalesRepo } from './index';
import { normalizeReceipts, type LoyverseReceipt } from '../loyverse/normalize';
import { storeId as makeStoreId } from './ids';
import type { NormalizedReceipt } from '../types';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(AQUI, '../../../../migrations');
const FIXTURES = join(AQUI, '../../../../fixtures');

const TENANT = 'tnt_kumobi';
const ACCOUNT = 'acc_kumobi';
const PROVIDER_STORE = '25d1edc7-527e-432b-9b3f-61d06df6fd88';
const STORE = makeStoreId(ACCOUNT, PROVIDER_STORE);
const AHORA = '2026-09-02T00:00:00.000Z';
const RANGO = { desde: '2026-05-21', hasta: '2026-09-01' };

const crudos: LoyverseReceipt[] = JSON.parse(
  readFileSync(join(FIXTURES, 'loyverse-historico-2026-05-21_2026-09-01.json'), 'utf8'),
).receipts;
const normalizados: NormalizedReceipt[] = normalizeReceipts(crudos, {
  timeZone: 'America/Mexico_City',
});

function migraciones(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'));
}

let db: TestDb;
let repo: SalesRepo;

beforeAll(async () => {
  db = createTestD1(migraciones());
  repo = createRepo(db.d1, TENANT);
  await repo.upsertAccount(
    {
      id: ACCOUNT,
      provider: 'loyverse',
      alias: 'Kumobi',
      tokenCiphertext: 'cifrado',
      tokenIv: 'iv',
      tokenLast4: 'ab12',
      defaultTimezone: 'America/Mexico_City',
      backfillMaxDays: null,
    },
    AHORA,
  );
  await repo.syncStores(
    ACCOUNT,
    'loyverse',
    [{ providerStoreId: PROVIDER_STORE, name: 'KUMOBI' }],
    { timezone: 'America/Mexico_City' },
    AHORA,
  );
  await repo.upsertReceipts(
    { provider: 'loyverse', accountId: ACCOUNT, storeId: STORE },
    normalizados,
    { syncedAt: AHORA },
  );
});

describe('receiptsByDay', () => {
  it('excluye los cancelados: el 2026-09-01 (par cancelado) no devuelve tickets', async () => {
    expect(await repo.receiptsByDay('2026-09-01')).toEqual([]);
  });

  it('la suma firmada de los tickets de un día == netSalesCents de ese día', async () => {
    const dias = await repo.dailyTotals(RANGO);
    expect(dias.length).toBeGreaterThan(0);
    for (const d of dias) {
      const recibos = await repo.receiptsByDay(d.businessDate);
      const suma = recibos.reduce(
        (a, r) => a + (r.receiptType === 'REFUND' ? -r.totalCents : r.totalCents),
        0,
      );
      expect(suma).toBe(d.netSalesCents);
    }
  });

  it('trae el nombre y la zona de la sucursal, ordenado cronológicamente', async () => {
    // El 2026-06-09 es el día de los 10 reembolsos (ventas netas negativas).
    const recibos = await repo.receiptsByDay('2026-06-09');
    expect(recibos.length).toBeGreaterThan(0);
    for (const r of recibos) {
      expect(r.storeName).toBe('KUMOBI');
      expect(r.storeTimezone).toBe('America/Mexico_City');
    }
    const fechas = recibos.map((r) => r.providerCreatedAt);
    expect([...fechas].sort()).toEqual(fechas); // no decreciente
    // Al menos un reembolso con su recibo original anotado.
    expect(recibos.some((r) => r.receiptType === 'REFUND' && r.refundForReceiptNumber)).toBe(
      true,
    );
  });

  it('cada ticket trae sus renglones (para el desplegable)', async () => {
    const recibos = await repo.receiptsByDay('2026-06-09');
    const conRenglones = recibos.filter((r) => r.lines.length > 0);
    expect(conRenglones.length).toBeGreaterThan(0);
    for (const l of conRenglones[0]!.lines) {
      expect(typeof l.itemName).toBe('string');
      expect(typeof l.totalCents).toBe('number');
      expect(typeof l.quantity).toBe('number');
    }
  });

  it('aísla por inquilino: otro inquilino no ve estos tickets', async () => {
    const otro = createRepo(db.d1, 'tnt_otro');
    expect(await otro.receiptsByDay('2026-06-09')).toEqual([]);
  });

  describe('con una segunda sucursal', () => {
    const PINOLO_ACCOUNT = 'acc_pinolo';
    const PINOLO_PROVIDER_STORE = 'pinolo-store-1';
    const PINOLO_STORE = makeStoreId(PINOLO_ACCOUNT, PINOLO_PROVIDER_STORE);
    // Un día que SÍ tiene actividad de KUMOBI, para que "ambas sucursales" sea
    // comprobable; se resuelve en tiempo de ejecución, no a mano.
    let DIA = '';

    beforeAll(async () => {
      DIA = (await repo.dailyTotals(RANGO)).find((d) => d.netTickets > 0)!.businessDate;
      await repo.upsertAccount(
        {
          id: PINOLO_ACCOUNT,
          provider: 'loyverse',
          alias: 'Pinolo',
          tokenCiphertext: 'cifrado',
          tokenIv: 'iv',
          tokenLast4: 'cd34',
          defaultTimezone: 'America/Mexico_City',
          backfillMaxDays: null,
        },
        AHORA,
      );
      await repo.syncStores(
        PINOLO_ACCOUNT,
        'loyverse',
        [{ providerStoreId: PINOLO_PROVIDER_STORE, name: 'Pinolo' }],
        { timezone: 'America/Mexico_City' },
        AHORA,
      );
      // Un ticket de Pinolo ese día, insertado directo (no hace falta el crudo).
      db.raw
        .prepare(
          `INSERT INTO sales_receipts
             (id, tenant_id, account_id, store_id, provider, receipt_number,
              receipt_type, receipt_date, business_date, total_cents,
              provider_created_at, provider_updated_at, synced_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          'rcpt_pinolo_1', TENANT, PINOLO_ACCOUNT, PINOLO_STORE, 'loyverse', '1-0001',
          'SALE', `${DIA}T18:00:00.000Z`, DIA, 12345,
          `${DIA}T18:00:00.000Z`, `${DIA}T18:00:00.000Z`, AHORA,
        );
    });

    it('sin filtro, lista tickets de ambas sucursales con su nombre', async () => {
      const recibos = await repo.receiptsByDay(DIA);
      const nombres = new Set(recibos.map((r) => r.storeName));
      expect(nombres.has('Pinolo')).toBe(true);
      expect(nombres.has('KUMOBI')).toBe(true);
    });

    it('el filtro por sucursal acota de verdad', async () => {
      const soloPinolo = await repo.receiptsByDay(DIA, { storeId: PINOLO_STORE });
      expect(soloPinolo.every((r) => r.storeName === 'Pinolo')).toBe(true);
      expect(soloPinolo).toHaveLength(1);

      const soloKumobi = await repo.receiptsByDay(DIA, { storeId: STORE });
      expect(soloKumobi.every((r) => r.storeName === 'KUMOBI')).toBe(true);
    });
  });
});
