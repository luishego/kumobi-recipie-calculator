import { describe, it, expect } from 'vitest';
import { receiptId, receiptLineId, storeId, esUrlSafe } from './ids';

const CUENTA = '29aee364-c65f-4ab9-8dc8-aaadf043be14';
const SUCURSAL = '25d1edc7-527e-432b-9b3f-61d06df6fd88';

describe('id de ticket', () => {
  it('se deriva de la llave natural del §5.4', () => {
    expect(receiptId('loyverse', CUENTA, SUCURSAL, '1-0086')).toBe(
      `loyverse|${CUENTA}|${SUCURSAL}|1-0086`,
    );
  });

  it('es determinista: el mismo ticket siempre da el mismo id', () => {
    expect(receiptId('loyverse', CUENTA, SUCURSAL, '1-0086')).toBe(
      receiptId('loyverse', CUENTA, SUCURSAL, '1-0086'),
    );
  });

  it('rechaza componentes que contengan el separador', () => {
    expect(() => receiptId('loyverse', 'a|b', SUCURSAL, '1-0086')).toThrow(/contiene/);
  });

  it('rechaza componentes vacíos', () => {
    expect(() => receiptId('loyverse', '', SUCURSAL, '1-0086')).toThrow(/Falta/);
  });

  it('los renglones cuelgan del ticket', () => {
    const id = receiptId('loyverse', CUENTA, SUCURSAL, '1-0086');
    expect(receiptLineId(id, 0)).toBe(`${id}#0`);
  });
});

describe('id de sucursal', () => {
  it('combina cuenta e id del proveedor', () => {
    expect(storeId(CUENTA, SUCURSAL)).toBe(`${CUENTA}.${SUCURSAL}`);
  });

  it('VIAJA EN UNA URL, así que tiene que ser URL-safe', () => {
    // Con "::" como separador, el id llegaba al endpoint como "%3A%3A" —Astro
    // no decodifica los parámetros de ruta— y la respuesta era "La sucursal no
    // existe" al activar o desactivar una sucursal en producción.
    const id = storeId(CUENTA, SUCURSAL);
    expect(esUrlSafe(id)).toBe(true);
    expect(encodeURIComponent(id)).toBe(id);
  });

  it('esUrlSafe detecta los ids que no lo son', () => {
    expect(esUrlSafe(`${CUENTA}::${SUCURSAL}`)).toBe(false);
    expect(esUrlSafe('con espacio')).toBe(false);
    expect(esUrlSafe('con/barra')).toBe(false);
  });
});
