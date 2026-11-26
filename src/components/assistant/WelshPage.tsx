"use client";

import { useCallback, useEffect, useState } from "react";
import type { Product } from "@/assistant/products";
import { isWelshTask, type WelshTask } from "@/assistant/welsh";
import { infoView, type WelshInfo } from "@/assistant/welsh-views";
import {
  doneResult,
  FIELD,
  type JobState,
  JobStatus,
  LINK,
  plural,
  ReportStepsTotal,
  Step,
  Steps,
  useWelshJob,
  WelshTaskSwitch
} from "@/components/assistant/WelshParts";
import { WelshReturn } from "@/components/assistant/WelshReturn";
import { WelshScan } from "@/components/assistant/WelshScan";
import { WelshSearch } from "@/components/assistant/WelshSearch";
import { SETUP_STEPS, WelshSetup } from "@/components/assistant/WelshSetup";
import { WelshStory } from "@/components/assistant/WelshStory";
import { type WelshClient, welshClient } from "@/components/assistant/welshClient";

const WELSH_TASKS: readonly { id: WelshTask; title: string; description: string }[] = [
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
  // What a task whose steps follow what it finds has said its total is; see `stepsIn`.
  const [reported, setReported] = useState<number | null>(null);

  /**
   * Opens a task, or the list for `null`, as a new entry in the browser's history with `?task=` in the address, so the
   * Back button returns to where the person was rather than leaving the Welsh page, and the address can be shared.
   */
  const choose = useCallback((next: WelshTask | null) => {
    setTask(next);
    const address = new URL(window.location.href);
    if (next === null) {
      address.searchParams.delete("task");
    } else {
      address.searchParams.set("task", next);
    }
    window.history.pushState(null, "", address);
  }, []);

  // Back and Forward change the address without telling the page, so the task is read from it again when they do.
  useEffect(() => {
    const follow = () => {
      const named = new URLSearchParams(window.location.search).get("task");
      setTask(isWelshTask(named) ? named : null);
    };
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);

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

  const label = products.find((p) => p.slug === product)?.label ?? product;
  const ready = product !== null && !changing && view !== null;
  const picker = (
    <ServiceStep
      products={products}
      product={product}
      label={label}
      ready={ready}
      changing={changing}
      view={view}
      state={info.state}
      onChoose={(slug) => {
        setProduct(slug);
        setChanging(false);
      }}
      onChange={() => setChanging(true)}
    />
  );

  // The main page: the service first, then either setting it up or what can be done with it.
  if (!chosen) {
    if (ready && product && view && !view.initialised) {
      return (
        <section aria-labelledby="welsh-setup" className="flex flex-col gap-4">
          <h2 id="welsh-setup" className="text-[15px] font-semibold">
            Set up {label} for Welsh
          </h2>
          <SetupNote />
          <Steps label={`Set up ${label} for Welsh`} total={SETUP_STEPS}>
            {picker}
            <WelshSetup key={product} product={product} candidates={view.candidates} openPr={view.setupPr} client={client} />
          </Steps>
        </section>
      );
    }
    return (
      <section aria-labelledby="welsh-start" className="flex flex-col gap-4">
        <h2 id="welsh-start" className="text-[15px] font-semibold">
          Which service is this for?
        </h2>
        <Steps label="Choose a service">{picker}</Steps>
        {ready && view?.initialised ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">What do you need to do?</h3>
            <ul className="grid gap-3 sm:grid-cols-2">
              {WELSH_TASKS.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => choose(t.id)}
                    className="flex h-full w-full flex-col gap-1 rounded-[10px] border border-asst-line px-4 py-3 text-left hover:border-asst-accent-line hover:bg-asst-hover"
                  >
                    <span className="text-sm font-semibold">{t.title}</span>
                    <span className="text-[13px] text-asst-muted">{t.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-labelledby="welsh-task" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <button type="button" onClick={() => choose(null)} className={`${LINK} self-start text-[13px]`}>
          ← All tasks
        </button>
        <h2 id="welsh-task" className="text-[17px] font-semibold">
          {chosen.title}
        </h2>
        <p className="text-[13px] text-asst-muted">{chosen.description}</p>
      </div>
      <Steps label={chosen.title} total={stepsIn(chosen.id) ?? reported}>
        {picker}
        {ready && product ? (
          // Keyed by the service, so changing it starts the task afresh rather than showing another service's results.
          <WelshTaskSwitch.Provider value={choose}>
            <ReportStepsTotal.Provider value={setReported}>
              <TaskSteps key={product} task={chosen.id} product={product} info={view} client={client} onSetUp={() => choose(null)} />
            </ReportStepsTotal.Provider>
          </WelshTaskSwitch.Provider>
        ) : null}
      </Steps>
    </section>
  );
}

/**
 * How many steps a task has, the service's included, when that is fixed; `null` for a task whose later steps follow
 * what it finds — the code check, and a returned spreadsheet, which may have nothing usable — and which reports its
 * own total through `useStepsTotal` once it knows.
 */
export function stepsIn(task: WelshTask): number | null {
  switch (task) {
    case "search":
      return 2;
    case "story":
      return 5;
    case "return":
    case "scan":
      return null;
  }
}

function ServiceFacts({ info }: Readonly<{ info: WelshInfo }>) {
  if (!info.initialised) {
    return <span className="text-asst-warn">Not set up for Welsh yet: it has no Welsh catalogue, so there is nothing approved to search or fill from.</span>;
  }
  return (
    <span>
      {plural(info.approved, "approved translation")}
      {info.needsReview ? `, ${info.needsReview} needing review` : ""} · {plural(info.repos.length, "repo")}
      {info.skipsStaffPages ? " · admin pages skipped" : ""}
    </span>
  );
}

function TaskSteps({
  task,
  product,
  info,
  client,
  onSetUp
}: Readonly<{ task: WelshTask; product: string; info: WelshInfo; client: WelshClient; onSetUp: () => void }>) {
  if (!info.initialised) {
    // A link to a task, or a change of service inside one, can land on a service with no catalogue yet: setting it up
    // is on the main page.
    return (
      <Step n={2} title="Set the service up first">
        <p className="text-[13px] text-asst-body">
          There is nothing to work with until this service is set up for Welsh.{" "}
          <button type="button" onClick={onSetUp} className={LINK}>
            Set it up
          </button>
        </p>
      </Step>
    );
  }
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

/** Step 1 of everything on the page: which service, and what it has set up. */
function ServiceStep({
  products,
  product,
  label,
  ready,
  changing,
  view,
  state,
  onChoose,
  onChange
}: Readonly<{
  products: readonly Product[];
  product: string | null;
  label: string | null;
  ready: boolean;
  changing: boolean;
  view: WelshInfo | null;
  state: JobState;
  onChoose: (slug: string) => void;
  onChange: () => void;
}>) {
  return (
    <Step n={1} title="Service" done={ready} summary={ready ? label : undefined}>
      {product === null || changing ? (
        <label className="flex flex-col gap-1 text-[13px]">
          <span className="text-asst-muted">Its catalogue and its repos are used in every step after this.</span>
          <select value={product ?? ""} onChange={(event) => onChoose(event.target.value)} className={`${FIELD} max-w-sm`}>
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
          <button type="button" onClick={onChange} className={LINK}>
            Change service
          </button>
        </div>
      )}
      <JobStatus state={state} working="Asking your assistant about this service…" />
    </Step>
  );
}

/** What setting a service up needs and what happens, before the steps. */
function SetupNote() {
  return (
    <div role="note" className="flex flex-col gap-2 rounded-[10px] border-l-4 border-asst-accent bg-asst-field px-4 py-3 text-[13px]">
      <p className="font-semibold text-asst-text">Before you start</p>
      <p className="text-asst-body">
        The service needs to be set up for Welsh first. You will need at least one document of translations the Welsh Language Unit has approved for it: a
        spreadsheet they sent back, or a JSON file of the service's Welsh.
      </p>
      <ol className="list-decimal pl-5 text-asst-body">
        <li>Add your documents. They are checked, and a Welsh catalogue is made from the translations in them.</li>
        <li>A pull request adding the catalogue is opened in the service's repo that you choose.</li>
        <li>Once the pull request has been reviewed and merged, you can use the other Welsh tasks.</li>
      </ol>
    </div>
  );
}
