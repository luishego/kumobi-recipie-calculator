// Propuesta automática de mapeo — HU-11.
//
// Los casos que importan salen del catálogo REAL de Kumobi, no de ejemplos
// inventados: es ahí donde están las colisiones de SKU y de nombre que hacen
// que "tomar la primera coincidencia" produzca un Food Cost equivocado.
import { describe, it, expect } from 'vitest';
import { normalizarNombre, proponerMapeos, propuestasSeguras } from './match';
import type { PosItemVendido } from '../repo/itemMap';
import type { RecetaCandidata } from './match';

/** Ítem vendido mínimo: solo lo que la propuesta consulta. */
function item(partes: Partial<PosItemVendido> & { itemName: string }): PosItemVendido {
  return {
    clave: partes.clave ?? `acc|${partes.itemName}|`,
    accountId: 'acc',
    providerItemId: partes.providerItemId ?? `it-${partes.itemName}`,
    providerVariantId: null,
    sku: null,
    variantName: null,
    unitsSold: 1,
    revenueCents: 10_000,
    lineCount: 1,
    lastSoldDate: '2026-09-01',
    mapeo: null,
    ...partes,
  };
}

const receta = (id: string, name: string, extra: Partial<RecetaCandidata> = {}) =>
  ({ id, name, ...extra }) as RecetaCandidata;

describe('normalizarNombre', () => {
  it('quita acentos, puntuación y mayúsculas', () => {
    expect(normalizarNombre('Clásica 1/4 lb')).toBe('clasica 1 4 lb');
    expect(normalizarNombre('Cyber_wings 5Kb')).toBe('cyber wings 5kb');
    expect(normalizarNombre('Mojito.exe 2.0')).toBe('mojito exe 2 0');
    expect(normalizarNombre('Cheese & Chimi')).toBe('cheese chimi');
  });

  it('colapsa espacios y recorta', () => {
    expect(normalizarNombre('  Papas   200  gr ')).toBe('papas 200 gr');
  });

  it('NO une platillos que solo difieren en el sufijo de versión', () => {
    // "Bacon" y "Bacon 2.0" conviven en la carta real: son distintos.
    expect(normalizarNombre('Bacon')).not.toBe(normalizarNombre('Bacon 2.0'));
  });

  it('empata las grafías que sí son el mismo nombre', () => {
    // En el histórico real aparecen "Cheese & Chimi" y "Cheese & chimi 2.0";
    // la diferencia de caja no debe impedir la coincidencia del primero.
    expect(normalizarNombre('cheese & chimi')).toBe(normalizarNombre('Cheese & Chimi'));
  });
});

describe('coincidencia por nombre', () => {
  const recetas = [receta('r1', 'Clásica 1/4 lb'), receta('r2', 'Veggie')];

  it('propone la única receta que empata', () => {
    const p = proponerMapeos([item({ itemName: 'Clásica 1/4 lb' })], recetas);
    const prop = p.get('acc|Clásica 1/4 lb|');
    expect(prop).toEqual({
      estado: 'PROPUESTO',
      recipeId: 'r1',
      recipeName: 'Clásica 1/4 lb',
      method: 'auto_name',
    });
  });

  it('empata a pesar de acentos y mayúsculas distintas', () => {
    const p = proponerMapeos([item({ itemName: 'CLASICA 1/4 LB' })], recetas);
    expect(p.get('acc|CLASICA 1/4 LB|')).toMatchObject({ estado: 'PROPUESTO', recipeId: 'r1' });
  });

  it('sin coincidencia deja SIN_CANDIDATO, no una propuesta cualquiera', () => {
    const p = proponerMapeos([item({ itemName: 'Envio' })], recetas);
    expect(p.get('acc|Envio|')).toEqual({ estado: 'SIN_CANDIDATO' });
  });
});

