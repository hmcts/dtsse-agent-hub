import { type DmnDocument, readDmn, writeDmn } from "../dmn-model.ts";

/** The model of a DMN file. */
export const parseDmn = (xml: string): DmnDocument => readDmn(xml).document;

/** What the model leaves out of a DMN file. */
export const inspectDmn = (xml: string) => readDmn(xml).inspection;

/** A small two-input completion-style table, as DMN text, for the case type `caseType`. */
export function sampleDmn(caseType: string, options: { extraRule?: boolean; hitPolicy?: string; name?: string } = {}): string {
  const rules = [
    { inputs: ['"submit", "update"', ""], outputs: ['"Review"', '"Auto"'] },
    { description: "cancel on dispose", inputs: ['"dispose"', "true"], outputs: ['"Review"', '"Manual"'] },
    ...(options.extraRule ? [{ inputs: ['"extra"', ""], outputs: ['"Extra"', '"Auto"'] }] : [])
  ];
  const doc: DmnDocument = {
    id: `wa-completion-definition-${caseType}`,
    name: "DRD",
    decisions: [
      {
        id: `wa-task-completion-demo-${caseType}`,
        name: options.name ?? "Demo completion",
        historyTimeToLive: "P30D",
        requires: ["Decision_LATEST"],
        table: {
          hitPolicy: options.hitPolicy ?? "COLLECT",
          inputs: [
            { label: "Event ID", inputVariable: "eventId", typeRef: "string", expression: "" },
            { label: "Closed", typeRef: "boolean", expressionLanguage: "feel", expression: "sort(caseData.items, function(x, y) x > y)" }
          ],
          outputs: [
            { label: "Task Type", name: "taskType", typeRef: "string" },
            { label: "Completion Mode", name: "completionMode", typeRef: "string" }
          ],
          rules
        }
      },
      {
        id: "Decision_LATEST",
        name: "LATEST",
        variable: { name: "LATEST", typeRef: "string" },
        requires: [],
        literal: { text: 'if (caseData.a != null) then "x" + caseData.a else null' }
      }
    ]
  };
  return writeDmn(doc);
}
