import { z } from "zod";

export interface BoundedArrayOptions<S extends z.ZodType> {
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
 * An array schema that checks its length before it validates its elements, and whose refinement is given the parsed
 * elements.
 *
 * `z.array(element).max(n)` does the same on its own from zod 4.6.6, the release that fixes GHSA-mrhx-c7xc-m3w5: an
 * array over the cap answers with the one `too_big` and no element is parsed. What this helper still is, is the one
 * place a request body says its cap, its minimum and its element refinement together, which is what
 * `bounded-array.test.ts` holds every body in `src` to.
 *
 * The mechanism: counting an array of `z.unknown()` first costs one issue whatever the length, because `z.unknown()`
 * cannot fail, and `pipe` does not run its output schema for an input that failed — so the refinement inside the pipe
 * is reached only for a list that is already the right length, with its elements their parsed type.
 */
export function boundedArray<S extends z.ZodType>(
  element: S,
  max: number,
  { min, message, refine }: BoundedArrayOptions<S> = {}
): z.ZodType<z.output<S>[], z.input<S>[]> {
  const counted = z.array(z.unknown()).max(max, message);
  const elements = refine === undefined ? z.array(element) : z.array(element).refine(refine.check, refine.message);
  const schema = (min === undefined ? counted : counted.min(min)).pipe(elements);
  // The pipe's own input type is `unknown[]`, which would stop TypeScript checking a `default` or a `transform` built
  // on the result. Narrowing it to the element's input type is sound: those are the values the schema accepts.
  return schema as unknown as z.ZodType<z.output<S>[], z.input<S>[]>;
}
