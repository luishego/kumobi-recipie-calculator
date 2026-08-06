import { describe, it, expect } from 'vitest';
import { buildSubRecipeGraph, checkAddSubRecipe } from './graph';
import { MAX_DEPTH } from './constants';
import type { RecipeItem, RecipeDocument } from './types';

function ing(refId: string): RecipeItem {
  return { type: 'INGREDIENT', refId, snapName: refId, quantity: 1, usageUnitId: 'unit_gr', calculatedCost: 0 };
}
function sub(refId: string): RecipeItem {
  return { type: 'RECETA', refId, snapName: refId, quantity: 1, usageUnitId: 'unit_gr', calculatedCost: 0 };
}
function recipe(id: string, items: RecipeItem[]): Pick<RecipeDocument, 'id' | 'items'> {
  return { id, items };
}
const idName = (id: string) => id;

describe('buildSubRecipeGraph', () => {
  it('incluye solo renglones de tipo RECETA', () => {
    const g = buildSubRecipeGraph([
      recipe('A', [ing('x'), sub('B'), ing('y'), sub('C')]),
      recipe('B', [ing('z')]),
    ]);
    expect(g.get('A')).toEqual(['B', 'C']);
    expect(g.get('B')).toEqual([]);
  });
});

describe('checkAddSubRecipe — ciclos', () => {
  it('detecta auto-referencia directa (A → A)', () => {
    const g = buildSubRecipeGraph([recipe('A', [])]);
    const r = checkAddSubRecipe('A', 'A', g, idName);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('cycle');
    expect(r.offendingRefId).toBe('A');
  });

  it('detecta ciclo indirecto (agregar B a A cuando B → A)', () => {
    // B ya referencia A; agregar B como renglón de A cerraría A → B → A.
    const g = buildSubRecipeGraph([
      recipe('A', []),
      recipe('B', [sub('A')]),
    ]);
    const r = checkAddSubRecipe('A', 'B', g, idName);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('cycle');
    expect(r.path).toEqual(['A', 'B', 'A']);
  });

  it('permite agregar cuando no hay ciclo', () => {
    const g = buildSubRecipeGraph([
      recipe('A', []),
      recipe('B', [sub('C')]),
      recipe('C', []),
    ]);
    expect(checkAddSubRecipe('A', 'B', g, idName).ok).toBe(true);
  });
});

describe('checkAddSubRecipe — profundidad', () => {
  it(`rechaza cuando el subárbol excede MAX_DEPTH (${MAX_DEPTH})`, () => {
    // Cadena cand → n1 → n2 → n3 → n4 → n5  ⇒ subtreeDepth(cand) = 5, +1 = 6 > 5.
    const recipes: Pick<RecipeDocument, 'id' | 'items'>[] = [];
    const chain = ['cand', 'n1', 'n2', 'n3', 'n4', 'n5'];
    for (let i = 0; i < chain.length; i++) {
      const next = chain[i + 1];
      recipes.push(recipe(chain[i], next ? [sub(next)] : []));
    }
    const g = buildSubRecipeGraph(recipes);
    const r = checkAddSubRecipe('A', 'cand', g, idName);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('depth');
  });

  it('permite una cadena dentro del límite', () => {
    // cand → n1 → n2  ⇒ subtreeDepth = 2, +1 = 3 ≤ 5.
    const g = buildSubRecipeGraph([
      recipe('cand', [sub('n1')]),
      recipe('n1', [sub('n2')]),
      recipe('n2', []),
    ]);
    expect(checkAddSubRecipe('A', 'cand', g, idName).ok).toBe(true);
  });
});
