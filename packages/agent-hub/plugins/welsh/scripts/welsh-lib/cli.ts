/**
 * Entry point for the welsh plugin's `scripts/welsh`: routes a subcommand and prints its result.
 *
 * No subcommand produces Welsh text of its own. Welsh comes from a catalogue
 * row or a Welsh Language Unit return, and `verify` proves it.
 */

import { applyCmd } from "./commands/apply.ts";
import { importLegacyCmd, infoCmd, init, searchCmd } from "./commands/catalogue.ts";
import { importCmd } from "./commands/import.ts";
import { scanCmd } from "./commands/scan.ts";
import { storyCmd } from "./commands/story.ts";
import { verifyCmd } from "./commands/verify.ts";
import { say, UsageError } from "./io.ts";

const COMMANDS: Record<string, { usage: string; run: (argv: string[]) => Promise<unknown> }> = {
  init: { usage: "init --service <product>", run: init },
  info: { usage: "info --service <product>", run: infoCmd },
  search: { usage: "search <text> --service <product> [--exact|--fuzzy] [--all]", run: searchCmd },
  "import-legacy": {
    usage: "import-legacy --service <product> [--xlsx <file>]... [--json <file>]... [--received YYYY-MM-DD]",
    run: importLegacyCmd
  },
  scan: { usage: "scan --service <product> [--repo <clone>] [--adapter <name>]... [--request] [--out <file.xlsx>]", run: scanCmd },
  story: {
    usage: "story <JIRA-KEY> --service <product> [--strings <file> | --candidates | --refresh] [--choose REF=ROW-ID]... [--write [--out <file.xlsx>]]",
    run: storyCmd
  },
  import: { usage: "import <returned.xlsx> --service <product> [--dry-run] [--pr] [--queries-out <file.xlsx>]", run: importCmd },
  apply: {
    usage: "apply --service <product> --from catalogue|<returned.xlsx> [--repo <clone>] [--choose REF=ROW-ID]... [--dry-run] [--test] [--pr]",
    run: applyCmd
  },
  verify: { usage: "verify --service <product> [--repo <clone>] [--base <rev>] [--return <file.xlsx>]...", run: verifyCmd }
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || !COMMANDS[command]) {
    say("Usage: welsh <command> [options]\n");
    for (const c of Object.values(COMMANDS)) {
      say(`  ${c.usage}`);
    }
    process.exitCode = command && command !== "--help" && command !== "-h" ? 2 : 0;
    return;
  }
  try {
    const result = await COMMANDS[command].run(rest);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    if (!(err instanceof UsageError)) {
      throw err;
    }
    say(`welsh ${command}: ${err.message}\n  usage: welsh ${COMMANDS[command].usage}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  say(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
