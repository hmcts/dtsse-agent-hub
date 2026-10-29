import { LaptopIcon } from "@/components/sidebar/icons";

/**
 * That a chat is a Claude Code session on the person's own computer rather than one running on their assistant.
 *
 * The icon is the repo's own, from `components/sidebar/icons`, and it is not the whole of the marker: the words are
 * beside it for a screen reader, because what a small laptop outline is supposed to mean is knowable only to whoever
 * put it there. They lead the row's name — "On your computer: Reviewing the claim form" — so the one thing about the
 * chat that is not in its title is the first thing read out. The tooltip says the same to a pointer.
 *
 * Its own module rather than another export of `AssistantShell`, which both of the lists that show it already
 * import: the sidebar's own list is in that file and the search's results are in `ConversationSearch`, which the
 * shell renders, so a marker living in the shell would have the two importing each other.
 */
export function LocalMark() {
  return (
    <span className="flex shrink-0 items-center text-asst-faint" title="On your computer">
      <LaptopIcon />
      {/* The trailing space is part of the text: the name of the row this sits in is these words joined to its
          title, and nothing between two inline elements adds one. */}
      <span className="sr-only">{"On your computer: "}</span>
    </span>
  );
}
