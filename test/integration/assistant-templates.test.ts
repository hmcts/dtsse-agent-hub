import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES } from "../../src/assistant/starters.ts";
import { deleteTemplate, listTemplates, saveTemplate } from "../../src/assistant/template-store.ts";
import { MAX_TEMPLATES, offeredTemplates, TEMPLATES_FULL, templateNameTaken } from "../../src/assistant/templates.ts";
import type { Identity } from "../../src/users/identity.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { assistantTemplates } from "../../src/web/data.ts";
import { connect, insertUser, type Person, prisma, resetDatabase } from "./database.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const { actAs, revalidated } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/templates.ts");

function persona(name: string): Person {
  const identity = devIdentity(name);
  return { oid: identity.oid, name: identity.name, email: identity.email! };
}

const ALICE = persona("alice");
const BOB = persona("bob");

const viewer = (who: Person): Identity => ({ ...who, tid: "dev" });

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

function own(who: Person) {
  return { actorOid: who.oid, ownerOid: who.oid };
}

/** One of `who`'s templates, written through the store so the caps and the checks apply as they do in the UI. */
async function given(who: Person, name: string, body = `${name} prompt`): Promise<string> {
  const saved = await saveTemplate(prisma, { ...own(who), name, body });
  return saved.id;
}

async function rows(who: Person): Promise<{ name: string; body: string }[]> {
  return await prisma.assistantTemplate.findMany({ where: { ownerOid: who.oid }, select: { name: true, body: true }, orderBy: { name: "asc" } });
}