describe('ambigüedad — el caso que corrompe el Food Cost en silencio', () => {
  it('dos recetas con el mismo nombre NO se resuelven automáticamente', () => {
    // Refleja los dos "Bacon" distintos del catálogo real.
    const p = proponerMapeos(
      [item({ itemName: 'Bacon' })],
      [receta('r-bacon-sencillo', 'Bacon'), receta('r-bacon-doble', 'Bacon')],
    );
    const prop = p.get('acc|Bacon|')!;
    expect(prop.estado).toBe('AMBIGUO');
    if (prop.estado === 'AMBIGUO') {
      expect(prop.candidatos.map((c) => c.id).sort()).toEqual([
        'r-bacon-doble',
        'r-bacon-sencillo',
      ]);
    }
  });

  it('una propuesta ambigua NO entra en la confirmación en bloque', () => {
    const p = proponerMapeos(
      [item({ itemName: 'Bacon' }), item({ itemName: 'Veggie' })],
      [receta('r1', 'Bacon'), receta('r2', 'Bacon'), receta('r3', 'Veggie')],
    );
    const seguras = propuestasSeguras(p);
    expect(seguras).toHaveLength(1);
    expect(seguras[0]).toMatchObject({ recipeId: 'r3' });
  });

  it('un SKU compartido por dos recetas también es ambiguo', () => {
    // El 10005 real lo comparten "Bebida" y "Kumobi Fresh Combo".
    const p = proponerMapeos(
      [item({ itemName: 'Bebida', sku: '10005' })],
      [
        receta('r-bebida', 'Bebida', { posSku: '10005' }),
        receta('r-combo', 'Kumobi Fresh Combo', { posSku: '10005' }),
      ],
    );
    const prop = p.get('acc|Bebida|')!;
    expect(prop.estado).toBe('AMBIGUO');
    if (prop.estado === 'AMBIGUO') expect(prop.method).toBe('auto_sku');
  });
});

describe('precedencia del SKU', () => {
  it('el SKU gana sobre el nombre cuando empata', () => {
    const p = proponerMapeos(
      [item({ itemName: 'Bebida', sku: '10024' })],
      [receta('r-agua', 'Agua mineral', { posSku: '10024' }), receta('r-bebida', 'Bebida')],
    );
    expect(p.get('acc|Bebida|')).toMatchObject({
      estado: 'PROPUESTO',
      recipeId: 'r-agua',
      method: 'auto_sku',
    });
  });

  it('un SKU ambiguo NO se rescata con el nombre', () => {
    // Si las dos señales se contradicen, no se sabe cuál creer: decide una
    // persona. Rescatarlo por nombre sería inventar una certeza que no hay.
    const p = proponerMapeos(
      [item({ itemName: 'Bebida', sku: '10005' })],
      [
        receta('r-a', 'Otra cosa', { posSku: '10005' }),
        receta('r-b', 'Y otra', { posSku: '10005' }),
        receta('r-bebida', 'Bebida'),
      ],
    );
    expect(p.get('acc|Bebida|')!.estado).toBe('AMBIGUO');
  });

  it('sin SKU en las recetas, cae a nombre (estado real hoy)', () => {
    // `RecipeDocument` no tiene código de POS: `auto_sku` queda dormido.
    const p = proponerMapeos(
      [item({ itemName: 'Veggie', sku: '10001' })],
      [receta('r1', 'Veggie')],
    );
    expect(p.get('acc|Veggie|')).toMatchObject({ method: 'auto_name', recipeId: 'r1' });
  });
});

describe('qué se excluye de las propuestas', () => {
  it('las sub-recetas no son destino: no se venden', () => {
    const p = proponerMapeos(
      [item({ itemName: 'Salsa madre' })],
      [receta('sub1', 'Salsa madre', { isSubRecipe: true })],
    );
    expect(p.get('acc|Salsa madre|')).toEqual({ estado: 'SIN_CANDIDATO' });
  });

  it('una sub-receta homónima no vuelve ambigua a la vendible', () => {
    const p = proponerMapeos(
      [item({ itemName: 'Teriyaki' })],
      [receta('sub', 'Teriyaki', { isSubRecipe: true }), receta('vend', 'Teriyaki')],
    );
    expect(p.get('acc|Teriyaki|')).toMatchObject({ estado: 'PROPUESTO', recipeId: 'vend' });
  });

  it('un ítem YA mapeado no recibe propuesta', () => {
    const yaMapeado = item({
      itemName: 'Veggie',
      mapeo: { kind: 'RECIPE', recipeId: 'otra', method: 'manual', confirmedByUser: true },
    });
    const p = proponerMapeos([yaMapeado], [receta('r1', 'Veggie')]);
    expect(p.has('acc|Veggie|')).toBe(false);
  });

  it('un ítem marcado "no aplica" tampoco vuelve a proponerse', () => {
    const ignorado = item({
      itemName: 'Envio',
      mapeo: { kind: 'IGNORED', recipeId: null, method: 'manual', confirmedByUser: true },
    });
    const p = proponerMapeos([ignorado], [receta('r1', 'Envio')]);
    expect(p.has('acc|Envio|')).toBe(false);
  });

  it('un ítem abierto del POS (sin id) no es mapeable', () => {
    const abierto = item({ itemName: 'Venta rápida', providerItemId: null });
    const p = proponerMapeos([abierto], [receta('r1', 'Venta rápida')]);
    expect(p.size).toBe(0);
  });
});
