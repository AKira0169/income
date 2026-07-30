/* dom.ts — the element builder the whole UI is written in.

   Both the app and the date picker built their own copy of this; it is one
   helper now. Everything is created as real nodes rather than parsed from HTML
   strings, so user text can never be read as markup. */

export type Child = Node | string | number | null | undefined | false | Child[];

/** Attributes, plus two shorthands and DOM event handlers.

    - `class` sets className, `text` sets textContent
    - any `on*` key is added as a listener (`onclick`, `onChange`, …)
    - `true` writes a bare attribute, `false`/`null`/`undefined` writes nothing */
export interface ElementProps {
  class?: string | null | false;
  text?: string | number | null | false;
  [key: string]: unknown;
}

export function append(node: Node, children: Child): void {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (const child of children) append(node, child);
    return;
  }
  node.appendChild(
    typeof children === 'object' && 'nodeType' in children
      ? children
      : document.createTextNode(String(children))
  );
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElementProps | null,
  children?: Child
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key.startsWith('on')) {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG needs createElementNS, so it cannot go through el(). */
export function svg(attrs: Record<string, string>, children: SVGElement[] = []): SVGSVGElement {
  const node = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.appendChild(child);
  return node;
}

export function svgPath(attrs: Record<string, string>): SVGPathElement {
  const node = document.createElementNS(SVG_NS, 'path');
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
