// Adapter de Loyverse — épica 02, HU-05.
//
// Aquí vive TODO lo específico del proveedor: URLs, cabeceras, nombres de
// campos, formas de paginar y códigos HTTP. Del adapter hacia afuera solo
// circula el modelo normalizado de `../types` y los errores de `../provider`.
//
// El adapter no escribe en base de datos y no conoce D1: recibe credenciales y
// devuelve datos.

import type {
  FetchReceiptsPage,
  FetchReceiptsParams,
  SalesProvider,
} from '../provider';
import { SalesProviderError } from '../provider';
import type { ProviderStore } from '../types';
import { normalizeReceipts, type LoyverseReceipt } from './normalize';

const BASE_URL = 'https://api.loyverse.com/v1.0';
/** Máximo que acepta el proveedor. Su valor por defecto es 50. */
export const MAX_LIMIT = 250;

interface LoyverseStore {
  id: string;
  name?: string | null;
}

export interface LoyverseAdapterOptions {
  token: string;
  /** Inyectable para pruebas y para envolver con reintentos. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class LoyverseAdapter implements SalesProvider {
  readonly providerId = 'loyverse';

  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: LoyverseAdapterOptions) {
    if (!opts.token) throw new Error('LoyverseAdapter requiere un token.');
    this.token = opts.token;
    // OJO: no guardar `fetch` desprendido (`?? fetch`). En el runtime de
    // Workers, invocar el `fetch` global a través de una referencia suelta
    // lanza "Illegal invocation" porque pierde su `this`. La llamada indirecta
    // lo resuelve, y además permite sustituirlo en pruebas después de construir.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.baseUrl = opts.baseUrl ?? BASE_URL;
  }

  // ── Traducción de fallos del proveedor a errores del dominio ──────────────
  private async request<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      });
    } catch (err) {
      // Fallo de red: transitorio, el job reintenta con backoff.
      throw new SalesProviderError(
        'PROVIDER_UNAVAILABLE',
        `No se pudo contactar a Loyverse: ${(err as Error).message}`,
      );
    }

    if (res.ok) return (await res.json()) as T;

    if (res.status === 401 || res.status === 403) {
      throw new SalesProviderError(
        'INVALID_TOKEN',
        'Loyverse rechazó las credenciales. La cuenta requiere reconexión.',
      );
    }
    if (res.status === 429) {
      throw new SalesProviderError(
        'RATE_LIMITED',
        'Se excedió el límite de solicitudes de Loyverse.',
        retryAfterMs(res),
      );
    }
    if (res.status >= 500) {
      throw new SalesProviderError(
        'PROVIDER_UNAVAILABLE',
        `Loyverse respondió ${res.status}.`,
      );
    }
    throw new SalesProviderError('UNKNOWN', `Loyverse respondió ${res.status}.`);
  }

  async validateCredentials(): Promise<void> {
    // Llamada barata: si el token sirve, esto responde; si no, lanza INVALID_TOKEN.
    await this.request<{ stores?: LoyverseStore[] }>('/stores', { limit: 1 });
  }

  async listStores(): Promise<ProviderStore[]> {
    const out: ProviderStore[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.request<{ stores?: LoyverseStore[]; cursor?: string | null }>(
        '/stores',
        cursor ? { cursor, limit: MAX_LIMIT } : { limit: MAX_LIMIT },
      );
      for (const s of page.stores ?? []) {
        out.push({ providerStoreId: s.id, name: s.name?.trim() || s.id });
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);

    return out;
  }

  async fetchReceipts(params: FetchReceiptsParams): Promise<FetchReceiptsPage> {
    const limit = Math.min(params.limit ?? MAX_LIMIT, MAX_LIMIT);

    // El cursor lleva los filtros dentro. Verificado contra la cuenta real el
    // 2026-09-01: pedir la página siguiente solo con `cursor` + `limit`, o
    // repitiendo además `store_id`, devuelve exactamente la misma página.
    // Se envía la forma mínima; el backfill persiste aparte los parámetros
    // originales por si ese comportamiento cambiara.
    const query = params.cursor
      ? { cursor: params.cursor, limit }
      : {
          store_id: params.providerStoreId,
          limit,
          // Incremental: por fecha de ACTUALIZACIÓN, para capturar también los
          // tickets editados, reembolsados o cancelados después de crearse.
          updated_at_min: params.updatedSince,
          created_at_min: params.createdSince,
        };

    const raw = await this.request<{ receipts?: LoyverseReceipt[]; cursor?: string | null }>(
      '/receipts',
      query,
    );

    return {
      receipts: normalizeReceipts(raw.receipts ?? [], {
        timeZone: params.timeZone,
        businessDayOffsetMinutes: params.businessDayOffsetMinutes ?? 0,
      }),
      cursor: raw.cursor ?? null,
      // Se devuelve la página cruda para archivarla en R2 antes de persistir.
      raw,
    };
  }
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}
