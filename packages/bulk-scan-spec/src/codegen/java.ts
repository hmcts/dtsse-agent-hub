import { renderLogic } from "../logic.ts";
import type { Field, FormSpec, Operand, Rule } from "../schema.ts";
import { allFields, isNegation, isTickedTest } from "../schema.ts";
import type { OutputFile } from "./envelopes.ts";
import type { KeyModel } from "./model.ts";
import {
  anchoredPattern,
  directMappings,
  evaluateRules,
  exclusiveGroups,
  formatPattern,
  isQuestion,
  keyModels,
  mandatoryGroups,
  modelByKey,
  partitionRules,
  resolveRef,
  tickedValues
} from "./model.ts";
import { expectedFor, validData } from "./scenarios.ts";

export interface JavaOptions {
  /** Base package of the service's bulk scan code, e.g. uk.gov.hmcts.divorce.bulkscan. */
  basePackage: string;
  /** Prefix for generated class names; defaults to the form type in PascalCase. */
  classPrefix?: string;
}

const q = (s: string): string => JSON.stringify(s);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The Java field for a key. A key whose second letter is a capital after a lower-case first ("aSoleApplication") would get a getter
 * Jackson names "asoleApplication", so it takes the field name without that letter and an explicit @JsonProperty, as nfdiv does.
 */
export type JavaNames = Map<string, { field: string; alias?: string }>;

export function javaField(key: string, names?: JavaNames): { field: string; alias?: string } {
  const assigned = names?.get(key);
  if (assigned) {
    return assigned;
  }
  const field = naturalField(key);
  return field === key ? { field } : { field, alias: key };
}

/** The Java field for a key: underscores become a capital on the next letter, and a lower-case letter then a capital drops the first letter, as nfdiv's fields do. */
function naturalField(key: string): string {
  const camel = key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  return /^[a-z][A-Z]/.test(camel) ? low(camel.slice(1)) : low(camel);
}

/** The Java field for each key of a form, chosen once; two keys that would share a field are refused. */
export function javaNames(spec: FormSpec): JavaNames {
  const owner = new Map<string, string>();
  const names: JavaNames = new Map();
  for (const { key } of keyModels(spec)) {
    const field = naturalField(key);
    const clash = owner.get(field);
    if (clash) {
      throw new Error(`the keys "${clash}" and "${key}" both become the Java field "${field}"`);
    }
    owner.set(field, key);
    names.set(key, field === key ? { field } : { field, alias: key });
  }
  return names;
}

function prefix(spec: FormSpec, options: JavaOptions): string {
  const name = options.classPrefix ?? spec.form.formType;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error(`"${name}" is not usable as a Java class prefix: use letters and digits only, starting with a letter (--prefix)`);
  }
  return cap(name);
}

function pojoFields(models: KeyModel[], finalForOptional: boolean, names: JavaNames): string {
  return models
    .map((m) => {
      const { field, alias } = javaField(m.key, names);
      const kind = finalForOptional && !m.mandatory ? "private final String" : "private String";
      return `${alias ? `    @JsonProperty(${q(alias)})\n` : ""}    ${kind} ${field};`;
    })
    .join("\n");
}

const header = (pkg: string): string => `package ${pkg};\n\n`;

export function nfdivOcrDataFields(spec: FormSpec, options: JavaOptions, names: JavaNames = javaNames(spec)): OutputFile {
  const pkg = `${options.basePackage}.validation.data`;
  const content = `${header(pkg)}import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import ${options.basePackage}.endpoint.model.input.OcrDataField;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.fasterxml.jackson.core.JsonGenerator.Feature.AUTO_CLOSE_JSON_CONTENT;
import static java.util.Collections.emptyList;
import static java.util.stream.Collectors.toMap;

@JsonIgnoreProperties(ignoreUnknown = true)
@Data
@AllArgsConstructor
@NoArgsConstructor
@Builder
public class OcrDataFields {

${pojoFields(keyModels(spec), false, names)}

    public static OcrDataFields transformData(List<OcrDataField> ocrDataFields) {
        final ObjectMapper mapper = new ObjectMapper().disable(AUTO_CLOSE_JSON_CONTENT);
        final Map<String, String> map =
            Optional.ofNullable(ocrDataFields)
                .orElse(emptyList())
                .stream()
                .collect(toMap(OcrDataField::getName, entry -> Optional.ofNullable(entry.getValue()).orElse("")));
        return mapper.convertValue(map, OcrDataFields.class);
    }
}
`;
  return { path: "nfdiv/validation/data/OcrDataFields.java", content };
}

