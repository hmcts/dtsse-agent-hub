/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SharedChatNotFound from "@/app/assistant/shared/[conversationId]/not-found";
import { AssistantModal } from "@/components/assistant/AssistantModal";
import { PasteHelp } from "@/components/assistant/PasteHelp";

afterEach(cleanup);

describe("AssistantModal", () => {
  it("should focus the first thing Tab can reach when it is given nowhere to start", () => {
    render(
      <AssistantModal title="Rename" onClose={() => undefined}>
        <input aria-label="Name" />
      </AssistantModal>
    );

    expect(document.activeElement).toBe(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Rename" }).getAttribute("aria-modal")).toBe("true");
  });

  it("should leave focus alone on close when what had it before has gone from the page", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <AssistantModal title="Rename" onClose={() => undefined}>
        <span />
      </AssistantModal>
    );
    opener.remove();

    unmount();

    expect(document.activeElement).toBe(document.body);
  });

  it("should answer Escape once, and keep it from the page behind", () => {
    const onClose = vi.fn();
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    render(
      <AssistantModal title="Rename" onClose={onClose}>
        <span />
      </AssistantModal>
    );

    fireEvent.keyDown(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();
    window.removeEventListener("keydown", behind);
  });

  it("should do nothing with a key that is neither Tab nor Escape", () => {
    const onClose = vi.fn();
    render(
      <AssistantModal title="Rename" onClose={onClose}>
        <span />
      </AssistantModal>
    );

    fireEvent.keyDown(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }), { key: "Enter" });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SharedChatNotFound", () => {
  it("should say the chat is not shared with the reader and who can change that", () => {
    render(<SharedChatNotFound />);

    expect(screen.getByRole("heading", { name: "This chat has not been shared with you" })).toBeTruthy();
    expect(screen.getByText(/ask them to add you/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the chats that are shared with you" })).toBeTruthy();
  });
});

describe("PasteHelp", () => {
  it("should show nothing for a kind with no help", () => {
    const { container } = render(<PasteHelp help={null} />);

    expect(container.innerHTML).toBe("");
  });
});
