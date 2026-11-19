/** Orders strings by code point, which is what a plain sort over names should mean and is the same on every machine. */
export function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
