// Persistencia idempotente — épica 02, fase 2.
//
// Criterio de terminado de la fase: insertar el histórico completo DOS VECES
// deja 108 recibos, y una consulta SQL sobre la base reproduce los seis totales
// de la conciliación. Esto último es lo que garantiza que la regla de negocio
// en SQL (`totals.ts`) y la regla en memoria (`aggregate.ts`) no se separen.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestD1, type TestDb } from './d1-sqlite.testing';
import { createRepo, type SalesRepo } from './index';
import { normalizeReceipts, type LoyverseReceipt } from '../loyverse/normalize';
import { dailyTotals } from '../aggregate';
import { toCents, formatMxn } from '../money';
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

interface FilaReporte { brutas: number; reembolsos: number; descuentos: number; netas: number; costo: number; impuestos: number }
const reporte = new Map<string, FilaReporte>();
for (const linea of readFileSync(join(FIXTURES, 'back-office-2026-05-21_2026-09-01.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1)) {
  if (!linea.trim()) continue;
  const c = linea.split(',');
  const [d, m, y] = c[0]!.split('/');
  reporte.set(`20${y}-${m}-${d}`, {
    brutas: toCents(c[1]), reembolsos: toCents(c[2]), descuentos: toCents(c[3]),
    netas: toCents(c[4]), costo: toCents(c[5]), impuestos: toCents(c[8]),
  });
}

let db: TestDb;
let repo: SalesRepo;

async function sembrarCuentaYSucursal(tenantId: string, accountId: string) {
  const r = createRepo(db.d1, tenantId);
  await r.upsertAccount({
    id: accountId,
    provider: 'loyverse',
    alias: 'Kumobi',
    tokenCiphertext: 'cifrado',
    tokenIv: 'iv',
    tokenLast4: 'ab12',
    defaultTimezone: 'America/Mexico_City',
    backfillMaxDays: null, // Kumobi opera sin tope
  }, AHORA);
  await r.syncStores(
    accountId, 'loyverse',
    [{ providerStoreId: PROVIDER_STORE, name: 'KUMOBI' }],
    { timezone: 'America/Mexico_City' }, AHORA,
  );
  return r;
}

beforeAll(async () => {
  db = createTestD1(
    readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')),
  );
  repo = await sembrarCuentaYSucursal(TENANT, ACCOUNT);
  await repo.upsertReceipts(
    { provider: 'loyverse', accountId: ACCOUNT, storeId: STORE },
    normalizados,
    { syncedAt: AHORA },
  );
});

describe('alta de cuenta y sucursales', () => {
  it('descubre la sucursal y la deja activa', async () => {
    const stores = await repo.listStores(ACCOUNT);
    expect(stores).toHaveLength(1);
    expect(stores[0]!.name).toBe('KUMOBI');
    expect(stores[0]!.active).toBe(true);
    expect(stores[0]!.timezone).toBe('America/Mexico_City');
  });

  it('una sucursal que desaparece del POS se marca, no se borra', async () => {
    // Se re-sincroniza con una lista vacía: la sucursal ya no existe allá.
    const res = await repo.syncStores(ACCOUNT, 'loyverse', [], { timezone: 'America/Mexico_City' }, AHORA);
    expect(res.missing).toBe(1);
    const stores = await repo.listStores(ACCOUNT);
    expect(stores).toHaveLength(1);          // sigue existiendo
    expect(stores[0]!.active).toBe(false);   // pero inactiva

    // Y al reaparecer, se reactiva sin perder nada.
    await repo.syncStores(
      ACCOUNT, 'loyverse',
      [{ providerStoreId: PROVIDER_STORE, name: 'KUMOBI' }],
      { timezone: 'America/Mexico_City' }, AHORA,
    );
    expect((await repo.listStores(ACCOUNT))[0]!.active).toBe(true);
  });
});

describe('idempotencia', () => {
  it('guardó el histórico completo', async () => {
    expect(await repo.countReceipts()).toBe(108);
    const renglones = normalizados.reduce((a, r) => a + r.lines.length, 0);
    expect(await repo.countLines()).toBe(renglones);
  });

  it('re-insertar el mismo histórico no duplica nada', async () => {
    const renglonesAntes = await repo.countLines();
    await repo.upsertReceipts(
      { provider: 'loyverse', accountId: ACCOUNT, storeId: STORE },
      normalizados,
      { syncedAt: '2026-09-02T06:00:00.000Z' },
    );
    expect(await repo.countReceipts()).toBe(108);
    expect(await repo.countLines()).toBe(renglonesAntes);
  });

  it('un ticket editado en el POS con menos renglones no deja huérfanos', async () => {
    const original = normalizados.find((r) => r.lines.length > 1)!;
    const recortado: NormalizedReceipt = { ...original, lines: [original.lines[0]!] };
    await repo.upsertReceipts(
      { provider: 'loyverse', accountId: ACCOUNT, storeId: STORE },
      [recortado],
      { syncedAt: '2026-09-02T07:00:00.000Z' },
    );
    const n = db.raw
      .prepare('SELECT count(*) c FROM sales_receipt_lines WHERE receipt_id LIKE ?')
      .get(`%${original.receiptNumber}`) as { c: number };
    expect(n.c).toBe(1);

    // Se restituye para no contaminar las pruebas de totales.
    await repo.upsertReceipts(
      { provider: 'loyverse', accountId: ACCOUNT, storeId: STORE },
      [original],
      { syncedAt: '2026-09-02T08:00:00.000Z' },
    );
  });

  it('una corrida atrasada no revierte datos más nuevos', async () => {
    const r = normalizados[0]!;
    const nuevo: NormalizedReceipt = { ...r, totalCents: 999_99, providerUpdatedAt: '2027-01-01T00:00:00.000Z' };
    const viejo: NormalizedReceipt = { ...r, totalCents: 1, providerUpdatedAt: '2020-01-01T00:00:00.000Z' };

    await repo.upsertReceipts({ provider: 'loyverse', accountId: ACCOUNT, storeId: STORE }, [nuevo], { syncedAt: AHORA });
    await repo.upsertReceipts({ provider: 'loyverse', accountId: ACCOUNT, storeId: STORE }, [viejo], { syncedAt: AHORA });

    const fila = db.raw
      .prepare('SELECT total_cents t FROM sales_receipts WHERE receipt_number = ?')
      .get(r.receiptNumber) as { t: number };
    expect(fila.t).toBe(999_99);

    await repo.upsertReceipts({ provider: 'loyverse', accountId: ACCOUNT, storeId: STORE }, [r], { syncedAt: AHORA });
  });
});

describe('los totales en SQL cuadran con el Back Office', () => {
  it('los seis campos, día por día', async () => {
    const dias = await repo.dailyTotals(RANGO);
    const porDia = new Map(dias.map((d) => [d.businessDate, d]));

    const campos: ReadonlyArray<[string, (d: (typeof dias)[number]) => number, (f: FilaReporte) => number]> = [
      ['Ventas netas', (d) => d.netSalesCents, (f) => f.netas],
      ['Ventas brutas', (d) => d.grossSalesCents, (f) => f.brutas],
      ['Reembolsos', (d) => d.refundsCents, (f) => f.reembolsos],
      ['Descuentos', (d) => d.discountsCents, (f) => f.descuentos],
      ['Impuestos', (d) => d.taxCents, (f) => f.impuestos],
      ['Costo de los bienes', (d) => d.costReportedCents, (f) => f.costo],
    ];

    for (const [nombre, nuestro, suyo] of campos) {
      const difs: string[] = [];
      for (const [dia, fila] of reporte) {
        const d = porDia.get(dia);
        const a = d ? nuestro(d) : 0;
        const b = suyo(fila);
        if (a !== b) difs.push(`${dia}: ${formatMxn(a)} vs ${formatMxn(b)}`);
      }
      expect(difs, `${nombre} — días con diferencia`).toEqual([]);
    }
  });

  it('la ruta SQL y la ruta en memoria dan exactamente lo mismo', async () => {
    // Si alguien toca una regla en `totals.ts` y no en `aggregate.ts`, o al
    // revés, esta prueba lo detecta antes de que las cifras se separen.
    const sql = await repo.dailyTotals(RANGO);
    const memoria = [...dailyTotals(normalizados).values()].sort((a, b) =>
      a.businessDate.localeCompare(b.businessDate),
    );
    expect(sql).toEqual(memoria);
  });
});

describe('filtro por sucursal', () => {
  it('acota los totales a una sola sucursal', async () => {
    // Segunda sucursal de la misma cuenta, con una porción del histórico.
    const SEGUNDA = makeStoreId(ACCOUNT, 'sucursal-2');
    await repo.syncStores(
      ACCOUNT, 'loyverse',
      [
        { providerStoreId: PROVIDER_STORE, name: 'KUMOBI' },
        { providerStoreId: 'sucursal-2', name: 'Segunda' },
      ],
      { timezone: 'America/Mexico_City' }, AHORA,
    );
    const suyos = normalizados
      // Sin cancelados: `dailyTotals` los excluye, así que sumarlos aquí daría
      // una expectativa equivocada (el fixture trae la venta cancelada 2-0021).
      .filter((r) => r.receiptType === 'SALE' && !r.cancelledAt)
      .slice(0, 3)
      .map((r) => ({ ...r, providerStoreId: 'sucursal-2', receiptNumber: `S2-${r.receiptNumber}` }));
    await repo.upsertReceipts(
      { provider: 'loyverse', accountId: ACCOUNT, storeId: SEGUNDA },
      suyos,
      { syncedAt: AHORA },
    );

    const todas = await repo.dailyTotals(RANGO);
    const soloPrimera = await repo.dailyTotals(RANGO, { storeId: STORE });
    const soloSegunda = await repo.dailyTotals(RANGO, { storeId: SEGUNDA });

    const suma = (ds: typeof todas) => ds.reduce((a, d) => a + d.netSalesCents, 0);
    expect(suma(soloPrimera)).toBe(3548133);
    expect(suma(soloSegunda)).toBe(suyos.reduce((a, r) => a + r.totalCents, 0));
    expect(suma(todas)).toBe(suma(soloPrimera) + suma(soloSegunda));
    // Y las brutas, que salen de los renglones, también se acotan.
    expect(soloSegunda.reduce((a, d) => a + d.grossSalesCents, 0)).toBeGreaterThan(0);
    expect(soloSegunda.reduce((a, d) => a + d.grossSalesCents, 0)).toBeLessThan(
      todas.reduce((a, d) => a + d.grossSalesCents, 0),
    );

    // Este archivo comparte la base entre pruebas (beforeAll), así que se
    // deshace lo insertado para no alterar los conteos de las siguientes.
    db.raw.prepare('DELETE FROM sales_receipt_lines WHERE store_id = ?').run(SEGUNDA);
    db.raw.prepare('DELETE FROM sales_receipts WHERE store_id = ?').run(SEGUNDA);
    db.raw.prepare('DELETE FROM sales_stores WHERE id = ?').run(SEGUNDA);
  });

  it('una sucursal sin ventas devuelve vacío, no todo', async () => {
    expect(await repo.dailyTotals(RANGO, { storeId: 'no-existe' })).toEqual([]);
  });
});

describe('aislamiento entre inquilinos', () => {
  it('un inquilino no ve ni suma los datos del otro', async () => {
    db.raw
      .prepare(
        `INSERT INTO tenants (id,name,slug,default_timezone,currency,status,created_at,updated_at)
         VALUES ('tnt_otro','Otro','otro','America/Mexico_City','MXN','ACTIVE',?,?)`,
      )
      .run(AHORA, AHORA);

    const otro = await sembrarCuentaYSucursal('tnt_otro', 'acc_otro');
    await otro.upsertReceipts(
      { provider: 'loyverse', accountId: 'acc_otro', storeId: makeStoreId('acc_otro', PROVIDER_STORE) },
      normalizados.slice(0, 5),
      { syncedAt: AHORA },
    );

    expect(await otro.countReceipts()).toBe(5);
    expect(await repo.countReceipts()).toBe(108);
    expect(await otro.listStores()).toHaveLength(1);

    // Y los totales de cada uno solo incluyen lo suyo.
    const nuestros = await repo.dailyTotals(RANGO);
    const suyos = await otro.dailyTotals(RANGO);
    const sumar = (ds: typeof nuestros) => ds.reduce((a, d) => a + d.netSalesCents, 0);
    expect(sumar(nuestros)).toBe(3548133);
    expect(sumar(suyos)).not.toBe(3548133);
    expect(suyos.length).toBeLessThan(nuestros.length);
  });

  it('createRepo rechaza construirse sin inquilino', () => {
    expect(() => createRepo(db.d1, '')).toThrow(/tenantId/i);
  });
});
