/** Message ids as people and agents quote them, and the page each one links to. */

const INT64_MAX = 9_223_372_036_854_775_807n;
const ID = /^[1-9]\d{0,18}$/;

/** The id when `raw` is a message id as written, digits with no leading zero and within `bigint` range; otherwise null. */
export function parseMessageRef(raw: string): bigint | null {
  if (!ID.test(raw)) {
    return null;
  }
  const id = BigInt(raw);
  return id <= INT64_MAX ? id : null;
}

export function messageHref(id: string): string {
  return `/m/${id}`;
}
