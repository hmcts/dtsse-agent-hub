/**
 * Whether a string is a UUID, which every agent, virtual agent and Assistant row id is. Pure and importing nothing,
 * so the proxy can check an address with the same rule the routes use without bundling a store.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