/** One check per mandatory group: nothing in it is answered, meaning no box ticked (an unticked box still carries its "false") or, for other inputs, every key blank. */
function mandatoryGroupChecks(spec: FormSpec, names: JavaNames): string {
  const models = modelByKey(spec);
  return mandatoryGroups(spec)
    .flatMap((g) => {
      const answered = g.keys.flatMap((k) => {
        const model = models.get(k);
        if (!model) {
          return [];
        }
        return model.inputType === "checkbox" ? [`ticked(${getter(k, names)}, ${tickedValues(model).map(q).join(", ")})`] : [`!isEmpty(${getter(k, names)})`];
      });
      return answered.length === 0
        ? []
        : [`        if (!(${answered.join(" || ")})) {\n            warnings.add(String.format(GROUP_EMPTY_WARNING, ${q(g.keys.join(", "))}));\n        }`];
    })
    .join("\n");
}

/** Java that is true when a key is unanswered: a tick box that is not ticked (an unticked box still sends "false"), or any other key that is empty. */
function blankJava(model: KeyModel, names: JavaNames): string {
  return model.inputType === "checkbox"
    ? `!ticked(${getter(model.key, names)}, ${tickedValues(model).map(q).join(", ")})`
    : `isEmpty(${getter(model.key, names)})`;
}

function getter(key: string, names: JavaNames): string {
  return `data.get${cap(javaField(key, names).field)}()`;
}

function conditionJava(spec: FormSpec, when: NonNullable<KeyModel["requiredWhen"]>, names: JavaNames): string | undefined {
  return conjunctionJava(spec, when, "data", names);
}

/**
 * How the sheet's case paths map onto the bulk-scan endpoints. success: validate-ocr SUCCESS, the transformation returns the case.
 * warning: validate-ocr WARNINGS (the envelope goes on), the transformation returns the case with the warnings in its data. exception:
 * validate-ocr WARNINGS too, because ERRORS would reject the envelope back to the supplier, and the transformation answers 422 so that
 * the orchestrator creates an exception record.
 */
function outcomeMessage(id: string, ref: string, outcome: string): string {
  return q(`Row ${id}, branch ${ref}: the transformation sheet gives case path ${outcome}`);
}

/** Java that records what the sheet's rules for a field give other than success, through `sink`; undefined if any branch is not code-able. */
function outcomeChain(
  spec: FormSpec,
  field: Field,
  names: JavaNames,
  v: string,
  sink: (outcome: "warning" | "exception", message: string) => string
): string[] | undefined {
  if (field.rules.length === 0 || field.rules.some((r) => r.action !== undefined)) {
    return undefined;
  }
  const id = field.id ?? field.keys[0] ?? "row";
  return buildChain(spec, field.rules, v, names, (rule, i, indent) => [
    rule.outcome === "warning" || rule.outcome === "exception"
      ? `${indent}${sink(rule.outcome, outcomeMessage(id, rule.ref ?? String(i + 1), rule.outcome))}`
      : `${indent}// ${rule.outcome ?? "no outcome stated"}`
  ]);
}

/**
 * Java for a list of rules. Branches chain with else; an independent branch starts a new chain; an unconditional rule is a statement
 * of its own, written after the chains so that it cannot cut one in two.
 */
