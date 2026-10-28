/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionForm } from "@/components/ActionForm";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByRole("form", { name: "Grant" }));
  });
}

describe("ActionForm", () => {
  it("should send the form's fields, confirm, and re-render the page when the action succeeds", async () => {
    const action = vi.fn(async (_form: FormData) => ({ ok: true as const, confirmation: "Bob now has read access" }));
    render(
      <ActionForm action={action} label="Grant">
        <input name="email" defaultValue="bob@example.com" />
      </ActionForm>
    );

    await submit();

    expect(action.mock.calls[0]?.[0].get("email")).toBe("bob@example.com");
    expect(screen.getByRole("status").textContent).toBe("Bob now has read access");
    expect(refresh).toHaveBeenCalled();
  });

  it("should show nothing on a success with nothing to say", async () => {
    render(
      <ActionForm action={vi.fn(async () => ({ ok: true as const }))} label="Grant">
        <span />
      </ActionForm>
    );

    await submit();

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should show the refusal when the action refuses", async () => {
    render(
      <ActionForm action={vi.fn(async () => ({ ok: false as const, error: "nobody at x has used the hub" }))} label="Grant">
        <span />
      </ActionForm>
    );

    await submit();

    expect(screen.getByRole("alert").textContent).toContain("nobody at x");
    expect(refresh).not.toHaveBeenCalled();
  });

  // A refused save changes nothing on the server and re-renders nothing, so a parent holding the fields in state has
  // no other way to hear that the value it is showing never came into force.
  it("should tell the parent when the action refuses, and not when it succeeds", async () => {
    const onRefused = vi.fn();
    const action = vi.fn(async () => ({ ok: false as const, error: "nobody at x has used the hub" }));
    render(
      <ActionForm action={action} label="Grant" onRefused={onRefused}>
        <span />
      </ActionForm>
    );

    await submit();
    expect(onRefused).toHaveBeenCalledTimes(1);

    action.mockImplementation(async () => ({ ok: true as const }) as never);
    await submit();

    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  it("should say it failed when the call throws", async () => {
    render(
      <ActionForm
        action={vi.fn(async () => {
          throw new Error("offline");
        })}
        label="Grant"
      >
        <span />
      </ActionForm>
    );

    await submit();

    expect(screen.getByRole("alert").textContent).toContain("could not be done");
  });

  it("should offer to sign in again instead of a failure when the call throws because the session has ended", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 }))
    );
    render(
      <ActionForm
        action={vi.fn(async () => {
          throw new Error("An unexpected response was received from the server.");
        })}
        label="Grant"
      >
        <span />
      </ActionForm>
    );

    await submit();

    expect(screen.getByRole("status").textContent).toContain("Your session has ended");
    expect(screen.getByRole("link", { name: "Sign in again" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
