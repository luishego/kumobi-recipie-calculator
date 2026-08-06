// Constantes de negocio y UI.

/** Profundidad máxima de anidación de sub-recetas (salvaguarda anti-recursión). */
export const MAX_DEPTH = 5;

/** Umbrales del semáforo de Food Cost (%). */
export const FOOD_COST_GOOD_MAX = 30; // 🟢 < 30
export const FOOD_COST_WARN_MAX = 35; // 🟡 30–35 · 🔴 > 35

/** Nombres de colecciones de Firestore. */
export const COLLECTIONS = {
  units: 'unit-config',
  categories: 'categories',
  ingredients: 'ingredients',
  recipes: 'recipes',
} as const;

/** Nombre de la cookie de sesión (Admin SDK). */
export const SESSION_COOKIE = 'kumobi_session';

/** Rutas privadas protegidas por el middleware SSR. */
export const PRIVATE_PATHS = ['/', '/insumos', '/recetas'];
