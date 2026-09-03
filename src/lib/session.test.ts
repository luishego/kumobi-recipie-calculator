import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { mintSessionToken, verifySessionToken } from './session';

const SECRET = 'test-secret-please-change-0123456789';
const USER = {
  uid: 'uid_123',
  email: 'chef@kumobi.mx',
  role: 'admin',
  tenantId: 'tnt_kumobi',
};

describe('cookie de sesión (HS256, edge-native)', () => {
  it('firma y verifica: round-trip conserva uid/email/role', async () => {
    const token = await mintSessionToken(USER, SECRET, 3600);
    const decoded = await verifySessionToken(token, SECRET);
    expect(decoded).toEqual(USER);
  });

  it('rechaza un token firmado con otro secreto', async () => {
    const token = await mintSessionToken(USER, SECRET, 3600);
    expect(await verifySessionToken(token, 'otro-secreto-distinto')).toBeNull();
  });

  it('rechaza un token manipulado', async () => {
    const token = await mintSessionToken(USER, SECRET, 3600);
    const tampered = token.slice(0, -3) + 'abc';
    expect(await verifySessionToken(tampered, SECRET)).toBeNull();
  });

  it('rechaza un token ya expirado (maxAge negativo)', async () => {
    const token = await mintSessionToken(USER, SECRET, -10);
    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });

  it('rechaza basura', async () => {
    expect(await verifySessionToken('no-es-un-jwt', SECRET)).toBeNull();
  });
});

describe('compatibilidad con las cookies emitidas antes de la épica 02', () => {
  /** Acuña una cookie como se hacía antes de que existiera `tenantId`. */
  async function cookieAntigua(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    return await new SignJWT({ email: USER.email, role: USER.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(USER.uid)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .sign(new TextEncoder().encode(SECRET));
  }

  it('sigue siendo válida: no expulsa del panel a quien tenga sesión abierta', async () => {
    const decoded = await verifySessionToken(await cookieAntigua(), SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded!.uid).toBe(USER.uid);
    expect(decoded!.role).toBe('admin');
  });

  it('reporta el inquilino ausente como null, sin inventarlo', async () => {
    // La sesión refleja la realidad; el periodo de gracia se aplica arriba, en
    // `resolveTenantId`, para que sea explícito y fácil de retirar.
    const decoded = await verifySessionToken(await cookieAntigua(), SECRET);
    expect(decoded!.tenantId).toBeNull();
  });
});
