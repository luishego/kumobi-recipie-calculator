// Capa de repositorio — épica 02 §5.8 y §5.10.
//
// ÚNICO lugar del sistema con SQL. Dos garantías salen de esa restricción, con
// un solo mecanismo:
//
//   1. AISLAMIENTO POR INQUILINO. El `tenantId` se fija al construir el
//      repositorio y se inyecta en cada consulta. Ningún endpoint arma SQL por
//      su cuenta, así que no hay forma de olvidar el filtro en la consulta
//      número 40. El `tenantId` sale SIEMPRE de la sesión, nunca del request.
//
//   2. PORTABILIDAD. Cambiar de motor (§5.10) es reimplementar este módulo, no
//      auditar la aplicación entera buscando consultas sueltas.
//
// Si alguna vez hace falta escribir SQL fuera de aquí, la respuesta correcta es
// agregar un método a este repositorio.

import type { D1Database } from '@cloudflare/workers-types';
import { createReceiptsRepo } from './receipts';
import { createStoresRepo } from './stores';
import { createTotalsRepo } from './totals';
import { createSyncStateRepo } from './syncState';
import { createItemMapRepo } from './itemMap';

export type SalesRepo = ReturnType<typeof createReceiptsRepo> &
  ReturnType<typeof createStoresRepo> &
  ReturnType<typeof createTotalsRepo> &
  ReturnType<typeof createSyncStateRepo> &
  ReturnType<typeof createItemMapRepo>;

export function createRepo(db: D1Database, tenantId: string): SalesRepo {
  if (!tenantId) {
    throw new Error(
      'createRepo requiere un tenantId. Debe venir de la sesión, nunca del request.',
    );
  }
  return {
    ...createReceiptsRepo(db, tenantId),
    ...createStoresRepo(db, tenantId),
    ...createTotalsRepo(db, tenantId),
    ...createSyncStateRepo(db, tenantId),
    ...createItemMapRepo(db, tenantId),
  };
}

export type { UpsertResult } from './receipts';
export type { AccountInput, AccountRow, StoreRow } from './stores';
export type { RangoFechas } from './totals';
export type { SyncStateRow, RunCounts, RunKind, BackfillStatus } from './syncState';
export type {
  PosItemVendido, MapeoItem, EntradaMapeo, CoberturaMapeo,
} from './itemMap';
export { cobertura } from './itemMap';
