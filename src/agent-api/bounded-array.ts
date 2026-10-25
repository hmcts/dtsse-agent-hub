import { z } from "zod";

export interface BoundedArrayOptions<S extends z.ZodTypeAny> {
  min?: number;
  message?: string;
  /**
   * Checked on the parsed elements, inside the pipe. A refinement chained onto the result instead would run on the
   * *unparsed* input whenever the length check failed, because that is what `pipe` passes on, and would throw rather
   * than refuse as soon as it touched an element as its parsed type.
   */
  refine?: { check: (values: z.output<S>[]) => boolean; message: string };
}

/**
 * An array schema that checks its length before it validates its elements.
 *
 * `z.array(element).max(n)` does the opposite: it parses every element first and applies the length check afterwards,
 * accumulating one issue per failing element however long the array is. A single request body within the
 * `MAX_REQUEST_BYTES` cap is then enough to allocate hundreds of megabytes, which is zod advisory
 * GHSA-mrhx-c7xc-m3w5, unfixed in the zod 3 line this app pins.
 *
 * Counting an array of `z.unknown()` first costs one issue whatever the length, because `z.unknown()` cannot fail. An
 * array already over the cap is still walked: `ZodArray._parse` records the `too_big` and then maps every element
 * through `z.unknown()` anyway, so what this bounds is the issues and the element schema's work, not the one pass
 * over the input. `pipe` is what stops there — it does not run its output schema for an input that failed.
 */
export function boundedArray<S extends z.ZodTypeAny>(
  element: S,
  max: number,
  { min, message, refine }: BoundedArrayOptions<S> = {}
): z.ZodType<z.output<S>[], z.ZodTypeDef, z.input<S>[]> {
  const counted = z.array(z.unknown()).max(max, message);
  const elements = refine === undefined ? z.array(element) : z.array(element).refine(refine.check, refine.message);
  const schema = (min === undefined ? counted : counted.min(min)).pipe(elements);
  // The pipe's own input type is `unknown[]`, which would stop TypeScript checking a `default` or a `transform` built
  // on the result. Narrowing it to the element's input type is sound: those are the values the schema accepts.
  return schema as unknown as z.ZodType<z.output<S>[], z.ZodTypeDef, z.input<S>[]>;
}
