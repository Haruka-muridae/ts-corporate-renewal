import type { ReactNode } from "react";

type ButtonProps = Readonly<{
  children: ReactNode;
  href: "#consultation";
  variant?: "primary" | "secondary";
}>;

const variants = {
  primary:
    "border-[var(--color-navy)] bg-[var(--color-navy)] text-white hover:border-[var(--color-gold)] hover:bg-[var(--color-gold)] hover:text-[var(--color-navy-dark)]",
  secondary:
    "border-[var(--color-gold)] bg-white text-[var(--color-navy)] hover:bg-[var(--color-gold-pale)]",
} as const;

export function Button({ children, href, variant = "primary" }: ButtonProps) {
  return (
    <a
      className={`inline-flex min-h-11 items-center justify-center rounded-sm border px-6 py-3 text-base font-semibold no-underline transition-colors duration-200 ${variants[variant]}`}
      href={href}
    >
      {children}
    </a>
  );
}
