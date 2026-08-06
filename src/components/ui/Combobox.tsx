import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface ComboOption {
  value: string;
  label: string;
  /** Etiqueta secundaria (ej. tipo de renglón). */
  meta?: string;
}

interface Props {
  options: ComboOption[];
  onSelect: (option: ComboOption) => void;
  placeholder?: string;
  /** Al seleccionar, limpiar el campo (para agregar múltiples renglones). */
  clearOnSelect?: boolean;
  disabled?: boolean;
}

/**
 * Combobox/autocomplete accesible por teclado (↑↓, Enter, Esc).
 * Filtra por texto en `label`. Usado para agregar renglones de receta.
 */
export function Combobox({
  options,
  onSelect,
  placeholder = 'Buscar…',
  clearOnSelect = true,
  disabled,
}: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 50);
    return options.filter((o) => o.label.toLowerCase().includes(q)).slice(0, 50);
  }, [options, query]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => setActive(0), [query]);

  function choose(option: ComboOption) {
    onSelect(option);
    if (clearOnSelect) setQuery('');
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[active];
      if (opt) choose(opt);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        disabled={disabled}
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border border-border-base bg-surface px-3 text-sm text-text-strong placeholder:text-text-muted focus:border-primary disabled:bg-app"
      />
      {open && filtered.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border-base bg-surface py-1 shadow-lg"
        >
          {filtered.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm ${
                i === active ? 'bg-primary-soft text-text-strong' : 'text-text-base'
              }`}
            >
              <span>{o.label}</span>
              {o.meta && (
                <span className="ml-2 rounded bg-app px-1.5 py-0.5 text-xs text-text-muted">
                  {o.meta}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && query.trim() && filtered.length === 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-border-base bg-surface px-3 py-2 text-sm text-text-muted shadow-lg">
          Sin resultados para «{query}»
        </div>
      )}
    </div>
  );
}
