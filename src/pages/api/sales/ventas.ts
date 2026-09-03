// Resumen de ventas por día — épica 02, HU-17.
//
//   GET /api/sales/ventas?desde=&hasta=&sucursal=
//
// Vista mínima: ventas netas y tickets por día. Sin comparativos ni Food Cost
// —eso es la épica 03—; esto existe para que el dato sincronizado se pueda ver
// y para detectar temprano un error de zona horaria o de reembolsos.
import type { APIRoute } from 'astro';
import { errorResponse, getRepo, json, HttpError } from '../../../lib/sales/server';

export const prerender = false;

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DIAS_POR_DEFECTO = 30;

function haceDias(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const repo = getRepo(locals);

    const desde = url.searchParams.get('desde') ?? haceDias(DIAS_POR_DEFECTO);
    const hasta = url.searchParams.get('hasta') ?? new Date().toISOString().slice(0, 10);
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
      // Filtrar por una sucursal de otro inquilino no debe devolver nada ni
      // filtrarse en silencio: se rechaza.
      throw new HttpError(404, 'La sucursal no existe.');
    }

    const dias = await repo.dailyTotals({ desde, hasta }, { storeId: sucursal });

    return json({ dias, rango: { desde, hasta }, sucursales, sucursal: sucursal ?? null });
  } catch (err) {
    return errorResponse(err);
  }
};
