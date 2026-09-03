// Lectura del reporte agregado del Back Office y conciliación — épica 02, HU-16.
//
// La fuente de comparación tiene que ser el reporte AGREGADO de Loyverse, no un
// volcado de su API: comparar la API contra sí misma valida el parseo, no la
// semántica. Qué considera Loyverse "venta neta", si su cifra lleva el IVA, en
// qué día imputa un reembolso — esas son las preguntas que la compuerta existe
// para responder, y solo el reporte agregado las contesta.
//
// Se comparan SEIS campos y no solo el total a propósito: cuadrar un total por
// compensación de dos errores es posible; cuadrar los seis, no.

import { toCents } from './money';
import type { DailyTotals } from './aggregate';

export interface FilaBackOffice {
  businessDate: string;
  brutas: number;
  reembolsos: number;
  descuentos: number;
  netas: number;
  costo: number;
  impuestos: number;
}

/** Encabezados del export de Loyverse, en español. Incluida la fecha: TODAS se
 *  ubican por nombre, para que una columna añadida no desplace la lectura. */
const COLUMNAS: Record<keyof FilaBackOffice, string> = {
  businessDate: 'fecha',
  brutas: 'ventas brutas',
  reembolsos: 'reembolsos',
  descuentos: 'descuentos',
  netas: 'ventas netas',
  costo: 'costo de los bienes',
  impuestos: 'impuestos',
};

/** Minúsculas y sin acentos, para comparar encabezados sin depender de tildes. */
const normaliza = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^"|"$/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

export class BackOfficeCsvError extends Error {}

/** "01/09/26" → "2026-09-01". El export usa dd/mm/aa. */
function fecha(valor: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(valor.trim());
  if (!m) throw new BackOfficeCsvError(`Fecha no reconocida: "${valor}". Se esperaba dd/mm/aa.`);
  return `20${m[3]}-${m[2]}-${m[1]}`;
}

export function parseBackOfficeCsv(texto: string): FilaBackOffice[] {
  const lineas = texto.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length < 2) {
    throw new BackOfficeCsvError('El archivo está vacío o no tiene filas de datos.');
  }

  // Por nombre de encabezado, no por posición: si Loyverse agrega una columna,
  // el reporte sigue leyéndose.
  const encabezados = lineas[0]!.split(',').map(normaliza);
  const indice: Record<string, number> = {};
  for (const [clave, nombre] of Object.entries(COLUMNAS)) {
    const i = encabezados.indexOf(nombre);
    if (i === -1) {
      throw new BackOfficeCsvError(
        `Al archivo le falta la columna "${nombre}". ¿Es el reporte de Ventas del Back Office?`,
      );
    }
    indice[clave] = i;
  }

  return lineas.slice(1).map((linea) => {
    const c = linea.split(',');
    return {
      businessDate: fecha(c[indice.businessDate!] ?? ''),
      brutas: toCents(c[indice.brutas!]),
      reembolsos: toCents(c[indice.reembolsos!]),
      descuentos: toCents(c[indice.descuentos!]),
      netas: toCents(c[indice.netas!]),
      costo: toCents(c[indice.costo!]),
      impuestos: toCents(c[indice.impuestos!]),
    };
  });
}

// ── Conciliación ────────────────────────────────────────────────────────────

export type CampoConciliado =
  | 'netas' | 'brutas' | 'reembolsos' | 'descuentos' | 'impuestos' | 'costo';

export const ETIQUETAS: Record<CampoConciliado, string> = {
  netas: 'Ventas netas',
  brutas: 'Ventas brutas',
  reembolsos: 'Reembolsos',
  descuentos: 'Descuentos',
  impuestos: 'Impuestos',
  costo: 'Costo de los bienes',
};

const NUESTRO: Record<CampoConciliado, (d: DailyTotals) => number> = {
  netas: (d) => d.netSalesCents,
  brutas: (d) => d.grossSalesCents,
  reembolsos: (d) => d.refundsCents,
  descuentos: (d) => d.discountsCents,
  impuestos: (d) => d.taxCents,
  costo: (d) => d.costReportedCents,
};

