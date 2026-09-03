// Límite de sucursales activas por inquilino — controla el consumo de la base.
//
// Se limita lo ACTIVO, no lo descubierto: una sucursal inactiva no sincroniza
// y por lo tanto no consume. Descubrir nunca se rechaza —no se pierde
// información—, y activar es el punto donde el límite se hace valer.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestD1, type TestDb } from './d1-sqlite.testing';
import { createRepo, type SalesRepo } from './index';
import { storeId as makeStoreId } from './ids';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../../migrations');
const TENANT = 'tnt_kumobi';
const CUENTA = 'acc1';
const T = '2026-09-03T00:00:00.000Z';

let db: TestDb;
let repo: SalesRepo;

const sucursal = (id: string, name = id) => ({ providerStoreId: id, name });

async function sincronizar(...ids: string[]) {
  return repo.syncStores(
    CUENTA, 'loyverse', ids.map((i) => sucursal(i)),
    { timezone: 'America/Mexico_City' }, T,
  );
}

beforeEach(async () => {
  db = createTestD1(
    readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')),
  );
  repo = createRepo(db.d1, TENANT);
  await repo.upsertAccount(
    {
      id: CUENTA, provider: 'loyverse', alias: 'Cuenta',
      tokenCiphertext: 'x', tokenIv: 'y', tokenLast4: '1234',
      defaultTimezone: 'America/Mexico_City', backfillMaxDays: null,
    },
    T,
  );
});

describe('cupo por defecto', () => {
  it('el inquilino arranca con 3 sucursales activas permitidas', async () => {
    const cupo = await repo.cupoSucursales();
    expect(cupo.limite).toBe(3);
    expect(cupo.activas).toBe(0);
    expect(cupo.disponibles).toBe(3);
  });
});

describe('descubrimiento', () => {
  it('las sucursales dentro del cupo entran activas', async () => {
    const r = await sincronizar('s1', 's2');
    expect(r.sinCupo).toEqual([]);
    expect((await repo.listStores()).every((s) => s.active)).toBe(true);
    expect((await repo.cupoSucursales()).disponibles).toBe(1);
  });

  it('NO se rechaza el descubrimiento: lo que excede se guarda inactivo', async () => {
    const r = await sincronizar('s1', 's2', 's3', 's4', 's5');
    // Las cinco existen —no se pierde información— pero solo tres sincronizan.
    expect(await repo.listStores()).toHaveLength(5);
    expect(r.sinCupo).toEqual(['s4', 's5']);
    const activas = (await repo.listStores()).filter((s) => s.active);
    expect(activas).toHaveLength(3);
    expect((await repo.cupoSucursales()).disponibles).toBe(0);
  });

  it('re-sincronizar no reactiva lo que quedó fuera de cupo', async () => {
    await sincronizar('s1', 's2', 's3', 's4');
    await sincronizar('s1', 's2', 's3', 's4');
    expect((await repo.listStores()).filter((s) => s.active)).toHaveLength(3);
  });
});

describe('activación manual', () => {
  it('rechaza activar cuando no queda cupo, y dice por qué', async () => {
    await sincronizar('s1', 's2', 's3', 's4');
    const cuarta = makeStoreId(CUENTA, 's4');
    const res = await repo.setStoreActive(cuarta, true, T);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.motivo).toBe('SIN_CUPO');
  });

  it('liberar cupo permite activar otra', async () => {
    await sincronizar('s1', 's2', 's3', 's4');
    expect((await repo.setStoreActive(makeStoreId(CUENTA, 's1'), false, T)).ok).toBe(true);
    expect((await repo.setStoreActive(makeStoreId(CUENTA, 's4'), true, T)).ok).toBe(true);
    expect((await repo.listStores()).filter((s) => s.active)).toHaveLength(3);
  });

  it('reactivar una que ya está activa no consume cupo', async () => {
    await sincronizar('s1', 's2', 's3');
    const res = await repo.setStoreActive(makeStoreId(CUENTA, 's1'), true, T);
    expect(res.ok).toBe(true);
    expect((await repo.cupoSucursales()).activas).toBe(3);
  });

  it('desactivar y volver a activar no permite saltarse el límite', async () => {
    // El agujero evidente: si activar no comprobara el cupo, bastaría con esto.
    await sincronizar('s1', 's2', 's3', 's4');
    await repo.setStoreActive(makeStoreId(CUENTA, 's4'), false, T);
    const res = await repo.setStoreActive(makeStoreId(CUENTA, 's4'), true, T);
    expect(res.ok).toBe(false);
  });

  it('una sucursal inexistente da NO_EXISTE, no SIN_CUPO', async () => {
    await sincronizar('s1', 's2', 's3');
    const res = await repo.setStoreActive('no-existe', true, T);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.motivo).toBe('NO_EXISTE');
  });
});

describe('la decisión del administrador se respeta', () => {
  it('re-sincronizar NO reactiva una sucursal desactivada a mano', async () => {
    await sincronizar('s1', 's2');
    await repo.setStoreActive(makeStoreId(CUENTA, 's1'), false, T);

    await sincronizar('s1', 's2');

    const s1 = (await repo.listStores()).find((s) => s.providerStoreId === 's1')!;
    expect(s1.active).toBe(false);
  });

  it('pero sí reactiva una que había desaparecido del POS y volvió', async () => {
    await sincronizar('s1', 's2');
    // s2 desaparece: la marcamos nosotros, no el administrador.
    await sincronizar('s1');
    expect((await repo.listStores()).find((s) => s.providerStoreId === 's2')!.active).toBe(false);

    await sincronizar('s1', 's2');
    expect((await repo.listStores()).find((s) => s.providerStoreId === 's2')!.active).toBe(true);
  });
});

describe('el límite es por inquilino', () => {
  it('cada inquilino tiene el suyo', async () => {
    db.raw
      .prepare(
        `INSERT INTO tenants (id,name,slug,default_timezone,currency,status,created_at,updated_at,max_active_stores)
         VALUES ('tnt_otro','Otro','otro','America/Mexico_City','MXN','ACTIVE',?,?,1)`,
      )
      .run(T, T);
    await sincronizar('s1', 's2', 's3');

    const otro = createRepo(db.d1, 'tnt_otro');
    expect((await otro.cupoSucursales()).limite).toBe(1);
    // Las 3 sucursales del otro inquilino no le consumen cupo.
    expect((await otro.cupoSucursales()).activas).toBe(0);
  });
});
