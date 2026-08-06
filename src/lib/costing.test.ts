import { describe, it, expect } from 'vitest';
import {
  previewNetCostPerUsageUnit,
  previewRowCost,
  previewCostPerYieldUnit,
  previewFoodCostPercentage,
  previewContributionMargin,
  foodCostLevel,
} from './costing';
import type { UnitConfig } from './types';

// Fixtures de unidades (conversionFactor = unidades base por 1 de esta unidad).
const gr: UnitConfig = { id: 'unit_gr', name: 'gram', symbol: 'gr', type: 'mass', standartBaseUnit: 'gr', conversionFactor: 1 };
const kg: UnitConfig = { id: 'unit_kg', name: 'kilogram', symbol: 'kg', type: 'mass', standartBaseUnit: 'gr', conversionFactor: 1000 };
const grNoFactor = { ...gr, conversionFactor: undefined as unknown as number };

describe('previewNetCostPerUsageUnit', () => {
  it('sin merma: precio/factor', () => {
    // 30 / 1000 / (100/100) = 0.03
    expect(previewNetCostPerUsageUnit({ purchasePrice: 30, conversionFactor: 1000, yieldPercentage: 100 })).toBeCloseTo(0.03, 10);
  });
  it('con merma sube el costo neto', () => {
    // 30 / 1000 / (90/100) = 0.033333…
    expect(previewNetCostPerUsageUnit({ purchasePrice: 30, conversionFactor: 1000, yieldPercentage: 90 })).toBeCloseTo(0.0333333, 6);
  });
  it('rechaza valores no positivos', () => {
    expect(previewNetCostPerUsageUnit({ purchasePrice: 0, conversionFactor: 1000, yieldPercentage: 100 })).toBeNull();
    expect(previewNetCostPerUsageUnit({ purchasePrice: 30, conversionFactor: 0, yieldPercentage: 100 })).toBeNull();
    expect(previewNetCostPerUsageUnit({ purchasePrice: 30, conversionFactor: 1000, yieldPercentage: 0 })).toBeNull();
  });
});

describe('previewRowCost', () => {
  it('misma unidad: los conversionFactor se cancelan', () => {
    // 300 gr × costo 0.0333/gr ≈ 10
    expect(previewRowCost({ quantity: 300, rowUnit: gr, ingredientUsageUnit: gr, unitCost: 0.0333333 })).toBeCloseTo(10, 4);
  });
  it('conversión de dimensión: renglón en kg, ingrediente en gr', () => {
    // 2 kg × 1000 × (0.0333333/1) ≈ 66.6667
    expect(previewRowCost({ quantity: 2, rowUnit: kg, ingredientUsageUnit: gr, unitCost: 0.0333333 })).toBeCloseTo(66.6667, 3);
  });
  it('devuelve null si la unidad no tiene conversionFactor (defensa H3)', () => {
    expect(previewRowCost({ quantity: 300, rowUnit: grNoFactor, ingredientUsageUnit: gr, unitCost: 0.03 })).toBeNull();
    expect(previewRowCost({ quantity: 300, rowUnit: gr, ingredientUsageUnit: grNoFactor, unitCost: 0.03 })).toBeNull();
  });
  it('devuelve null con cantidad no positiva o costo/unidad faltante', () => {
    expect(previewRowCost({ quantity: 0, rowUnit: gr, ingredientUsageUnit: gr, unitCost: 0.03 })).toBeNull();
    expect(previewRowCost({ quantity: 100, rowUnit: undefined, ingredientUsageUnit: gr, unitCost: 0.03 })).toBeNull();
    expect(previewRowCost({ quantity: 100, rowUnit: gr, ingredientUsageUnit: gr, unitCost: undefined })).toBeNull();
  });
});

describe('previewCostPerYieldUnit', () => {
  it('divide entre el rendimiento', () => {
    expect(previewCostPerYieldUnit(10, 2)).toBe(5);
  });
  it('null si el rendimiento no es positivo', () => {
    expect(previewCostPerYieldUnit(10, 0)).toBeNull();
  });
});

describe('previewFoodCostPercentage / previewContributionMargin', () => {
  it('food cost % = costo/porción ÷ precio × 100', () => {
    expect(previewFoodCostPercentage(5, 20)).toBeCloseTo(25, 10);
  });
  it('food cost % null sin precio válido', () => {
    expect(previewFoodCostPercentage(5, 0)).toBeNull();
    expect(previewFoodCostPercentage(5, undefined)).toBeNull();
  });
  it('margen = precio − costo/porción', () => {
    expect(previewContributionMargin(5, 20)).toBe(15);
  });
});

describe('foodCostLevel (semáforo 🟢<30 · 🟡30–35 · 🔴>35)', () => {
  it('verde por debajo de 30', () => {
    expect(foodCostLevel(29.99)).toBe('good');
    expect(foodCostLevel(25)).toBe('good');
  });
  it('amarillo entre 30 y 35 inclusive', () => {
    expect(foodCostLevel(30)).toBe('warn');
    expect(foodCostLevel(35)).toBe('warn');
  });
  it('rojo por encima de 35', () => {
    expect(foodCostLevel(35.01)).toBe('bad');
    expect(foodCostLevel(50)).toBe('bad');
  });
  it('null si no hay porcentaje', () => {
    expect(foodCostLevel(null)).toBeNull();
    expect(foodCostLevel(undefined)).toBeNull();
  });
});
