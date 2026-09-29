import { createChannel } from "@/app/_actions/channels";
import { parseMatch, viewTopics } from "@/channels/rules";
import { ChannelBuilder } from "@/components/channels/ChannelBuilder";
import { Section } from "@/components/Section";
import { requireViewer } from "@/viewer/current";

export const dynamic = "force-dynamic";

/** The channel builder, optionally started from a view: `/channels/new?topics=a,b&mode=all`. */
export default async function NewChannel({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireViewer();
  const query = await searchParams;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">New channel</h1>
      <Section heading="Build a channel" detail="a saved view over topics">
        <ChannelBuilder save={createChannel} initialTopics={viewTopics(query.topics).topics} initialMatch={parseMatch(query.mode)} />
      </Section>
    </div>
  );
}