function buildChain(
  spec: FormSpec,
  rules: Rule[],
  v: string,
  names: JavaNames,
  body: (rule: Rule, index: number, indent: string) => string[]
): string[] | undefined {
  const { chains, unconditional } = partitionRules(rules);
  const lines: string[] = [];
  for (const chain of chains) {
    for (const [n, rule] of chain.entries()) {
      const tests = (rule.whenAny ?? (rule.when ? [rule.when] : [])).map((g) => conjunctionJava(spec, g, v, names));
      if (tests.some((t) => t === undefined)) {
        return undefined;
      }
      const cond = tests.map((t) => (tests.length > 1 ? `(${t})` : t)).join(" || ");
      const head = rule.otherwise ? (n === 0 ? "{" : "} else {") : `${n === 0 ? "" : "} else "}if (${cond}) {`;
      lines.push(`        ${head}`, ...body(rule, rules.indexOf(rule), "            "));
    }
    lines.push("        }");
  }
  return [...lines, ...unconditional.flatMap((rule) => body(rule, rules.indexOf(rule), "        "))];
}

function ruleComments(fields: Field[]): string {
  return fields
    .filter((f) => f.rules.length > 0 || f.logicText)
    .map((f) => {
      const text = (f.rules.length > 0 ? renderLogic(f.rules, undefined) : (f.logicText ?? "")).split("\n").filter(Boolean).slice(0, 6);
      return `        // TODO(sheet ${f.id ?? f.keys[0] ?? "row"}): decide whether the validator needs this branch\n${text.map((l) => `        //   ${l}`).join("\n")}`;
    })
    .join("\n");
}

