/**
 * What a message may carry. The agent API's schemas and the web UI's server actions both check against these, so
 * neither path accepts a message the other would refuse.
 */

export const MAX_TITLE = 300;
export const MAX_BODY = 32_000;

const DIGITS = /^\d{1,19}$/;
const MAX_MESSAGE_ID = 9_223_372_036_854_775_807n;

/**
 * A message id written in decimal, or `undefined` when it is not one. Ids are a Postgres `bigint`, so nineteen digits
 * past its maximum are refused here rather than by the database.
 */
export function messageIdOf(value: string): bigint | undefined {
  if (!DIGITS.test(value)) {
    return undefined;
  }
  const id = BigInt(value);
  return id > MAX_MESSAGE_ID ? undefined : id;
}
