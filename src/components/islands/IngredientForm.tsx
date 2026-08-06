import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { Category, Ingredient, UnitConfig } from '../../lib/types';
import { previewNetCostPerUsageUnit } from '../../lib/costing';
import { formatUnitCost } from '../../lib/format';
import { FieldWrap, Select, TextInput } from '../ui/Field';
import { Button } from '../ui/Button';
import { Alert, PreviewLabel } from '../ui/Alert';

// Validación Zod (HU-02). Nota: NO se exige misma dimensión entre compra y uso;
// conversionFactor es el puente empírico (puede cruzar dimensiones).
const schema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio.'),
  categoryId: z.string().min(1, 'Selecciona una categoría.'),
  purchaseUnitId: z.string().min(1, 'Selecciona la unidad de compra.'),
  purchasePrice: z.coerce
    .number({ invalid_type_error: 'Ingresa un precio.' })
    .positive('El precio debe ser mayor a 0.'),
  usageUnitId: z.string().min(1, 'Selecciona la unidad de uso.'),
  conversionFactor: z.coerce
    .number({ invalid_type_error: 'Ingresa el factor.' })
    .positive('El factor debe ser mayor a 0.'),
  yieldPercentage: z.coerce
    .number({ invalid_type_error: 'Ingresa el rendimiento.' })
    .gt(0, 'Debe ser mayor a 0.')
    .lte(100, 'No puede superar 100.'),
});

export type IngredientFormValues = z.infer<typeof schema>;

interface Props {
  units: UnitConfig[];
  categories: Category[];
  initial?: Ingredient;
  submitting: boolean;
  serverError: string | null;
  onSubmit: (values: IngredientFormValues) => void;
  onCancel: () => void;
}

export function IngredientForm({
  units,
  categories,
  initial,
  submitting,
  serverError,
  onSubmit,
  onCancel,
}: Props) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<IngredientFormValues>({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: initial
      ? {
          name: initial.name,
          categoryId: initial.categoryId,
          purchaseUnitId: initial.purchaseUnitId,
          purchasePrice: initial.purchasePrice,
          usageUnitId: initial.usageUnitId,
          conversionFactor: initial.conversionFactor,
          yieldPercentage: initial.yieldPercentage,
        }
      : { yieldPercentage: 100 },
  });

  const usageUnitId = watch('usageUnitId');
  const usageSymbol = units.find((u) => u.id === usageUnitId)?.symbol;

  // Preview en vivo (informativo) del costo neto por unidad de uso.
  const preview = useMemo(() => {
    return previewNetCostPerUsageUnit({
      purchasePrice: Number(watch('purchasePrice')),
      conversionFactor: Number(watch('conversionFactor')),
      yieldPercentage: Number(watch('yieldPercentage')),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch('purchasePrice'), watch('conversionFactor'), watch('yieldPercentage')]);

  const yieldPct = Number(watch('yieldPercentage'));
  const merma =
    Number.isFinite(yieldPct) && yieldPct > 0 && yieldPct <= 100
      ? (100 - yieldPct).toFixed(0)
      : null;

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex flex-col gap-4"
      noValidate
    >
      <FieldWrap label="Nombre" htmlFor="name" required error={errors.name?.message}>
        <TextInput
          id="name"
          placeholder="Lechuga romana"
          invalid={!!errors.name}
          {...register('name')}
        />
      </FieldWrap>

      <FieldWrap
        label="Categoría"
        htmlFor="categoryId"
        required
        error={errors.categoryId?.message}
      >
        <Select id="categoryId" invalid={!!errors.categoryId} {...register('categoryId')}>
          <option value="">Selecciona…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </FieldWrap>

      <fieldset className="rounded-md border border-border-base p-3">
        <legend className="px-1 text-xs font-medium text-text-muted">Compra</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FieldWrap
            label="Unidad de compra"
            htmlFor="purchaseUnitId"
            required
            error={errors.purchaseUnitId?.message}
          >
            <Select
              id="purchaseUnitId"
              invalid={!!errors.purchaseUnitId}
              {...register('purchaseUnitId')}
            >
              <option value="">Selecciona…</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.symbol})
                </option>
              ))}
            </Select>
          </FieldWrap>
          <FieldWrap
            label="Precio de compra"
            htmlFor="purchasePrice"
            required
            error={errors.purchasePrice?.message}
          >
            <TextInput
              id="purchasePrice"
              type="number"
              step="0.01"
              min="0"
              prefix="$"
              invalid={!!errors.purchasePrice}
              {...register('purchasePrice')}
            />
          </FieldWrap>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-border-base p-3">
        <legend className="px-1 text-xs font-medium text-text-muted">
          Uso / rendimiento
        </legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FieldWrap
            label="Unidad de uso"
            htmlFor="usageUnitId"
            required
            error={errors.usageUnitId?.message}
          >
            <Select
              id="usageUnitId"
              invalid={!!errors.usageUnitId}
              {...register('usageUnitId')}
            >
              <option value="">Selecciona…</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.symbol})
                </option>
              ))}
            </Select>
          </FieldWrap>
          <FieldWrap
            label="Factor de conversión"
            htmlFor="conversionFactor"
            required
            error={errors.conversionFactor?.message}
            hint="Unidades de uso contenidas en 1 unidad de compra (ej. 500 g por pieza). Puede cruzar dimensiones."
          >
            <TextInput
              id="conversionFactor"
              type="number"
              step="any"
              min="0"
              invalid={!!errors.conversionFactor}
              {...register('conversionFactor')}
            />
          </FieldWrap>
          <FieldWrap
            label="Rendimiento"
            htmlFor="yieldPercentage"
            required
            error={errors.yieldPercentage?.message}
            hint={merma ? `Merma ${merma}%` : 'Entre 0 y 100'}
          >
            <TextInput
              id="yieldPercentage"
              type="number"
              step="any"
              min="0"
              max="100"
              suffix="%"
              invalid={!!errors.yieldPercentage}
              {...register('yieldPercentage')}
            />
          </FieldWrap>
        </div>
      </fieldset>

      <PreviewLabel>
        Costo neto estimado:{' '}
        <span className="font-semibold tabular">
          {preview != null ? formatUnitCost(preview, usageSymbol) : '—'}
        </span>{' '}
        <span className="text-xs">(se confirma al guardar)</span>
      </PreviewLabel>

      {serverError && <Alert tone="danger">{serverError}</Alert>}

      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancelar
        </Button>
        <Button type="submit" loading={submitting}>
          Guardar
        </Button>
      </div>
    </form>
  );
}
