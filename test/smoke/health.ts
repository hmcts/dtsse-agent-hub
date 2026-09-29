/** The pipeline's smoke and functional stages: the deployed service answers `/health` with UP. */
async function smoke(): Promise<number> {
  const base = process.env.TEST_URL ?? "http://localhost:3000";
  const response = await fetch(new URL("/health", base));
  const body = (await response.json().catch(() => ({}))) as { status?: string };

  if (response.status !== 200 || body.status !== "UP") {
    console.error(`${base}/health answered ${response.status} ${JSON.stringify(body)}`);
    return 1;
  }
  console.info(`${base}/health is UP`);
  return 0;
}

void smoke().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
