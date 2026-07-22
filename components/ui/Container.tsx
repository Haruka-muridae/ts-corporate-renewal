import type { ReactNode } from "react";

type ContainerProps = Readonly<{
  children: ReactNode;
  className?: string;
}>;

export function Container({ children, className = "" }: ContainerProps) {
  return (
    <div
      className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`.trim()}
    >
      {children}
    </div>
  );
}
