// Cifras propias para la conciliación — épica 02, HU-16.
//
//   GET /api/sales/conciliacion?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
//
// Devuelve NUESTRO lado del cuadre. El lado de Loyverse lo aporta el usuario
// subiendo el reporte del Back Office, que se compara en el navegador: no hace
// falta guardarlo, y así el reporte nunca queda desactualizado respecto a lo
// que el POS diga hoy.
//
// Sin rango se usa el histórico completo que haya en la base.
import type { APIRoute } from 'astro';
import { errorResponse, getRepo, json, HttpError } from '../../../lib/sales/server';

export const prerender = false;

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const repo = getRepo(locals);

    let desde = url.searchParams.get('desde') ?? undefined;
    let hasta = url.searchParams.get('hasta') ?? undefined;
    for (const [nombre, v] of [['desde', desde], ['hasta', hasta]] as const) {
      if (v && !ES_FECHA.test(v)) {
        throw new HttpError(400, `El parámetro "${nombre}" debe tener el formato YYYY-MM-DD.`);
      }
    }

    if (!desde || !hasta) {
      const rango = await repo.salesDateRange();
      if (!rango) return json({ dias: [], rango: null, sinDatos: true });
      desde = desde ?? rango.desde;
      hasta = hasta ?? rango.hasta;
    }

    const dias = await repo.dailyTotals({ desde, hasta });
    return json({ dias, rango: { desde, hasta }, sinDatos: dias.length === 0 });
  } catch (err) {
    return errorResponse(err);
  }
};
