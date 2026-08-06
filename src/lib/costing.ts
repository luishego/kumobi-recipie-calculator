// Fórmulas de costeo — SOLO para previews informativos en la UI.
// La fuente de verdad la calculan y persisten las Cloud Functions.
import { FOOD_COST_GOOD_MAX, FOOD_COST_WARN_MAX } from './constants';
import type { UnitConfig } from './types';

/**
 * Costo neto por unidad de uso de un insumo (HU-02).
 * netCostPerUsageUnit = (purchasePrice / conversionFactor) / (yieldPercentage/100)
 * Aquí `conversionFactor` es el del ingrediente (unidades de uso por unidad de compra).
 */
export function previewNetCostPerUsageUnit(input: {
  purchasePrice: number;
  conversionFactor: number;
  yieldPercentage: number;
}): number | null {
  const { purchasePrice, conversionFactor, yieldPercentage } = input;
  if (
    !Number.isFinite(purchasePrice) ||
    !Number.isFinite(conversionFactor) ||
    !Number.isFinite(yieldPercentage) ||
    purchasePrice <= 0 ||
    conversionFactor <= 0 ||
    yieldPercentage <= 0
  ) {
    return null;
  }
  return purchasePrice / conversionFactor / (yieldPercentage / 100);
}

/**
 * Costo parcial de un renglón de receta con conversión flexible (opción B, HU-03).
 * calculatedCost = quantity × unidadRenglon.conversionFactor
 *                  × (costoUnitario / usageUnitIngrediente.conversionFactor)
 * `costoUnitario` = netCostPerUsageUnit (ingrediente) o costPerYieldUnit (sub-receta).
 * Aquí ambos `conversionFactor` son los de `unit-config` (unidades base por unidad).
 * Si la unidad del renglón es la misma que la del ingrediente, se cancelan.
 */
export function previewRowCost(input: {
  quantity: number;
  rowUnit: UnitConfig | undefined; // unidad elegida en el renglón
  ingredientUsageUnit: UnitConfig | undefined; // usageUnit del ingrediente/sub-receta
  unitCost: number | undefined; // netCostPerUsageUnit o costPerYieldUnit
}): number | null {
  const { quantity, rowUnit, ingredientUsageUnit, unitCost } = input;
  if (
    !rowUnit ||
    !ingredientUsageUnit ||
    unitCost == null ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(unitCost) ||
    // Defensa ante datos de catálogo incompletos: la unidad debe traer un
    // conversionFactor numérico y positivo (unidades base por unidad). Si falta,
    // devolvemos null (la UI muestra "—" y bloquea el guardado) en vez de NaN.
    !Number.isFinite(rowUnit.conversionFactor) ||
    rowUnit.conversionFactor <= 0 ||
    !Number.isFinite(ingredientUsageUnit.conversionFactor) ||
    ingredientUsageUnit.conversionFactor <= 0
  ) {
    return null;
  }
  return (
    quantity *
    rowUnit.conversionFactor *
    (unitCost / ingredientUsageUnit.conversionFactor)
  );
}

/** Costo por unidad de rendimiento: totalCost / yield.quantityProduced. */
export function previewCostPerYieldUnit(
  totalCost: number,
  quantityProduced: number,
): number | null {
  if (!Number.isFinite(quantityProduced) || quantityProduced <= 0) return null;
  return totalCost / quantityProduced;
}

/** foodCostPercentage = (costPerYieldUnit / targetSellingPrice) × 100. */
export function previewFoodCostPercentage(
  costPerYieldUnit: number | null,
  targetSellingPrice: number | undefined,
): number | null {
  if (
    costPerYieldUnit == null ||
    targetSellingPrice == null ||
    !Number.isFinite(targetSellingPrice) ||
    targetSellingPrice <= 0
  ) {
    return null;
  }
  return (costPerYieldUnit / targetSellingPrice) * 100;
}

/** contributionMargin = targetSellingPrice − costPerYieldUnit. */
export function previewContributionMargin(
  costPerYieldUnit: number | null,
  targetSellingPrice: number | undefined,
): number | null {
  if (costPerYieldUnit == null || targetSellingPrice == null) return null;
  return targetSellingPrice - costPerYieldUnit;
}

export type FoodCostLevel = 'good' | 'warn' | 'bad';

/** Clasifica el Food Cost en el semáforo: 🟢<30 · 🟡30–35 · 🔴>35. */
export function foodCostLevel(percentage: number | null | undefined): FoodCostLevel | null {
  if (percentage == null || !Number.isFinite(percentage)) return null;
  if (percentage < FOOD_COST_GOOD_MAX) return 'good';
  if (percentage <= FOOD_COST_WARN_MAX) return 'warn';
  return 'bad';
}

export const FOOD_COST_LABEL: Record<FoodCostLevel, string> = {
  good: 'Bajo',
  warn: 'Medio',
  bad: 'Alto',
};
