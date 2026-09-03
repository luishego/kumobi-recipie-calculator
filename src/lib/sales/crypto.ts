// Cifrado de credenciales de POS en reposo — épica 02 §5.3.
//
// AES-GCM sobre **Web Crypto**, no `node:crypto`: el runtime es el edge de
// Cloudflare. La llave maestra vive como secret del Worker (`SALES_TOKEN_KEY`)
// y este módulo es el ÚNICO que la toca; el repositorio recibe y guarda texto
// ya cifrado, y el token descifrado nunca viaja al navegador.
//
// AES-GCM es autenticado: si el texto cifrado se altera, el descifrado falla en
// vez de devolver basura. Eso convierte "llave equivocada" y "dato corrupto" en
// el mismo error detectable, que es justo lo que hace falta para dar un mensaje
// claro en vez de un fallo opaco.

export type SalesCryptoErrorCode = 'BAD_KEY' | 'DECRYPT_FAILED';

export class SalesCryptoError extends Error {
  readonly code: SalesCryptoErrorCode;
  constructor(code: SalesCryptoErrorCode, message: string) {
    super(message);
    this.name = 'SalesCryptoError';
    this.code = code;
  }
}

/** AES-256 exige 32 bytes exactos. */
const KEY_BYTES = 32;
/** El tamaño recomendado de IV para GCM. Uno nuevo por cada cifrado. */
const IV_BYTES = 12;

// ── Codificación ────────────────────────────────────────────────────────────

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// El parámetro genérico `<ArrayBuffer>` es necesario desde TypeScript 5.7: sin
// él, `Uint8Array` es `Uint8Array<ArrayBufferLike>` y no encaja en `BufferSource`,
// que es lo que espera Web Crypto.
function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  // Se acepta base64 estándar y base64url: la llave se genera con
  // `randomBytes(32).toString('base64url')`, pero lo guardado usa el estándar.
  const normal = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Llave maestra ───────────────────────────────────────────────────────────

/**
 * Importa `SALES_TOKEN_KEY` como llave de AES-GCM.
 *
 * Genera una con:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 */
export async function importMasterKey(raw: string | undefined): Promise<CryptoKey> {
  if (!raw) {
    throw new SalesCryptoError(
      'BAD_KEY',
      'Falta SALES_TOKEN_KEY en el entorno. En Cloudflare es un secret del Worker, ' +
        'no una variable de build: `npx wrangler secret put SALES_TOKEN_KEY`.',
    );
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = b64ToBytes(raw.trim());
  } catch {
    throw new SalesCryptoError('BAD_KEY', 'SALES_TOKEN_KEY no es base64 válido.');
  }

  if (bytes.length !== KEY_BYTES) {
    throw new SalesCryptoError(
      'BAD_KEY',
      `SALES_TOKEN_KEY debe ser de ${KEY_BYTES} bytes (43 caracteres en base64url); ` +
        `se recibieron ${bytes.length}.`,
    );
  }

  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// ── Cifrado y descifrado ────────────────────────────────────────────────────

export interface CipherText {
  /** Base64 del texto cifrado. Va a `sales_accounts.token_ciphertext`. */
  ciphertext: string;
  /** Base64 del IV. Va a `sales_accounts.token_iv`. */
  iv: string;
}

/** Cifra un token del POS. Cada llamada usa un IV nuevo. */
export async function encryptToken(plaintext: string, key: CryptoKey): Promise<CipherText> {
  if (!plaintext) throw new SalesCryptoError('BAD_KEY', 'No hay token que cifrar.');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: bytesToB64(new Uint8Array(buf)), iv: bytesToB64(iv) };
}

/**
 * Descifra un token guardado.
 *
 * Falla —en vez de devolver basura— si la llave no corresponde o si el dato fue
 * alterado. El mensaje nombra la causa más probable, porque el síntoma real de
 * este error suele ser "el job dejó de sincronizar" sin más pistas.
 */
export async function decryptToken(
  cipher: CipherText,
  key: CryptoKey,
): Promise<string> {
  try {
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(cipher.iv) },
      key,
      b64ToBytes(cipher.ciphertext),
    );
    return new TextDecoder().decode(buf);
  } catch {
    throw new SalesCryptoError(
      'DECRYPT_FAILED',
      'No se pudo descifrar el token guardado. La causa más probable es que ' +
        'SALES_TOKEN_KEY no sea la misma llave con la que se cifró: revisa que el ' +
        'secret del Worker y el de .env coincidan. La cuenta debe reconectarse.',
    );
  }
}

/**
 * Comprobación de salud: confirma que la llave actual puede leer lo guardado.
 *
 * Sirve para dar un diagnóstico claro al arrancar o desde la pantalla de estado,
 * en vez de descubrir el desajuste como un fallo de sincronización nocturno.
 */
export async function canDecrypt(cipher: CipherText, key: CryptoKey): Promise<boolean> {
  try {
    await decryptToken(cipher, key);
    return true;
  } catch {
    return false;
  }
}

/** Últimos 4 caracteres del token: lo único de él que puede ver la UI. */
export function tokenLast4(token: string): string {
  return token.trim().slice(-4);
}
