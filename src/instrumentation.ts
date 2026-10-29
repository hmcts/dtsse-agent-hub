/**
 * Next calls `register` in the Edge runtime as well as Node. Everything the hub starts needs Node, so it is imported
 * only there: a top-level Node import here fails the Edge build, and in development that failure reloads every open
 * page whenever it recompiles.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register: registerNode } = await import("./instrumentation-node.ts");
    await registerNode();
  }
}