export function nfdivValidator(spec: FormSpec, options: JavaOptions, names: JavaNames = javaNames(spec)): OutputFile {
  const pkg = `${options.basePackage}.validation`;
  const models = keyModels(spec);
  const mandatory = models.filter((m) => m.mandatory);
  const conditional = models.filter((m) => !m.mandatory && m.requiredWhen);
  const allowed = models.filter((m) => m.allowed.length > 0);
  const formatted = models.filter((m) => formatPattern(m));
  const limited = models.filter((m) => m.maxLength);
  const minimal = models.filter((m) => m.minLength);
  const groups = exclusiveGroups(spec);
  const chains = allFields(spec).map((f) => ({ field: f, chain: outcomeChain(spec, f, names, "data", (_o, message) => `warnings.add(${message});`) }));
  const content = `${header(pkg)}import org.springframework.stereotype.Component;
import ${options.basePackage}.endpoint.data.OcrDataValidationRequest;
import ${options.basePackage}.endpoint.data.OcrValidationResponse;
import ${options.basePackage}.validation.data.OcrDataFields;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import static java.util.Collections.emptyList;
import static org.apache.commons.lang3.ObjectUtils.isEmpty;
import static ${options.basePackage}.endpoint.data.ValidationStatus.getValidationStatus;
import static ${options.basePackage}.validation.data.OcrDataFields.transformData;

@Component
public class OcrValidator {

    public static final String FIELD_EMPTY_OR_MISSING_WARNING = "Mandatory field '%s' should not be empty";
    public static final String FIELD_FORMAT_WARNING = "Field '%s' has a value that is not in the expected format: '%s'";
    public static final String FIELD_LENGTH_WARNING = "Field '%s' is longer than %d characters";
    public static final String FIELD_MIN_LENGTH_WARNING = "Field '%s' is shorter than %d characters";
    public static final String GROUP_EMPTY_WARNING = "At least one of the fields '%s' is required";
    public static final String FIELD_VALUE_NOT_ALLOWED_WARNING = "Field '%s' has unexpected value '%s'";
    public static final String GROUP_MULTIPLE_WARNING = "Only one of the fields '%s' may be ticked";

    private static final Map<String, Set<String>> ALLOWED_VALUES = new LinkedHashMap<>();
    private static final Map<String, Pattern> FORMAT_PATTERNS = new LinkedHashMap<>();
    private static final Map<String, Integer> LENGTH_LIMITS = new LinkedHashMap<>();
    private static final Map<String, Integer> LENGTH_MINIMUMS = new LinkedHashMap<>();

    static {
${allowed.map((m) => `        ALLOWED_VALUES.put(${q(m.key)}, Set.of(${[...m.allowed, ...(m.blankAllowed ? [""] : [])].map(q).join(", ")}));`).join("\n")}
${formatted.map((m) => `        FORMAT_PATTERNS.put(${q(m.key)}, Pattern.compile(${q(anchoredPattern(formatPattern(m) ?? ""))}));`).join("\n")}
${limited.map((m) => `        LENGTH_LIMITS.put(${q(m.key)}, ${m.maxLength});`).join("\n")}
${minimal.map((m) => `        LENGTH_MINIMUMS.put(${q(m.key)}, ${m.minLength});`).join("\n")}
    }

    public OcrValidationResponse validateExceptionRecord(String formType, OcrDataValidationRequest request) {
        OcrDataFields data = transformData(request == null ? null : request.getOcrDataFields());
        List<String> warnings = new ArrayList<>();

        validateMandatory(data, warnings);
        validateMandatoryGroups(data, warnings);
        validateConditional(data, warnings);
        validateAllowedValues(data, warnings);
        validateFormats(data, warnings);
        validateLengths(data, warnings);
        validateExclusiveGroups(data, warnings);
        validateSheetRules(data, warnings);

        return OcrValidationResponse.builder()
            .errors(emptyList())
            .warnings(warnings)
            .status(getValidationStatus(emptyList(), warnings))
            .build();
    }

    private void validateMandatory(OcrDataFields data, List<String> warnings) {
        Map<String, String> mandatory = new LinkedHashMap<>();
${mandatory
  .filter((m) => m.inputType !== "checkbox" || isQuestion(m))
  .map((m) => `        mandatory.put(${q(m.key)}, ${getter(m.key, names)});`)
  .join("\n")}
        mandatory.entrySet().stream()
            .filter(e -> isEmpty(e.getValue()))
            .forEach(e -> warnings.add(String.format(FIELD_EMPTY_OR_MISSING_WARNING, e.getKey())));
${mandatory
  .filter((m) => m.inputType === "checkbox" && !isQuestion(m))
  .map((m) => `        if (${blankJava(m, names)}) {\n            warnings.add(String.format(FIELD_EMPTY_OR_MISSING_WARNING, ${q(m.key)}));\n        }`)
  .join("\n")}
    }

    private void validateMandatoryGroups(OcrDataFields data, List<String> warnings) {
${mandatoryGroupChecks(spec, names)}
    }

    private void validateSheetRules(OcrDataFields data, List<String> warnings) {
${chains
  .map((c) => c.chain?.join("\n"))
  .filter(Boolean)
  .join("\n")}
${ruleComments(chains.filter((c) => !c.chain).map((c) => c.field))}
    }
${MATCHES}
    private void validateConditional(OcrDataFields data, List<String> warnings) {
${conditional
  .map((m) => {
    const cond = conditionJava(spec, m.requiredWhen ?? {}, names);
    return cond
      ? `        if (${cond} && ${blankJava(m, names)}) {\n            warnings.add(String.format(FIELD_EMPTY_OR_MISSING_WARNING, ${q(m.key)}));\n        }`
      : `        // TODO: ${m.key} is mandatory under a condition the sheet words by row id`;
  })
  .join("\n")}
    }

    private void validateAllowedValues(OcrDataFields data, List<String> warnings) {
        Map<String, String> values = new LinkedHashMap<>();
${allowed.map((m) => `        values.put(${q(m.key)}, ${getter(m.key, names)});`).join("\n")}
        values.forEach((key, value) -> {
            if (!isEmpty(value) && ALLOWED_VALUES.get(key).stream().noneMatch(allowed -> allowed.equalsIgnoreCase(value))) {
                warnings.add(String.format(FIELD_VALUE_NOT_ALLOWED_WARNING, key, value));
            }
        });
    }

    private void validateFormats(OcrDataFields data, List<String> warnings) {
        Map<String, String> values = new LinkedHashMap<>();
${formatted.map((m) => `        values.put(${q(m.key)}, ${getter(m.key, names)});`).join("\n")}
        values.forEach((key, value) -> {
            if (!isEmpty(value) && !FORMAT_PATTERNS.get(key).matcher(value).matches()) {
                warnings.add(String.format(FIELD_FORMAT_WARNING, key, value));
            }
        });
    }

    private void validateLengths(OcrDataFields data, List<String> warnings) {
        Map<String, String> values = new LinkedHashMap<>();
${[...new Map([...limited, ...minimal].map((m) => [m.key, m])).values()].map((m) => `        values.put(${q(m.key)}, ${getter(m.key, names)});`).join("\n")}
        values.forEach((key, value) -> {
            if (!isEmpty(value) && LENGTH_LIMITS.containsKey(key) && value.length() > LENGTH_LIMITS.get(key)) {
                warnings.add(String.format(FIELD_LENGTH_WARNING, key, LENGTH_LIMITS.get(key)));
            }
            if (!isEmpty(value) && LENGTH_MINIMUMS.containsKey(key) && value.length() < LENGTH_MINIMUMS.get(key)) {
                warnings.add(String.format(FIELD_MIN_LENGTH_WARNING, key, LENGTH_MINIMUMS.get(key)));
            }
        });
    }

    private void validateExclusiveGroups(OcrDataFields data, List<String> warnings) {
${groups
  .map(
    (g) =>
      `        if (${g.options.map((o) => `(ticked(${getter(o.key, names)}, ${o.ticked.map(q).join(", ")}) ? 1 : 0)`).join(" + ")} > 1) {\n            warnings.add(String.format(GROUP_MULTIPLE_WARNING, ${q(g.options.map((o) => o.key).join(", "))}));\n        }`
  )
  .join("\n")}
    }

}
`;
  return { path: "nfdiv/validation/OcrValidator.java", content };
}

const MATCHES = `
    private static boolean ticked(String actual, String... ticked) {
        for (String value : ticked) {
            if (value.equalsIgnoreCase(actual)) {
                return true;
            }
        }
        return false;
    }

    private static boolean matches(String actual, String expected) {
        String value = actual == null ? "" : actual;
        return expected == null ? value.isEmpty() : value.equalsIgnoreCase(expected);
    }
