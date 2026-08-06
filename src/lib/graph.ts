// Anti-ciclos (DFS) + límite de profundidad para anidación de sub-recetas (HU-03).
// Se valida en la UI para feedback inmediato; el backend re-valida como fuente de verdad.
import { MAX_DEPTH } from './constants';
import type { RecipeDocument } from './types';

/**
 * Mapa de dependencias: id de receta → ids de sub-recetas que referencia
 * (solo renglones type === 'RECETA').
 */
export function buildSubRecipeGraph(
  recipes: Pick<RecipeDocument, 'id' | 'items'>[],
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const r of recipes) {
    graph.set(
      r.id,
      r.items.filter((it) => it.type === 'RECETA').map((it) => it.refId),
    );
  }
  return graph;
}

export interface CycleCheckResult {
  ok: boolean;
  /** Motivo de fallo (para el banner de la UI). */
  reason?: 'cycle' | 'depth';
  /** Ruta del ciclo detectado, ej. ['A','B','A'] (nombres o ids). */
  path?: string[];
  /** refId del renglón culpable, para señalarlo en la tabla. */
  offendingRefId?: string;
}

/**
 * ¿Agregar `candidateSubRecipeId` como renglón de la receta `currentRecipeId`
 * crearía un ciclo o excedería la profundidad máxima?
 *
 * @param currentRecipeId  id de la receta que se edita (puede ser 'nueva' / vacío).
 * @param candidateSubRecipeId  id de la sub-receta que se intenta agregar.
 * @param graph  grafo actual de dependencias (sin el candidato).
 * @param nameOf  resolutor id → nombre para armar rutas legibles.
 */
export function checkAddSubRecipe(
  currentRecipeId: string,
  candidateSubRecipeId: string,
  graph: Map<string, string[]>,
  nameOf: (id: string) => string,
): CycleCheckResult {
  // Auto-referencia directa: A → A.
  if (candidateSubRecipeId === currentRecipeId) {
    return {
      ok: false,
      reason: 'cycle',
      path: [nameOf(currentRecipeId), nameOf(currentRecipeId)],
      offendingRefId: candidateSubRecipeId,
    };
  }

  // Ciclo indirecto: si desde el candidato se puede llegar de vuelta a la receta
  // actual, agregarlo cerraría el ciclo (A → … → candidato → … → A).
  const cyclePath = findPath(candidateSubRecipeId, currentRecipeId, graph, nameOf);
  if (cyclePath) {
    return {
      ok: false,
      reason: 'cycle',
      path: [nameOf(currentRecipeId), ...cyclePath],
      offendingRefId: candidateSubRecipeId,
    };
  }

  // Profundidad: profundidad del subárbol del candidato + el nivel que aporta
  // el renglón nuevo no debe exceder MAX_DEPTH.
  const depth = subtreeDepth(candidateSubRecipeId, graph) + 1;
  if (depth > MAX_DEPTH) {
    return {
      ok: false,
      reason: 'depth',
      offendingRefId: candidateSubRecipeId,
    };
  }

  return { ok: true };
}

/** DFS: ¿hay ruta de `from` a `target`? Devuelve la ruta de nombres o null. */
function findPath(
  from: string,
  target: string,
  graph: Map<string, string[]>,
  nameOf: (id: string) => string,
): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): boolean {
    if (visited.has(node)) return false;
    visited.add(node);
    path.push(nameOf(node));
    if (node === target) return true;
    for (const next of graph.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    path.pop();
    return false;
  }

  return dfs(from) ? [...path] : null;
}

/** Profundidad máxima del subárbol de sub-recetas a partir de `node` (0 si hoja). */
function subtreeDepth(node: string, graph: Map<string, string[]>): number {
  const stack: Array<{ id: string; depth: number; ancestors: Set<string> }> = [
    { id: node, depth: 0, ancestors: new Set() },
  ];
  let max = 0;
  while (stack.length) {
    const { id, depth, ancestors } = stack.pop()!;
    max = Math.max(max, depth);
    // Corte defensivo por si el grafo persistido ya tuviera un ciclo.
    if (ancestors.has(id) || depth > MAX_DEPTH + 1) continue;
    const nextAncestors = new Set(ancestors).add(id);
    for (const child of graph.get(id) ?? []) {
      stack.push({ id: child, depth: depth + 1, ancestors: nextAncestors });
    }
  }
  return max;
}
