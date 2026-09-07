// Estado de sincronización, bitácora y consumo de cuota — épica 02, HU-14.
//
//   GET /api/sales/estado
//
// Una sola respuesta con todo lo que la pantalla necesita, en vez de tres
// peticiones: son tres consultas baratas sobre tablas pequeñas, y pedirlas
// juntas evita que la pantalla muestre un estado y una bitácora que no
// corresponden al mismo instante.
import type { APIRoute } from 'astro';
import { UMBRAL_SIN_SINCRONIZAR_HORAS } from '../../../lib/constants';
import {
  DAILY_WRITE_BUDGET, DB_SIZE_LIMIT_BYTES, DB_SIZE_WARN_BYTES,
  dbSizeBytes, rowsWrittenToday,
} from '../../../lib/sales/sync/budget';
import { errorResponse, getDb, getRepo, json } from '../../../lib/sales/server';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  try {
    const repo = getRepo(locals);
    const db = getDb(locals);

    const [cuentas, sucursales, estados, corridas, escritasHoy, tamano] = await Promise.all([
      repo.listAccounts(),
      repo.listStores(),
      repo.listSyncState(),
      repo.listAllRuns(50),
      rowsWrittenToday(db),
      dbSizeBytes(db),
    ]);

    const aliasPorCuenta = new Map(cuentas.map((c) => [c.id, c.alias] as const));
    const estadoPorSucursal = new Map(estados.map((e) => [e.storeId, e] as const));

    // La sucursal manda y el estado se le adosa, no al revés: una sucursal
    // recién descubierta todavía no tiene fila en `sync_state`, y omitirla de
    // esta pantalla escondería justo la que nunca ha sincronizado.
    const filas = sucursales.map((s) => ({
      storeId: s.id,
      nombre: s.name,
      accountId: s.accountId,
      cuenta: aliasPorCuenta.get(s.accountId) ?? s.accountId,
      cuentaStatus: cuentas.find((c) => c.id === s.accountId)?.status ?? null,
      timezone: s.timezone,
      activa: s.active,
      estado: estadoPorSucursal.get(s.id) ?? null,
    }));

    return json({
      sucursales: filas,
      corridas,
      umbralHoras: UMBRAL_SIN_SINCRONIZAR_HORAS,
      cuota: {
        escritasHoy,
        presupuesto: DAILY_WRITE_BUDGET,
        // El límite duro de Cloudflare, no el nuestro: al alcanzarlo la base
        // deja de aceptar CONSULTAS, no solo escrituras (§5.1). Se muestra
        // junto al presupuesto para que se entienda por qué el nuestro es menor.
        limiteDiario: 100_000,
        tamanoBytes: tamano,
        avisoTamanoBytes: DB_SIZE_WARN_BYTES,
        limiteTamanoBytes: DB_SIZE_LIMIT_BYTES,
      },
      ahora: new Date().toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
};