`;

function operandJava(spec: FormSpec, key: string, operand: Operand, v: string, names: JavaNames): string {
  const get = getter(key, names).replace("data.", `${v}.`);
  if (isTickedTest(operand)) {
    const model = modelByKey(spec).get(key);
    const test = `ticked(${get}, ${(model ? tickedValues(model) : ["true"]).map(q).join(", ")})`;
    return operand.ticked ? test : `!${test}`;
  }
  if (isNegation(operand)) {
    return `!matches(${get}, ${operand.not === null ? "null" : q(String(operand.not))})`;
  }
  return `matches(${get}, ${operand === null ? "null" : q(String(operand))})`;
}

function conjunctionJava(spec: FormSpec, c: Record<string, Operand>, v: string, names: JavaNames): string | undefined {
  const parts: string[] = [];
  for (const [key, operand] of Object.entries(c)) {
    if (/^ccd:/.test(key)) {
      return undefined;
    }
    if (/^\d/.test(key)) {
      const negated = isNegation(operand);
      const resolved = isTickedTest(operand) ? undefined : resolveRef(spec, key, negated ? operand.not : operand);
      if (!resolved || Object.keys(resolved).some((k) => !modelByKey(spec).has(k))) {
        return undefined;
      }
      const all = Object.entries(resolved).map(([k, o]) => operandJava(spec, k, o, v, names));
      // A sheet id stands for all its keys together, so its negation is the negation of their conjunction.
      parts.push(negated ? `!(${all.join(" && ")})` : all.join(" && "));
    } else if (modelByKey(spec).has(key)) {
      parts.push(operandJava(spec, key, operand, v, names));
    } else {
      return undefined;
    }
  }
  return parts.join(" && ");
}

/** Java for a field's rules when every condition tests OCR keys and every action sets a literal or copies a key; undefined otherwise. */
function ruleChain(spec: FormSpec, field: Field, names: JavaNames): string[] | undefined {
  const copied = field.rules.flatMap((r) => Object.values(r.set ?? {}).flatMap((v) => (v !== null && typeof v === "object" ? [v.from] : [])));
  if (!field.rules.some((r) => r.set) || field.rules.some((r) => r.action !== undefined) || copied.some((k) => !modelByKey(spec).has(k))) {
    return undefined;
  }
  return buildChain(spec, field.rules, "ocr", names, (rule, _i, indent) => [
    ...(rule.outcome && rule.outcome !== "success" ? [`${indent}// sheet: ${rule.outcome}`] : []),
    ...Object.entries(rule.set ?? {}).map(([ccd, v]) => {
      const value = v !== null && typeof v === "object" ? getter(v.from, names).replace("data.", "ocr.") : v === null ? "null" : q(String(v));
      return `${indent}caseData.put(${q(ccd)}, ${value});`;
    })
  ]);
}

