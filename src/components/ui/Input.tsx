import { InputHTMLAttributes, forwardRef, useId } from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

/**
 * Input — text/email/password field with optional label and error state.
 * Usage: <Input label="Email" type="email" error={errors.email} {...register} />
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, id, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-foreground">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className={cn(
            "h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground",
            "placeholder:text-foreground-subtle",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            "disabled:opacity-50 disabled:pointer-events-none",
            error
              ? "border-rose-500 focus-visible:ring-rose-500"
              : "border-border-strong",
            className
          )}
          {...props}
        />
        {error && (
          <p id={`${inputId}-error`} className="text-xs text-rose-600">
            {error}
          </p>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";
