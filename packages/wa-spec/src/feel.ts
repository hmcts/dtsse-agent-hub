import type { Cell, CompareOp, Comparison, Cond, Expr, Scalar } from "./schema.ts";

/** `raw` is anything outside the structured forms: an escaped string, a number written another way, or a character the grammar lacks. */
type Token = { t: "str" | "num" | "id" | "kw" | "op" | "raw"; v: string; text: string };

const KEYWORDS = new Set(["if", "then", "else", "and", "or", "null", "true", "false"]);
const OPERATORS = ["!=", "<=", ">=", "=", "<", ">", "(", ")", ".", "+", "-", ","];

/** FEEL's built-in functions whose names are several words; the lexer sees each word apart. */
const MULTI_WORD_FUNCTIONS = [
  "date and time",
  "list contains",
  "get entries",
  "starts with",
  "ends with",
  "string length",
  "substring before",
  "substring after",
  "upper case",
  "lower case"
];

/** Splits FEEL into tokens, keeping each token's source text. Every input lexes. */
function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (t: Token["t"], v: string, source: string) => {
    tokens.push({ t, v, text: source });
    i += source.length;
  };
  while (i < text.length) {
    const c = text.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"') {
      let end = i + 1;
      while (end < text.length && text.charAt(end) !== '"') {
        end += text.charAt(end) === "\\" ? 2 : 1;
      }
      const source = text.slice(i, end + 1);
      const value = source.slice(1, -1);
      push(end >= text.length || value.includes("\\") ? "raw" : "str", value, source);
    } else if (/\d/.test(c)) {
      const literal = /^\d+(\.\d+)?/.exec(text.slice(i))?.[0] ?? "";
      push(String(Number(literal)) === literal ? "num" : "raw", literal, literal);
    } else if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_]\w*/.exec(text.slice(i))?.[0] ?? "";
      push(KEYWORDS.has(word) ? "kw" : "id", word, word);
    } else {
      const op = OPERATORS.find((o) => text.startsWith(o, i));
      push(op ? "op" : "raw", op ?? c, op ?? c);
    }
  }
  return tokens;
}

function literalOf(token: Token | undefined): { value: Scalar } | undefined {
  if (!token) {
    return undefined;
  }
  if (token.t === "str") {
    return { value: token.v };
  }
  if (token.t === "num") {
    return { value: Number(token.v) };
  }
  if (token.t === "kw" && (token.v === "true" || token.v === "false")) {
    return { value: token.v === "true" };
  }
  if (token.t === "kw" && token.v === "null") {
    return { value: null };
  }
  return undefined;
}

type Node =
  | { n: "lit"; value: Scalar }
  | { n: "path"; path: string }
  | { n: "if"; c: Node; a: Node; b: Node }
  | { n: "plus"; items: Node[] }
  | { n: "minus"; l: Node; r: Node }
  | { n: "call"; name: string; args: Node[] }
  | { n: "quantifier"; quantifier: "some" | "every"; variable: string; over: Node; satisfies: Node }
  | { n: "cmp"; op: string; l: Node; r: Node }
  | { n: "and" | "or"; items: Node[] };

class Fail extends Error {}

