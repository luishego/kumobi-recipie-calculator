// Qué puede hacer cada rol — en un solo lugar.
//
// Hasta ahora el rol se guardaba en la sesión, se mostraba en la navegación y
// **no decidía nada**: `admin`, `chef` y `manager` tenían acceso idéntico. Este
// módulo le da significado, y lo hace con CAPACIDADES en vez de comparaciones
// sueltas contra `role === 'admin'` repartidas por el código: cuando mañana se
// agregue un rol, se toca esta tabla y no quince archivos.
//
// Todo es puro: se prueba sin levantar nada, que es lo mínimo exigible a la
// pieza que decide quién entra a dónde.

export const STAFF_ROLES = ['admin', 'chef', 'manager'] as const;
export type Rol = (typeof STAFF_ROLES)[number];

/** ¿Este rol puede usar el panel de costeo? */
export function isStaffRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && (STAFF_ROLES as readonly string[]).includes(role);
}

/**
 * Las dos capacidades que hoy separan a un rol de otro.
 *
 * `administrarIntegracion` cubre todo lo de Loyverse: cuentas y sus tokens,
 * sucursales, estado de sincronización, mapeo ítem↔receta y conciliación. Es
 * la frontera que pidió el cliente: la cocina opera su catálogo y ve lo que se
 * vendió, pero no toca la tubería que trae esos datos ni las credenciales del
 * POS.
 */
export const CAPACIDADES = {
  /** Dashboard, insumos, recetas: el catálogo de costeo. */
  operarCatalogo: ['admin', 'chef', 'manager'],
  /** La vista de lo vendido. */
  verVentas: ['admin', 'chef', 'manager'],
  /** Cuentas, tokens, sucursales, estado, mapeo, conciliación y sincronizar. */
  administrarIntegracion: ['admin'],
} as const satisfies Record<string, readonly string[]>;

export type Capacidad = keyof typeof CAPACIDADES;

export function puede(role: string | null | undefined, capacidad: Capacidad): boolean {
  return typeof role === 'string' && (CAPACIDADES[capacidad] as readonly string[]).includes(role);
}

/**
 * Rutas y endpoints que exigen `administrarIntegracion`.
 *
 * Se listan por prefijo y el cotejo respeta los límites de segmento, para que
 * `/api/sales/items` no case con `/api/sales/item-map` ni al revés — son
 * endpoints distintos y confundirlos abriría o cerraría de más.
 *
 * `manager` queda del lado restringido A PROPÓSITO: el cliente no definió qué
 * puede hacer, y lo que no está concedido se niega. Cuando se defina, se
 * agrega aquí y no en quince comprobaciones sueltas.
 */
export const RUTAS_INTEGRACION = [
  '/ventas/cuentas',
  '/ventas/estado',
  '/ventas/mapeo',
  '/ventas/conciliacion',
  '/api/sales/accounts',
  '/api/sales/stores',
  '/api/sales/estado',
  '/api/sales/item-map',
  '/api/sales/items',
  '/api/sales/conciliacion',
] as const;

/** ¿La ruta cae bajo alguno de los prefijos, respetando segmentos? */
export function cubre(pathname: string, prefijos: readonly string[]): boolean {
  return prefijos.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/** ¿Esta ruta exige permiso de integración? */
export function esRutaDeIntegracion(pathname: string): boolean {
  return cubre(pathname, RUTAS_INTEGRACION);
}

/**
 * ¿Este rol puede entrar a esta ruta?
 *
 * No enumera lo permitido: quien tiene rol de staff entra a todo el panel
 * salvo lo que esté explícitamente restringido. Enumerar lo permitido haría
 * que cada página nueva naciera inaccesible y se "arreglara" agregándola a la
 * lista — un patrón que termina en una lista que nadie revisa.
 */
export function puedeEntrar(role: string | null | undefined, pathname: string): boolean {
  if (!isStaffRole(role)) return false;
  if (esRutaDeIntegracion(pathname)) return puede(role, 'administrarIntegracion');
  return true;
}
