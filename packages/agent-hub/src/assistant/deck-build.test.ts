// A deck build against the mock hub's real pod routes, with a fake in place of the slides plugin's script.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import { createApi } from "../api.ts";
import {
  BUILD_BUDGET_MS,
  buildFailure,
  createDeckBuildRunner,
  type DeckBuildDeps,
  NOT_LOADED,
  parseDeckBuildFrame,
  runDeckBuild,
  TOO_SLOW
} from "./deck-build.ts";
import type { RunResult } from "./lookups.ts";

const VID = "va-decks";
const LAUNCH = `launch-${"d".repeat(16)}`;
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
const CONVERSATION = "0f8a6a1e-0000-4000-8000-0000000000c1";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");
const PPTX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9]);

let hub: MockHub;
let url: string;
let jobs = 0;

beforeAll(async () => {
  hub = createMockHub({ launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
  url = await hub.listen();
});

afterAll(async () => {
  await hub.close();
});

const OUTLINE = {
  title: "Ways of working",
  slides: [
    { id: "why", layout: "HMCTS_SECTION", title: "Why" },
    { id: "pic", layout: "HMCTS_IMAGE", title: "Pipeline", image: { asset: `sha256:${PNG_SHA}`, alt: "Five stages" } }
  ]
};

/** A build the mock hub holds for the pod, and its frame. */
function asked(version = 3): { job_id: string; conversation_id: string; version: number } {
  jobs += 1;
  const jobId = `6c1f8d2b-1111-4222-8333-${String(jobs).padStart(12, "0")}`;
  hub.deckBuilds.set(jobId, { virtualId: VID, conversation_id: CONVERSATION, version, outline: OUTLINE, assets: { [PNG_SHA]: PNG }, answered: false });
  return { job_id: jobId, conversation_id: CONVERSATION, version };
}

const answerOf = (jobId: string) => hub.deckBuildAnswers.find((answer) => answer.job_id === jobId);

type Call = { cmd: string; args: string[]; timeoutMs: number; outline: Record<string, any> | null; picture: boolean };

function deps(run: (call: Call) => Promise<RunResult> | RunResult, overrides: Partial<DeckBuildDeps> = {}): { deps: DeckBuildDeps; calls: Call[] } {
  const calls: Call[] = [];
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "deck-ws-"));
  return {
    calls,
    deps: {
      api: createApi({ baseUrl: url, launchToken: LAUNCH }),
      id: VID,
      env: { AGENT_HUB_PLUGINS: "slides" },
      workspace,
      install: () => path.join(workspace, "..", "slides-copy"),
      run: async (cmd, args, opts) => {
        const file = args[1] ?? "";
        const outline = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
        const picturePath = outline?.slides?.[1]?.image?.path;
        const picture = typeof picturePath === "string" && fs.readFileSync(path.resolve(path.dirname(file), picturePath)).equals(PNG);
        const call = { cmd, args, timeoutMs: opts.timeoutMs, outline, picture };
        calls.push(call);
        return await run(call);
      },
      ...overrides
    }
  };
}

