// Guardar y quitar mapeos ítem ↔ receta — épica 02, HU-11.
//
//   PUT     /api/sales/item-map   → guarda o corrige mapeos, en bloque
//   DELETE  /api/sales/item-map   → quita la decisión de un ítem
//
// El PUT acepta un arreglo porque la operación normal de la pantalla es
// "confirmar las N propuestas automáticas": hacerlo de una en una serían N
// peticiones y N escrituras contra el presupuesto de cuota de D1 (§5.1).
//
// El `recipe_id` NO se valida contra Firestore. Este Worker no tiene
// credenciales de Firestore —la sesión de Firebase vive en el navegador— y
// añadirlas para comprobar una existencia sería ampliar la superficie del
// servidor por poco: la isla solo ofrece recetas que acaba de leer, y una
// receta borrada después se muestra como "receta no encontrada" en la pantalla.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import type { EntradaMapeo } from '../../../lib/sales/repo';
import {
  HttpError, errorResponse, getRepo, json, readJson,
} from '../../../lib/sales/server';

export const prerender = false;

// La invariante kind ↔ recipeId se declara en el esquema (CHECK), en el
// repositorio y aquí. Las tres capas por el mismo motivo: una fila IGNORED con
// receta, o una RECIPE sin ella, es un dato incoherente que nadie detecta hasta
// que el Food Cost sale raro.
const Entrada = z
  .object({
    accountId: z.string().trim().min(1),
    providerItemId: z.string().trim().min(1, 'El ítem no tiene id en el POS: no es mapeable.'),
    providerVariantId: z.string().trim().default(''),
    kind: z.enum(['RECIPE', 'IGNORED']),
    recipeId: z.string().trim().min(1).nullable().default(null),
    method: z.enum(['auto_sku', 'auto_name', 'manual']).default('manual'),
  })
  .refine((e) => e.kind !== 'RECIPE' || !!e.recipeId, {
    message: 'Un mapeo a receta requiere el id de la receta.',
    path: ['recipeId'],
  })
  .refine((e) => e.kind !== 'IGNORED' || !e.recipeId, {
    message: 'Un ítem marcado como "no aplica" no puede llevar receta.',
    path: ['recipeId'],
  });

// Tope defensivo: el catálogo de una cuenta son decenas de ítems, no miles.
// Un cuerpo enorme sería un error o un abuso, y en los dos casos conviene
// rechazarlo antes de escribir.
const Lote = z.object({ entradas: z.array(Entrada).min(1).max(500) });

const Clave = z.object({ clave: z.string().trim().min(1) });

export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    const repo = getRepo(locals);
    const parsed = Lote.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    }

    // Todas las entradas son decisión explícita del administrador: al llegar
    // por esta ruta quedan confirmadas, incluso las que venían de una propuesta
    // automática. `method` conserva CÓMO se originó, que es otra pregunta.
    const entradas: EntradaMapeo[] = parsed.data.entradas.map((e) => ({
      ...e,
      confirmedByUser: true,
    }));

    // Las cuentas se comprueban ANTES de escribir, y todas. El upsert ya se
    // niega a escribir una cuenta ajena (WHERE EXISTS), pero en un lote mixto
    // eso escribiría las válidas y descartaría el resto en silencio: el
    // administrador vería "guardado" con parte de su trabajo perdido.
    const propias = new Set((await repo.listAccounts()).map((a) => a.id));
    const ajenas = [...new Set(entradas.map((e) => e.accountId))].filter(
      (id) => !propias.has(id),
    );
    if (ajenas.length > 0) {
      throw new HttpError(404, `La cuenta no existe: ${ajenas.join(', ')}`);
    }

    const escritas = await repo.upsertItemMap(entradas, new Date().toISOString());
    return json({ escritas });
  } catch (err) {
    return errorResponse(err);
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    const repo = getRepo(locals);
    const parsed = Clave.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, 'Falta la clave del ítem.');
    }
    if (!(await repo.deleteItemMap(parsed.data.clave))) {
      throw new HttpError(404, 'Ese ítem no tiene un mapeo guardado.');
    }
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
};