function parseNode(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()?.v === v;
  const isKw = (v: string) => peek()?.t === "kw" && peek()?.v === v;
  const expectKw = (v: string) => {
    if (!isKw(v)) {
      throw new Fail();
    }
    pos++;
  };

  /** The name of the function a call at `pos` names, when the words there are followed by `(`. */
  const functionName = (): string | undefined => {
    const first = peek();
    if (first?.t !== "id") {
      return undefined;
    }
    const known = MULTI_WORD_FUNCTIONS.find(
      (name) => name.split(" ").every((word, i) => tokens[pos + i]?.v === word) && tokens[pos + name.split(" ").length]?.v === "("
    );
    return known ?? (tokens[pos + 1]?.t === "op" && tokens[pos + 1]?.v === "(" ? first.v : undefined);
  };
  const primary = (): Node => {
    const token = peek();
    if (!token) {
      throw new Fail();
    }
    if (isOp("(")) {
      pos++;
      const inner = expr();
      if (!isOp(")")) {
        throw new Fail();
      }
      pos++;
      return inner;
    }
    const literal = literalOf(token);
    if (literal) {
      pos++;
      return { n: "lit", value: literal.value };
    }
    const name = functionName();
    if (name) {
      pos += name.split(" ").length + 1;
      const args: Node[] = [];
      while (!isOp(")")) {
        if (args.length > 0) {
          if (!isOp(",")) {
            throw new Fail();
          }
          pos++;
        }
        args.push(expr());
      }
      pos++;
      return { n: "call", name, args };
    }
    if (token.t === "id") {
      let path = token.v;
      pos++;
      for (;;) {
        if (isOp(".") && tokens[pos + 1]?.t === "id") {
          path += `.${tokens[pos + 1]?.v}`;
          pos += 2;
        } else if (peek()?.text === "[" && tokens[pos + 1]?.t === "num" && tokens[pos + 2]?.text === "]") {
          path += `[${tokens[pos + 1]?.v}]`;
          pos += 3;
        } else if (isOp(".")) {
          throw new Fail();
        } else {
          return { n: "path", path };
        }
      }
    }
    throw new Fail();
  };
  const sum = (): Node => {
    let left = primary();
    while (isOp("+") || isOp("-")) {
      const plus = isOp("+");
      pos++;
      const right = primary();
      left = !plus ? { n: "minus", l: left, r: right } : left.n === "plus" ? { n: "plus", items: [...left.items, right] } : { n: "plus", items: [left, right] };
    }
    return left;
  };
  const comparison = (): Node => {
    const left = sum();
    const token = peek();
    if (token?.t === "op" && ["=", "!=", "<", "<=", ">", ">="].includes(token.v)) {
      pos++;
      return { n: "cmp", op: token.v, l: left, r: sum() };
    }
    return left;
  };
  const chain = (word: "and" | "or", next: () => Node): Node => {
    const items: Node[] = [];
    const add = (node: Node) => (node.n === word ? items.push(...node.items) : items.push(node));
    add(next());
    while (isKw(word)) {
      pos++;
      add(next());
    }
    return items.length === 1 ? (items[0] as Node) : { n: word, items };
  };
  const expr = (): Node => {
    const [quantifier, variable, within] = [peek(), tokens[pos + 1], tokens[pos + 2]];
    if ((quantifier?.v === "some" || quantifier?.v === "every") && quantifier.t === "id" && variable?.t === "id" && within?.v === "in") {
      pos += 3;
      const over = sum();
      if (peek()?.v !== "satisfies") {
        throw new Fail();
      }
      pos++;
      return { n: "quantifier", quantifier: quantifier.v, variable: variable.v, over, satisfies: expr() };
    }
    if (isKw("if")) {
      pos++;
      const c = chain("or", () => chain("and", comparison));
      expectKw("then");
      const a = expr();
      expectKw("else");
      return { n: "if", c, a, b: expr() };
    }
    return chain("or", () => chain("and", comparison));
  };
  const result = expr();
  if (pos !== tokens.length) {
    throw new Fail();
  }
  return result;
}

const OPS: Record<string, Comparison> = { "=": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };
const OP_TEXT: Record<Comparison, string> = { eq: "=", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=", exists: "!= null", notExists: "= null" };

function toCond(node: Node): Cond {
  if (node.n === "and" || node.n === "or") {
    const items = node.items.map(toCond);
    return node.n === "and" ? { all: items } : { any: items };
  }
  if (node.n === "cmp") {
    const op = OPS[node.op];
    if (!op) {
      throw new Fail();
    }
    if (node.l.n !== "path" || node.r.n !== "lit") {
      return { left: toExpr(node.l), op: op as CompareOp, right: toExpr(node.r) };
    }
    if (node.r.value === null) {
      if (op === "eq") {
        return { field: node.l.path, op: "notExists" };
      }
      if (op === "ne") {
        return { field: node.l.path, op: "exists" };
      }
      throw new Fail();
    }
    return { field: node.l.path, op, value: node.r.value };
  }
  if (node.n === "path" || node.n === "call" || node.n === "lit" || node.n === "quantifier") {
    return { truthy: toExpr(node) };
  }
  throw new Fail();
}

function toExpr(node: Node): Expr {
  switch (node.n) {
    case "lit":
      return node.value;
    case "path":
      return { field: node.path };
    case "if":
      return { if: toCond(node.c), use: toExpr(node.a), otherwise: toExpr(node.b) };
    case "plus":
      return { plus: node.items.map(toExpr) };
    case "minus":
      return { minus: [toExpr(node.l), toExpr(node.r)] };
    case "call":
      return { call: node.name, args: node.args.map(toExpr) };
    case "quantifier":
      return { quantifier: node.quantifier, variable: node.variable, over: toExpr(node.over), satisfies: toExpr(node.satisfies) };
    default:
      return toCond(node);
  }
}

/** Drops whitespace outside string literals, keeping one space only between two words, so FEEL written with different layout compares equal. */
export function normaliseFeel(text: string): string {
  const word = /^[\p{L}\p{N}_]$/u;
  return lex(text)
    .map((token, i, tokens) => {
      const before = tokens[i - 1]?.text.at(-1) ?? "";
      return word.test(before) && word.test(token.text.charAt(0)) ? ` ${token.text}` : token.text;
    })
    .join("");
}

export function isStructured(expr: Expr): boolean {
  return !(typeof expr === "object" && expr !== null && "feel" in expr);
}

/** Parses an output entry, input expression or literal expression; unparseable FEEL is kept verbatim as `{feel}`. */
export function parseExpr(text: string): Expr | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    return toExpr(parseNode(lex(trimmed)));
  } catch (error) {
    if (!(error instanceof Fail)) {
      throw error;
    }
  }
  return { feel: trimmed };
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderScalar(value: Scalar): string {
  if (typeof value === "string") {
    return quote(value);
  }
  return String(value);
}

