// Tipos del dominio Kumobi. Espejo exacto de los esquemas de Firestore
// confirmados en la especificación funcional (fase 01).

// Valores reales en `unit-config`: 'mass' | 'volume' | 'unit' (piezas/conteo).
export type UnitType = 'mass' | 'volume' | 'unit';

/** Colección `unit-config`. OJO: aquí `conversionFactor` = unidades base por 1 de esta unidad. */
export interface UnitConfig {
  id: string;
  name: string;
  symbol: string;
  type: UnitType;
  /** Campo con la grafía original del cliente (sic). */
  standartBaseUnit: string;
  /** Unidades base por 1 de esta unidad (ej. kg → 1000 gr). */
  conversionFactor: number;
}

/** Colección `categories`. */
export interface Category {
  id: string;
  name: string;
  hexColor: string;
}

/**
 * Colección `ingredients`.
 * OJO: aquí `conversionFactor` = unidades de uso por 1 unidad de compra
 * (semántica distinta a la de `unit-config`). Puede cruzar dimensiones.
 */
export interface Ingredient {
  id: string;
  name: string;
  categoryId: string;
  purchaseUnitId: string;
  purchasePrice: number;
  usageUnitId: string;
  conversionFactor: number;
  yieldPercentage: number;
  /** Oficial: lo calcula/persiste una Cloud Function. La UI solo lo lee. */
  netCostPerUsageUnit: number;
}

export type ItemType = 'INGREDIENT' | 'RECETA';

export interface RecipeItem {
  type: ItemType;
  refId: string;
  snapName: string;
  quantity: number;
  usageUnitId: string;
  /** Oficial: lo calcula/persiste el backend. La UI muestra preview aparte. */
  calculatedCost: number;
}

export interface RecipeYield {
  quantityProduced: number;
  unitId: string;
}

/** Colección `recipes`. Interface `RecipeDocument` confirmada por el cliente. */
export interface RecipeDocument {
  id: string;
  name: string;
  description?: string;
  categoryId: string;
  isSubRecipe: boolean;
  yield: RecipeYield;
  items: RecipeItem[];
  // Financieros — calculados por Cloud Functions (la UI solo lee):
  totalCost: number;
  costPerYieldUnit: number;
  targetSellingPrice?: number;
  foodCostPercentage?: number;
  contributionMargin?: number;
  // Estado y auditoría:
  requiresRecalculation: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** Payload de entrada que la UI escribe en `/ingredients` (sin campos derivados). */
export type IngredientInput = Omit<Ingredient, 'id' | 'netCostPerUsageUnit'>;

/** Payload de entrada que la UI escribe en `/recipes` (sin campos derivados por backend). */
export interface RecipeInput {
  name: string;
  description?: string;
  categoryId: string;
  isSubRecipe: boolean;
  yield: RecipeYield;
  items: Array<Omit<RecipeItem, 'calculatedCost'>>;
  targetSellingPrice?: number;
}