export interface DiaConciliado {
  businessDate: string;
  cuadra: boolean;
  campos: Record<CampoConciliado, { nuestro: number; suyo: number; diff: number }>;
  tickets: number;
}

export interface ResultadoConciliacion {
  /** Los seis campos coinciden en todos los días QUE EL REPORTE CUBRE. */
  cuadra: boolean;
  /**
   * Además de cuadrar, no queda nada sin verificar: ni días nuestros fuera del
   * rango del reporte, ni cobertura dispar.
   *
   * La distinción importa porque es la diferencia entre "los números coinciden"
   * y "está verificado". Un reporte exportado con un rango corto puede cuadrar
   * perfectamente y dejar días enteros sin mirar.
   */
  verificacionCompleta: boolean;
  dias: DiaConciliado[];
  /** Días con alguna diferencia, para mostrarlos primero. */
  diasConDiferencia: DiaConciliado[];
  totales: Record<CampoConciliado, { nuestro: number; suyo: number; diff: number }>;
  /** Días con actividad de cada lado; deben coincidir. */
  cobertura: { nuestros: number; suyos: number; soloNuestros: string[]; soloSuyos: string[] };
  /** Días nuestros que quedan fuera del rango del reporte: no se pueden conciliar. */
  fueraDeRango: string[];
}

export function conciliar(
  nuestros: readonly DailyTotals[],
  reporte: readonly FilaBackOffice[],
): ResultadoConciliacion {
  const mios = new Map(nuestros.map((d) => [d.businessDate, d]));
  const suyos = new Map(reporte.map((f) => [f.businessDate, f]));
  const campos = Object.keys(ETIQUETAS) as CampoConciliado[];

  const totales = Object.fromEntries(
    campos.map((c) => [c, { nuestro: 0, suyo: 0, diff: 0 }]),
  ) as ResultadoConciliacion['totales'];

  const dias: DiaConciliado[] = [];
  for (const businessDate of [...suyos.keys()].sort()) {
    const mio = mios.get(businessDate);
    const suyo = suyos.get(businessDate)!;

    const detalle = {} as DiaConciliado['campos'];
    let cuadra = true;
    for (const c of campos) {
      const nuestro = mio ? NUESTRO[c](mio) : 0;
      const suyoV = suyo[c];
      const diff = nuestro - suyoV;
      detalle[c] = { nuestro, suyo: suyoV, diff };
      totales[c].nuestro += nuestro;
      totales[c].suyo += suyoV;
      totales[c].diff += diff;
      if (diff !== 0) cuadra = false;
    }

    dias.push({ businessDate, cuadra, campos: detalle, tickets: mio?.netTickets ?? 0 });
  }

  const conActividadNuestra = [...mios.values()].filter((d) => d.netTickets !== 0);
  const conActividadSuya = [...suyos.values()].filter((f) => f.netas !== 0 || f.brutas !== 0);

  const soloNuestros = conActividadNuestra
    .filter((d) => {
      const s = suyos.get(d.businessDate);
      return !s || (s.netas === 0 && s.brutas === 0);
    })
    .map((d) => d.businessDate);
  const soloSuyos = conActividadSuya
    .filter((f) => (mios.get(f.businessDate)?.netTickets ?? 0) === 0)
    .map((f) => f.businessDate);
  const fueraDeRango = [...mios.keys()].filter((d) => !suyos.has(d)).sort();
  const cuadra = dias.every((d) => d.cuadra);

  return {
    cuadra,
    verificacionCompleta:
      cuadra && fueraDeRango.length === 0 && soloNuestros.length === 0 && soloSuyos.length === 0,
    dias,
    diasConDiferencia: dias.filter((d) => !d.cuadra),
    totales,
    cobertura: {
      nuestros: conActividadNuestra.length,
      suyos: conActividadSuya.length,
      soloNuestros,
      soloSuyos,
    },
    // Un día nuestro fuera del rango del reporte no puede conciliarse: hay que
    // pedir el export con un rango que lo cubra.
    fueraDeRango,
  };
}
