import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

// Fills {tags} in a LibreOffice/OpenDocument text (.odt) template, natively — the
// file stays an .odt, so a later PDF export is LibreOffice's own format rather
// than a lossy Word -> LibreOffice conversion. Supports the same tag kinds as the
// Word templates:
//   {value}                    a value (missing values render empty)
//   {#name} … {/name}          loop over a list, or show once when truthy
//   {^name} … {/name}          show once when falsy / empty
// A loop can sit inline within one paragraph, around whole paragraphs, or around
// table rows (open and close tag in different cells of a row, or in different rows).

const NS = {
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
};
const LOOP = 'tplloop'; // synthetic wrapper element for a loop range (removed on render)

// The DOM node types are used loosely on purpose (xmldom's typings are partial).
type N = any;
type Data = Record<string, unknown>;
type Scope = { data: unknown; parent: Scope | null };

const isEl = (n: N) => !!n && n.nodeType === 1;
const isPara = (n: N) => isEl(n) && n.namespaceURI === NS.text && (n.localName === 'p' || n.localName === 'h');

function collect<T>(list: ArrayLike<T>): T[] {
  const out: T[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

function allTextNodes(root: N): N[] {
  const out: N[] = [];
  const walk = (n: N) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.push(c);
      else if (c.nodeType === 1) walk(c);
    }
  };
  walk(root);
  return out;
}

const setText = (n: N, v: string) => {
  n.data = v;
  n.nodeValue = v;
};

// 1) LibreOffice splits text into several spans when formatting changes, which can
//    cut a {tag} in two. Pull each such tag back into a single text node.
function mergeSplitTags(doc: N) {
  const paras = [...collect(doc.getElementsByTagNameNS(NS.text, 'p')), ...collect(doc.getElementsByTagNameNS(NS.text, 'h'))];
  for (const p of paras) {
    // Text that belongs to this paragraph itself (not to nested paragraphs, e.g. in frames).
    const nodes: N[] = [];
    const walk = (n: N) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) nodes.push(c);
        else if (c.nodeType === 1 && !isPara(c)) walk(c);
      }
    };
    walk(p);
    if (nodes.length < 2) continue;

    const full = nodes.map((n) => n.data as string).join('');
    const owner: number[] = [];
    nodes.forEach((n, k) => {
      for (let i = 0; i < n.data.length; i++) owner.push(k);
    });
    let changed = false;
    const re = /\{[^{}]*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(full))) {
      const s = m.index;
      const e = s + m[0].length;
      if (owner[s] !== owner[e - 1]) {
        const k = owner[s];
        for (let i = s; i < e; i++) owner[i] = k;
        changed = true;
      }
    }
    if (!changed) continue;
    const parts = nodes.map(() => '');
    for (let i = 0; i < full.length; i++) parts[owner[i]] += full[i];
    nodes.forEach((n, k) => setText(n, parts[k]));
  }
}

interface Marker {
  kind: '#' | '^' | '/';
  name: string;
  node: N;
}

