// Adapter de Loyverse: traducción de fallos del proveedor a errores del dominio,
// y forma de las peticiones. Sin red: el `fetch` se inyecta.
import { describe, it, expect, afterEach } from 'vitest';
import { LoyverseAdapter } from './adapter';
import type { SalesProviderError } from '../provider';

const TOKEN = 'token-de-prueba-1234';
const STORE = '25d1edc7-527e-432b-9b3f-61d06df6fd88';
const TZ = 'America/Mexico_City';

function respuesta(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Ejecuta algo que debe fallar y devuelve el error, ya tipado. */
async function capturar(p: Promise<unknown>): Promise<SalesProviderError> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error('Se esperaba un fallo del proveedor y no lo hubo.');
  return err as SalesProviderError;
}

/** Captura las peticiones y devuelve respuestas preparadas. */
function stub(...respuestas: Response[]) {
  const llamadas: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    llamadas.push({ url: String(input), init });
    return respuestas[Math.min(i++, respuestas.length - 1)]!;
  }) as unknown as typeof fetch;
  return { fetchImpl, llamadas };
}

describe('invocación de fetch', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('no captura una referencia desprendida del fetch global', async () => {
    // En el runtime de Workers, llamar al `fetch` global por una referencia
    // suelta lanza "Illegal invocation". Este test lo detecta de forma
    // observable: si el adapter guardara `fetch` al construirse, no vería la
    // sustitución posterior y la petición no quedaría registrada.
    const adapter = new LoyverseAdapter({ token: TOKEN });

    let visto = '';
    globalThis.fetch = (async (input: any) => {
      visto = String(input);
      return respuesta({ stores: [] });
    }) as unknown as typeof fetch;

    await adapter.validateCredentials();
    expect(visto).toContain('/v1.0/stores');
  });
});

describe('traducción de errores del proveedor', () => {
  const casos: Array<[number, string]> = [
    [401, 'INVALID_TOKEN'],
    [403, 'INVALID_TOKEN'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [418, 'UNKNOWN'],
  ];

  it.each(casos)('HTTP %i → %s', async (status, code) => {
    const { fetchImpl } = stub(respuesta({ error: 'x' }, status));
    const adapter = new LoyverseAdapter({ token: TOKEN, fetchImpl });
    await expect(adapter.validateCredentials()).rejects.toMatchObject({ code });
  });

  it('un 429 con Retry-After propone cuánto esperar', async () => {
    const { fetchImpl } = stub(respuesta({}, 429, { 'retry-after': '30' }));
    const adapter = new LoyverseAdapter({ token: TOKEN, fetchImpl });
    const err = await capturar(adapter.validateCredentials());
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('un fallo de red conserva la causa en el mensaje', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Illegal invocation');
    }) as unknown as typeof fetch;
    const adapter = new LoyverseAdapter({ token: TOKEN, fetchImpl });
    const err = await capturar(adapter.validateCredentials());
    expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    // Sin esto, diagnosticar un fallo en producción es adivinar.
    expect(err.message).toContain('Illegal invocation');
  });
});

describe('forma de las peticiones', () => {
  it('autentica con Bearer', async () => {
    const { fetchImpl, llamadas } = stub(respuesta({ stores: [] }));
    await new LoyverseAdapter({ token: TOKEN, fetchImpl }).validateCredentials();
    const headers = llamadas[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('la primera página lleva los filtros; la siguiente, solo el cursor', async () => {
    const { fetchImpl, llamadas } = stub(
      respuesta({ receipts: [], cursor: 'CURSOR-1' }),
      respuesta({ receipts: [], cursor: null }),
    );
    const adapter = new LoyverseAdapter({ token: TOKEN, fetchImpl });

    const p1 = await adapter.fetchReceipts({
      providerStoreId: STORE, timeZone: TZ, updatedSince: '2026-09-01T00:00:00.000Z',
    });
    expect(llamadas[0]!.url).toContain(`store_id=${STORE}`);
    expect(llamadas[0]!.url).toContain('updated_at_min=');
    expect(p1.cursor).toBe('CURSOR-1');

    await adapter.fetchReceipts({ providerStoreId: STORE, timeZone: TZ, cursor: p1.cursor! });
    // Verificado contra la cuenta real: el cursor lleva los filtros dentro.
    expect(llamadas[1]!.url).toContain('cursor=CURSOR-1');
    expect(llamadas[1]!.url).not.toContain('store_id=');
  });

  it('nunca pide más de 250 por página', async () => {
    const { fetchImpl, llamadas } = stub(respuesta({ receipts: [], cursor: null }));
    await new LoyverseAdapter({ token: TOKEN, fetchImpl }).fetchReceipts({
      providerStoreId: STORE, timeZone: TZ, limit: 5000,
    });
    expect(llamadas[0]!.url).toContain('limit=250');
  });

  it('listStores sigue el cursor hasta agotarlo', async () => {
    const { fetchImpl, llamadas } = stub(
      respuesta({ stores: [{ id: 's1', name: 'Uno' }], cursor: 'C' }),
      respuesta({ stores: [{ id: 's2', name: 'Dos' }], cursor: null }),
    );
    const stores = await new LoyverseAdapter({ token: TOKEN, fetchImpl }).listStores();
    expect(stores).toEqual([
      { providerStoreId: 's1', name: 'Uno' },
      { providerStoreId: 's2', name: 'Dos' },
    ]);
    expect(llamadas).toHaveLength(2);
  });

  it('devuelve la página cruda para archivarla antes de normalizar', async () => {
    const cruda = { receipts: [], cursor: null };
    const { fetchImpl } = stub(respuesta(cruda));
    const page = await new LoyverseAdapter({ token: TOKEN, fetchImpl }).fetchReceipts({
      providerStoreId: STORE, timeZone: TZ,
    });
    expect(page.raw).toEqual(cruda);
  });
});
