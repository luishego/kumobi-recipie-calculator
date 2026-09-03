import { describe, it, expect } from 'vitest';
import {
  importMasterKey,
  encryptToken,
  decryptToken,
  canDecrypt,
  tokenLast4,
  SalesCryptoError,
} from './crypto';

/**
 * 32 bytes exactos en base64url, como los genera
 * `randomBytes(32).toString('base64url')`. Son de prueba, no secretos.
 */
const LLAVE = 'bGxhdmUtZGUtcHJ1ZWJhcy1udW1lcm8tdW5vLi4uLi4';
const OTRA_LLAVE = 'bGxhdmUtZGUtcHJ1ZWJhcy1udW1lcm8tZG9zLi4uLi4';
const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('llave maestra', () => {
  it('acepta 32 bytes en base64url', async () => {
    await expect(importMasterKey(LLAVE)).resolves.toBeDefined();
  });

  it('explica qué hacer si falta', async () => {
    await expect(importMasterKey(undefined)).rejects.toThrow(/wrangler secret put/);
  });

  it('rechaza una llave del tamaño equivocado', async () => {
    // "corta" = 5 bytes.
    await expect(importMasterKey('Y29ydGE')).rejects.toMatchObject({ code: 'BAD_KEY' });
    await expect(importMasterKey('Y29ydGE')).rejects.toThrow(/32 bytes/);
  });
});

describe('cifrado y descifrado', () => {
  it('round-trip: lo que se cifra se recupera igual', async () => {
    const key = await importMasterKey(LLAVE);
    const cifrado = await encryptToken(TOKEN, key);
    expect(cifrado.ciphertext).not.toContain(TOKEN);
    expect(await decryptToken(cifrado, key)).toBe(TOKEN);
  });

  it('cada cifrado usa un IV nuevo: el mismo token no produce el mismo texto', async () => {
    const key = await importMasterKey(LLAVE);
    const a = await encryptToken(TOKEN, key);
    const b = await encryptToken(TOKEN, key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Y aun así ambos se descifran al mismo valor.
    expect(await decryptToken(a, key)).toBe(await decryptToken(b, key));
  });

  it('con otra llave falla, y el mensaje dice por qué', async () => {
    const key = await importMasterKey(LLAVE);
    const otra = await importMasterKey(OTRA_LLAVE);
    const cifrado = await encryptToken(TOKEN, key);
    await expect(decryptToken(cifrado, otra)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
    await expect(decryptToken(cifrado, otra)).rejects.toThrow(/SALES_TOKEN_KEY/);
  });

  it('detecta un texto cifrado alterado: AES-GCM está autenticado', async () => {
    const key = await importMasterKey(LLAVE);
    const cifrado = await encryptToken(TOKEN, key);
    const alterado = {
      ...cifrado,
      ciphertext: cifrado.ciphertext.slice(0, -6) + 'AAAAAA',
    };
    await expect(decryptToken(alterado, key)).rejects.toBeInstanceOf(SalesCryptoError);
  });

  it('canDecrypt distingue la llave correcta de la equivocada sin lanzar', async () => {
    const key = await importMasterKey(LLAVE);
    const otra = await importMasterKey(OTRA_LLAVE);
    const cifrado = await encryptToken(TOKEN, key);
    expect(await canDecrypt(cifrado, key)).toBe(true);
    expect(await canDecrypt(cifrado, otra)).toBe(false);
  });
});

describe('tokenLast4', () => {
  it('devuelve solo los últimos cuatro caracteres', () => {
    expect(tokenLast4(TOKEN)).toBe('c5d6');
    expect(tokenLast4('  a1b2c3d4  ')).toBe('c3d4');
  });
});
