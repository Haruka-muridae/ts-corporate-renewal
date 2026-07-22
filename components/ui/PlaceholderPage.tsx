type PlaceholderPageProps = Readonly<{
  title: string;
}>;

export function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-5 py-20 sm:px-8">
      <div className="w-full border-l-2 border-[var(--color-gold)] pl-5 sm:pl-8">
        <p className="mb-2 text-sm tracking-[0.18em] text-[var(--color-text-muted)]">
          Potenitas
        </p>
        <h1 className="text-3xl font-semibold text-[var(--color-navy)] sm:text-4xl">
          {title}
        </h1>
        <p className="mt-6 text-base text-[var(--color-text-muted)]">TODO</p>
      </div>
    </main>
  );
}
