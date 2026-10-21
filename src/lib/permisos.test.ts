import { describe, it, expect } from 'vitest';
import {
  isStaffRole,
  puede,
  puedeEntrar,
  esRutaDeIntegracion,
  STAFF_ROLES,
} from './permisos';

describe('isStaffRole', () => {
  it('acepta los tres roles de staff', () => {
    for (const r of STAFF_ROLES) expect(isStaffRole(r)).toBe(true);
  });

  it('coincide con isStaff() de firestore.rules y con set-claim.mjs', () => {
    // Si esta lista se desalinea de las Rules, el panel deja entrar a alguien
    // que después solo verá `permission-denied`, o al revés.
    expect([...STAFF_ROLES]).toEqual(['admin', 'chef', 'manager']);
  });

  it('rechaza una cuenta de solo-menú', () => {
    expect(isStaffRole(null)).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });

  it('rechaza roles inventados, mayúsculas y no-cadenas', () => {
    for (const r of ['', 'Admin', 'ADMIN', 'cocinero', 'superadmin']) {
      expect(isStaffRole(r)).toBe(false);
    }
    for (const v of [true, 1, {}, []] as unknown as string[]) {
      expect(isStaffRole(v)).toBe(false);
    }
  });
});

describe('capacidades', () => {
  it('el chef opera el catálogo y ve ventas', () => {
    expect(puede('chef', 'operarCatalogo')).toBe(true);
    expect(puede('chef', 'verVentas')).toBe(true);
  });

  it('el chef NO administra la integración', () => {
    // El límite que pidió el cliente: la cocina no toca la tubería del POS
    // ni sus credenciales.
    expect(puede('chef', 'administrarIntegracion')).toBe(false);
  });

  it('el admin puede todo', () => {
    expect(puede('admin', 'operarCatalogo')).toBe(true);
    expect(puede('admin', 'verVentas')).toBe(true);
    expect(puede('admin', 'administrarIntegracion')).toBe(true);
  });

  it('manager queda restringido mientras nadie defina su alcance', () => {
    // Lo que no está concedido se niega. Cuando se defina, se concede aquí.
    expect(puede('manager', 'operarCatalogo')).toBe(true);
    expect(puede('manager', 'administrarIntegracion')).toBe(false);
  });

  it('sin rol no se puede nada', () => {
    for (const c of ['operarCatalogo', 'verVentas', 'administrarIntegracion'] as const) {
      expect(puede(null, c)).toBe(false);
    }
  });
});

describe('esRutaDeIntegracion — los límites de segmento', () => {
  it('reconoce las páginas restringidas y sus hijas', () => {
    for (const r of [
      '/ventas/cuentas',
      '/ventas/estado',
      '/ventas/mapeo',
      '/ventas/conciliacion',
      '/api/sales/accounts',
      '/api/sales/accounts/abc/sync',
      '/api/sales/accounts/abc/backfill',
      '/api/sales/accounts/abc/token',
      '/api/sales/stores/xyz/resync',
      '/api/sales/item-map',
      '/api/sales/items',
    ]) {
      expect(esRutaDeIntegracion(r)).toBe(true);
    }
  });

  it('NO toca lo que el chef sí puede usar', () => {
    // Si alguno de estos cayera del lado restringido, la vista de ventas se
    // rompería para el chef sin que nada lo explique.
    for (const r of ['/', '/insumos', '/recetas', '/recetas/abc', '/ventas', '/api/sales/ventas', '/api/sales/recibos']) {
      expect(esRutaDeIntegracion(r)).toBe(false);
    }
  });

  it('no confunde /api/sales/items con /api/sales/item-map', () => {
    // Son endpoints distintos; un prefijo ingenuo los mezclaría.
    expect(esRutaDeIntegracion('/api/sales/items')).toBe(true);
    expect(esRutaDeIntegracion('/api/sales/item-map')).toBe(true);
  });

  it('no restringe por coincidencia parcial de nombre', () => {
    // `/ventas` no debe caer porque `/ventas/cuentas` empiece parecido.
    expect(esRutaDeIntegracion('/ventas')).toBe(false);
    expect(esRutaDeIntegracion('/ventasx')).toBe(false);
    expect(esRutaDeIntegracion('/api/sales/estadox')).toBe(false);
  });
});

describe('puedeEntrar', () => {
  it('el chef entra al catálogo y a la vista de ventas', () => {
    for (const r of ['/', '/insumos', '/recetas/abc', '/ventas', '/api/sales/ventas']) {
      expect(puedeEntrar('chef', r)).toBe(true);
    }
  });

  it('el chef NO entra a la integración', () => {
    for (const r of ['/ventas/cuentas', '/ventas/mapeo', '/api/sales/accounts/a/sync']) {
      expect(puedeEntrar('chef', r)).toBe(false);
    }
  });

  it('el admin entra a todo', () => {
    for (const r of ['/', '/ventas/cuentas', '/api/sales/accounts/a/sync', '/api/sales/conciliacion']) {
      expect(puedeEntrar('admin', r)).toBe(true);
    }
  });

  it('sin rol de staff no entra a ninguna parte', () => {
    for (const r of ['/', '/ventas', '/ventas/cuentas']) {
      expect(puedeEntrar(null, r)).toBe(false);
    }
  });

  it('una ruta nueva nace accesible para staff, no inaccesible', () => {
    // Enumerar lo permitido haría que cada página nueva naciera bloqueada y se
    // "arreglara" agregándola a una lista que nadie revisa.
    expect(puedeEntrar('chef', '/reportes-que-aun-no-existen')).toBe(true);
    expect(puedeEntrar('admin', '/reportes-que-aun-no-existen')).toBe(true);
  });
});
