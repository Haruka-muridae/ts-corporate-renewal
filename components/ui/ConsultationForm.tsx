"use client";

import { useState } from "react";

import type { ConsultationFormContent } from "@/types/lp";

type ConsultationFormProps = Readonly<{
  content: ConsultationFormContent;
}>;

export function ConsultationForm({ content }: ConsultationFormProps) {
  const [status, setStatus] = useState("");

  return (
    <form
      id={content.id}
      action="#consultation"
      method="get"
      className="rounded-sm border border-[var(--color-gold-dark)] bg-white p-5 text-left text-[var(--color-text)] sm:p-8"
      aria-describedby={`${content.id}-notice`}
      onSubmit={(event) => {
        event.preventDefault();
        setStatus(content.developmentMessage);
      }}
    >
      <h3 className="text-xl font-semibold text-[var(--color-navy)] sm:text-2xl">
        {content.heading}
      </h3>
      <p
        id={`${content.id}-notice`}
        className="mt-3 border-l-2 border-[var(--color-gold)] pl-4 text-base leading-7 text-[var(--color-text-muted)]"
      >
        {content.notice}
      </p>

      <div className="mt-7 grid gap-6 md:grid-cols-2">
        {content.fields.map((field) => (
          <div
            key={field.id}
            className={field.kind === "textarea" ? "md:col-span-2" : ""}
          >
            <label
              htmlFor={field.id}
              className="block text-base font-semibold text-[var(--color-navy)]"
            >
              {field.label}
            </label>
            {field.kind === "textarea" ? (
              <textarea
                id={field.id}
                required={field.required}
                rows={4}
                className="mt-2 block min-h-28 w-full resize-y rounded-sm border border-[var(--color-border-strong)] bg-white px-4 py-3 text-base leading-7 text-[var(--color-text)]"
              />
            ) : (
              <input
                id={field.id}
                type="text"
                required={field.required}
                autoComplete={field.autoComplete}
                className="mt-2 block min-h-12 w-full rounded-sm border border-[var(--color-border-strong)] bg-white px-4 py-3 text-base text-[var(--color-text)]"
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-8">
        <button
          type="submit"
          className="min-h-11 rounded-sm border border-[var(--color-gold)] bg-[var(--color-gold)] px-6 py-3 text-base font-semibold text-[var(--color-navy-dark)] transition-colors duration-200 hover:bg-[var(--color-gold-light)]"
        >
          {content.submitLabel}
        </button>
      </div>
      <p className="mt-4 min-h-7 text-base leading-7 text-[var(--color-navy)]" role="status" aria-live="polite">
        {status}
      </p>
    </form>
  );
}
