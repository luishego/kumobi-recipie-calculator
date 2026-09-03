// Ítems vendidos y mapeo a recetas — HU-11.
//
// Se prueba contra el histórico REAL de Kumobi (108 recibos, 284 renglones),
// no contra filas inventadas: la agregación por ítem tiene que respetar las
// mismas reglas de §8 que los totales —cancelados fuera, reembolsos en
// negativo— y esas reglas solo se verifican con los casos difíciles que ya
// existen en estos datos.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestD1, type TestDb } from './d1-sqlite.testing';
import { createRepo, type SalesRepo } from './index';
import { cobertura } from './itemMap';
import { posItemMapId, storeId as makeStoreId } from './ids';
import { normalizeReceipts, type LoyverseReceipt } from '../loyverse/normalize';
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
      tokenCiphertext: 'x', tokenIv: 'y', tokenLast4: 'ab12',
      defaultTimezone: 'America/Mexico_City', backfillMaxDays: null,
    },
    AHORA,
  );
  await repo.syncStores(
    ACCOUNT, 'loyverse', [{ providerStoreId: PROVIDER_STORE, name: 'KUMOBI' }],
    { timezone: 'America/Mexico_City' }, AHORA,
  );
  await repo.upsertReceipts(
    { provider: 'loyverse', accountId: ACCOUNT, storeId: STORE },
    normalizados,
    { syncedAt: AHORA },
  );
});

/** Los ítems del histórico real, indexados por nombre para leer las pruebas. */
async function porNombre() {
  const items = await repo.listPosItems(RANGO);
  const m = new Map<string, (typeof items)[number][]>();
  for (const it of items) {
    const previas = m.get(it.itemName);
    if (previas) previas.push(it);
    else m.set(it.itemName, [it]);
  }
  return { items, m };
}

