interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Etiqueta cuando checked === false. */
  offLabel: string;
  /** Etiqueta cuando checked === true. */
  onLabel: string;
  id?: string;
}

/** Toggle segmentado de dos estados (usado para isSubRecipe). */
export function Toggle({ checked, onChange, offLabel, onLabel, id }: Props) {
  return (
    <div
      id={id}
      role="group"
      className="inline-flex rounded-md border border-border-base bg-app p-0.5 text-sm"
    >
      <button
        type="button"
        aria-pressed={!checked}
        onClick={() => onChange(false)}
        className={`rounded px-3 py-1 font-medium transition-colors ${
          !checked ? 'bg-surface text-text-strong shadow-card' : 'text-text-muted'
        }`}
      >
        {offLabel}
      </button>
      <button
        type="button"
        aria-pressed={checked}
        onClick={() => onChange(true)}
        className={`rounded px-3 py-1 font-medium transition-colors ${
          checked ? 'bg-surface text-text-strong shadow-card' : 'text-text-muted'
        }`}
      >
        {onLabel}
      </button>
    </div>
  );
}
