import { useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
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
import { previewNetCostPerUsageUnit } from '../../lib/costing';
import type { Category, Ingredient, RecipeDocument, UnitConfig } from '../../lib/types';
import { formatMXN, formatPercent, formatUnitCost } from '../../lib/format';
import { Button } from '../ui/Button';
import { CategoryBadge } from '../ui/Badge';
import { Modal } from '../ui/Modal';
import { Toast, type ToastState } from '../ui/Toast';
import { EmptyState, ErrorState, TableSkeleton } from '../ui/states';
import { IngredientForm, type IngredientFormValues } from './IngredientForm';

const ALL = '__all__';

export default function IngredientsPanel() {
  const { ready } = useAuthReady();
  const catalogs = useCatalogs(ready);
  const {
    data: ingredients,
    loading,
    error,
    reload,
  } = useCollection<Ingredient>(COLLECTIONS.ingredients, ready);
  // Para validar integridad referencial al eliminar (qué recetas usan cada insumo).
  const { data: recipes } = useCollection<RecipeDocument>(COLLECTIONS.recipes, ready);

  const recipesUsingIngredient = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of recipes) {
      for (const it of r.items ?? []) {
        if (it.type === 'INGREDIENT') {
          const arr = m.get(it.refId) ?? [];
          arr.push(r.name);
          m.set(it.refId, arr);
        }
      }
    }
    return m;
  }, [recipes]);

  const [search, setSearch] = useState('');
  const [categoryTab, setCategoryTab] = useState<string>(ALL);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Ingredient | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const unitById = useMemo(
    () => new Map(catalogs.units.map((u) => [u.id, u])),
    [catalogs.units],
  );
  const catById = useMemo(
    () => new Map(catalogs.categories.map((c) => [c.id, c])),
    [catalogs.categories],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ingredients
      .filter((i) => (categoryTab === ALL ? true : i.categoryId === categoryTab))
      .filter((i) => (q ? i.name.toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [ingredients, search, categoryTab]);

  function openCreate() {
    setEditing(undefined);
    setFormError(null);
    setModalOpen(true);
  }
  function openEdit(ing: Ingredient) {
    setEditing(ing);
    setFormError(null);
    setModalOpen(true);
  }

  async function handleSubmit(values: IngredientFormValues) {
    setSubmitting(true);
    setFormError(null);
    try {
      const db = getDb();
      // Arquitectura: el cliente calcula y escribe `netCostPerUsageUnit` (las
      // Security Rules lo validan). Las Cloud Functions se encargan de la
      // propagación (recostear recetas dependientes y marcar requiresRecalculation).
      const netCost = previewNetCostPerUsageUnit({
        purchasePrice: values.purchasePrice,
        conversionFactor: values.conversionFactor,
        yieldPercentage: values.yieldPercentage,
      });
      if (netCost == null) {
        setFormError(
          'No se pudo calcular el costo neto. Revisa precio, factor de conversión y rendimiento.',
        );
        setSubmitting(false);
        return;
      }
      const payload = {
        name: values.name.trim(),
        categoryId: values.categoryId,
        purchaseUnitId: values.purchaseUnitId,
        purchasePrice: values.purchasePrice,
        usageUnitId: values.usageUnitId,
        conversionFactor: values.conversionFactor,
        yieldPercentage: values.yieldPercentage,
        netCostPerUsageUnit: netCost,
        updatedAt: serverTimestamp(),
      };
      if (editing) {
        await updateDoc(doc(db, COLLECTIONS.ingredients, editing.id), payload);
      } else {
        await addDoc(collection(db, COLLECTIONS.ingredients), {
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
      setModalOpen(false);
      setToast({ message: 'Insumo guardado', tone: 'success' });
    } catch (err) {
      console.error('[IngredientsPanel] guardar', err);
      setFormError('No se pudo guardar el insumo. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(ing: Ingredient) {
    const used = recipesUsingIngredient.get(ing.id) ?? [];
    if (used.length > 0) {
      setToast({
        message: `No se puede eliminar "${ing.name}": lo usan ${used.length} receta(s). Quítalo de esas recetas primero.`,
        tone: 'danger',
      });
      return;
    }
    if (!confirm(`¿Eliminar "${ing.name}"? Esta acción no se puede deshacer.`)) return;
    try {
      await deleteDoc(doc(getDb(), COLLECTIONS.ingredients, ing.id));
      setToast({ message: 'Insumo eliminado', tone: 'success' });
    } catch (err) {
      console.error('[IngredientsPanel] eliminar', err);
      setToast({ message: 'No se pudo eliminar el insumo', tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-strong">
            Insumos (materias primas)
          </h1>
          <p className="text-sm text-text-muted">
            El costo neto por unidad de uso lo calcula el backend al guardar.
          </p>
        </div>
        <Button onClick={openCreate}>+ Nuevo insumo</Button>
      </div>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="🔎 Buscar por nombre…"
        aria-label="Buscar insumo por nombre"
        className="h-9 w-full max-w-sm rounded-md border border-border-base bg-surface px-3 text-sm text-text-strong placeholder:text-text-muted focus:border-primary"
      />

      <CategoryTabs
        categories={catalogs.categories}
        active={categoryTab}
        onChange={setCategoryTab}
      />

      {loading || catalogs.loading ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : ingredients.length === 0 ? (
        <EmptyState
          title="Aún no hay insumos"
          description="Registra tu primera materia prima para empezar a costear."
          action={<Button onClick={openCreate}>Nuevo insumo</Button>}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={`Sin resultados${search ? ` para «${search}»` : ''}`}
          description="Ajusta la búsqueda o el filtro de categoría."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSearch('');
                setCategoryTab(ALL);
              }}
            >
              Limpiar filtros
            </Button>
          }
        />
      ) : (
        <IngredientsTable
          rows={filtered}
          unitById={unitById}
          catById={catById}
          onEdit={openEdit}
          onDelete={handleDelete}
        />
      )}

      <p className="text-xs text-text-muted">
        Mostrando {filtered.length} de {ingredients.length}
      </p>

      <Modal
        open={modalOpen}
        title={editing ? 'Editar insumo' : 'Nuevo insumo'}
        onClose={() => !submitting && setModalOpen(false)}
      >
        <IngredientForm
          units={catalogs.units}
          categories={catalogs.categories}
          initial={editing}
          submitting={submitting}
          serverError={formError}
          onSubmit={handleSubmit}
          onCancel={() => setModalOpen(false)}
        />
      </Modal>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function CategoryTabs({
  categories,
  active,
  onChange,
}: {
  categories: Category[];
  active: string;
  onChange: (id: string) => void;
}) {
  const base =
    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors';
  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filtrar por categoría">
      <button
        role="tab"
        aria-selected={active === ALL}
        onClick={() => onChange(ALL)}
        className={`${base} ${
          active === ALL
            ? 'border-primary bg-primary-soft text-primary'
            : 'border-border-base bg-surface text-text-base'
        }`}
      >
        Todas
      </button>
      {categories.map((c) => (
        <button
          key={c.id}
          role="tab"
          aria-selected={active === c.id}
          onClick={() => onChange(c.id)}
          className={`${base} ${
            active === c.id
              ? 'border-primary bg-primary-soft text-primary'
              : 'border-border-base bg-surface text-text-base'
          }`}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: c.hexColor }}
            aria-hidden="true"
          />
          {c.name}
        </button>
      ))}
    </div>
  );
}

function IngredientsTable({
  rows,
  unitById,
  catById,
  onEdit,
  onDelete,
}: {
  rows: Ingredient[];
  unitById: Map<string, UnitConfig>;
  catById: Map<string, Category>;
  onEdit: (i: Ingredient) => void;
  onDelete: (i: Ingredient) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border-base bg-surface shadow-card">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-app text-left text-xs text-text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Nombre</th>
            <th className="px-4 py-2 font-medium">Categoría</th>
            <th className="px-4 py-2 text-right font-medium">Compra</th>
            <th className="px-4 py-2 text-right font-medium">Rendimiento</th>
            <th className="px-4 py-2 text-right font-medium">Costo neto</th>
            <th className="px-4 py-2 text-right font-medium">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-base">
          {rows.map((i) => {
            const purchaseUnit = unitById.get(i.purchaseUnitId);
            const usageUnit = unitById.get(i.usageUnitId);
            return (
              <tr key={i.id} className="hover:bg-app/60">
                <td className="px-4 py-2.5 font-medium text-text-strong">{i.name}</td>
                <td className="px-4 py-2.5">
                  <CategoryBadge category={catById.get(i.categoryId)} />
                </td>
                <td className="px-4 py-2.5 text-right tabular">
                  {formatMXN(i.purchasePrice)}
                  {purchaseUnit ? `/${purchaseUnit.symbol}` : ''}
                </td>
                <td className="px-4 py-2.5 text-right tabular">
                  {formatPercent(i.yieldPercentage)}
                </td>
                <td className="px-4 py-2.5 text-right font-medium text-text-strong tabular">
                  {formatUnitCost(i.netCostPerUsageUnit, usageUnit?.symbol)}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => onEdit(i)}
                      aria-label={`Editar ${i.name}`}
                      className="rounded p-1 text-text-muted hover:bg-app hover:text-primary"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => onDelete(i)}
                      aria-label={`Eliminar ${i.name}`}
                      className="rounded p-1 text-text-muted hover:bg-app hover:text-danger"
                    >
                      🗑
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
