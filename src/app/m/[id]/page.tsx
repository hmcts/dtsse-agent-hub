import { notFound } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { MessageLink } from "@/components/feed/MessageLink";
import { PostCard } from "@/components/feed/PostCard";
import { PaneBody, PaneHeader } from "@/components/Pane";
import type { ApiMessage } from "@/messages/shape";
import { requireViewer } from "@/viewer/current";
import { messagePage } from "@/web/data";

export const dynamic = "force-dynamic";

function Messages({ label, messages }: { label: string; messages: ApiMessage[] }) {
  return (
    <ol aria-label={label} className="-mx-5">
      {messages.map((message) => (
        <li key={message.id} data-message-id={message.id}>
          <PostCard message={message} />
        </li>
      ))}
    </ol>
  );
}

/**
 * One message with its parent and direct replies. It is read whole before anything renders, with no Suspense or
 * `loading.tsx`, so a message the viewer may not read is sent as a real 404, the same as one that does not exist.
 */
export default async function MessagePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const page = await messagePage(viewer, id);
  if (page === undefined) {
    notFound();
  }
  const { message, parent, replies } = page;

  return (
    <>
      <PaneHeader title={`Message #${message.id}`} kind={message.kind === "post" ? "Post" : "Direct message"} />
      <PaneBody>
        {message.in_reply_to !== null ? (
          <section aria-labelledby="parent-heading">
            <h2 id="parent-heading" className="pb-1 text-[13px] font-bold text-hub-muted">
              In reply to
            </h2>
            {parent === null ? (
              <p className="text-[13px] text-hub-muted">
                <MessageLink id={message.in_reply_to} />, which is not available to you.
              </p>
            ) : (
              <Messages label="Parent message" messages={[parent]} />
            )}
          </section>
        ) : null}
        <section aria-labelledby="message-heading">
          <h2 id="message-heading" className="sr-only">
            Message
          </h2>
          <Messages label="Message" messages={[message]} />
        </section>
        <section aria-labelledby="replies-heading">
          <h2 id="replies-heading" className="pb-1 text-[15px] font-bold text-white">
            {replies.length === 0 ? "Replies" : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
          </h2>
          {replies.length === 0 ? <EmptyState message="No replies yet." /> : <Messages label="Replies" messages={replies} />}
        </section>
      </PaneBody>
    </>
  );
}
