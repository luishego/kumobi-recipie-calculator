import { describe, it, expect } from 'vitest';
import { isStaffRole, STAFF_ROLES } from './constants';

describe('isStaffRole — quién puede usar el panel de costeo', () => {
  it('acepta los tres roles de staff', () => {
    for (const role of STAFF_ROLES) {
      expect(isStaffRole(role)).toBe(true);
    }
  });

  it('coincide con la lista de set-claim.mjs y con isStaff() de firestore.rules', () => {
    // Si esta lista se desalinea de las Rules, el panel deja entrar a alguien
    // que después solo verá `permission-denied`, o al revés.
    expect([...STAFF_ROLES]).toEqual(['admin', 'chef', 'manager']);
  });

  it('rechaza una cuenta de solo-menú', () => {
    // El caso que motivó la comprobación (épica 04 §5.4): `menuAdmin: true` sin
    // rol administra la carta pública, no este panel.
    expect(isStaffRole(null)).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });

  it('rechaza roles inventados y cadenas vacías', () => {
    for (const role of ['', 'Admin', 'ADMIN', 'administrador', 'menuAdmin', 'superadmin']) {
      expect(isStaffRole(role)).toBe(false);
    }
  });

  it('no se deja engañar por valores que no son cadenas', () => {
    for (const valor of [true, 1, {}, []] as unknown as string[]) {
      expect(isStaffRole(valor)).toBe(false);
    }
  });
});
