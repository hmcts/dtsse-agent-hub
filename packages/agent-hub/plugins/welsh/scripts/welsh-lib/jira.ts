/**
 * Jira through the Teamwork Graph CLI. Descriptions are read and written as
 * ADF (Atlassian Document Format) so images, panels and mentions survive the
 * round trip — an HTML or Markdown rewrite would flatten them.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tool } from "./tools.ts";

export function fetchStory(key: string): Story {
  const out = twg(["jira", "workitem", "get", key, "--fields", "summary,description", "-o", "json", "--output-summary", "none"]);
  const issue = Array.isArray(out.data) ? out.data[0] : out.data;
  if (!issue) {
    throw new Error(`twg returned no issue for ${key}`);
  }
  const description = (issue.description ?? issue.fields?.description ?? null) as AdfNode | null;
  return {
    key: issue.key ?? key,
    summary: issue.summary ?? issue.fields?.summary ?? "",
    url: issue.url ?? `https://hmcts.atlassian.net/browse/${key}`,
    description: description ?? { type: "doc", version: 1, content: [] },
    hash: adfHash(description)
  };
}

export function updateDescription(key: string, description: AdfNode): void {
  twg(["jira", "workitem", "update", "--id", key, "--fields-json", JSON.stringify({ description }), "-o", "json", "--output-summary", "none"]);
}

/** Whether a story's description changed between a preview and the write that follows it. */
export function adfHash(doc: AdfNode | null): string {
  return createHash("sha256")
    .update(JSON.stringify(doc ?? null))
    .digest("hex");
}

/** Plain text of an ADF node; hard breaks and block boundaries become newlines. */
export function adfText(node: AdfNode): string {
  if (node.type === "text") {
    return node.text ?? "";
  }
  if (node.type === "hardBreak") {
    return "\n";
  }
  const inner = (node.content ?? []).map(adfText);
  return BLOCKS.has(node.type) ? inner.join("\n") : inner.join("");
}

const BLOCKS = new Set(["doc", "bulletList", "orderedList", "listItem", "table", "tableRow", "panel", "blockquote", "expand", "layoutSection", "layoutColumn"]);

function twg(args: string[]): { data: any } {
  const res = spawnSync(tool("twg"), args, {
    encoding: "utf8",
    env: { ...process.env, TWG_AGENT_DEFAULTS: "1" },
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.error) {
    throw new Error(`could not run twg (${res.error.message}). See docs/how-to/set-up-mcp-servers.md`);
  }
  if (res.status !== 0) {
    throw new Error(`twg ${args.slice(0, 3).join(" ")} failed: ${(res.stderr || res.stdout).trim().slice(0, 800)}`);
  }
  return JSON.parse(res.stdout);
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
  version?: number;
}

export interface Story {
  key: string;
  summary: string;
  url: string;
  description: AdfNode;
  hash: string;
}
