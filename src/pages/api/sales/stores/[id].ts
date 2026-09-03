// Activar o desactivar una sucursal — épica 02, HU-07.
//
//   PATCH /api/sales/stores/:id   { active: boolean }
//
// Excluir una sucursal de la sincronización sin desconectar toda la cuenta.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { HttpError, errorResponse, getRepo, json, readJson } from '../../../../lib/sales/server';

export const prerender = false;

const Cambio = z.object({ active: z.boolean() });

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  try {
    const repo = getRepo(locals);
    // Astro NO decodifica los parámetros de ruta: si el id trajera algún
    // carácter codificado, llegaría literal y no coincidiría con lo guardado.
    // Los ids de sucursal son URL-safe desde la migración 0003, pero decodificar
    // aquí es una línea y evita que el síntoma vuelva como "no existe".
    const storeId = params.id ? decodeURIComponent(params.id) : undefined;
    if (!storeId) throw new HttpError(400, 'Falta el identificador de la sucursal.');

    const parsed = Cambio.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'Se esperaba { active: boolean }.');

    // El UPDATE ya filtra por inquilino: una sucursal de otro cliente no coincide
    // y el resultado es 404, no una modificación silenciosa.
    const res = await repo.setStoreActive(storeId, parsed.data.active, new Date().toISOString());

    if (!res.ok && res.motivo === 'NO_EXISTE') {
      throw new HttpError(404, 'La sucursal no existe.');
    }
    if (!res.ok) {
      throw new HttpError(
        409,
        `Se alcanzó el límite de ${res.cupo.limite} sucursales activas. ` +
          'Desactiva otra antes de activar esta, o pide que se amplíe el límite.',
        'SIN_CUPO',
      );
    }

    return json({ ok: true, active: parsed.data.active, cupo: res.cupo });
  } catch (err) {
    return errorResponse(err);
  }
};
