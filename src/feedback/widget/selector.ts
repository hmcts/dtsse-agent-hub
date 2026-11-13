/**
 * A CSS selector that finds one element again on a later load of the same page. Stable hooks first — an id a person
 * wrote, then a test id, a name or an ARIA label — and failing those a chain of `tag:nth-of-type()` steps from the
 * nearest ancestor that has one. Every candidate is checked to match exactly the element, so a selector that would
 * find two is never stored.
 */

/** `CSS.escape`, which jsdom lacks, from the CSSOM spec's serialisation of an identifier. */
export function cssEscape(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const character = value.charAt(index);
    if (code === 0) {
      out += "�";
    } else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f || (index === 0 && code >= 0x30 && code <= 0x39)) {
      out += `\\${code.toString(16)} `;
    } else if (index === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d) {
      out += `\\${code.toString(16)} `;
    } else if (index === 0 && value.length === 1 && code === 0x2d) {
      out += `\\${character}`;
    } else if (code >= 0x80 || code === 0x2d || code === 0x5f || /[0-9A-Za-z]/.test(character)) {
      out += character;
    } else {
      out += `\\${character}`;
    }
  }
  return out;
}

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Whether an id was made by a framework or a build rather than written by a person, and so is likely to differ on the
 * next load: React's `:r1:`, Ember's `ember123`, a hash, or a run of digits.
 */
export function looksGenerated(id: string): boolean {
  return (
    id.length > 40 ||
    /\d{3,}/.test(id) ||
    /[0-9a-f]{8,}/i.test(id) ||
    /[:]/.test(id) ||
    /^(ember|react|radix|headlessui|mui|yui|ext-gen|rc-|__)/i.test(id) ||
    /^\d/.test(id)
  );
}

const HOOK_ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-qa", "name", "aria-label"] as const;

function matchesOnly(root: ParentNode, selector: string, element: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === element;
  } catch {
    return false;
  }
}

function tagOf(element: Element): string {
  return element.localName;
}

function idStep(element: Element): string | undefined {
  const id = element.getAttribute("id");
  return id && !looksGenerated(id) ? `#${cssEscape(id)}` : undefined;
}

function nthStep(element: Element): string {
  const tag = tagOf(element);
  const parent = element.parentElement;
  if (parent === null) {
    return tag;
  }
  const same = Array.from(parent.children).filter((sibling) => sibling.localName === element.localName);
  return same.length === 1 ? tag : `${tag}:nth-of-type(${same.indexOf(element) + 1})`;
}

/** The selector for `element`, unique within its document. */
export function selectorFor(element: Element): string {
  const root = element.ownerDocument;
  const id = idStep(element);
  if (id !== undefined && matchesOnly(root, id, element)) {
    return id;
  }
  for (const attribute of HOOK_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) {
      const selector = `${tagOf(element)}[${attribute}=${quoted(value)}]`;
      if (matchesOnly(root, selector, element)) {
        return selector;
      }
    }
  }
  const steps: string[] = [];
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const anchorId = node === element ? undefined : idStep(node);
    if (anchorId !== undefined && matchesOnly(root, anchorId, node)) {
      steps.unshift(anchorId);
    } else {
      steps.unshift(nthStep(node));
    }
    const selector = steps.join(" > ");
    if (matchesOnly(root, selector, element)) {
      return selector;
    }
  }
  return steps.join(" > ");
}