beforeEach(async () => {
  await resetDatabase();
  await insertUser(ALICE);
  await insertUser(BOB);
  revalidated.length = 0;
  actAs("alice");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("saving a template", () => {
  it("should keep it against the signed-in person and confirm it when the form is filled in", async () => {
    const result = await actions.saveTemplate(form({ name: "Stand-up", body: "What I did yesterday:\r\n- …" }));

    expect(result).toMatchObject({ ok: true, confirmation: `"Stand-up" is saved, and is in the + menu of every chat` });
    expect(await rows(ALICE)).toEqual([{ name: "Stand-up", body: "What I did yesterday:\n- …" }]);
    expect(revalidated).toEqual(["/assistant"]);
  });

  it("should record the signed-in person as the owner, not anyone the form names", async () => {
    await actions.saveTemplate(form({ name: "Stand-up", body: "mine", owner: BOB.oid, ownerOid: BOB.oid }));

    expect(await prisma.assistantTemplate.findMany({ select: { ownerOid: true } })).toEqual([{ ownerOid: ALICE.oid }]);
  });

  it("should replace the named template, keeping its id, when the person edits one of their own", async () => {
    const id = await given(ALICE, "Stand-up");

    const result = await actions.saveTemplate(form({ id, name: "Daily", body: "Changed" }));

    expect(result).toMatchObject({ ok: true, id });
    expect(await rows(ALICE)).toEqual([{ name: "Daily", body: "Changed" }]);
  });

  it.each([
    ["no name", { name: " ", body: "x" }, "give your template a name"],
    ["no prompt", { name: "Mine", body: " " }, "write the prompt"],
    ["a prompt past the cap", { name: "Mine", body: "b".repeat(4_001) }, "at most 4,000 characters"],
    ["a name one of the built-in templates uses", { name: TEMPLATES[2]!.name, body: "x" }, "one of the built-in templates"],
    ["an id that is not a template", { id: "11111111-1111-4111-8111-111111111111", name: "Mine", body: "x" }, "no longer exists"],
    ["an id that is not an id at all", { id: "not-a-uuid", name: "Mine", body: "x" }, "no longer exists"]
  ])("should refuse %s and write nothing", async (_label, values, error) => {
    const result = await actions.saveTemplate(form(values));

    expect(result.ok ? undefined : result.error).toContain(error);
    expect(await prisma.assistantTemplate.count()).toBe(0);
  });

  it("should refuse a name the person has already used, in the store's own words, and keep the first one", async () => {
    await given(ALICE, "Stand-up", "first");

    const result = await actions.saveTemplate(form({ name: "Stand-up", body: "second" }));

    expect(result).toEqual({ ok: false, error: templateNameTaken("Stand-up") });
    expect(await rows(ALICE)).toEqual([{ name: "Stand-up", body: "first" }]);
  });

  it("should let two people each keep a template of the same name, since the one name per person is per person", async () => {
    await given(ALICE, "Stand-up", "alice's");
    actAs("bob");

    expect((await actions.saveTemplate(form({ name: "Stand-up", body: "bob's" }))).ok).toBe(true);
    expect(await rows(BOB)).toEqual([{ name: "Stand-up", body: "bob's" }]);
  });

  it("should refuse one past the cap in the store's own words, which is what the dialog shows", async () => {
    for (let index = 0; index < MAX_TEMPLATES; index += 1) {
      await given(ALICE, `Template ${index}`);
    }

    const result = await actions.saveTemplate(form({ name: "One too many", body: "x" }));

    expect(result).toEqual({ ok: false, error: TEMPLATES_FULL });
    expect(await prisma.assistantTemplate.count()).toBe(MAX_TEMPLATES);
  });

  it("should still let the person change one of the ones they have when they are at the cap", async () => {
    const ids: string[] = [];
    for (let index = 0; index < MAX_TEMPLATES; index += 1) {
      ids.push(await given(ALICE, `Template ${index}`));
    }

    expect((await actions.saveTemplate(form({ id: ids[0]!, name: "Template 0", body: "Changed" }))).ok).toBe(true);
    expect(await prisma.assistantTemplate.count()).toBe(MAX_TEMPLATES);
  });

  /**
   * Two tabs racing for the last place. The connection here stands in for the one that gets there first: it takes the
   * same `user` row `saveTemplate` locks and inserts the twentieth template while holding it, so the save under test
   * is made to do its counting on the far side of somebody else's commit.
   *
   * Counting inside the transaction is not enough on its own, and this is what says so: at READ COMMITTED a save
   * that did not take the lock would read nineteen, find room, and insert, leaving twenty-one rows against a cap of
   * twenty — and `listTemplates` stops at twenty, so the extra one would be invisible in the dialog while the dialog
   * told the person they were full.
   */
  it("should refuse the one over the cap when two saves race for the last place", async () => {
    for (let index = 0; index < MAX_TEMPLATES - 1; index += 1) {
      await given(ALICE, `Template ${index}`);
    }
    const first = await connect();
    try {
      await first.query("BEGIN");
      await first.query('SELECT 1 FROM "user" WHERE oid = $1 FOR UPDATE', [ALICE.oid]);
      // Settled rather than awaited, so a save that does not block leaves no unhandled rejection behind it.
      const racing = saveTemplate(prisma, { ...own(ALICE), name: "Mine", body: "x" }).then(
        () => "saved" as const,
        (error: Error) => error.message
      );
      // Long enough for the save to have reached the lock, or to have sailed past it.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await first.query("INSERT INTO assistant_template (owner_oid, name, body) VALUES ($1, $2, $3)", [ALICE.oid, "Theirs", "x"]);
      await first.query("COMMIT");

      expect(await racing).toBe(TEMPLATES_FULL);
    } finally {
      await first.end();
    }
    expect(await prisma.assistantTemplate.count()).toBe(MAX_TEMPLATES);
  });
});

describe("deleting a template", () => {
  it("should remove one of the signed-in person's own and confirm it", async () => {
    const id = await given(ALICE, "Stand-up");
    await given(ALICE, "Retro");

    const result = await actions.deleteTemplate(form({ id }));

    expect(result).toMatchObject({ ok: true, confirmation: "Your template is deleted" });
    expect(await rows(ALICE)).toEqual([{ name: "Retro", body: "Retro prompt" }]);
    expect(revalidated).toContain("/assistant");
  });

  it.each([
    ["an id that is not a template", "11111111-1111-4111-8111-111111111111"],
    ["an id that is not an id at all", "not-a-uuid"]
  ])("should say %s is not one of theirs", async (_label, id) => {
    await given(ALICE, "Stand-up");

    expect(await actions.deleteTemplate(form({ id }))).toEqual({ ok: false, error: "that is not one of your templates" });
    expect(await prisma.assistantTemplate.count()).toBe(1);
  });
});

describe("offering a person's templates", () => {
  it("should read back only the signed-in person's own, by name, for the dialog and both composers", async () => {
    await given(ALICE, "Stand-up");
    await given(ALICE, "Retro");
    await given(BOB, "Bob's own");

    expect((await assistantTemplates(viewer(ALICE))).map((template) => template.name)).toEqual(["Retro", "Stand-up"]);
  });

  it("should put the person's own above every built-in one when the composer is handed the list", async () => {
    await given(ALICE, "Stand-up");

    const offered = offeredTemplates(await assistantTemplates(viewer(ALICE)));

    expect(offered.map((template) => template.name)).toEqual(["Stand-up", ...TEMPLATES.map((template) => template.name)]);
    expect(offered[0]).toMatchObject({ name: "Stand-up", text: "Stand-up prompt" });
  });

  it("should offer the built-in templates alone to somebody who has saved none", async () => {
    await given(BOB, "Bob's own");

    expect(offeredTemplates(await assistantTemplates(viewer(ALICE)))).toEqual([...TEMPLATES]);
  });
});

/**
 * The one that matters. Each of these asserts something a different reader would otherwise have to take on trust:
 *
 * - Bob's own read does not carry Alice's row, so her templates are not merely unlisted in his UI but absent from the
 *   query that feeds it.
 * - Bob naming Alice's template id in a save or a delete does not reach her row. The `where` in every statement
 *   carries the owner, so his id matches nothing: he is told the template has gone and *Alice's row is unchanged*,
 *   which is the assertion — a refusal with her row quietly rewritten would pass a test that only read the result.
 * - A caller that hands the store a different owner outright is refused by `canManageTemplate` rather than served,
 *   so the rule and not the query shape is what is being relied on.
 * - The actions never read an owner from the form, so a hand-rolled POST naming Alice writes against Bob.
 */
describe("another person's templates", () => {
  it("should not read Alice's templates into Bob's own list at all", async () => {
    await given(ALICE, "Alice's own");
    await given(BOB, "Bob's own");

    expect(await listTemplates(prisma, own(BOB))).toEqual([{ id: expect.any(String), name: "Bob's own", text: "Bob's own prompt" }]);
    expect(await assistantTemplates(viewer(BOB))).toHaveLength(1);
  });

  it("should leave Alice's template exactly as it was when Bob saves over its id", async () => {
    const id = await given(ALICE, "Alice's own", "hers");
    actAs("bob");

    const result = await actions.saveTemplate(form({ id, name: "Taken over", body: "his" }));

    expect(result).toEqual({ ok: false, error: "that template no longer exists" });
    expect(await rows(ALICE)).toEqual([{ name: "Alice's own", body: "hers" }]);
    expect(await prisma.assistantTemplate.count()).toBe(1);
  });

  it("should leave Alice's template exactly as it was when Bob deletes its id", async () => {
    const id = await given(ALICE, "Alice's own", "hers");
    actAs("bob");

    expect(await actions.deleteTemplate(form({ id }))).toEqual({ ok: false, error: "that is not one of your templates" });
    expect(await rows(ALICE)).toEqual([{ name: "Alice's own", body: "hers" }]);
  });

  it("should write against Bob when a hand-rolled post names Alice as the owner", async () => {
    actAs("bob");

    await actions.saveTemplate(form({ name: "Mine", body: "x", ownerOid: ALICE.oid, owner_oid: ALICE.oid, actorOid: ALICE.oid }));

    expect(await rows(ALICE)).toEqual([]);
    expect(await rows(BOB)).toEqual([{ name: "Mine", body: "x" }]);
  });

  it.each([
    ["read", async () => await listTemplates(prisma, { actorOid: BOB.oid, ownerOid: ALICE.oid })],
    ["save over", async () => await saveTemplate(prisma, { actorOid: BOB.oid, ownerOid: ALICE.oid, name: "Mine", body: "x" })],
    ["delete", async () => await deleteTemplate(prisma, { actorOid: BOB.oid, ownerOid: ALICE.oid }, "11111111-1111-4111-8111-111111111111")]
  ])("should refuse a caller trying to %s somebody else's templates, by the rule and not by the query", async (_label, attempt) => {
    await given(ALICE, "Alice's own", "hers");

    await expect(attempt()).rejects.toThrow("you can only change your own templates");
    expect(await rows(ALICE)).toEqual([{ name: "Alice's own", body: "hers" }]);
  });
});
