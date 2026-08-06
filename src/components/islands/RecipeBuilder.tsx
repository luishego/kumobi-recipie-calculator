import { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { getDb } from '../../lib/firebase/client';
import {
  useAuthReady,
  useCatalogs,
  useCollection,
} from '../../lib/firebase/hooks';
import { COLLECTIONS } from '../../lib/constants';
import type {
  Ingredient,
  ItemType,
  RecipeDocument,
  UnitConfig,
} from '../../lib/types';
import {
  previewContributionMargin,
  previewCostPerYieldUnit,
  previewFoodCostPercentage,
  previewRowCost,
} from '../../lib/costing';
import { buildSubRecipeGraph, checkAddSubRecipe } from '../../lib/graph';
import { formatMXN } from '../../lib/format';
import { Button } from '../ui/Button';
import { FieldWrap, Select, TextInput } from '../ui/Field';
import { Toggle } from '../ui/Toggle';
import { Combobox, type ComboOption } from '../ui/Combobox';
import { Alert } from '../ui/Alert';
import { Toast, type ToastState } from '../ui/Toast';
import { EmptyState, ErrorState, TableSkeleton } from '../ui/states';
import { RecipeSummary } from './RecipeSummary';

interface RowState {
  key: string;
  type: ItemType;
  refId: string;
  snapName: string;
  quantity: number | '';
  usageUnitId: string;
  error?: string;
}

let rowSeq = 0;
const newKey = () => `row_${++rowSeq}_${Date.now()}`;

export default function RecipeBuilder({ recipeId }: { recipeId?: string }) {
  const { ready } = useAuthReady();
  const catalogs = useCatalogs(ready);
  const { data: ingredients, loading: loadingIng } = useCollection<Ingredient>(
    COLLECTIONS.ingredients,
    ready,
  );
  const { data: recipes, loading: loadingRec } = useCollection<RecipeDocument>(
    COLLECTIONS.recipes,
    ready,
  );

  // Cabecera
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [isSubRecipe, setIsSubRecipe] = useState(false);
  const [yieldQty, setYieldQty] = useState<number | ''>('');
  const [yieldUnitId, setYieldUnitId] = useState('');
  const [targetPrice, setTargetPrice] = useState<number | ''>('');
  const [rows, setRows] = useState<RowState[]>([]);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [loadedEdit, setLoadedEdit] = useState(false);

  const unitById = useMemo(
    () => new Map(catalogs.units.map((u) => [u.id, u])),
    [catalogs.units],
  );
  const ingById = useMemo(
    () => new Map(ingredients.map((i) => [i.id, i])),
    [ingredients],
  );
  const recById = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes]);

  const nameOf = (id: string) =>
    recById.get(id)?.name ?? (id === recipeId ? name || 'esta receta' : id);

  // Cargar receta existente (modo edición).
  useEffect(() => {
    if (!recipeId || !ready || loadedEdit) return;
    (async () => {
      try {
        const snap = await getDoc(doc(getDb(), COLLECTIONS.recipes, recipeId));
        if (snap.exists()) {
          const r = { id: snap.id, ...snap.data() } as RecipeDocument;
          setName(r.name);
          setCategoryId(r.categoryId);
          setIsSubRecipe(r.isSubRecipe);
          setYieldQty(r.yield?.quantityProduced ?? '');
          setYieldUnitId(r.yield?.unitId ?? '');
          setTargetPrice(r.targetSellingPrice ?? '');
          setRows(
            (r.items ?? []).map((it) => ({
              key: newKey(),
              type: it.type,
              refId: it.refId,
              snapName: it.snapName,
              quantity: it.quantity,
              usageUnitId: it.usageUnitId,
            })),
          );
        }
      } catch (err) {
        console.error('[RecipeBuilder] cargar receta', err);
      } finally {
        setLoadedEdit(true);
      }
    })();
  }, [recipeId, ready, loadedEdit]);

  // Opciones del combobox de renglones: ingredientes + sub-recetas.
  const rowOptions = useMemo<ComboOption[]>(() => {
    const ing = ingredients.map<ComboOption>((i) => ({
      value: `INGREDIENT:${i.id}`,
      label: i.name,
      meta: 'Ingrediente',
    }));
    const subs = recipes
      .filter((r) => r.isSubRecipe && r.id !== recipeId)
      .map<ComboOption>((r) => ({
        value: `RECETA:${r.id}`,
        label: r.name,
        meta: 'Sub-receta',
      }));
    return [...ing, ...subs];
  }, [ingredients, recipes, recipeId]);

  /** Resuelve la unidad de uso y el costo unitario del ítem referenciado. */
  function resolveItemBasis(type: ItemType, refId: string): {
    usageUnit: UnitConfig | undefined;
    unitCost: number | undefined;
  } {
    if (type === 'INGREDIENT') {
      const ing = ingById.get(refId);
      return {
        usageUnit: ing ? unitById.get(ing.usageUnitId) : undefined,
        unitCost: ing?.netCostPerUsageUnit,
      };
    }
    const sub = recById.get(refId);
    return {
      usageUnit: sub ? unitById.get(sub.yield.unitId) : undefined,
      unitCost: sub?.costPerYieldUnit,
    };
  }

  function addRow(option: ComboOption) {
    const [type, refId] = option.value.split(':') as [ItemType, string];

    // Anti-ciclos + profundidad al agregar una sub-receta.
    if (type === 'RECETA') {
      const graph = buildSubRecipeGraph(recipes);
      const check = checkAddSubRecipe(recipeId ?? '__new__', refId, graph, nameOf);
      if (!check.ok) {
        if (check.reason === 'cycle') {
          const path = (check.path ?? []).join(' → ');
          setBanner(`Esta sub-receta crearía un ciclo (${path}). No se puede agregar.`);
        } else {
          setBanner(
            `Esta sub-receta excede la profundidad máxima de anidación permitida. No se puede agregar.`,
          );
        }
        return;
      }
    }

    setBanner(null);
    const basis = resolveItemBasis(type, refId);
    setRows((prev) => [
      ...prev,
      {
        key: newKey(),
        type,
        refId,
        snapName: option.label,
        quantity: '',
        usageUnitId: basis.usageUnit?.id ?? '',
      },
    ]);
  }

  function updateRow(key: string, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  // Costeo en vivo (preview).
  const rowCosts = useMemo(() => {
    return rows.map((r) => {
      const basis = resolveItemBasis(r.type, r.refId);
      const cost = previewRowCost({
        quantity: typeof r.quantity === 'number' ? r.quantity : NaN,
        rowUnit: unitById.get(r.usageUnitId),
        ingredientUsageUnit: basis.usageUnit,
        unitCost: basis.unitCost,
      });
      return { key: r.key, cost, dimensionType: basis.usageUnit?.type };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, unitById, ingById, recById]);

  const totalCost = useMemo(
    () => rowCosts.reduce((sum, rc) => sum + (rc.cost ?? 0), 0),
    [rowCosts],
  );
  const allRowsCosted =
    rows.length > 0 && rowCosts.every((rc) => rc.cost != null);
  const costPerYieldUnit = previewCostPerYieldUnit(
    totalCost,
    typeof yieldQty === 'number' ? yieldQty : NaN,
  );
  const foodCostPercentage = isSubRecipe
    ? null
    : previewFoodCostPercentage(
        costPerYieldUnit,
        typeof targetPrice === 'number' ? targetPrice : undefined,
      );
  const contributionMargin = isSubRecipe
    ? null
    : previewContributionMargin(
        costPerYieldUnit,
        typeof targetPrice === 'number' ? targetPrice : undefined,
      );

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'El nombre es obligatorio.';
    if (!categoryId) errs.categoryId = 'Selecciona una categoría.';
    if (!(typeof yieldQty === 'number' && yieldQty > 0))
      errs.yieldQty = 'El rendimiento debe ser mayor a 0.';
    if (!yieldUnitId) errs.yieldUnitId = 'Selecciona la unidad de rendimiento.';
    if (rows.length === 0) errs.rows = 'Agrega al menos un ingrediente o sub-receta.';
    if (!isSubRecipe && targetPrice !== '' && !(Number(targetPrice) > 0))
      errs.targetPrice = 'El precio de venta debe ser mayor a 0.';

    // Validación por renglón.
    setRows((prev) =>
      prev.map((r) => {
        let error: string | undefined;
        if (!(typeof r.quantity === 'number' && r.quantity > 0))
          error = 'Cantidad > 0';
        else if (!r.usageUnitId) error = 'Falta unidad';
        return { ...r, error };
      }),
    );
    const rowInvalid = rows.some(
      (r) => !(typeof r.quantity === 'number' && r.quantity > 0) || !r.usageUnitId,
    );
    if (rowInvalid && !errs.rows) errs.rows = 'Revisa las cantidades y unidades de los renglones.';

    setFieldErrors(errs);
    return Object.keys(errs).length === 0 && !rowInvalid;
  }

  async function handleSave() {
    setSaveError(null);
    if (!validate()) return;
    // No guardar recetas con renglones sin costo resoluble (evita totales erróneos).
    if (!allRowsCosted) {
      setSaveError(
        'Hay renglones sin costo calculable (revisa unidades o que el insumo tenga costo). No se puede guardar.',
      );
      return;
    }
    setSubmitting(true);
    try {
      // Arquitectura: el cliente calcula y escribe los campos financieros (las
      // Security Rules los validan). Las Cloud Functions se encargan de la
      // propagación: recostear recetas dependientes y marcar requiresRecalculation
      // cuando cambia el precio de un insumo base.
      const costByKey = new Map(rowCosts.map((rc) => [rc.key, rc.cost ?? 0]));
      const safeCostPerYield = costPerYieldUnit ?? 0;
      const payload: Record<string, unknown> = {
        name: name.trim(),
        categoryId,
        isSubRecipe,
        yield: {
          quantityProduced: Number(yieldQty),
          unitId: yieldUnitId,
        },
        items: rows.map((r) => ({
          type: r.type,
          refId: r.refId,
          snapName: r.snapName,
          quantity: Number(r.quantity),
          usageUnitId: r.usageUnitId,
          calculatedCost: costByKey.get(r.key) ?? 0,
        })),
        totalCost,
        costPerYieldUnit: safeCostPerYield,
        requiresRecalculation: false,
        updatedAt: serverTimestamp(),
      };
      if (!isSubRecipe && typeof targetPrice === 'number') {
        payload.targetSellingPrice = targetPrice;
        if (foodCostPercentage != null) payload.foodCostPercentage = foodCostPercentage;
        if (contributionMargin != null) payload.contributionMargin = contributionMargin;
      }

      const db = getDb();
      if (recipeId) {
        await updateDoc(doc(db, COLLECTIONS.recipes, recipeId), payload);
      } else {
        await addDoc(collection(db, COLLECTIONS.recipes), {
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
      setToast({ message: 'Receta guardada', tone: 'success' });
      setTimeout(() => window.location.assign('/recetas'), 900);
    } catch (err) {
      console.error('[RecipeBuilder] guardar', err);
      setSaveError('No se pudo guardar la receta. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  const loading = catalogs.loading || loadingIng || loadingRec || (!!recipeId && !loadedEdit);

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <TableSkeleton rows={5} cols={4} />
        <TableSkeleton rows={4} cols={1} />
      </div>
    );
  }
  if (catalogs.error) {
    return <ErrorState message={catalogs.error} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text-strong">
          {recipeId ? 'Editar receta' : 'Nueva receta'}
        </h1>
        <div className="flex gap-2">
          <a href="/recetas">
            <Button variant="secondary" disabled={submitting}>
              Cancelar
            </Button>
          </a>
          <Button onClick={handleSave} loading={submitting}>
            Guardar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        {/* Columna izquierda: cabecera + renglones */}
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 rounded-lg border border-border-base bg-surface p-5 shadow-card sm:grid-cols-2">
            <FieldWrap label="Nombre" htmlFor="r-name" required error={fieldErrors.name}>
              <TextInput
                id="r-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Lasaña boloñesa"
                invalid={!!fieldErrors.name}
              />
            </FieldWrap>
            <FieldWrap
              label="Categoría"
              htmlFor="r-cat"
              required
              error={fieldErrors.categoryId}
            >
              <Select
                id="r-cat"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                invalid={!!fieldErrors.categoryId}
              >
                <option value="">Selecciona…</option>
                {catalogs.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FieldWrap>

            <div className="sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-text-base">Tipo</span>
              <Toggle
                checked={isSubRecipe}
                onChange={setIsSubRecipe}
                offLabel="Platillo final"
                onLabel="Sub-receta"
              />
            </div>

            <FieldWrap
              label="Rendimiento"
              htmlFor="r-yield"
              required
              error={fieldErrors.yieldQty}
            >
              <TextInput
                id="r-yield"
                type="number"
                step="any"
                min="0"
                value={yieldQty}
                onChange={(e) =>
                  setYieldQty(e.target.value === '' ? '' : Number(e.target.value))
                }
                invalid={!!fieldErrors.yieldQty}
              />
            </FieldWrap>
            <FieldWrap
              label="Unidad de rendimiento"
              htmlFor="r-yieldunit"
              required
              error={fieldErrors.yieldUnitId}
            >
              <Select
                id="r-yieldunit"
                value={yieldUnitId}
                onChange={(e) => setYieldUnitId(e.target.value)}
                invalid={!!fieldErrors.yieldUnitId}
              >
                <option value="">Selecciona…</option>
                {catalogs.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.symbol})
                  </option>
                ))}
              </Select>
            </FieldWrap>

            {!isSubRecipe && (
              <FieldWrap
                label="Precio de venta"
                htmlFor="r-price"
                error={fieldErrors.targetPrice}
                hint="Sin impuestos. Necesario para el Food Cost."
              >
                <TextInput
                  id="r-price"
                  type="number"
                  step="0.01"
                  min="0"
                  prefix="$"
                  value={targetPrice}
                  onChange={(e) =>
                    setTargetPrice(e.target.value === '' ? '' : Number(e.target.value))
                  }
                  invalid={!!fieldErrors.targetPrice}
                />
              </FieldWrap>
            )}
          </div>

          {/* Agregar renglón */}
          <div className="rounded-lg border border-border-base bg-surface p-5 shadow-card">
            <label className="mb-1 block text-xs font-medium text-text-base">
              Agregar renglón
            </label>
            <Combobox
              options={rowOptions}
              onSelect={addRow}
              placeholder="🔎 Ingrediente o sub-receta…"
            />

            {banner && (
              <div className="mt-3">
                <Alert tone="danger">{banner}</Alert>
              </div>
            )}
            {fieldErrors.rows && !banner && (
              <div className="mt-3">
                <Alert tone="danger">{fieldErrors.rows}</Alert>
              </div>
            )}

            <div className="mt-4">
              {rows.length === 0 ? (
                <EmptyState
                  title="Agrega el primer ingrediente o sub-receta"
                  description="Usa el buscador de arriba para armar la receta."
                />
              ) : (
                <RowsTable
                  rows={rows}
                  rowCosts={rowCosts}
                  units={catalogs.units}
                  onUpdate={updateRow}
                  onRemove={removeRow}
                />
              )}
            </div>
          </div>

          {saveError && <Alert tone="danger">{saveError}</Alert>}
        </div>

        {/* Columna derecha: resumen financiero */}
        <RecipeSummary
          isSubRecipe={isSubRecipe}
          totalCost={totalCost}
          costPerYieldUnit={costPerYieldUnit}
          foodCostPercentage={foodCostPercentage}
          contributionMargin={contributionMargin}
          complete={allRowsCosted}
        />
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function RowsTable({
  rows,
  rowCosts,
  units,
  onUpdate,
  onRemove,
}: {
  rows: RowState[];
  rowCosts: Array<{ key: string; cost: number | null; dimensionType?: string }>;
  units: UnitConfig[];
  onUpdate: (key: string, patch: Partial<RowState>) => void;
  onRemove: (key: string) => void;
}) {
  const costByKey = new Map(rowCosts.map((rc) => [rc.key, rc]));
  return (
    <div className="overflow-x-auto rounded-md border border-border-base">
      <table className="w-full text-sm">
        <thead className="bg-app text-left text-xs text-text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Ítem</th>
            <th className="px-3 py-2 font-medium">Cantidad</th>
            <th className="px-3 py-2 font-medium">Unidad</th>
            <th className="px-3 py-2 text-right font-medium">Costo</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border-base">
          {rows.map((r) => {
            const rc = costByKey.get(r.key);
            // Unidades filtradas por dimensión (opción B): mismo `type` que el ítem.
            const unitOptions = units.filter((u) => u.type === rc?.dimensionType);
            return (
              <tr key={r.key} className={r.error ? 'bg-fc-bad-bg/40' : ''}>
                <td className="px-3 py-2">
                  <div className="font-medium text-text-strong">{r.snapName}</div>
                  <div className="text-xs text-text-muted">
                    {r.type === 'INGREDIENT' ? 'Ingrediente' : 'Sub-receta'}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={r.quantity}
                    onChange={(e) =>
                      onUpdate(r.key, {
                        quantity: e.target.value === '' ? '' : Number(e.target.value),
                        error: undefined,
                      })
                    }
                    aria-label={`Cantidad de ${r.snapName}`}
                    className={`h-8 w-24 rounded-md border bg-surface px-2 text-sm tabular focus:border-primary ${
                      r.error ? 'border-danger' : 'border-border-base'
                    }`}
                  />
                </td>
                <td className="px-3 py-2">
                  <select
                    value={r.usageUnitId}
                    onChange={(e) => onUpdate(r.key, { usageUnitId: e.target.value })}
                    aria-label={`Unidad de ${r.snapName}`}
                    className="h-8 rounded-md border border-border-base bg-surface px-2 text-sm focus:border-primary"
                  >
                    {unitOptions.length === 0 && <option value="">—</option>}
                    {unitOptions.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.symbol}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 text-right font-medium text-text-strong tabular">
                  {rc?.cost != null ? formatMXN(rc.cost) : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => onRemove(r.key)}
                    aria-label={`Quitar ${r.snapName}`}
                    className="rounded p-1 text-text-muted hover:bg-app hover:text-danger"
                  >
                    🗑
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
