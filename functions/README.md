# Kumobi — Cloud Functions (propagación)

Funciones de **propagación** para el costeo dinámico. No recalculan costos finales
(eso lo hace el cliente al re-guardar); avisan qué recetas quedaron desactualizadas.

## Qué hace

`onIngredientWrite` — trigger Firestore `onDocumentWritten('ingredients/{id}')`:

- Si cambia un campo que afecta el costo (`purchasePrice`, `conversionFactor`,
  `yieldPercentage`, `netCostPerUsageUnit`), marca **`requiresRecalculation = true`**
  en todas las recetas que usan ese insumo, **directa o indirectamente** (cascada por
  sub-recetas).
- Si cambió `purchasePrice`, agrega un registro a `ingredients/{id}/price_history`.
- Si el insumo se elimina, marca las recetas que lo usaban.
- `maxInstances: 3` (tope para controlar costos de invocación).

El dashboard (HU-04) lee `requiresRecalculation` y muestra la alerta; el usuario abre
la receta y la re-guarda para que el cliente la recueste.

## Requisitos

- Firebase CLI: `npm install -g firebase-tools`
- Estar autenticado: `firebase login`
- Plan **Blaze** en el proyecto (las Cloud Functions v2 lo requieren).
- Node 20 (runtime declarado en `firebase.json` y `functions/package.json`).

## Instalar y compilar

```bash
cd functions
npm install
npm run build   # tsc → lib/
```

## Probar en local (emuladores, opcional)

```bash
# desde 03-desarrollo/
firebase emulators:start --only functions,firestore
```

## Desplegar

```bash
# desde 03-desarrollo/ (donde está firebase.json y .firebaserc)
firebase deploy --only functions
```

Para desplegar también las reglas corregidas:

```bash
firebase deploy --only firestore:rules
# o todo junto:
firebase deploy --only functions,firestore:rules
```

> El proyecto por defecto (`kumobi-recipie-calculator`) está fijado en `.firebaserc`.
> Para otro proyecto: `firebase use <projectId>` o `firebase deploy --project <projectId>`.

## Verificar tras el deploy

1. En el panel, edita el precio de un insumo usado por una receta.
2. La función marca esa receta con `requiresRecalculation = true`.
3. El dashboard muestra la alerta "requiere recálculo" y el KPI se incrementa.
4. Revisa `ingredients/{id}/price_history` para el registro del cambio de precio.
