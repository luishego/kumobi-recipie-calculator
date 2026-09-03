// Contrato común de proveedores de datos de venta — épica 02, HU-05.
//
// Sumar otro POS en el futuro debe ser escribir un adapter, no rediseñar el
// sistema. Ni el modelo de datos, ni el job de sincronización, ni la UI
// dependen de detalles de Loyverse: solo de esta interfaz.

import type { NormalizedReceipt, ProviderStore } from './types';

/**
 * Conjunto CERRADO de errores del dominio. El job decide qué hacer mirando el
 * código, nunca inspeccionando estados HTTP del proveedor.
 */
export type SalesErrorCode =
  | 'INVALID_TOKEN'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNKNOWN';

export class SalesProviderError extends Error {
  readonly code: SalesErrorCode;
  /** Espera sugerida por el proveedor ante un 429, si la envía. */
  readonly retryAfterMs?: number;

  constructor(code: SalesErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'SalesProviderError';
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export interface FetchReceiptsParams {
  providerStoreId: string;
  /** Zona horaria de la sucursal: necesaria para calcular `businessDate`. */
  timeZone: string;
  businessDayOffsetMinutes?: number;
  /** Sincronización incremental: tickets ACTUALIZADOS desde este instante. */
  updatedSince?: string;
  /** Descarga inicial: tickets CREADOS desde este instante. */
  createdSince?: string;
  /** Continuación. Cuando viene, reemplaza a los demás filtros. */
  cursor?: string;
  /** Máximo 250; el proveedor usa 50 por defecto. */
  limit?: number;
}

export interface FetchReceiptsPage {
  receipts: NormalizedReceipt[];
  /** `null` cuando ya no hay más páginas. */
  cursor: string | null;
  /**
   * Respuesta cruda de esta página, tal como llegó. El job la archiva en R2
   * ANTES de normalizar (§5.9): si la normalización falla, el dato de origen
   * ya está a salvo y la corrida es re-procesable sin volver a llamar a la API.
   */
  raw: unknown;
}

export interface SalesProvider {
  readonly providerId: string;
  /** Confirma que las credenciales sirven. Lanza `INVALID_TOKEN` si no. */
  validateCredentials(): Promise<void>;
  listStores(): Promise<ProviderStore[]>;
  fetchReceipts(params: FetchReceiptsParams): Promise<FetchReceiptsPage>;
}
