import type { Cell, Comparison, Cond, Expr, Scalar } from "./schema.ts";

type Token = { t: "str" | "num" | "id" | "kw" | "op"; v: string };

const KEYWORDS = new Set(["if", "then", "else", "and", "or", "null", "true", "false"]);
const OPERATORS = ["!=", "<=", ">=", "=", "<", ">", "(", ")", ".", "+", ","];

/** Lexes the FEEL subset the structured forms cover; anything outside it (escapes, calls, lists, `-`) fails. */
function lex(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) {
        return undefined;
      }
      const value = text.slice(i + 1, end);
      if (value.includes("\\")) {
        return undefined;
      }
      tokens.push({ t: "str", v: value });
      i = end + 1;
    } else if (/\d/.test(c)) {
      const match = /^\d+(\.\d+)?/.exec(text.slice(i));
      const literal = match?.[0] ?? "";
      if (String(Number(literal)) !== literal) {
        return undefined;
      }
      tokens.push({ t: "num", v: literal });
      i += literal.length;
    } else if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))?.[0] ?? "";
      tokens.push({ t: KEYWORDS.has(word) ? "kw" : "id", v: word });
      i += word.length;
    } else {
      const op = OPERATORS.find((o) => text.startsWith(o, i));
      if (!op) {
        return undefined;
      }
      tokens.push({ t: "op", v: op });
      i += op.length;
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
    if (token.t === "id") {
      let path = token.v;
      pos++;
      while (isOp(".")) {
        const next = tokens[pos + 1];
        if (next?.t !== "id") {
          throw new Fail();
        }
        path += `.${next.v}`;
        pos += 2;
      }
      return { n: "path", path };
    }
    throw new Fail();
  };
  const sum = (): Node => {
    const items = [primary()];
    while (isOp("+")) {
      pos++;
      items.push(primary());
    }
    return items.length === 1 ? (items[0] as Node) : { n: "plus", items };
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
    const items = [next()];
    while (isKw(word)) {
      pos++;
      items.push(next());
    }
    return items.length === 1 ? (items[0] as Node) : { n: word, items };
  };
  const expr = (): Node => {
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
  if (node.n === "cmp" && node.l.n === "path" && node.r.n === "lit") {
    const op = OPS[node.op];
    if (!op) {
      throw new Fail();
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
    default:
      return toCond(node);
  }
}

/** Collapses whitespace outside string literals, so equal FEEL written with different layout compares equal. */
export function normaliseFeel(text: string): string {
  let out = "";
  let inString = false;
  let pendingSpace = false;
  for (const c of text.trim()) {
    if (c === '"') {
      inString = !inString;
    }
    if (!inString && /\s/.test(c)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += c;
  }
  return out;
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
  const tokens = lex(trimmed);
  if (tokens) {
    try {
      return toExpr(parseNode(tokens));
    } catch (error) {
      if (!(error instanceof Fail)) {
        throw error;
      }
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
  if ("field" in expr && !("op" in expr)) {
    return expr.field;
  }
  return renderCond(expr as Cond);
}

function renderOperand(expr: Expr): string {
  const text = renderExpr(expr);
  const bare = typeof expr !== "object" || expr === null || ("field" in expr && !("op" in expr));
  return bare ? text : `(${text})`;
}

/** Parses an input entry (unary tests); an empty entry is `undefined`. */
export function parseCell(text: string): Cell | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const tokens = lex(trimmed);
  if (tokens) {
    const parsed = structuredCell(tokens);
    if (parsed) {
      return parsed;
    }
  }
  return { feel: trimmed };
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