describe("runDeckBuild", () => {
  it("should build the version with the slides plugin's script, its pictures beside the outline, and send the .pptx", async () => {
    // Arrange
    const frame = asked();
    const { deps: d, calls } = deps(({ args }) => {
      fs.writeFileSync(args[3] as string, PPTX);
      return { code: 0, stdout: JSON.stringify({ out: args[3] }), stderr: "" };
    });

    // Act
    await runDeckBuild(d, frame);

    // Assert
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.cmd).toBe(path.join(d.workspace, "..", "slides-copy", "scripts", "slides"));
    expect(call?.args).toEqual(["build", expect.stringMatching(/outline\.json$/), "--out", expect.stringMatching(/deck\.pptx$/)]);
    expect(call?.timeoutMs).toBeLessThanOrEqual(BUILD_BUDGET_MS);
    expect(call?.outline?.slides[1].image).toEqual({ path: `assets/${PNG_SHA}.png`, alt: "Five stages" });
    expect(call?.picture).toBe(true);
    expect(answerOf(frame.job_id)).toEqual({ virtual_id: VID, job_id: frame.job_id, pptx: PPTX });
    // The working directory goes with the build.
    expect(fs.existsSync(path.dirname(call?.args[1] as string))).toBe(false);
  });

  it("should answer with the problems the script printed when it exits 2", async () => {
    // Arrange
    const frame = asked();
    const { deps: d } = deps(() => ({
      code: 2,
      stdout: JSON.stringify({ errors: ["slide 2: the picture is missing", "slide 3: too many bullets"] }),
      stderr: ""
    }));

    // Act
    await runDeckBuild(d, frame);

    // Assert
    expect(answerOf(frame.job_id)).toEqual({
      virtual_id: VID,
      job_id: frame.job_id,
      error: "This version could not be built: slide 2: the picture is missing; slide 3: too many bullets"
    });
  });

  it("should say the build took too long when the script runs past its time", async () => {
    // Arrange
    const frame = asked();
    let now = 0;
    const { deps: d, calls } = deps(
      ({ timeoutMs }) => {
        now += timeoutMs;
        return { code: 1, stdout: "", stderr: "" };
      },
      { clock: () => now, budgetMs: 60_000 }
    );

    // Act
    await runDeckBuild(d, frame);

    // Assert
    expect(calls[0]?.timeoutMs).toBe(60_000);
    expect(answerOf(frame.job_id)?.error).toBe(TOO_SLOW);
  });

  it("should not run anything when the owner has not ticked the slides plugin", async () => {
    // Arrange
    const frame = asked();
    const { deps: d, calls } = deps(() => ({ code: 0, stdout: "{}", stderr: "" }), { env: { AGENT_HUB_PLUGINS: "welsh" } });

    // Act
    await runDeckBuild(d, frame);

    // Assert
    expect(calls).toEqual([]);
    expect(answerOf(frame.job_id)?.error).toBe(NOT_LOADED);
  });

  it("should answer with why when the hub no longer has the build to read", async () => {
    // Arrange
    const frame = { job_id: "6c1f8d2b-1111-4222-8333-999999999999", conversation_id: CONVERSATION, version: 2 };
    const { deps: d, calls } = deps(() => ({ code: 0, stdout: "{}", stderr: "" }));

    // Act
    await runDeckBuild(d, frame);

    // Assert
    expect(calls).toEqual([]);
    expect(answerOf(frame.job_id)?.error).toMatch(/^This version could not be built: /);
  });

  it("should refuse a build whose version is not the one the frame named", async () => {
    // Arrange
    const frame = { ...asked(5), version: 6 };
    const { deps: d, calls } = deps(() => ({ code: 0, stdout: "{}", stderr: "" }));

    // Act
    await runDeckBuild(d, frame);

    // Assert
    expect(calls).toEqual([]);
    expect(answerOf(frame.job_id)?.error).toMatch(/different version/);
  });

  it("should say so when the script ends well but writes no deck", async () => {
    // Arrange
    const frame = asked();
    const { deps: d } = deps(() => ({ code: 0, stdout: "{}", stderr: "" }));

    // Act
    await runDeckBuild(d, frame);

    // Assert
    expect(answerOf(frame.job_id)?.error).toMatch(/without writing the deck/);
  });

  it("should refuse to send a deck larger than the hub keeps", async () => {
    // Arrange
    const frame = asked();
    const { deps: d } = deps(({ args }) => {
      fs.writeFileSync(args[3] as string, Buffer.concat([PPTX, Buffer.alloc(5 * 1024 * 1024)]));
      return { code: 0, stdout: "{}", stderr: "" };
    });

    // Act
    await runDeckBuild(d, frame);

    // Assert
    expect(answerOf(frame.job_id)?.error).toMatch(/more than the 5242880 bytes/);
  });

  it("should say it could not answer, and not throw, when the hub refuses the answer", async () => {
    // Arrange
    const said: string[] = [];
    const frame = asked();
    const { deps: d } = deps(() => ({ code: 2, stdout: JSON.stringify({ errors: ["x".repeat(3000)] }), stderr: "" }), {
      say: (message) => said.push(message),
      api: { ...createApi({ baseUrl: url, launchToken: LAUNCH }), putDeckBuild: async () => Promise.reject(new Error("hub down")) }
    });

    // Act
    await runDeckBuild(d, frame);

    // Assert
    expect(said).toEqual([`deck build ${frame.job_id}: could not answer it: hub down`]);
  });
});

