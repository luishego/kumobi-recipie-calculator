// Fecha de negocio — épica 02 §5.5.
//
// Loyverse entrega timestamps en UTC. Agrupar las ventas por día UTC es
// incorrecto para México: en el histórico real de Kumobi, 65 de 108 recibos
// (el 60 %) caen en un día distinto si se agrupa por UTC en vez de por hora
// local. No es un caso de borde: es la mayoría.
//
// La fecha de negocio se calcula UNA VEZ, al escribir, y se persiste. Nunca se
// recalcula al consultar.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // 'en-CA' produce directamente "YYYY-MM-DD".
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * Fecha de negocio ("YYYY-MM-DD") de un instante UTC, en la zona de la sucursal.
 *
 * `businessDayOffsetMinutes` está previsto para sucursales que cierran después
 * de medianoche y quieren imputar esos tickets al día anterior. En esta épica
 * siempre vale 0; el parámetro existe para que activarlo después no obligue a
 * re-modelar.
 */
export function businessDate(
  instantIso: string,
  timeZone: string,
  businessDayOffsetMinutes = 0,
): string {
  const ms = Date.parse(instantIso);
  if (Number.isNaN(ms)) {
    throw new TypeError(`Fecha no reconocida: ${JSON.stringify(instantIso)}`);
  }
  const shifted = new Date(ms - businessDayOffsetMinutes * 60_000);
  return formatterFor(timeZone).format(shifted);
}
