"use client";

import { useState } from "react";
import { FIELD, LINK } from "@/components/assistant/WelshParts";

const JAVA_TARGETS = ["nfdiv", "probate"];
const DEFAULT_PACKAGE = "com.example.bulkscan";

/** The SIP and the transformation sheet as Excel, and the code for a service as a zip, all of the version being viewed. */
export function BulkScanDownloads({ specId, version, targets }: Readonly<{ specId: string; version: number; targets: readonly string[] }>) {
  const [target, setTarget] = useState(targets.includes("nfdiv") ? "nfdiv" : (targets[0] ?? ""));
  const [javaPackage, setJavaPackage] = useState(DEFAULT_PACKAGE);
  const base = `/api/ui/assistant/bulk-scan/${encodeURIComponent(specId)}/download?version=${version}`;
  const code = `${base}&kind=code&target=${encodeURIComponent(target)}${JAVA_TARGETS.includes(target) ? `&package=${encodeURIComponent(javaPackage)}` : ""}`;
  return (
    <section aria-labelledby="bulk-scan-downloads" className="flex flex-col gap-2">
      <h2 id="bulk-scan-downloads" className="text-sm font-semibold">
        Downloads
      </h2>
      <p className="text-pretty text-[13px] text-asst-body">
        {`Of version ${version}. The SIP is built on a blank in the shape of the Exela V3.2 template, so copy it into Exela's own file before sending it.`}
      </p>
      <ul className="flex flex-col gap-1 text-[13px]">
        <li>
          <a className={LINK} href={`${base}&kind=sip`}>
            Exela SIP (.xlsx)
          </a>
        </li>
        <li>
          <a className={LINK} href={`${base}&kind=transformation`}>
            HMCTS transformation sheet (.xlsx)
          </a>
        </li>
      </ul>
      <div className="flex flex-wrap items-end gap-3 text-[13px]">
        <label className="flex flex-col gap-1 text-asst-muted">
          Code for
          <select className={FIELD} value={target} onChange={(event) => setTarget(event.target.value)}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {JAVA_TARGETS.includes(target) ? (
          <label className="flex flex-col gap-1 text-asst-muted">
            Java package
            <input className={`${FIELD} w-72`} value={javaPackage} onChange={(event) => setJavaPackage(event.target.value)} />
          </label>
        ) : null}
        <a className={`${LINK} pb-1.5`} href={code}>
          {`Download the ${target} code (.zip)`}
        </a>
      </div>
      <p className="text-pretty text-xs text-asst-muted">Give the zip to your assistant to put into the service's repository.</p>
    </section>
  );
}
