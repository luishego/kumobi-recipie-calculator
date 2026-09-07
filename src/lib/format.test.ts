// Fechas de los selectores de la interfaz.
//
// Se prueban las invariantes que NO dependen de la zona de la máquina donde
// corren: la forma, la relación entre ellas, y —lo que motivó el arreglo— que
// nunca devuelvan un día que todavía no ha empezado aquí.
import { describe, it, expect } from 'vitest';
import { haceDiasLocal, hoyLocal } from './format';

const FORMA = /^\d{4}-\d{2}-\d{2}$/;

describe('fechas locales para la interfaz', () => {
  it('tienen la forma YYYY-MM-DD', () => {
    expect(hoyLocal()).toMatch(FORMA);
    expect(haceDiasLocal(30)).toMatch(FORMA);
  });

  it('cero días atrás es hoy', () => {
    expect(haceDiasLocal(0)).toBe(hoyLocal());
  });

  it('nunca devuelven un día posterior al de hoy AQUÍ', () => {
    // El defecto que se corrigió: con `toISOString()` esto fallaba en México a
    // partir de las 18:00, porque el día UTC ya era el siguiente y el selector
    // ofrecía como máximo un día que no había empezado.
    const hoyDeVerdad = new Date().toLocaleDateString('en-CA');
    expect(hoyLocal() <= hoyDeVerdad).toBe(true);
    expect(haceDiasLocal(1) < hoyDeVerdad).toBe(true);
  });

  it('retroceden el número de días pedido', () => {
    const ayer = haceDiasLocal(1);
    const hace30 = haceDiasLocal(30);
    expect(ayer < hoyLocal()).toBe(true);
    expect(hace30 < ayer).toBe(true);

    // La diferencia en días de calendario es exactamente la pedida.
    const dias = (a: string, b: string) =>
      Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
    expect(dias(hoyLocal(), hace30)).toBe(30);
  });
});