export function nfdivTransformer(spec: FormSpec, options: JavaOptions, names: JavaNames = javaNames(spec)): OutputFile {
  const pkg = `${options.basePackage}.transformation`;
  const cls = `${prefix(spec, options)}FormToCaseTransformer`;
  const direct = directMappings(spec);
  const lines: string[] = [];
  for (const f of allFields(spec)) {
    if (f.role !== "field" || f.ccd.length === 0) {
      continue;
    }
    const id = f.id ?? f.keys[0] ?? "row";
    const chain = ruleChain(spec, f, names);
    const [ccd] = f.ccd;
    const [key] = f.keys;
    if (chain) {
      lines.push(`        // sheet ${id}`, ...chain);
    } else if (ccd && key && direct.get(ccd) === key && f.ccd.length === 1) {
      lines.push(`        caseData.put(${q(ccd)}, ${getter(key, names).replace("data.", "ocr.")});`);
    } else {
      lines.push(`        // TODO(sheet ${id}): ${f.ccd.join(", ")} <- ${f.keys.join(", ")}`);
    }
  }
  const outcomes = allFields(spec).flatMap(
    (f) =>
      outcomeChain(spec, f, names, "ocr", (o, message) => `${o === "exception" ? "transformationErrors" : "transformationWarnings"}.add(${message});`) ?? []
  );
  const usesOutcomes = outcomes.some((l) => /transformation(Errors|Warnings)\.add/.test(l));
  const commonPackage = options.basePackage.replace(/\.bulkscan$/, "");
  const content = `${header(pkg)}import org.springframework.stereotype.Component;
${usesOutcomes ? `import uk.gov.hmcts.ccd.sdk.type.ListValue;\nimport ${commonPackage}.common.exception.InvalidDataException;\n` : ""}import ${options.basePackage}.endpoint.model.input.OcrDataField;
import ${options.basePackage}.validation.data.OcrDataFields;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
${usesOutcomes ? "import java.util.UUID;\n" : ""}
@Component
public class ${cls} extends BulkScanFormTransformer {

    @Override
    Map<String, Object> runFormSpecificTransformation(List<OcrDataField> ocrDataFields, boolean automatedProcessCreation, String envelopeId) {
        OcrDataFields ocr = OcrDataFields.transformData(ocrDataFields);
        Map<String, Object> caseData = new HashMap<>();
${lines.join("\n")}
${
  usesOutcomes
    ? `        List<String> transformationWarnings = new ArrayList<>();
        List<String> transformationErrors = new ArrayList<>();
${outcomes.join("\n")}
        if (!transformationErrors.isEmpty()) {
            // The orchestrator answers a 422 by creating an exception record for a caseworker.
            throw new InvalidDataException("The transformation sheet puts the record in exception", null, transformationErrors);
        }
        caseData.put("warnings", transformationWarnings.stream()
            .map(w -> ListValue.<String>builder().id(UUID.randomUUID().toString()).value(w).build())
            .toList());
`
    : ""
}        return caseData;
    }
${MATCHES}}
`;
  return { path: `nfdiv/transformation/${cls}.java`, content };
}