describe('agregación de ítems vendidos', () => {
  it('devuelve los 28 ítems distintos del histórico real', async () => {
    const items = await repo.listPosItems(RANGO);
    expect(items).toHaveLength(28);
  });

  it('distingue dos ítems que comparten nombre y SKU', async () => {
    // Los dos "Bacon" del catálogo real: mismo nombre, mismo SKU 10006,
    // `item_id` distinto. Si la agrupación fuera por nombre o por SKU se
    // fusionarían, y su Food Cost quedaría mezclado para siempre.
    const { m } = await porNombre();
    const bacon = m.get('Bacon')!;
    expect(bacon).toHaveLength(2);
    expect(bacon[0]!.sku).toBe('10006');
    expect(bacon[1]!.sku).toBe('10006');
    expect(bacon[0]!.providerItemId).not.toBe(bacon[1]!.providerItemId);
  });

  it('el ingreso por ítem suma exactamente las ventas brutas del periodo', async () => {
    // Cuadra contra la misma cifra que ya concilió en HU-16: si la agregación
    // por ítem perdiera o duplicara renglones, esta suma se movería.
    const items = await repo.listPosItems(RANGO);
    const dias = await repo.dailyTotals(RANGO);
    const brutasDias = dias.reduce((a, d) => a + d.grossSalesCents, 0);

    // Los renglones de venta valen `total_cents` (YA neto del descuento de
    // renglón), y las brutas de `totals.ts` son `gross_total_cents` de solo
    // las ventas, ANTES del descuento. En el histórico de Kumobi el descuento
    // de renglón no es cero: son $1 441.05, la misma cifra que concilió HU-16.
    // Así que para cerrar la identidad hay que devolver las dos cosas que la
    // agregación por ítem descuenta: lo reembolsado y lo descontado.
    const porItem = items.reduce((a, i) => a + i.revenueCents, 0);
    const reembolsado = dias.reduce((a, d) => a + d.refundsCents, 0);
    const descontado = dias.reduce((a, d) => a + d.discountsCents, 0);
    expect(porItem + reembolsado + descontado).toBe(brutasDias);
  });

  it('los reembolsos restan unidades e ingreso del ítem', async () => {
    // "Agua mineral" (SKU 10024) tiene el reembolso 2-0022 de $50 sobre el
    // recibo 2-0021, ambos en el histórico.
    const { m } = await porNombre();
    const agua = m.get('Agua mineral')!;
    expect(agua).toHaveLength(1);
    // 9 unidades brutas contadas en el fixture, menos la reembolsada.
    expect(agua[0]!.unitsSold).toBeLessThan(9);
  });

  it('excluye por completo los recibos cancelados', async () => {
    const antes = await repo.listPosItems(RANGO);
    const totalAntes = antes.reduce((a, i) => a + i.revenueCents, 0);

    // Se cancela `1-0047` (9 renglones), NO `2-0021`: los únicos cancelados
    // de origen en el fixture son `2-0021` y su reembolso `2-0022`, así que
    // cancelar cualquiera de esos dos no movería ni un centavo y el test
    // pasaría sin probar nada.
    const { total } = db.raw
      .prepare(
        `SELECT SUM(l.total_cents) AS total
           FROM sales_receipt_lines l
           JOIN sales_receipts r ON r.id = l.receipt_id
          WHERE r.receipt_number = ?`,
      )
      .get('1-0047') as { total: number };
    expect(total).toBeGreaterThan(0);

    db.raw
      .prepare(`UPDATE sales_receipts SET cancelled_at = ? WHERE receipt_number = ?`)
      .run(AHORA, '1-0047');
    const despues = await repo.listPosItems(RANGO);
    const totalDespues = despues.reduce((a, i) => a + i.revenueCents, 0);

    // Exactamente los renglones del recibo cancelado, no "algo menos": una
    // diferencia distinta delataría que el filtro se lleva de más o de menos.
    expect(totalAntes - totalDespues).toBe(total);
  });

  it('ordena del que más ingreso trae al que menos', async () => {
    const items = await repo.listPosItems(RANGO);
    const ingresos = items.map((i) => i.revenueCents);
    expect([...ingresos].sort((a, b) => b - a)).toEqual(ingresos);
  });

  it('acota por sucursal', async () => {
    const otra = makeStoreId(ACCOUNT, 'sucursal-inexistente');
    expect(await repo.listPosItems(RANGO, { storeId: otra })).toEqual([]);
    expect(await repo.listPosItems(RANGO, { storeId: STORE })).toHaveLength(28);
  });

  it('acota por rango de fechas', async () => {
    const soloMayo = await repo.listPosItems({ desde: '2026-05-21', hasta: '2026-05-31' });
    expect(soloMayo.length).toBeGreaterThan(0);
    expect(soloMayo.length).toBeLessThan(28);
  });

  it('toma el nombre del renglón más reciente, no del primero', async () => {
    // Un ítem renombrado en el POS: los renglones viejos conservan el nombre
    // anterior. La pantalla debe mostrar el vigente.
    const items = await repo.listPosItems(RANGO);
    const veggie = items.find((i) => i.itemName === 'Veggie')!;
    db.raw
      .prepare(
        `UPDATE sales_receipt_lines SET item_name = 'Veggie Deluxe'
           WHERE provider_item_id = ?
             AND business_date = (SELECT MAX(business_date) FROM sales_receipt_lines
                                   WHERE provider_item_id = ?)`,
      )
      .run(veggie.providerItemId, veggie.providerItemId);

    const despues = await repo.listPosItems(RANGO);
    expect(despues.find((i) => i.providerItemId === veggie.providerItemId)!.itemName)
      .toBe('Veggie Deluxe');
  });
});

