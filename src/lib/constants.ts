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

/**
 * Horas sin sincronización exitosa a partir de las cuales una sucursal se marca
 * como rezagada (HU-14).
 *
 * 36 h y no 24: el cron corre una vez al día, así que con 24 h una corrida que
 * se retrase unos minutos pintaría de rojo una sucursal perfectamente sana. Con
 * 36 h hace falta que se salte una corrida entera para que la marca aparezca, y
 * entonces la marca significa algo. Queda como constante hasta que algún
 * inquilino necesite otro valor; la épica lo tiene anotado como decisión
 * abierta (§13.2).
 */
export const UMBRAL_SIN_SINCRONIZAR_HORAS = 36;

/** Rutas privadas protegidas por el middleware SSR. */
export const PRIVATE_PATHS = ['/', '/insumos', '/recetas', '/ventas', '/api/sales'];