describe("buildFailure", () => {
  it("should say the tools could not start when the script is not there", () => {
    expect(buildFailure("", "", 127)).toMatch(/could not start the slides tools/);
  });

  it("should give the script's own error for a fault in it", () => {
    expect(buildFailure(JSON.stringify({ error: "boom" }), "", 1)).toBe("The slides tools failed: boom");
  });

  it("should give the last line the script said when it printed nothing to read", () => {
    expect(buildFailure("not json", "slides: installing\nnpm ERR! network\n    at somewhere", 1)).toBe("The slides tools stopped: npm ERR! network");
    expect(buildFailure("", "", 1)).toBe("The slides tools stopped (exit 1). Try again.");
  });

  it("should keep a long list of problems to the hub's 2000 characters", () => {
    const text = buildFailure(JSON.stringify({ errors: ["y".repeat(5000)] }), "", 2);
    expect(text).toHaveLength(2000);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("parseDeckBuildFrame", () => {
  const good = { job_id: "6c1f8d2b-1111-4222-8333-444455556666", conversation_id: CONVERSATION, version: 4 };

  it("should take a frame with a job, a conversation and a version", () => {
    expect(parseDeckBuildFrame({ ...good, extra: true })).toEqual(good);
  });

  it.each([
    ["not an object", "build"],
    ["an array", [good]],
    ["a job id that is not a uuid", { ...good, job_id: "../x" }],
    ["a conversation id that is not a uuid", { ...good, conversation_id: "c1" }],
    ["a version that is not whole", { ...good, version: 1.5 }],
    ["a version of 0", { ...good, version: 0 }],
    ["a version as text", { ...good, version: "4" }]
  ])("should refuse %s", (_label, value) => {
    expect(parseDeckBuildFrame(value)).toBeNull();
  });
});

describe("createDeckBuildRunner", () => {
  it("should run builds one at a time in the order they came, and ignore a frame that is not one", async () => {
    // Arrange
    const said: string[] = [];
    const first = asked();
    const second = asked();
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const { deps: d } = deps(
      async ({ args }) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(args[1] as string);
        running -= 1;
        return { code: 2, stdout: JSON.stringify({ errors: ["nope"] }), stderr: "" };
      },
      { say: (message) => said.push(message) }
    );
    const runner = createDeckBuildRunner(d);

    // Act
    runner.deckBuild(first);
    runner.deckBuild({ job_id: "nope" });
    runner.deckBuild(second);
    await runner.idle();

    // Assert
    expect(most).toBe(1);
    expect(order).toHaveLength(2);
    expect(answerOf(first.job_id)?.error).toMatch(/nope/);
    expect(answerOf(second.job_id)?.error).toMatch(/nope/);
    expect(said).toEqual([`ignoring a deck build that is not one: ${JSON.stringify({ job_id: "nope" })}`]);
  });

  it("should take the time a build waited behind another out of its own", async () => {
    // Arrange
    let now = 0;
    const first = asked();
    const second = asked();
    const { deps: d, calls } = deps(
      () => {
        now += 1000;
        return { code: 2, stdout: JSON.stringify({ errors: ["x"] }), stderr: "" };
      },
      { clock: () => now, budgetMs: 10_000 }
    );
    const runner = createDeckBuildRunner(d);

    // Act
    runner.deckBuild(first);
    runner.deckBuild(second);
    await runner.idle();

    // Assert
    expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 9_000]);
  });
});
