/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorPanel, errorDigest } from "@/components/ErrorPanel";

afterEach(cleanup);

function serverError(message: string, digest: unknown): Error {
  return Object.assign(new Error(message), { digest });
}

describe("ErrorPanel", () => {
  it("should show the digest and never the message when a server component threw", () => {
    render(<ErrorPanel error={serverError('relation "agent" does not exist at db.internal:5432', "4096281734")} retry={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    expect(screen.getByRole("alert").textContent).toContain("4096281734");
    expect(document.body.textContent).not.toContain("relation");
    expect(document.body.textContent).not.toContain("db.internal");
  });

  it("should leave out the reference line when the error has no digest", () => {
    render(<ErrorPanel error={new Error("thrown in the browser")} retry={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).not.toContain("reference");
    expect(document.body.textContent).not.toContain("thrown in the browser");
  });

  it("should retry the segment when the viewer presses try again", () => {
    const retry = vi.fn();
    render(<ErrorPanel error={undefined} retry={retry} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("should link home with a full page load when the viewer gives up", () => {
    render(<ErrorPanel error={undefined} retry={vi.fn()} />);

    expect(screen.getByRole("link", { name: "Back to home" }).getAttribute("href")).toBe("/");
  });
});

describe("errorDigest", () => {
  it("should read the digest when it is a non-empty string", () => {
    expect(errorDigest(serverError("x", "123"))).toBe("123");
  });

  it("should give nothing when the thrown value is not an object carrying a string digest", () => {
    expect(errorDigest(undefined)).toBeUndefined();
    expect(errorDigest(null)).toBeUndefined();
    expect(errorDigest("a string")).toBeUndefined();
    expect(errorDigest(new Error("x"))).toBeUndefined();
    expect(errorDigest(serverError("x", 42))).toBeUndefined();
    expect(errorDigest(serverError("x", ""))).toBeUndefined();
  });
});
