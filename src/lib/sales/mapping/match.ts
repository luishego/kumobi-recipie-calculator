// Propuesta automática de mapeo ítem del POS → receta — épica 02, HU-11.
//
// FUNCIÓN PURA: sin red, sin base, sin reloj. Es el único lugar donde se
// deciden las coincidencias, y se prueba contra el catálogo real de Kumobi.
//
// ── Por qué la ambigüedad es un estado de primera clase ─────────────────────
//
// Sobre los datos reales de Kumobi (28 ítems vendidos, 284 renglones) hay dos
// hechos que invalidan el enfoque ingenuo de "tomar la primera coincidencia":
//
//   · El SKU NO es único en el POS. El 10005 lo comparten "Bebida" ($75) y
//     "Kumobi Fresh Combo" ($179); el 10006, dos ítems distintos llamados
//     "Bacon" ($100 y $269).
//   · El NOMBRE tampoco es único: esos dos "Bacon" son ítems diferentes.
//
// Si un ítem empata con varias recetas y el sistema elige una en silencio, el
// Food Cost de la épica 03 sale mal y se ve perfectamente bien. Un mapeo mal
// hecho no se delata: produce un número plausible. Por eso una coincidencia
// múltiple NO se resuelve automáticamente — se marca AMBIGUO y la decide una
// persona. Es la misma lógica que la compuerta de HU-16: preferir un hueco
// visible a una cifra creíble y falsa.
//
// Lo inverso —varios ítems del POS hacia una misma receta— sí se permite: un
// platillo vendido solo y dentro de un combo es el caso normal.

import type { PosItemVendido } from '../repo/itemMap';

/** Receta candidata. Subconjunto de `RecipeDocument` que hace falta aquí. */
export interface RecetaCandidata {
  id: string;
  name: string;
  /** Las sub-recetas no se venden: no son destino válido de un ítem del POS. */
  isSubRecipe?: boolean;
  /**
   * Código del POS de la receta, si algún día se captura en Firestore.
   * Hoy `RecipeDocument` no lo tiene, así que `auto_sku` no emite propuestas.
   */
  posSku?: string | null;
}

export type MetodoAuto = 'auto_sku' | 'auto_name';

export type Propuesta =
  /** Una sola receta coincide: se puede confirmar en bloque. */
  | { estado: 'PROPUESTO'; recipeId: string; recipeName: string; method: MetodoAuto }
  /** Varias recetas coinciden: requiere decisión humana. */
  | { estado: 'AMBIGUO'; method: MetodoAuto; candidatos: RecetaCandidata[] }
  /** Ninguna coincide: hay que elegir a mano o marcar que no aplica. */
  | { estado: 'SIN_CANDIDATO' };

/**
 * Nombre comparable: minúsculas, sin acentos, sin puntuación, espacios
 * colapsados. "Cyber_wings 5Kb" y "cyber wings 5kb" son el mismo nombre;
 * "Clásica 1/4 lb" y "clasica 1 4 lb", también.
 *
 * Deliberadamente NO hace stemming ni quita palabras: "Bacon" y "Bacon 2.0"
 * son platillos distintos en la carta de Kumobi, y una normalización agresiva
 * los uniría. Es preferible no proponer que proponer mal.
 */
export function normalizarNombre(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // descarta los diacriticos ya separados
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Índice nombre normalizado → recetas. Varias pueden compartir nombre. */
function indexarPor<T>(items: readonly T[], clave: (t: T) => string | null): Map<string, T[]> {
  const idx = new Map<string, T[]>();
  for (const item of items) {
    const k = clave(item);
    if (!k) continue;
    const previas = idx.get(k);
    if (previas) previas.push(item);
    else idx.set(k, [item]);
  }
  return idx;
}

/**
 * Propone una receta para cada ítem vendido que todavía no tenga mapeo.
 *
 * Los ítems YA mapeados no se tocan: la propuesta automática nunca sobreescribe
 * una decisión existente, ni siquiera la de otra corrida automática. Corregir un
 * mapeo es del administrador.
 *
 * El orden de preferencia es SKU y luego nombre, y no se mezclan: si el SKU
 * empata con algo, el nombre ya no se consulta. Un empate por SKU con dos
 * recetas es ambiguo aunque por nombre hubiera una sola — porque entonces no se
 * sabe cuál de las dos señales creer.
 */
export function proponerMapeos(
  items: readonly PosItemVendido[],
  recetas: readonly RecetaCandidata[],
): Map<string, Propuesta> {
  // Las sub-recetas quedan fuera: son insumos de otras recetas, no productos.
  const vendibles = recetas.filter((r) => !r.isSubRecipe);

  const porSku = indexarPor(vendibles, (r) =>
    r.posSku ? normalizarNombre(r.posSku) : null,
  );
  const porNombre = indexarPor(vendibles, (r) => normalizarNombre(r.name) || null);

  const salida = new Map<string, Propuesta>();

  for (const item of items) {
    if (item.mapeo) continue; // ya decidido
    if (!item.providerItemId) continue; // ítem abierto del POS: no es mapeable

    const candidatos =
      (item.sku ? porSku.get(normalizarNombre(item.sku)) : undefined) ?? [];
    const method: MetodoAuto = candidatos.length ? 'auto_sku' : 'auto_name';
    const finales = candidatos.length
      ? candidatos
      : porNombre.get(normalizarNombre(item.itemName)) ?? [];

    if (finales.length === 0) {
      salida.set(item.clave, { estado: 'SIN_CANDIDATO' });
    } else if (finales.length === 1) {
      const receta = finales[0]!;
      salida.set(item.clave, {
        estado: 'PROPUESTO',
        recipeId: receta.id,
        recipeName: receta.name,
        method,
      });
    } else {
      salida.set(item.clave, { estado: 'AMBIGUO', method, candidatos: finales });
    }
  }

  return salida;
}

/** Solo las propuestas confirmables en bloque (las ambiguas quedan fuera). */
export function propuestasSeguras(
  propuestas: Map<string, Propuesta>,
): Array<{ clave: string; recipeId: string; method: MetodoAuto }> {
  const seguras: Array<{ clave: string; recipeId: string; method: MetodoAuto }> = [];
  for (const [clave, p] of propuestas) {
    if (p.estado === 'PROPUESTO') {
      seguras.push({ clave, recipeId: p.recipeId, method: p.method });
    }
  }
  return seguras;
}
