import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { CHECKBOX_CLASS, INPUT_CLASS, SELECT_CLASS, buttonClass, type ButtonKind, type ButtonSize } from "@/lib/brand-ui";

/**
 * The shared chrome controls (DECISIONS #7, docs/design/DESIGN.md). Thin
 * wrappers over the lib/brand-ui recipes that /styleguide shows, so a page
 * gets the brand look in light, night and tv by using them. Semantics stay
 * native: a Button is a <button>, a Select is a <select>.
 */

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { kind?: ButtonKind; size?: ButtonSize }
>(function Button({ kind = "secondary", size = "md", className = "", type = "button", ...rest }, ref) {
  return <button ref={ref} type={type} className={buttonClass(kind, size, className)} {...rest} />;
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = "", ...rest },
  ref,
) {
  return <input ref={ref} className={`${INPUT_CLASS} ${className}`.trim()} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = "", ...rest },
  ref,
) {
  return <select ref={ref} className={`${SELECT_CLASS} ${className}`.trim()} {...rest} />;
});

/** A checkbox with its label as one 44px row (36px from sm). */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }
>(function Checkbox({ label, className = "", disabled, ...rest }, ref) {
  return (
    <label className={`flex min-h-11 items-center gap-2 text-gh-sm sm:min-h-8 ${disabled ? "text-muted" : "text-ink"} ${className}`.trim()}>
      <input ref={ref} type="checkbox" disabled={disabled} className={CHECKBOX_CLASS} {...rest} />
      {label}
    </label>
  );
});