// 2) Put every block marker ({#x}, {^x}, {/x}) in a text node of its own.
function isolateMarkers(doc: N): Marker[] {
  const markers: Marker[] = [];
  const re = /\{([#^/])([\w.]+)\}/g;
  for (const t of allTextNodes(doc.documentElement)) {
    const s: string = t.data;
    if (!s.includes('{')) continue;
    const matches = [...s.matchAll(re)];
    if (matches.length === 0) continue;
    const parent = t.parentNode;
    let last = 0;
    const add = (txt: string, marker?: { kind: Marker['kind']; name: string }) => {
      if (!txt) return;
      const node = doc.createTextNode(txt);
      parent.insertBefore(node, t);
      if (marker) markers.push({ ...marker, node });
    };
    for (const m of matches) {
      add(s.slice(last, m.index));
      add(m[0], { kind: m[1] as Marker['kind'], name: m[2] });
      last = (m.index as number) + m[0].length;
    }
    add(s.slice(last));
    parent.removeChild(t);
  }
  return markers;
}

function ancestors(n: N): Set<N> {
  const set = new Set<N>();
  for (let x = n; x; x = x.parentNode) set.add(x);
  return set;
}
function commonAncestor(a: N, b: N): N {
  const anc = ancestors(a);
  for (let x = b; x; x = x.parentNode) if (anc.has(x)) return x;
  return null;
}
// The child of `anc` that contains `n` (n is a strict descendant of anc).
function childOf(anc: N, n: N): N {
  let x = n;
  while (x && x.parentNode !== anc) x = x.parentNode;
  return x;
}
function closestPara(n: N): N {
  for (let x = n.parentNode; x; x = x.parentNode) if (isPara(x)) return x;
  return null;
}
// Siblings from start to end inclusive; empty when end isn't reachable from start.
function siblingRange(start: N, end: N): N[] {
  if (!start || !end) return [];
  const out: N[] = [];
  for (let n = start; n; n = n.nextSibling) {
    out.push(n);
    if (n === end) return out;
  }
  return [];
}
// True when the paragraph holds nothing but this marker (plus whitespace) — such a
// paragraph is dropped together with its marker instead of leaving an empty line.
function isMarkerOnly(para: N, marker: N): boolean {
  if (collect(para.getElementsByTagNameNS(NS.draw, '*')).length > 0) return false;
  return allTextNodes(para).every((t) => t === marker || !String(t.data).trim());
}

// 3) Turn each {#x} … {/x} pair into a wrapper element around the nodes it covers.
function wrapPair(doc: N, open: Marker, close: Marker) {
  const o = open.node;
  const c = close.node;
  const po = closestPara(o);
  const pc = closestPara(c);
  const para = po && pc && po !== pc ? commonAncestor(po, pc) : null;
  const blockLoop = !!para && para !== po && para !== pc;

  let range: N[] = [];
  const dropParas: N[] = [];
  let wholeWrap: N = null; // an element to wrap as a whole (a table row)

  if (blockLoop) {
    if (para.namespaceURI === NS.table && para.localName === 'table-row') {
      wholeWrap = para; // markers in different cells of one row: repeat the row
    } else {
      const a = childOf(para, po);
      const b = childOf(para, pc);
      let start = a;
      let end = b;
      if (a === po && isMarkerOnly(po, o)) {
        dropParas.push(po);
        start = po.nextSibling;
      }
      if (b === pc && isMarkerOnly(pc, c)) {
        dropParas.push(pc);
        end = pc.previousSibling;
      }
      range = siblingRange(start, end);
    }
  } else {
    // Inline: both markers inside one paragraph (possibly at different span depths).
    // Same rule as the Word templates: a loop/condition written within a line stays
    // inline (an empty line remains when it is false); only markers on their OWN
    // lines (the block case above) repeat or remove whole lines.
    const lca = commonAncestor(o, c);
    const a = childOf(lca, o);
    const b = childOf(lca, c);
    const start = a === o ? o.nextSibling : a;
    const end = b === c ? c.previousSibling : b;
    range = siblingRange(start, end);
  }

  const wrapper = doc.createElement(LOOP);
  wrapper.setAttribute('name', open.name);
  wrapper.setAttribute('inv', open.kind === '^' ? '1' : '0');
  if (wholeWrap) {
    wholeWrap.parentNode.insertBefore(wrapper, wholeWrap);
    wrapper.appendChild(wholeWrap);
  } else if (range.length > 0) {
    range[0].parentNode.insertBefore(wrapper, range[0]);
    for (const n of range) wrapper.appendChild(n);
  }

  o.parentNode.removeChild(o);
  c.parentNode.removeChild(c);
  for (const p of dropParas) p.parentNode.removeChild(p);
}

// 4) Render with data. Names resolve in the current loop item first, then outward.
function lookup(scope: Scope | null, name: string): unknown {
  for (let s = scope; s; s = s.parent) {
    const d = s.data as Record<string, unknown> | null;
    // Own properties only, so a tag like {constructor} or {__proto__} never resolves.
    if (d && typeof d === 'object' && Object.hasOwn(d, name) && d[name] !== undefined) return d[name];
  }
  return undefined;
}

const TAG = /\{([\w.]+)\}/g;

function renderText(node: N, scope: Scope, doc: N): N[] {
  const s: string = node.data;
  if (!s.includes('{')) return [node.cloneNode(false)];
  const out: N[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(doc.createTextNode(buf));
      buf = '';
    }
  };
  let last = 0;
  for (const m of s.matchAll(TAG)) {
    buf += s.slice(last, m.index);
    const v = lookup(scope, m[1]);
    const str = v == null || typeof v === 'object' ? '' : String(v);
    str.split(/\r\n|\r|\n/).forEach((line, i) => {
      if (i > 0) {
        flush();
        out.push(doc.createElementNS(NS.text, 'text:line-break'));
      }
      buf += line;
    });
    last = (m.index as number) + m[0].length;
  }
  buf += s.slice(last);
  flush();
  return out;
}

function render(node: N, scope: Scope, doc: N): N[] {
  if (node.nodeType === 3) return renderText(node, scope, doc);
  if (node.nodeType !== 1) return [node.cloneNode(true)];

  if (node.nodeName === LOOP) {
    const name = node.getAttribute('name');
    const inverted = node.getAttribute('inv') === '1';
    const v = lookup(scope, name);
    const truthy = Array.isArray(v) ? v.length > 0 : !!v;
    const scopes: Scope[] = [];
    if (inverted) {
      if (!truthy) scopes.push(scope);
    } else if (Array.isArray(v)) {
      for (const item of v) scopes.push({ data: item, parent: scope });
    } else if (truthy) {
      scopes.push(v && typeof v === 'object' ? { data: v, parent: scope } : scope);
    }
    const out: N[] = [];
    for (const sc of scopes) {
      for (let ch = node.firstChild; ch; ch = ch.nextSibling) out.push(...render(ch, sc, doc));
    }
    return out;
  }

  const clone = node.cloneNode(false);
  for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
    for (const r of render(ch, scope, doc)) clone.appendChild(r);
  }
  return [clone];
}

export function renderOdtXml(xml: string, data: Data): string {
  const doc: N = new DOMParser({
    onError: (level: string, msg: string) => {
      if (level === 'fatalError') throw new Error(`XML inválido no modelo: ${msg}`);
    },
  }).parseFromString(xml, 'text/xml');

  mergeSplitTags(doc);
  const markers = isolateMarkers(doc);

  // Pair opens with closes (properly nested). Inner pairs close first, so wrapping
  // in this order handles nested loops without disturbing the outer markers.
  const stack: Marker[] = [];
  const pairs: { open: Marker; close: Marker }[] = [];
  for (const mk of markers) {
    if (mk.kind === '/') {
      const open = stack.pop();
      if (!open || open.name !== mk.name) {
        throw new Error(`No modelo, a etiqueta {/${mk.name}} não tem a abertura correspondente.`);
      }
      pairs.push({ open, close: mk });
    } else {
      stack.push(mk);
    }
  }
  if (stack.length > 0) {
    throw new Error(`No modelo, a etiqueta {${stack[stack.length - 1].kind}${stack[stack.length - 1].name}} não foi fechada.`);
  }
  for (const { open, close } of pairs) wrapPair(doc, open, close);

  const [root] = render(doc.documentElement, { data, parent: null }, doc);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root);
}

// Fill an .odt template (Buffer) and return the filled .odt.
export function renderOdt(template: Buffer, data: Data): Buffer {
  const zip = new PizZip(template);
  // Body plus styles.xml (page headers/footers live there).
  for (const name of ['content.xml', 'styles.xml']) {
    const f = zip.file(name);
    if (f) zip.file(name, renderOdtXml(f.asText(), data));
  }
  // ODF wants the `mimetype` entry stored uncompressed.
  const mt = zip.file('mimetype');
  if (mt) zip.file('mimetype', mt.asText(), { compression: 'STORE' });
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// True when the buffer is an OpenDocument TEXT file (.odt). Plain .odt only: a
// template (.ott) has a different mimetype and is rejected by callers.
export function isOdt(buf: Buffer): boolean {
  try {
    const zip = new PizZip(buf);
    const mime = (zip.file('mimetype')?.asText() ?? '').trim();
    return mime === 'application/vnd.oasis.opendocument.text' && !!zip.file('content.xml');
  } catch {
    return false;
  }
}
