import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  ReactNode,
} from 'react';
import { forwardRef } from 'react';

interface FieldWrapProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
}

export function FieldWrap({
  label,
  htmlFor,
  required,
  error,
  hint,
  children,
}: FieldWrapProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-text-base">
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-text-muted">{hint}</p>}
      {error && (
        <p className="flex items-center gap-1 text-xs text-danger" role="alert">
          <span aria-hidden="true">⚠</span>
          {error}
        </p>
      )}
    </div>
  );
}

const baseInput =
  'h-9 w-full rounded-md border bg-surface px-3 text-sm text-text-strong placeholder:text-text-muted focus:border-primary disabled:bg-app disabled:text-text-muted';

interface TextProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  prefix?: string;
  suffix?: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextProps>(
  ({ invalid, prefix, suffix, className = '', ...rest }, ref) => {
    const border = invalid ? 'border-danger' : 'border-border-base';
    if (prefix || suffix) {
      return (
        <div
          className={`flex h-9 items-center rounded-md border bg-surface ${border} focus-within:border-primary`}
        >
          {prefix && (
            <span className="pl-3 text-sm text-text-muted">{prefix}</span>
          )}
          <input
            ref={ref}
            {...rest}
            className={`h-full w-full bg-transparent px-2 text-sm text-text-strong tabular placeholder:text-text-muted focus:outline-none ${className}`}
          />
          {suffix && (
            <span className="pr-3 text-sm text-text-muted">{suffix}</span>
          )}
        </div>
      );
    }
    return (
      <input
        ref={ref}
        {...rest}
        className={`${baseInput} ${border} ${className}`}
      />
    );
  },
);
TextInput.displayName = 'TextInput';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ invalid, className = '', children, ...rest }, ref) => {
    const border = invalid ? 'border-danger' : 'border-border-base';
    return (
      <select
        ref={ref}
        {...rest}
        className={`${baseInput} ${border} ${className}`}
      >
        {children}
      </select>
    );
  },
);
Select.displayName = 'Select';
