/**
 * Entry point for the slides plugin's `scripts/slides`: routes a subcommand and prints its result. Every run of a
 * command prints one JSON object on stdout: the result (exit 0), `{errors}` for anything the caller can put right,
 * such as the outline, the arguments, where the deck goes or a picture it uses (exit 2), or `{error}` for a fault in
 * the script itself (exit 1).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DeckError, writeDeck } from "./build.ts";
import { fail, say, UsageError } from "./io.ts";
import { layoutSummary } from "./masters.ts";
import { OutlineError, validateOutline } from "./outline.ts";

function readOutline(file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    fail(`cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

export async function buildCmd(argv: string[]): Promise<unknown> {
  const outAt = argv.indexOf("--out");
  const out = outAt === -1 ? undefined : argv[outAt + 1];
  const rest = outAt === -1 ? argv : argv.filter((_, i) => i !== outAt && i !== outAt + 1);
  if (rest.length !== 1) {
    fail("give one outline file");
  }
  if (!out || out.startsWith("--")) {
    fail("--out <file.pptx> is required");
  }
  if (!out.toLowerCase().endsWith(".pptx")) {
    fail("--out must name a .pptx file");
  }
  const file = resolve(rest[0]);
  const { outline, warnings } = validateOutline(readOutline(file), dirname(file));
  for (const warning of warnings) {
    say(`warning: ${warning}`);
  }
  const path = resolve(out);
  const { slides } = await writeDeck(outline, dirname(file), path);
  say(`wrote ${slides} slide(s) to ${path}`);
  return { out: path, slides, warnings };
}

export async function layoutsCmd(): Promise<unknown> {
  return { layouts: layoutSummary() };
}

const COMMANDS: Record<string, { usage: string; run: (argv: string[]) => Promise<unknown> }> = {
  build: { usage: "build <outline.json> --out <file.pptx>", run: buildCmd },
  layouts: { usage: "layouts", run: layoutsCmd }
};

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || !COMMANDS[command]) {
    say("Usage: slides <command> [options]\n");
    for (const c of Object.values(COMMANDS)) {
      say(`  ${c.usage}`);
    }
    if (command && command !== "--help" && command !== "-h") {
      print({ errors: [`there is no command ${command}`] });
      process.exitCode = 2;
    }
    return;
  }
  try {
    print(await COMMANDS[command].run(rest));
  } catch (err) {
    if (err instanceof OutlineError) {
      say(`slides ${command}: ${err.message}`);
      print({ errors: err.problems });
    } else if (err instanceof DeckError) {
      say(`slides ${command}: ${err.message}`);
      print({ errors: [err.message] });
    } else if (err instanceof UsageError) {
      say(`slides ${command}: ${err.message}\n  usage: slides ${COMMANDS[command].usage}`);
      print({ errors: [err.message] });
    } else {
      throw err;
    }
    process.exitCode = 2;
  }
}

main().catch((err) => {
  say(err instanceof Error ? (err.stack ?? err.message) : String(err));
  print({ error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
