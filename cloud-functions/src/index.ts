/**
 * Kumobi — Cloud Functions de propagación (fase de producción).
 *
 * Responsabilidad: cuando cambia un insumo base, o una sub-receta cambia de costo
 * o se elimina, propagar el impacto a las recetas que dependen (directa o
 * indirectamente) marcándolas `requiresRecalculation = true`, y registrar el
 * historial de precios de insumos.
 *
 * NO recalcula los costos finales: eso lo hace el cliente al re-guardar la receta
 * (arquitectura "cliente calcula y escribe"; ver especificacion-funcional).
 * Estas funciones solo AVISAN qué recetas quedaron desactualizadas.
 *
 * `maxInstances` acotado para controlar costos de invocación (requisito del cliente).
 */
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();

// Tope de instancias concurrentes para evitar costos disparados.
setGlobalOptions({ maxInstances: 3, region: 'us-central1' });

/** Campos del insumo que afectan el costo y disparan propagación. */
const PRICE_FIELDS = [
  'purchasePrice',
  'conversionFactor',
  'yieldPercentage',
  'netCostPerUsageUnit',
] as const;

interface RecipeItemLite {
  type: 'INGREDIENT' | 'RECETA';
  refId: string;
}
interface RecipeLite {
  id: string;
  items: RecipeItemLite[];
}

async function loadRecipes(): Promise<RecipeLite[]> {
  const snap = await db.collection('recipes').get();
  return snap.docs.map((d) => ({
    id: d.id,
    items: (d.data().items ?? []) as RecipeItemLite[],
  }));
}

/**
 * Devuelve el conjunto de recetas que dependen (transitivamente, hacia arriba)
 * de cualquiera de las `seedRecipeIds`, SIN incluir las propias semillas.
 */
function ancestorRecipes(
  seedRecipeIds: Set<string>,
  recipes: RecipeLite[],
): Set<string> {
  const affected = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of recipes) {
      if (affected.has(r.id) || seedRecipeIds.has(r.id)) continue;
      const usesAffected = r.items.some(
        (it) =>
          it.type === 'RECETA' &&
          (seedRecipeIds.has(it.refId) || affected.has(it.refId)),
      );
      if (usesAffected) {
        affected.add(r.id);
        grew = true;
      }
    }
  }
  return affected;
}

/** Marca `requiresRecalculation = true` en las recetas indicadas. */
async function flagRecipes(ids: Set<string>): Promise<number> {
  if (ids.size === 0) return 0;
  const batch = db.batch();
  for (const id of ids) {
    batch.update(db.collection('recipes').doc(id), { requiresRecalculation: true });
  }
  await batch.commit();
  return ids.size;
}

// ── Insumos ────────────────────────────────────────────────────────────────
export const onIngredientWrite = onDocumentWritten(
  'ingredients/{ingredientId}',
  async (event) => {
    const ingredientId = event.params.ingredientId;
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    // Alta: aún no hay recetas que dependan del insumo.
    if (!before && after) return;

    const changed =
      !after || // baja
      (before && after && PRICE_FIELDS.some((f) => before[f] !== after[f]));
    if (!changed) return;

    // Historial de precios (solo en actualización con cambio de precio de compra).
    if (before && after && before.purchasePrice !== after.purchasePrice) {
      await db
        .collection('ingredients')
        .doc(ingredientId)
        .collection('price_history')
        .add({
          previousPrice: before.purchasePrice ?? 0,
          newPrice: after.purchasePrice ?? 0,
          previousNetCost: before.netCostPerUsageUnit ?? null,
          newNetCost: after.netCostPerUsageUnit ?? null,
          source: 'cloud-function',
          changedAt: FieldValue.serverTimestamp(),
        });
    }

    const recipes = await loadRecipes();
    // Semilla: recetas que usan el insumo directamente.
    const seeds = new Set<string>();
    for (const r of recipes) {
      if (r.items.some((it) => it.type === 'INGREDIENT' && it.refId === ingredientId)) {
        seeds.add(r.id);
      }
    }
    const toFlag = new Set<string>([...seeds, ...ancestorRecipes(seeds, recipes)]);
    const n = await flagRecipes(toFlag);
    logger.info(`Insumo ${ingredientId}: recetas marcadas para recálculo: ${n}`);
  },
);

// ── Recetas (sub-recetas) ────────────────────────────────────────────────────
export const onRecipeWrite = onDocumentWritten(
  'recipes/{recipeId}',
  async (event) => {
    const recipeId = event.params.recipeId;
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    // Alta: aún no tiene recetas padre que dependan de ella.
    if (!before && after) return;

    // Determinar si el cambio afecta a las recetas padre:
    //  - baja de la sub-receta, o
    //  - cambió su costo por unidad de rendimiento (costPerYieldUnit).
    const deleted = before && !after;
    const costChanged =
      before && after && before.costPerYieldUnit !== after.costPerYieldUnit;
    if (!deleted && !costChanged) return; // (marcar requiresRecalculation solo no re-dispara)

    const recipes = await loadRecipes();
    // Los padres de esta receta (no ella misma) quedan desactualizados.
    const toFlag = ancestorRecipes(new Set([recipeId]), recipes);
    const n = await flagRecipes(toFlag);
    logger.info(
      `Receta ${recipeId} (${deleted ? 'eliminada' : 'recosteada'}): padres marcados: ${n}`,
    );
  },
);
