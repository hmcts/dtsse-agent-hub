import { KINDS, type Kind } from "./schema.ts";

const KIND_SLUG: Record<Kind, string> = {
  initiation: "initiation",
  configuration: "configuration",
  permissions: "permissions",
  completion: "completion",
  cancellation: "cancellation",
  "task-types": "types",
  "allowed-days": "allowed-days"
};

const KIND_PATTERN = new RegExp(`^wa-task-(${KINDS.map((kind) => KIND_SLUG[kind]).join("|")})-(.+)-([^-]+)\\.dmn$`);

const KIND_OF_SLUG = new Map(KINDS.map((kind) => [KIND_SLUG[kind], kind]));

/** A task DMN's decision key, which is also its file name without the extension: `wa-task-<kind>-<service>-<caseType>`. */
export function decisionKeyOf(service: string, kind: Kind, caseType: string): string {
  return `wa-task-${KIND_SLUG[kind]}-${service}-${caseType}`;
}

export const fileNameOf = (service: string, kind: Kind, caseType: string): string => `${decisionKeyOf(service, kind, caseType)}.dmn`;

/** What a task DMN's name says. The service may hold hyphens; the case type, which follows the last one, may not. */
export function parseFileName(name: string): { kind: Kind; service: string; caseType: string } | undefined {
  const match = KIND_PATTERN.exec(name);
  const kind = match ? KIND_OF_SLUG.get(match[1] as string) : undefined;
  return match && kind ? { kind, service: match[2] as string, caseType: match[3] as string } : undefined;
}

/** Whether a file is one of a service's task DMNs of a kind the spec knows. */
export const isWaTaskDmn = (name: string): boolean => parseFileName(name) !== undefined;
