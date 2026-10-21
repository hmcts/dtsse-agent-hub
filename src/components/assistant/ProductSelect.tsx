"use client";

import { useId } from "react";
import { PRODUCTS } from "@/assistant/products";

/** The labelled product picker of the empty chat, styled as one field with its label inside. */
export function ProductSelect({ value, onChange }: { value: string; onChange: (product: string) => void }) {
  const id = useId();
  return (
    <div className="flex w-full max-w-[640px] items-center overflow-hidden rounded-xl border border-asst-line bg-asst-raised focus-within:border-asst-accent-line">
      <label htmlFor={id} className="shrink-0 border-r border-asst-strong py-3 pl-4 pr-3.5 text-sm font-medium">
        Product
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 cursor-pointer appearance-none bg-transparent py-3 pl-3.5 pr-10 text-sm text-asst-text outline-none"
        style={{
          backgroundImage: "linear-gradient(45deg,transparent 50%,oklch(0.78 0.12 185) 50%),linear-gradient(135deg,oklch(0.78 0.12 185) 50%,transparent 50%)",
          backgroundPosition: "calc(100% - 20px) 50%,calc(100% - 15px) 50%",
          backgroundSize: "5px 5px",
          backgroundRepeat: "no-repeat"
        }}
      >
        {PRODUCTS.map((product) => (
          <option key={product.slug} value={product.slug} className="bg-asst-raised">
            {product.label}
          </option>
        ))}
      </select>
    </div>
  );
}