function renderCond(cond: Cond, inAll = false): string {
  if ("all" in cond) {
    return cond.all.map((c) => renderCond(c, true)).join(" and ");
  }
  if ("any" in cond) {
    const text = cond.any.map((c) => renderCond(c)).join(" or ");
    return inAll ? `(${text})` : text;
  }
  if ("truthy" in cond) {
    return renderOperand(cond.truthy);
  }
  if ("left" in cond) {
    return `${renderOperand(cond.left)} ${OP_TEXT[cond.op]} ${renderOperand(cond.right)}`;
  }
  if (cond.op === "exists" || cond.op === "notExists") {
    return `${cond.field} ${OP_TEXT[cond.op]}`;
  }
  return `${cond.field} ${OP_TEXT[cond.op]} ${renderScalar(cond.value ?? null)}`;
}

export function renderExpr(expr: Expr | undefined): string {
  if (expr === undefined) {
    return "";
  }
  if (typeof expr !== "object" || expr === null) {
    return renderScalar(expr);
  }
  if ("feel" in expr) {
    return expr.feel;
  }
  if ("if" in expr) {
    return `if (${renderCond(expr.if)}) then ${renderExpr(expr.use)} else ${renderExpr(expr.otherwise)}`;
  }
  if ("plus" in expr) {
    return expr.plus.map((item) => renderOperand(item)).join(" + ");
  }
  if ("minus" in expr) {
    return expr.minus.map((item) => renderOperand(item)).join(" - ");
  }
  if ("quantifier" in expr) {
    return `(${expr.quantifier} ${expr.variable} in ${renderOperand(expr.over)} satisfies ${renderExpr(expr.satisfies)})`;
  }
  if ("call" in expr) {
    return `${expr.call}(${expr.args.map((arg) => renderExpr(arg)).join(", ")})`;
  }
  if ("field" in expr && !("op" in expr)) {
    return expr.field;
  }
  return renderCond(expr as Cond);
}

function renderOperand(expr: Expr): string {
  const text = renderExpr(expr);
  const bare = typeof expr !== "object" || expr === null || ("field" in expr && !("op" in expr)) || "call" in expr || "truthy" in expr || "quantifier" in expr;
  return bare ? text : `(${text})`;
}

/** Parses an input entry (unary tests); an empty entry is `undefined`. */
export function parseCell(text: string): Cell | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  return structuredCell(lex(trimmed)) ?? { feel: trimmed };
}

function literalList(tokens: Token[]): Scalar[] | undefined {
  const values: Scalar[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i % 2 === 1) {
      if (token?.t !== "op" || token.v !== ",") {
        return undefined;
      }
    } else {
      const literal = literalOf(token);
      if (!literal || literal.value === null) {
        return undefined;
      }
      values.push(literal.value);
    }
  }
  return tokens.length % 2 === 1 && values.length > 0 ? values : undefined;
}

function structuredCell(tokens: Token[]): Cell | undefined {
  const list = literalList(tokens);
  if (list) {
    return { in: list };
  }
  const [first, second, ...rest] = tokens;
  if (first?.t === "id" && first.v === "not" && second?.v === "(" && tokens.at(-1)?.v === ")") {
    const inner = literalList(rest.slice(0, -1));
    return inner ? { notIn: inner } : undefined;
  }
  if (first?.t === "op" && ["<", "<=", ">", ">="].includes(first.v) && tokens.length === 2) {
    const literal = literalOf(second);
    if (literal && (typeof literal.value === "number" || typeof literal.value === "string")) {
      return { cmp: first.v as "<" | "<=" | ">" | ">=", value: literal.value };
    }
  }
  return undefined;
}

export function renderCell(cell: Cell | undefined): string {
  if (cell === undefined) {
    return "";
  }
  if ("in" in cell) {
    return cell.in.map(renderScalar).join(", ");
  }
  if ("notIn" in cell) {
    return `not(${cell.notIn.map(renderScalar).join(", ")})`;
  }
  if ("cmp" in cell) {
    return `${cell.cmp} ${renderScalar(cell.value)}`;
  }
  return cell.feel;
}

/** A canonical string for an output entry or expression, equal for entries that differ only in layout. */
export function canonicalExpr(text: string): string {
  const expr = parseExpr(text);
  if (expr === undefined) {
    return "";
  }
  return JSON.stringify(typeof expr === "object" && expr !== null && "feel" in expr ? { feel: normaliseFeel(expr.feel) } : expr);
}

export function canonicalCell(text: string): string {
  const cell = parseCell(text);
  if (cell === undefined) {
    return "";
  }
  return JSON.stringify("feel" in cell ? { feel: normaliseFeel(cell.feel) } : cell);
}
