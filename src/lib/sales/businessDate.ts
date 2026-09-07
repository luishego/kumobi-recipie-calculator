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

// ── Conversión inversa: fecha local → instante UTC (HU-15) ──────────────────
//
// `businessDate` va de instante a fecha local. La re-sincronización manual
// necesita el camino contrario: el administrador pide "del 1 al 3 de agosto" y
// el proveedor filtra por instantes UTC. Sin esta conversión, un rango pedido
// en México perdería las últimas 6 horas de cada día local — que es justo donde
// cae el grueso de las ventas de un restaurante.

const partesFormatters = new Map<string, Intl.DateTimeFormat>();

function partesFormatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = partesFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // 'h23' evita el "24" que algunos motores producen a medianoche con hour12:false.
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partesFormatters.set(timeZone, f);
  }
  return f;
}

/** Desplazamiento de la zona (en minutos) vigente en ese instante. */
function offsetMinutos(instanteMs: number, timeZone: string): number {
  const partes = partesFormatterFor(timeZone).formatToParts(new Date(instanteMs));
  const v = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value);
  const comoSiFueraUtc = Date.UTC(
    v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'),
  );
  return (comoSiFueraUtc - instanteMs) / 60_000;
}

const ES_FECHA_LOCAL = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Instante UTC en que empieza un día local ("YYYY-MM-DD") en esa zona.
 *
 * Dos pasadas, no una: la primera aproximación usa el desplazamiento vigente en
 * la medianoche UTC de ese día, que puede no ser el que rige en el instante
 * resultante si la zona cambia de horario esa madrugada. Con la segunda pasada
 * converge para cualquier zona con saltos de una hora. México no observa
 * horario de verano desde 2022, así que aquí la segunda pasada no cambia nada;
 * está porque el producto es multi-inquilino y la siguiente zona puede no serlo.
 */
export function inicioDelDiaUtc(fechaLocal: string, timeZone: string): string {
  if (!ES_FECHA_LOCAL.test(fechaLocal)) {
    throw new TypeError(`Fecha local no reconocida: ${JSON.stringify(fechaLocal)}`);
  }
  const [a, m, d] = fechaLocal.split('-').map(Number) as [number, number, number];
  const supuesto = Date.UTC(a, m - 1, d);
  const primera = supuesto - offsetMinutos(supuesto, timeZone) * 60_000;
  const ms = supuesto - offsetMinutos(primera, timeZone) * 60_000;
  return new Date(ms).toISOString();
}

/** Día local siguiente, en aritmética de calendario. */
export function diaSiguiente(fechaLocal: string): string {
  if (!ES_FECHA_LOCAL.test(fechaLocal)) {
    throw new TypeError(`Fecha local no reconocida: ${JSON.stringify(fechaLocal)}`);
  }
  const [a, m, d] = fechaLocal.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Rango `[desde, hasta]` de días LOCALES convertido a instantes UTC.
 *
 * El límite superior es EXCLUSIVO y cae en el inicio del día siguiente, para
 * que `hasta` quede incluido completo. Pedir "hasta el 3" y recibir los tickets
 * del 3 hasta las 00:00 sería una trampa silenciosa: el reporte se vería bien y
 * faltaría un día entero de ventas.
 */
export function rangoUtcDeDiasLocales(
  desde: string,
  hasta: string,
  timeZone: string,
): { desdeUtc: string; hastaUtcExclusivo: string } {
  if (desde > hasta) {
    throw new RangeError('La fecha inicial es posterior a la final.');
  }
  return {
    desdeUtc: inicioDelDiaUtc(desde, timeZone),
    hastaUtcExclusivo: inicioDelDiaUtc(diaSiguiente(hasta), timeZone),
  };
}
