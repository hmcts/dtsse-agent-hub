import { describe, expect, it } from "vitest";
import { taskFailed, taskNotifications } from "./task-notification.ts";

function block(inner: string): string {
  return `<task-notification>\n${inner}\n</task-notification>`;
}

const REPORTED = block(
  [
    "<task-id>bohu4iyck</task-id>",
    "<tool-use-id>toolu_bdrk_01MiSSuFVL3TcKiNnDeNbvc7</tool-use-id>",
    "<output-file>/tmp/claude-1000/-home-linus/d8f088b7/tasks/bohu4iyck.output</output-file>",
    "<status>completed</status>",
    '<summary>Background command "Run the unit and integration suites" completed (exit code 0)</summary>'
  ].join("\n")
);

describe("taskNotifications", () => {
  it("should report the status and the summary when a turn is a task notification", () => {
    expect(taskNotifications(REPORTED)).toEqual([
      { status: "completed", summary: 'Background command "Run the unit and integration suites" completed (exit code 0)', event: null, result: null }
    ]);
  });

  it("should report a subagent's result when the notification carries one", () => {
    const text = block("<status>completed</status>\n<summary>Agent finished</summary>\n<result>## Files changed\n\n- one.ts\n</result>");

    expect(taskNotifications(text)).toEqual([{ status: "completed", summary: "Agent finished", event: null, result: "## Files changed\n\n- one.ts" }]);
  });

  it("should report what a monitor saw when the notification carries an event instead of a status", () => {
    const text = block(
      [
        "<task-id>b1ako8104</task-id>",
        '<summary>Monitor event: "hmcts-claude-provider apply completion"</summary>',
        "<event>RUN COMPLETED: failure\napply job: success\napply job: failure</event>",
        "If this event is something the user would act on now, send a PushNotification."
      ].join("\n")
    );

    expect(taskNotifications(text)).toEqual([
      {
        status: null,
        summary: 'Monitor event: "hmcts-claude-provider apply completion"',
        event: "RUN COMPLETED: failure\napply job: success\napply job: failure",
        result: null
      }
    ]);
  });

  it("should report the task when an event is the only field a person can read", () => {
    expect(taskNotifications(block("<task-id>abc</task-id>\n<event>round 1: 89/94 routed</event>"))).toEqual([
      { status: null, summary: null, event: "round 1: 89/94 routed", result: null }
    ]);
  });

  it("should report every task when one turn carries several notifications", () => {
    const text = `  ${block("<status>completed</status>\n<summary>first</summary>")}\n\n${block("<status>failed</status>\n<summary>second</summary>")}  `;

    expect(taskNotifications(text)?.map((task) => [task.status, task.summary])).toEqual([
      ["completed", "first"],
      ["failed", "second"]
    ]);
  });

  it("should read the fields whatever their order and ignore tags it does not show", () => {
    const text = block("<summary>out of order</summary>\n<note>boilerplate</note>\n<usage>1 token</usage>\n<status>stopped</status>\n<worktree>/w</worktree>");

    expect(taskNotifications(text)).toEqual([{ status: "stopped", summary: "out of order", event: null, result: null }]);
  });

  it.each<[string, string]>([
    ["the status is missing", block("<summary>only a summary</summary>")],
    ["the summary is missing", block("<status>completed</status>")]
  ])("should report the task with the other field null when %s", (_label, text) => {
    const [task] = taskNotifications(text) ?? [];

    expect(task === undefined).toBe(false);
    expect(task?.status === null || task?.summary === null).toBe(true);
  });

  it("should lower case the status so it reads the same however the harness words it", () => {
    expect(taskNotifications(block("<status>FAILED</status>\n<summary>s</summary>"))?.[0]?.status).toBe("failed");
  });

  it("should keep a summary's markdown and angle brackets as they were written", () => {
    const summary = "**done**: fixed <Foo /> & <b>bar</b>";

    expect(taskNotifications(block(`<status>completed</status>\n<summary>${summary}</summary>`))?.[0]?.summary).toBe(summary);
  });

  it("should keep a very long summary whole, since cutting it for the screen is the caller's job", () => {
    const summary = "x".repeat(5000);

    expect(taskNotifications(block(`<status>completed</status>\n<summary>${summary}</summary>`))?.[0]?.summary).toBe(summary);
  });

  it.each<[string, string]>([
    ["the text is prose", "please fix the build"],
    ["the text is empty", "   "],
    ["a notification is quoted inside a prompt", `Summarise this transcript:\n\n${REPORTED}`],
    ["prose follows the notification", `${REPORTED}\n\nand now do the next thing`],
    ["the block has no closing tag", REPORTED.replace("</task-notification>", "")],
    ["the block was cut mid field", "<task-notification>\n<status>comple"],
    ["the block has no status, summary or event", block("<task-id>abc</task-id>\n<output-file>/tmp/abc.output</output-file>")],
    ["the tag is a different one", "<system-reminder>something else</system-reminder>"],
    ["the tag only starts the same way", "<task-notifications>\n<status>completed</status>\n</task-notifications>"]
  ])("should report no task when %s", (_label, text) => {
    expect(taskNotifications(text)).toBeNull();
  });

  it("should report no task when a later block in the turn has no closing tag", () => {
    expect(taskNotifications(`${REPORTED}\n<task-notification>\n<status>completed</status>`)).toBeNull();
  });

  describe("when the entry is truncated", () => {
    /** The shape the upload limit leaves: the fields before the report survive, the report itself is cut mid line. */
    const CUT = [
      "<task-notification>",
      "<task-id>aadecd3c1b44da27e</task-id>",
      "<output-file>/tmp/claude-1000/-home-linus/42f0b3a2/tasks/aadecd3c1b44da27e.output</output-file>",
      "<status>completed</status>",
      '<summary>Agent "Design decay detection and FDR control" finished</summary>',
      "<note>A task-notification fires each time this agent stops.</note>",
      "<result>## Layer 1 — the first thing it found",
      "",
      "| Test | Verdict |"
    ].join("\n");

    it("should read the fields the prefix kept, and not the report it was cut part way through", () => {
      expect(taskNotifications(CUT, { truncated: true })).toEqual([
        { status: "completed", summary: 'Agent "Design decay detection and FDR control" finished', event: null, result: null }
      ]);
    });

    it("should report no task for the same text when the entry is not marked truncated", () => {
      expect(taskNotifications(CUT)).toBeNull();
    });

    it("should keep the blocks that closed as well as the one the prefix cut", () => {
      const text = `${REPORTED}\n${CUT}`;

      expect(taskNotifications(text, { truncated: true })?.map((task) => task.summary)).toEqual([
        'Background command "Run the unit and integration suites" completed (exit code 0)',
        'Agent "Design decay detection and FDR control" finished'
      ]);
    });

    it("should keep the blocks that closed when the prefix stops part way through the next open tag", () => {
      expect(taskNotifications(`${REPORTED}\n<task-notif`, { truncated: true })?.map((task) => task.status)).toEqual(["completed"]);
    });

    it.each<[string, string]>([
      ["the prefix kept no field whole", "<task-notification>\n<status>comple"],
      ["the prefix kept only the tags it does not show", "<task-notification>\n<task-id>abc</task-id>\n<output-file>/tmp/ab"],
      ["prose follows the blocks rather than another one", `${REPORTED}\nand now do the next thing`]
    ])("should report no task when %s", (_label, text) => {
      expect(taskNotifications(text, { truncated: true })).toBeNull();
    });
  });
});

describe("taskFailed", () => {
  it.each<[string | null, boolean]>([
    ["completed", false],
    ["stopped", false],
    [null, false],
    ["failed", true],
    ["error", true],
    ["killed", true],
    ["timeout", true]
  ])("should decide %s is a failure: %s", (status, expected) => {
    expect(taskFailed(status)).toBe(expected);
  });
});
