import type { ReactNode } from "react";

type ButtonProps = Readonly<{
  children: ReactNode;
  href: string;
  variant?: "primary" | "secondary";
}>;

const variants = {
  primary: "bg-slate-950 text-white",
  secondary: "border border-slate-300 bg-white text-slate-950",
} as const;

export function Button({ children, href, variant = "primary" }: ButtonProps) {
  return (
    <a
      className={`inline-flex min-h-11 items-center justify-center rounded px-5 py-2 text-sm font-medium ${variants[variant]}`}
      href={href}
    >
      {children}
    </a>
  );
}
