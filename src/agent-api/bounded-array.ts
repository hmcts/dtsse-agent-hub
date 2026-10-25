import { z } from "zod";

/**
 * An array schema that checks its length before it validates its elements.
 *
 * `z.array(element).max(n)` does the opposite: it parses every element first and applies the length check afterwards,
 * accumulating one issue per failing element however long the array is. A single request body within the
 * `MAX_REQUEST_BYTES` cap is then enough to allocate hundreds of megabytes, which is zod advisory
 * GHSA-mrhx-c7xc-m3w5, unfixed in the zod 3 line this app pins. Counting an array of `z.unknown()` first costs one
 * issue whatever the length, because `z.unknown()` cannot fail, and a length that is already out of range stops the
 * parse before any element is looked at.
 *
 * Length checks go on the outer array and everything else — `transform`, `refine`, `optional` — after the pipe, which
 * is where the element issues surface. Their paths are unchanged: an element's issue still carries its index.
 */
export function boundedArray<S extends z.ZodTypeAny>(
  element: S,
  max: number,
  { min, message }: { min?: number; message?: string } = {}
): z.ZodPipeline<z.ZodArray<z.ZodUnknown>, z.ZodArray<S>> {
  const counted = z.array(z.unknown()).max(max, message);
  return (min === undefined ? counted : counted.min(min)).pipe(z.array(element));
}
