// Ítems vendidos y estado del mapeo — épica 02, HU-11.
//
//   GET /api/sales/items?desde=&hasta=&sucursal=
//
// Devuelve lo que se vendió agrupado por ítem del POS, con su mapeo si ya lo
// tiene, y la cobertura del rango. Los ítems SIN mapear vienen en la misma
// lista, no aparte: son el hueco que impide cerrar el Food Cost y tienen que
// ser visibles y contabilizables, no descartados en silencio.
//
// Las RECETAS no salen de aquí. Viven en Firestore y las lee la isla con el SDK
// cliente; este endpoint solo conoce el `recipe_id`. Es la única frontera entre
// los dos almacenes, y se cruza en el navegador, donde ya hay sesión de Firebase.
import type { APIRoute } from 'astro';
import { cobertura } from '../../../lib/sales/repo';
import { errorResponse, getRepo, json, HttpError } from '../../../lib/sales/server';

export const prerender = false;

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const repo = getRepo(locals);

    // Sin rango explícito se usa TODO el histórico sincronizado, no los últimos
    // 30 días: el mapeo es una tarea de catálogo, no un reporte de periodo, y
    // un ítem que se vendió en junio necesita mapeo igual que el de ayer.
    const rangoTotal = await repo.salesDateRange();
    if (!rangoTotal) {
      return json({
        items: [],
        cobertura: cobertura([]),
        rango: null,
        sucursales: [],
        sucursal: null,
      });
    }

    const desde = url.searchParams.get('desde') ?? rangoTotal.desde;
    const hasta = url.searchParams.get('hasta') ?? rangoTotal.hasta;
    for (const [nombre, v] of [['desde', desde], ['hasta', hasta]] as const) {
      if (!ES_FECHA.test(v)) {
        throw new HttpError(400, `El parámetro "${nombre}" debe tener el formato YYYY-MM-DD.`);
      }
    }
    if (desde > hasta) {
      throw new HttpError(400, 'La fecha inicial es posterior a la final.');
    }

    const sucursal = url.searchParams.get('sucursal') ?? undefined;
    const sucursales = (await repo.listStores()).map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
    }));
    if (sucursal && !sucursales.some((s) => s.id === sucursal)) {
      throw new HttpError(404, 'La sucursal no existe.');
    }

    const items = await repo.listPosItems({ desde, hasta }, { storeId: sucursal });

    return json({
      items,
      cobertura: cobertura(items),
      rango: { desde, hasta },
      rangoDisponible: rangoTotal,
      sucursales,
      sucursal: sucursal ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
};
