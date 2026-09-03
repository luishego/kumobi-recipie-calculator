// Archivo del payload crudo del proveedor — épica 02 §5.9.
//
// Cada página descargada se guarda TAL COMO LLEGÓ, antes de normalizarla. Si la
// normalización falla o resulta estar equivocada, el dato de origen ya está a
// salvo y el rango se re-procesa sin volver a llamar a la API.
//
// Guardar el crudo no es opcional por dos razones que no se ven hasta que hacen
// falta: re-descargar un histórico largo son horas por el límite de solicitudes,
// y sobre todo, **una re-descarga trae el estado ACTUAL, no el que había** — si
// un ticket se editó después, lo que el proveedor devuelve hoy ya no es lo que
// devolvió aquel día. El archivo es la única copia de lo que el POS afirmó.

import type { R2Bucket } from '@cloudflare/workers-types';

export interface ArchiveTarget {
  tenantId: string;
  accountId: string;
  providerStoreId: string;
}

/**
 * Clave del objeto en R2.
 *
 * `raw/{inquilino}/{cuenta}/{sucursal}/{YYYY-MM-DD de la corrida}/{corrida}-{página}.json`
 *
 * La fecha es la de la corrida, no la de los tickets: agrupa por descarga, que
 * es como se re-procesa, y evita que una página con tickets de varios días
 * tenga que partirse.
 */
export function rawObjectKey(
  target: ArchiveTarget,
  runId: string,
  page: number,
  now: Date = new Date(),
): string {
  const dia = now.toISOString().slice(0, 10);
  return [
    'raw',
    target.tenantId,
    target.accountId,
    target.providerStoreId,
    dia,
    `${runId}-${String(page).padStart(4, '0')}.json`,
  ].join('/');
}

/**
 * Guarda una página cruda. Devuelve la clave para anotarla en cada ticket.
 *
 * Un fallo al archivar NO detiene la sincronización: es preferible tener los
 * tickets sin su copia cruda que no tenerlos. Se registra y se sigue.
 */
export async function archiveRawPage(
  bucket: R2Bucket | undefined,
  key: string,
  raw: unknown,
): Promise<string | null> {
  if (!bucket) return null;
  try {
    await bucket.put(key, JSON.stringify(raw), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    return key;
  } catch (err) {
    console.error(`[sales/archive] no se pudo archivar ${key}:`, err);
    return null;
  }
}