describe('guardar el mapeo', () => {
  async function primerItem() {
    return (await repo.listPosItems(RANGO))[0]!;
  }

  it('guarda un mapeo a receta y lo devuelve en la siguiente consulta', async () => {
    const it0 = await primerItem();
    const escritas = await repo.upsertItemMap(
      [{
        accountId: ACCOUNT,
        providerItemId: it0.providerItemId!,
        providerVariantId: it0.providerVariantId,
        kind: 'RECIPE',
        recipeId: 'rec-clasica',
        method: 'auto_name',
      }],
      AHORA,
    );
    expect(escritas).toBe(1);

    const deNuevo = (await repo.listPosItems(RANGO)).find((i) => i.clave === it0.clave)!;
    expect(deNuevo.mapeo).toEqual({
      kind: 'RECIPE',
      recipeId: 'rec-clasica',
      method: 'auto_name',
      confirmedByUser: true,
    });
  });

  it('la clave del ítem es el id de la fila: no hay que rearmar nada', async () => {
    const it0 = await primerItem();
    expect(it0.clave).toBe(
      posItemMapId(ACCOUNT, it0.providerItemId!, it0.providerVariantId ?? ''),
    );
  });

  it('re-guardar el mismo ítem corrige, no duplica', async () => {
    const it0 = await primerItem();
    const base = {
      accountId: ACCOUNT,
      providerItemId: it0.providerItemId!,
      providerVariantId: it0.providerVariantId,
      method: 'manual' as const,
    };
    await repo.upsertItemMap([{ ...base, kind: 'RECIPE', recipeId: 'r1' }], AHORA);
    await repo.upsertItemMap([{ ...base, kind: 'RECIPE', recipeId: 'r2' }], AHORA);

    expect(await repo.listItemMap()).toHaveLength(1);
    const vigente = (await repo.listPosItems(RANGO)).find((i) => i.clave === it0.clave)!;
    expect(vigente.mapeo!.recipeId).toBe('r2');
  });

  it('marca un ítem como "no aplica" sin receta', async () => {
    const it0 = await primerItem();
    await repo.upsertItemMap(
      [{
        accountId: ACCOUNT,
        providerItemId: it0.providerItemId!,
        providerVariantId: it0.providerVariantId,
        kind: 'IGNORED',
        method: 'manual',
      }],
      AHORA,
    );
    const vigente = (await repo.listPosItems(RANGO)).find((i) => i.clave === it0.clave)!;
    expect(vigente.mapeo).toMatchObject({ kind: 'IGNORED', recipeId: null });
  });

  it('rechaza un mapeo a receta sin receta', async () => {
    const it0 = await primerItem();
    await expect(
      repo.upsertItemMap(
        [{
          accountId: ACCOUNT, providerItemId: it0.providerItemId!,
          kind: 'RECIPE', method: 'manual',
        }],
        AHORA,
      ),
    ).rejects.toThrow(/requiere/i);
  });

  it('rechaza un "no aplica" con receta', async () => {
    const it0 = await primerItem();
    await expect(
      repo.upsertItemMap(
        [{
          accountId: ACCOUNT, providerItemId: it0.providerItemId!,
          kind: 'IGNORED', recipeId: 'r1', method: 'manual',
        }],
        AHORA,
      ),
    ).rejects.toThrow(/no puede llevar/i);
  });

  it('quitar el mapeo devuelve el ítem a "sin mapear"', async () => {
    const it0 = await primerItem();
    await repo.upsertItemMap(
      [{
        accountId: ACCOUNT, providerItemId: it0.providerItemId!,
        providerVariantId: it0.providerVariantId,
        kind: 'RECIPE', recipeId: 'r1', method: 'manual',
      }],
      AHORA,
    );
    expect(await repo.deleteItemMap(it0.clave)).toBe(true);
    const vigente = (await repo.listPosItems(RANGO)).find((i) => i.clave === it0.clave)!;
    expect(vigente.mapeo).toBeNull();
  });

  it('quitar un mapeo que no existe devuelve false, no lanza', async () => {
    expect(await repo.deleteItemMap('no|existe|')).toBe(false);
  });

  it('un lote se escribe de una sola vez', async () => {
    const items = (await repo.listPosItems(RANGO)).slice(0, 10);
    const escritas = await repo.upsertItemMap(
      items.map((i) => ({
        accountId: ACCOUNT,
        providerItemId: i.providerItemId!,
        providerVariantId: i.providerVariantId,
        kind: 'RECIPE' as const,
        recipeId: `rec-${i.providerItemId}`,
        method: 'auto_name' as const,
      })),
      AHORA,
    );
    expect(escritas).toBe(10);
    expect(await repo.listItemMap()).toHaveLength(10);
  });

  it('un lote vacío no va a la base', async () => {
    expect(await repo.upsertItemMap([], AHORA)).toBe(0);
  });
});

