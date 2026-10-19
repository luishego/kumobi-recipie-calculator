// Tickets de un día — épica 02, HU-17 (detalle del día).
//
//   GET /api/sales/recibos?fecha=YYYY-MM-DD&sucursal=
//
// Devuelve los tickets que componen la cifra de ese día en `/api/sales/ventas`
// (mismos criterios: cancelados excluidos). Cada ticket trae su sucursal, que
// importa cuando el inquilino tiene más de una.
import type { APIRoute } from 'astro';
import { errorResponse, getRepo, json, HttpError } from '../../../lib/sales/server';

export const prerender = false;

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const repo = getRepo(locals);

    const fecha = url.searchParams.get('fecha');
    if (!fecha || !ES_FECHA.test(fecha)) {
      throw new HttpError(400, 'El parámetro "fecha" debe tener el formato YYYY-MM-DD.');
    }

    const sucursal = url.searchParams.get('sucursal') ?? undefined;
    if (sucursal) {
      // Igual que en /ventas: una sucursal de otro inquilino se rechaza, no se
      // filtra en silencio.
      const existe = (await repo.listStores()).some((s) => s.id === sucursal);
      if (!existe) throw new HttpError(404, 'La sucursal no existe.');
    }

    const recibos = await repo.receiptsByDay(fecha, { storeId: sucursal });

    return json({ recibos, fecha, sucursal: sucursal ?? null });
  } catch (err) {
    return errorResponse(err);
  }
};
