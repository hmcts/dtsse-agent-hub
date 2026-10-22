// The lifecycle vocabulary and the pod's own state directory. The workspace suite exercised these only
// through the commands that use them; they are pinned directly here because a wrong phase name or a
// world-readable state directory is not visible in any of those assertions.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import { usePodEnv } from "../__fixtures__/pod-shims.ts";
import { EXIT_FATAL, EXIT_NO_CREDENTIAL, FatalError, isVirtualPhase, PHASES, say, virtualStateDir } from "./phases.ts";

let home: TempClaudeHome;
let restoreEnv: () => void;

beforeAll(() => {
  home = tempClaudeHome();
  restoreEnv = usePodEnv(home);
});

afterAll(() => {
  restoreEnv();
  home.cleanup();
});

describe("PHASES", () => {
  it("should name the six phases the hub accepts in the order the pod moves through them", () => {
    // Act & Assert
    expect([...PHASES]).toEqual(["provisioning", "awaiting_credentials", "awaiting_login", "cloning", "running", "failed"]);
  });
});

describe("isVirtualPhase", () => {
  it("should accept every phase the hub accepts when given one of them", () => {
    // Act & Assert
    expect(PHASES.every((phase) => isVirtualPhase(phase))).toBe(true);
  });

  it("should refuse anything that is not a phase when given a near miss or a non-string", () => {
    // Act & Assert
    expect(isVirtualPhase("dancing")).toBe(false);
    expect(isVirtualPhase("Running")).toBe(false);
    expect(isVirtualPhase(undefined)).toBe(false);
    expect(isVirtualPhase(5)).toBe(false);
  });
});

describe("FatalError", () => {
  it("should be an Error carrying its message when the hub has failed the agent", () => {
    // Act
    const e = new FatalError("the account is not the agent owner");

    // Assert
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("the account is not the agent owner");
  });

  it("should be the one outcome that exits with the do-not-retry code", () => {
    // Act & Assert
    expect(EXIT_FATAL).toBe(3);
    expect(EXIT_NO_CREDENTIAL).toBe(4);
  });
});

describe("say", () => {
  it("should write one prefixed line to stderr when told something", () => {
    // Arrange
    const write = process.stderr.write.bind(process.stderr);
    let out = "";
    process.stderr.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stderr.write;

    // Act
    try {
      say("azure: signed in");
    } finally {
      process.stderr.write = write;
    }

    // Assert
    expect(out).toBe("virtual-agent: azure: signed in\n");
  });
});

describe("virtualStateDir", () => {
  it("should create the directory inside the session state tree, readable only by the pod", () => {
    // Act
    const dir = virtualStateDir();

    // Assert
    expect(dir).toBe(path.join(home.hub, "virtual"));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("should be a no-op when the directory is already there", () => {
    // Act
    const first = virtualStateDir();
    fs.writeFileSync(path.join(first, "azure-cache.sha"), "kept\n");
    const second = virtualStateDir();

    // Assert
    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(second, "azure-cache.sha"), "utf8")).toBe("kept\n");
  });
});
