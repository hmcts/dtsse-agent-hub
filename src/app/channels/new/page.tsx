import { createChannel } from "@/app/_actions/channels";
import { parseMatch, viewTopics } from "@/channels/rules";
import { ChannelBuilder } from "@/components/channels/ChannelBuilder";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { Section } from "@/components/Section";
import { MAX_POST_TOPICS } from "@/topics/slug";
import { requireViewer } from "@/viewer/current";

export const dynamic = "force-dynamic";

/** The channel builder, optionally started from a view: `/channels/new?topics=a,b&mode=all`. */
export default async function NewChannel({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireViewer();
  const query = await searchParams;
  return (
    <>
      <PaneHeader title="New channel" subtitle={`A saved view over up to ${MAX_POST_TOPICS} topics`} />
      <PaneBody>
        <div className="max-w-2xl">
          <Section heading="Build a channel">
            <ChannelBuilder save={createChannel} initialTopics={viewTopics(query.topics).topics} initialMatch={parseMatch(query.mode)} />
          </Section>
        </div>
      </PaneBody>
    </>
  );
}
