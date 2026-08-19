import { describe, it, expect } from 'vitest';
import { mintSessionToken, verifySessionToken } from './session';

const SECRET = 'test-secret-please-change-0123456789';
const USER = { uid: 'uid_123', email: 'chef@kumobi.mx', role: 'admin' };

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
