"use client";

import { useEffect, useState } from "react";
import type { Product } from "@/assistant/products";
import type { WelshTask } from "@/assistant/welsh";
import { infoView, type WelshInfo } from "@/assistant/welsh-views";
import { doneResult, FIELD, JobStatus, LINK, plural, Step, Steps, useWelshJob } from "@/components/assistant/WelshParts";
import { WelshReturn } from "@/components/assistant/WelshReturn";
import { WelshScan } from "@/components/assistant/WelshScan";
import { WelshSearch } from "@/components/assistant/WelshSearch";
import { WelshStory } from "@/components/assistant/WelshStory";
import { type WelshClient, welshClient } from "@/components/assistant/welshClient";

export const WELSH_TASKS: readonly { id: WelshTask; title: string; description: string }[] = [
  { id: "search", title: "Look up a translation", description: "Search the approved Welsh for a word or phrase." },
  {
    id: "scan",
    title: "Find Welsh that's missing",
    description: "Check a service's code for English with no Welsh, and get the list to send to the Welsh Language Unit."
  },
  {
    id: "return",
    title: "The Welsh unit sent translations back",
    description: "Check their spreadsheet, add it to the catalogue, then put the Welsh into the code."
  },
  { id: "story", title: "Add Welsh to a Jira story", description: "Add a Welsh content table to a story, filled from the catalogue." }
];

/** The service last worked on, so the next visit starts there. Only a slug, kept in this browser. */
export const PRODUCT_KEY = "asst-welsh-product";

export interface WelshPageProps {
  products: readonly Product[];
  /** From `?product=`; otherwise the service this browser last used, otherwise none yet. */
  initialProduct?: string | null;
  /** From `?task=`, so a link can open a task directly. */
  initialTask?: WelshTask | null;
  client?: WelshClient;
}

/**
 * The Welsh page: pick what needs doing, then follow its steps. The first step of every task is the service, because
 * the service decides everything after it — whose catalogue is searched and filled from, and whose repos are checked.
 * Every task runs in the person's own assistant with their own sign-ins, and none of them translates; see "Welsh
 * translation jobs" in docs/agent-api.md.
 */
export function WelshPage({ products, initialProduct = null, initialTask = null, client = welshClient }: Readonly<WelshPageProps>) {
  const [task, setTask] = useState<WelshTask | null>(initialTask);
  const [product, setProduct] = useState<string | null>(initialProduct);
  const [changing, setChanging] = useState(false);
  const info = useWelshJob(client);
  const { run } = info;

  // The remembered service is read after the first render, since the server has no way to know it.
  useEffect(() => {
    if (initialProduct === null) {
      const remembered = window.localStorage.getItem(PRODUCT_KEY);
      if (remembered && products.some((p) => p.slug === remembered)) {
        setProduct(remembered);
      }
    }
  }, [initialProduct, products]);

  useEffect(() => {
    if (product !== null) {
      window.localStorage.setItem(PRODUCT_KEY, product);
      void run({ kind: "info", product, args: {} });
    }
  }, [product, run]);

  const done = doneResult(info.state);
  const view = done ? infoView(done.result) : null;
  const chosen = WELSH_TASKS.find((t) => t.id === task);

  if (!chosen) {
    return (
      <section aria-labelledby="welsh-tasks" className="flex flex-col gap-3">
        <h2 id="welsh-tasks" className="text-[15px] font-semibold">
          What do you need to do?
        </h2>
        <div role="note" className="flex flex-col gap-1 rounded-[10px] border-l-4 border-asst-accent bg-asst-field px-4 py-3 text-[13px]">
          <p className="font-semibold text-asst-text">Before you start</p>
          <p className="text-asst-body">
            The service needs to be set up for Welsh first: a Welsh catalogue of the translations the Welsh Language Unit has approved for it, and a list of its
            repos. A developer sets this up in cft-workspace. You will see in the first step whether the service you pick is ready.
          </p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {WELSH_TASKS.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setTask(t.id)}
                className="flex h-full w-full flex-col gap-1 rounded-[10px] border border-asst-line px-4 py-3 text-left hover:border-asst-accent-line hover:bg-asst-hover"
              >
                <span className="text-sm font-semibold">{t.title}</span>
                <span className="text-[13px] text-asst-muted">{t.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const label = products.find((p) => p.slug === product)?.label ?? product;
  const ready = product !== null && !changing && view !== null;

  return (
    <section aria-labelledby="welsh-task" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <button type="button" onClick={() => setTask(null)} className={`${LINK} self-start text-[13px]`}>
          ← All tasks
        </button>
        <h2 id="welsh-task" className="text-[17px] font-semibold">
          {chosen.title}
        </h2>
        <p className="text-[13px] text-asst-muted">{chosen.description}</p>
      </div>
      <Steps label={chosen.title}>
        <Step n={1} title="Service" done={ready} summary={ready ? label : undefined}>
          {product === null || changing ? (
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-asst-muted">Which service is this for? Its catalogue and its repos are used in every step below.</span>
              <select
                value={product ?? ""}
                onChange={(event) => {
                  setProduct(event.target.value);
                  setChanging(false);
                }}
                className={`${FIELD} max-w-sm`}
              >
                <option value="" disabled>
                  Choose a service
                </option>
                {products.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-[13px] text-asst-muted">
              {view ? <ServiceFacts info={view} /> : null}
              <button type="button" onClick={() => setChanging(true)} className={LINK}>
                Change service
              </button>
            </div>
          )}
          <JobStatus state={info.state} working="Asking your assistant about this service…" />
        </Step>
        {ready && product ? (
          // Keyed by the service, so changing it starts the task afresh rather than showing another service's results.
          <TaskSteps key={product} task={chosen.id} product={product} info={view} client={client} />
        ) : null}
      </Steps>
    </section>
  );
}

function ServiceFacts({ info }: Readonly<{ info: WelshInfo }>) {
  if (!info.initialised) {
    return (
      <span className="text-asst-warn">
        This service is not set up for Welsh yet: it has no Welsh catalogue, so there is nothing approved to search or fill from. Ask a developer to set it up
        in cft-workspace.
      </span>
    );
  }
  return (
    <span>
      {plural(info.approved, "approved translation")}
      {info.needsReview ? `, ${info.needsReview} needing review` : ""} · {plural(info.repos.length, "repo")}
      {info.skipsStaffPages ? " · admin pages skipped" : ""}
    </span>
  );
}

function TaskSteps({ task, product, info, client }: Readonly<{ task: WelshTask; product: string; info: WelshInfo; client: WelshClient }>) {
  const repos = info.repos;
  switch (task) {
    case "search":
      return <WelshSearch product={product} client={client} />;
    case "scan":
      return <WelshScan product={product} repos={repos} skipsStaffPages={info.skipsStaffPages} client={client} />;
    case "return":
      return <WelshReturn product={product} repos={repos} client={client} />;
    case "story":
      return <WelshStory product={product} client={client} />;
  }
}