function builderCalls(data: Record<string, string>, names: JavaNames): string {
  return Object.entries(data)
    .map(([k, v]) => `            .${javaField(k, names).field}(${q(v)})`)
    .join("\n");
}

export function nfdivTests(spec: FormSpec, options: JavaOptions, names: JavaNames = javaNames(spec)): OutputFile[] {
  const models = keyModels(spec);
  const valid = validData(spec);
  const cls = `${prefix(spec, options)}FormToCaseTransformer`;
  const mandatory = models.filter((m) => m.mandatory);
  const expected = expectedFor(spec, valid);
  // The sample is asserted free of every warning only when the sheet expects none and nothing is left unchecked; otherwise only the checks that
  // do not depend on the sheet's rules are asserted.
  const sampleExpectedClean = expected.validation === "success" && expected.unchecked.length === 0;
  const validTest = `${header(`${options.basePackage}.validation`)}import org.junit.jupiter.api.Test;
import ${options.basePackage}.endpoint.data.OcrDataValidationRequest;
import ${options.basePackage}.endpoint.model.input.OcrDataField;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class OcrValidatorGeneratedTest {

    private final OcrValidator validator = new OcrValidator();

    private OcrDataValidationRequest request(String... overrides) {
        List<OcrDataField> fields = new ArrayList<>();
${Object.entries(valid)
  .map(([k, v]) => `        fields.add(new OcrDataField(${q(k)}, ${q(v)}));`)
  .join("\n")}
        for (int i = 0; i < overrides.length; i += 2) {
            final String name = overrides[i];
            fields.removeIf(f -> f.getName().equals(name));
            fields.add(new OcrDataField(name, overrides[i + 1]));
        }
        return new OcrDataValidationRequest(fields);
    }

${
  sampleExpectedClean
    ? `    @Test
    void shouldReturnNoWarningsWhenEverySampleValueIsValid() {
        assertThat(validator.validateExceptionRecord(${q(spec.form.formType)}, request()).getWarnings()).isEmpty();
    }`
    : `    @Test
    void shouldStillAcceptTheSampleSubmissionsKeysAndFormats() {
        assertThat(validator.validateExceptionRecord(${q(spec.form.formType)}, request()).getWarnings())
            .noneMatch(w -> w.startsWith("Mandatory field") || w.contains("not in the expected format") || w.contains("unexpected value"));
    }`
}
${mandatory
  .map(
    (m) => `
    @Test
    void shouldWarnWhen${cap(javaField(m.key, names).field)}IsEmpty() {
        assertThat(validator.validateExceptionRecord(${q(spec.form.formType)}, request(${q(m.key)}, "")).getWarnings())
            .contains(String.format(OcrValidator.FIELD_EMPTY_OR_MISSING_WARNING, ${q(m.key)}));
    }`
  )
  .join("\n")}
${models
  .filter((m) => m.allowed.length > 0)
  .map(
    (m) => `
    @Test
    void shouldWarnWhen${cap(javaField(m.key, names).field)}HasAnUnexpectedValue() {
        assertThat(validator.validateExceptionRecord(${q(spec.form.formType)}, request(${q(m.key)}, "not-a-listed-value")).getWarnings())
            .contains(String.format(OcrValidator.FIELD_VALUE_NOT_ALLOWED_WARNING, ${q(m.key)}, "not-a-listed-value"));
    }`
  )
  .join("\n")}
}
`;
  const direct = directMappings(spec);
  const mapped = [...direct.entries()].map(([ccd, key]) => [ccd, key, valid[key] ?? ""] as const);
  const derived = allFields(spec).flatMap((f) => {
    if (f.role !== "field" || !ruleChain(spec, f, names)) {
      return [];
    }
    const verdict = evaluateRules(spec, f, valid);
    return Object.entries(verdict?.set ?? {}).flatMap(([ccd, value]) =>
      value === null || value === undefined ? [] : [[f.id ?? f.keys[0] ?? "row", ccd, String(value)] as const]
    );
  });
  const transformerTest = `${header(`${options.basePackage}.transformation`)}import org.junit.jupiter.api.Test;
import ${options.basePackage}.endpoint.model.input.OcrDataField;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ${cls}GeneratedTest {

    private Map<String, Object> transform() {
        List<OcrDataField> fields = List.of(
${Object.entries(valid)
  .map(([k, v]) => `            new OcrDataField(${q(k)}, ${q(v)})`)
  .join(",\n")}
        );
        return new ${cls}().runFormSpecificTransformation(fields, false, "envelope-id");
    }

    @Test
    void shouldCopyEachDirectlyMappedOcrValueIntoItsCcdField() {
        Map<String, Object> caseData = transform();
${mapped.map(([ccd, , value]) => `        assertThat(caseData).containsEntry(${q(ccd)}, ${q(value)});`).join("\n")}
    }

    @Test
    void shouldApplyTheSheetsRulesToTheSampleSubmission() {
        Map<String, Object> caseData = transform();
${derived.map(([id, ccd, value]) => `        assertThat(caseData).as("sheet ${id}").containsEntry(${q(ccd)}, ${q(value)});`).join("\n")}
    }
}
`;
  return [
    { path: "nfdiv/test/OcrValidatorGeneratedTest.java", content: validTest },
    { path: `nfdiv/test/${cls}GeneratedTest.java`, content: transformerTest }
  ];
}

