// Identificadores generados por la APLICACIÓN, nunca por la base — épica 02 §5.10.
//
// Son DETERMINISTAS a propósito: el id de un ticket se deriva de su llave
// natural compuesta (§5.4). Dos consecuencias buenas:
//   · El upsert puede chocar contra la llave primaria, sin ir a buscar antes si
//     la fila existe: una ida y vuelta menos por ticket.
//   · Los renglones referencian al ticket sin necesidad de leer un id generado.
//
// El separador es "|" porque no aparece en ninguno de los componentes: el
// proveedor es un slug, la cuenta y la sucursal son UUID, y el número de recibo
// tiene la forma "1-0086".

const SEP = '|';

/**
 * Id del ticket, derivado de su llave natural (§5.4):
 * `provider + account_id + provider_store_id + receipt_number`.
 *
 * Usa el id de sucursal **del proveedor**, no nuestro id interno de fila: es
 * la llave natural, y mantiene el id legible y estable aunque cambiara nuestra
 * forma de generar ids de sucursal.
 */
export function receiptId(
  provider: string,
  accountId: string,
  providerStoreId: string,
  receiptNumber: string,
): string {
  const partes = [provider, accountId, providerStoreId, receiptNumber];
  for (const parte of partes) {
    if (!parte) throw new Error('Falta un componente de la llave del ticket.');
    if (parte.includes(SEP)) {
      throw new Error(`Un componente de la llave contiene "${SEP}": ${parte}`);
    }
  }
  return partes.join(SEP);
}

export function receiptLineId(receiptIdValue: string, lineIndex: number): string {
  return `${receiptIdValue}#${lineIndex}`;
}

/**
 * Id de fila de sucursal: única por cuenta e id del proveedor.
 *
 * El separador es "." por dos razones:
 *   · Es distinto al del ticket, para que un id compuesto no quede ambiguo.
 *   · Es un carácter **no reservado en URLs**, y este id SÍ viaja en la ruta
 *     (`PATCH /api/sales/stores/:id`). Con "::" el id llegaba codificado como
 *     "%3A%3A" y no coincidía con lo guardado, porque Astro no decodifica los
 *     parámetros de ruta. Lo verifica `esUrlSafe`.
 */
export function storeId(accountId: string, providerStoreId: string): string {
  return `${accountId}.${providerStoreId}`;
}

/**
 * Id de fila de `pos_item_map`, derivado de su llave natural:
 * `account_id + provider_item_id + provider_variant_id`.
 *
 * Que sea determinista tiene un beneficio extra sobre el del ticket: el mismo
 * string sirve de llave en la pantalla de mapeo y de id de la fila, así que el
 * cliente no tiene que rearmar nada para guardar una decisión.
 *
 * `providerVariantId` vacío es legítimo: es el centinela de "sin variante" que
 * usa el esquema (§7). El id queda entonces con el separador final, y eso es
 * correcto — distingue "sin variante" de una variante llamada como el ítem.
 */
export function posItemMapId(
  accountId: string,
  providerItemId: string,
  providerVariantId = '',
): string {
  if (!accountId) throw new Error('Falta la cuenta en la llave del mapeo.');
  for (const parte of [accountId, providerItemId, providerVariantId]) {
    if (parte.includes(SEP)) {
      throw new Error(`Un componente de la llave del mapeo contiene "${SEP}": ${parte}`);
    }
  }
  return [accountId, providerItemId, providerVariantId].join(SEP);
}

/**
 * ¿Este id puede viajar en una ruta sin codificarse?
 *
 * Invariante de diseño: todo id que aparezca en una URL debe cumplirla. Si
 * algún día un id deja de ser URL-safe, el fallo aparece como "no existe" en
 * producción, que es de los síntomas más difíciles de rastrear.
 */
export function esUrlSafe(id: string): boolean {
  return encodeURIComponent(id) === id;
}
