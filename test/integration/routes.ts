import { devUser, type Person } from "./database.ts";

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

export interface Call<P> {
  as: Person;
  path: string;
  params?: P;
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Invokes a route handler the way Next does, authenticated with the development header. */
export async function call<P>(handler: Handler<P>, { as, path, params, method = "GET", body, signal, headers = {} }: Call<P>): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "x-dev-user": devUser(as), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal })
  });
  return await handler(request, { params: Promise.resolve((params ?? {}) as P) });
}

export async function jsonOf<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