export function probateFiles(spec: FormSpec, options: JavaOptions): OutputFile[] {
  const names = javaNames(spec);
  const models = keyModels(spec);
  const pkg = `${options.basePackage}.model.exceptionrecord`;
  const fields = `${header(pkg)}import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;

@Builder
@Data
@AllArgsConstructor
public class ExceptionRecordOCRFields {

${pojoFields(models, true, names)}
}
`;
  const validator = `${header(pkg)}import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ExceptionRecordOCRFieldsValidator {

    private ExceptionRecordOCRFieldsValidator() {
    }

    public static List<String> missingMandatoryFields(ExceptionRecordOCRFields fields) {
        Map<String, String> mandatory = new LinkedHashMap<>();
${models
  .filter((m) => m.mandatory)
  .map((m) => `        mandatory.put(${q(m.key)}, fields.get${cap(javaField(m.key, names).field)}());`)
  .join("\n")}
        List<String> missing = new ArrayList<>();
        mandatory.forEach((name, value) -> {
            if (value == null || value.isBlank()) {
                missing.add(name);
            }
        });
        return missing;
    }
}
`;
  const valid = validData(spec);
  const test = `${header(pkg)}import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ExceptionRecordOCRFieldsValidatorGeneratedTest {

    @Test
    void shouldReportNothingMissingWhenEveryMandatoryFieldIsSet() {
        ExceptionRecordOCRFields fields = ExceptionRecordOCRFields.builder()
${builderCalls(valid, names)}
            .build();
        assertThat(ExceptionRecordOCRFieldsValidator.missingMandatoryFields(fields)).isEmpty();
    }

    @Test
    void shouldNameEveryMandatoryFieldWhenNothingIsSet() {
        ExceptionRecordOCRFields fields = ExceptionRecordOCRFields.builder().build();
        assertThat(ExceptionRecordOCRFieldsValidator.missingMandatoryFields(fields)).isEqualTo(List.of(${models
          .filter((m) => m.mandatory)
          .map((m) => q(m.key))
          .join(", ")}));
    }
}
`;
  return [
    { path: "probate/ExceptionRecordOCRFields.java", content: fields },
    { path: "probate/ExceptionRecordOCRFieldsValidator.java", content: validator },
    { path: "probate/ExceptionRecordOCRFieldsValidatorGeneratedTest.java", content: test }
  ];
}

export function nfdivFiles(spec: FormSpec, options: JavaOptions): OutputFile[] {
  const names = javaNames(spec);
  return [
    nfdivOcrDataFields(spec, options, names),
    nfdivValidator(spec, options, names),
    nfdivTransformer(spec, options, names),
    ...nfdivTests(spec, options, names)
  ];
}
