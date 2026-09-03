import { describe, it, expect } from 'vitest';
import { resolveTenantId, usandoPeriodoDeGracia, TENANT_KUMOBI } from './tenant';

describe('resolveTenantId', () => {
  it('usa el inquilino de la sesión cuando existe', () => {
    expect(resolveTenantId({ tenantId: 'tnt_otro' })).toBe('tnt_otro');
  });

  it('durante el periodo de gracia, una sesión sin inquilino se asume de Kumobi', () => {
    // Cookies emitidas antes de la épica 02, o usuarios sin el claim todavía.
    expect(resolveTenantId({ tenantId: null })).toBe(TENANT_KUMOBI);
    expect(resolveTenantId(null)).toBe(TENANT_KUMOBI);
  });

  it('el periodo de gracia es visible, no silencioso', () => {
    expect(usandoPeriodoDeGracia({ tenantId: null })).toBe(true);
    expect(usandoPeriodoDeGracia({ tenantId: 'tnt_kumobi' })).toBe(false);
  });

  it('nunca devuelve vacío: createRepo se apoya en eso', () => {
    expect(resolveTenantId({ tenantId: null })).toBeTruthy();
    expect(resolveTenantId({ tenantId: 'tnt_x' })).toBeTruthy();
  });
});