describe('aislamiento entre inquilinos', () => {
  it('no escribe un mapeo sobre una cuenta de otro inquilino', async () => {
    db.raw
      .prepare(
        `INSERT INTO tenants (id,name,slug,default_timezone,currency,status,created_at,updated_at)
         VALUES ('tnt_otro','Otro','otro','America/Mexico_City','MXN','ACTIVE',?,?)`,
      )
      .run(AHORA, AHORA);
    const otro = createRepo(db.d1, 'tnt_otro');

    // El otro inquilino intenta mapear un ítem de la cuenta de Kumobi.
    const escritas = await otro.upsertItemMap(
      [{
        accountId: ACCOUNT, providerItemId: 'cualquiera',
        kind: 'RECIPE', recipeId: 'r1', method: 'manual',
      }],
      AHORA,
    );
    expect(escritas).toBe(0);
    expect(await otro.listItemMap()).toHaveLength(0);
    expect(await repo.listItemMap()).toHaveLength(0);
  });

  it('los ítems de un inquilino no aparecen en el otro', async () => {
    db.raw
      .prepare(
        `INSERT INTO tenants (id,name,slug,default_timezone,currency,status,created_at,updated_at)
         VALUES ('tnt_otro','Otro','otro','America/Mexico_City','MXN','ACTIVE',?,?)`,
      )
      .run(AHORA, AHORA);
    expect(await createRepo(db.d1, 'tnt_otro').listPosItems(RANGO)).toEqual([]);
  });

  it('no borra el mapeo de otro inquilino', async () => {
    const it0 = (await repo.listPosItems(RANGO))[0]!;
    await repo.upsertItemMap(
      [{
        accountId: ACCOUNT, providerItemId: it0.providerItemId!,
        providerVariantId: it0.providerVariantId,
        kind: 'RECIPE', recipeId: 'r1', method: 'manual',
      }],
      AHORA,
    );
    db.raw
      .prepare(
        `INSERT INTO tenants (id,name,slug,default_timezone,currency,status,created_at,updated_at)
         VALUES ('tnt_otro','Otro','otro','America/Mexico_City','MXN','ACTIVE',?,?)`,
      )
      .run(AHORA, AHORA);

    expect(await createRepo(db.d1, 'tnt_otro').deleteItemMap(it0.clave)).toBe(false);
    expect(await repo.listItemMap()).toHaveLength(1);
  });
});

describe('cobertura del mapeo', () => {
  it('sin nada mapeado, todo el ingreso está sin decidir', async () => {
    const items = await repo.listPosItems(RANGO);
    const c = cobertura(items);
    expect(c.itemsSinMapear).toBe(28);
    expect(c.itemsMapeados).toBe(0);
    expect(c.mapeadoCents).toBe(0);
    expect(c.fraccionDecidida).toBe(0);
  });

  it('un ítem "no aplica" cuenta como decidido, no como hueco', async () => {
    // Es la razón de existir del tercer estado: sin él, "Envio" y las cervezas
    // dejarían la cobertura clavada por debajo del 100 % para siempre.
    const items = await repo.listPosItems(RANGO);
    await repo.upsertItemMap(
      items.map((i) => ({
        accountId: ACCOUNT,
        providerItemId: i.providerItemId!,
        providerVariantId: i.providerVariantId,
        kind: 'IGNORED' as const,
        method: 'manual' as const,
      })),
      AHORA,
    );
    const c = cobertura(await repo.listPosItems(RANGO));
    expect(c.itemsIgnorados).toBe(28);
    expect(c.sinMapearCents).toBe(0);
    expect(c.fraccionDecidida).toBe(1);
  });

  it('la fracción es null cuando no hay ingreso, en vez de un porcentaje falso', () => {
    expect(cobertura([]).fraccionDecidida).toBeNull();
  });

  it('mapear el ítem que más factura mueve la cobertura más que el que menos', async () => {
    const items = await repo.listPosItems(RANGO);
    const mapear = async (i: (typeof items)[number]) => {
      await repo.upsertItemMap(
        [{
          accountId: ACCOUNT, providerItemId: i.providerItemId!,
          providerVariantId: i.providerVariantId,
          kind: 'RECIPE', recipeId: 'r', method: 'manual',
        }],
        AHORA,
      );
      const c = cobertura(await repo.listPosItems(RANGO));
      await repo.deleteItemMap(i.clave);
      return c.fraccionDecidida!;
    };

    expect(await mapear(items[0]!)).toBeGreaterThan(await mapear(items.at(-1)!));
  });
});
