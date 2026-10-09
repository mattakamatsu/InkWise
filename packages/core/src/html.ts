import { Parser } from 'htmlparser2';

/**
 * Turns Readwise's `html_content` into well-formed XHTML for an EPUB.
 *
 * The text itself is never rewritten: no smart quotes, no whitespace collapsing,
 * no hyphenation. Highlights only reach Readwise if the selected text matches the
 * source exactly, so the EPUB must carry the source text byte for byte.
 */

/** Tags kept as-is (with their filtered attributes). */
const KEEP = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'pre', 'code', 'figure', 'figcaption', 'img', 'a', 'em', 'strong', 'i', 'b', 'u', 's',
  'sub', 'sup', 'small', 'mark', 'q', 'cite', 'abbr', 'del', 'ins', 'kbd', 'samp', 'var',
  'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main',
]);

/** Tags dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'form', 'noscript', 'object', 'embed', 'template', 'button',
  'input', 'select', 'textarea', 'option', 'svg', 'math', 'canvas', 'audio', 'video',
  'source', 'track', 'picture-source', 'head', 'title', 'meta', 'link', 'frameset', 'frame',
  'dialog', 'map', 'area',
]);

const VOID = new Set(['img', 'br', 'hr', 'wbr']);

/** Generic containers that are unwrapped rather than split when they land in phrasing content. */
const CONTAINER = new Set(['div', 'section', 'article', 'aside', 'header', 'footer', 'main']);

/** Block-level tags; used to keep blocks from ending up inside a <p>. */
const BLOCK = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'pre', 'figure', 'figcaption', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main',
]);

/** Elements whose content model only allows phrasing content. */
const PHRASING_ONLY = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'dt', 'caption', 'span', 'a', 'em', 'strong', 'i', 'b', 'u', 's', 'sub', 'sup', 'small', 'mark', 'q', 'cite', 'abbr', 'code', 'kbd', 'samp', 'var']);

const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  blockquote: ['cite'],
  q: ['cite'],
  abbr: ['title'],
};

/**
 * Elements that only accept certain children. Anything else that lands directly
 * inside them gets wrapped in the implicit child (the value), which is what a
 * browser does visually and what keeps epubcheck happy.
 */
const STRICT_CHILDREN: Record<string, { allowed: Set<string>; wrap: string }> = {
  ul: { allowed: new Set(['li']), wrap: 'li' },
  ol: { allowed: new Set(['li']), wrap: 'li' },
  dl: { allowed: new Set(['dt', 'dd']), wrap: 'dd' },
  // XHTML lets a table hold either bare rows or sections, never both, so every
  // row goes in a section (what a browser does) and the two can't collide.
  table: { allowed: new Set(['caption', 'thead', 'tbody', 'tfoot']), wrap: 'tbody' },
  thead: { allowed: new Set(['tr']), wrap: 'tr' },
  tbody: { allowed: new Set(['tr']), wrap: 'tr' },
  tfoot: { allowed: new Set(['tr']), wrap: 'tr' },
  tr: { allowed: new Set(['td', 'th']), wrap: 'td' },
};

/** Implicit wrappers are recorded under this name, which no close tag matches. */
const IMPLICIT = '#implicit';

export interface CleanOptions {
  /** Base URL for resolving relative links and images (Reader's `source_url`). */
  baseUrl?: string | null;
  /**
   * Maps an absolute image URL to the path used inside the EPUB.
   * Images without an entry are replaced by their alt text.
   */
  imageMap?: Map<string, string>;
  /** Keep <img> tags at all. When false every image becomes alt text. */
  includeImages?: boolean;
}

export interface CleanResult {
  xhtml: string;
  /** Absolute URLs of every image referenced by the content, in order, deduped. */
  imageUrls: string[];
}

export function cleanHtml(html: string, opts: CleanOptions = {}): CleanResult {
  const out: string[] = [];
  /**
   * Every open source element; `tag` is what we emitted for it, or null if it
   * was unwrapped. A table remembers whether a body section has started, since
   * a header section after that point has to become a body too.
   */
  const open: { name: string; tag: string | null; hasBody?: boolean }[] = [];
  const imageUrls: string[] = [];
  const seenImages = new Set<string>();
  let dropDepth = 0;
  const includeImages = opts.includeImages ?? true;

  const emitted = () => open.filter((e) => e.tag !== null).map((e) => e.tag as string);
  const insideEmitted = (tag: string) => open.some((e) => e.tag === tag);
  const insidePhrasingOnly = () => open.some((e) => e.tag !== null && PHRASING_ONLY.has(e.tag));

  /** Close emitted elements from the innermost outward until (and including) entry `idx`. */
  const closeFrom = (idx: number) => {
    for (let i = open.length - 1; i >= idx; i--) {
      const e = open[i]!;
      if (e.tag !== null) {
        out.push(`</${e.tag}>`);
        e.tag = null;
      }
    }
  };

  /** The innermost element we actually emitted. */
  const innermost = () => {
    for (let i = open.length - 1; i >= 0; i--) if (open[i]!.tag !== null) return open[i]!;
    return undefined;
  };

  /** The innermost open table, if any. */
  const currentTable = () => {
    for (let i = open.length - 1; i >= 0; i--) if (open[i]!.tag === 'table') return open[i]!;
    return undefined;
  };

  /** Record that a body section was emitted (explicitly or as a wrapper) in the current table. */
  const noteBody = (tag: string) => {
    if (tag !== 'tbody') return;
    const table = currentTable();
    if (table) table.hasBody = true;
  };

  /**
   * Make room for `child` (a tag, or '#text'): close an implicit wrapper that a
   * real child replaces, and open one when the parent wouldn't accept `child`.
   */
  const fitInto = (child: string) => {
    // Step out of implicit wrappers when an ancestor takes `child` directly
    // (a real <li> after loose text in a <ul>, a <tr> after a stray cell).
    for (let i = open.length - 1; i >= 0; i--) {
      const e = open[i]!;
      if (e.tag === null) continue;
      if (STRICT_CHILDREN[e.tag]?.allowed.has(child)) {
        closeFrom(i + 1);
        open.splice(i + 1);
        break;
      }
      if (e.name !== IMPLICIT) break;
    }
    // Then open whatever wrappers the parent needs (at most tbody, tr, then td).
    for (let guard = 0; guard < 3; guard++) {
      const tag = innermost()?.tag;
      const rule = tag ? STRICT_CHILDREN[tag] : undefined;
      if (!rule || rule.allowed.has(child)) return;
      out.push(`<${rule.wrap}>`);
      noteBody(rule.wrap);
      open.push({ name: IMPLICIT, tag: rule.wrap });
    }
  };

  const parser = new Parser(
    {
      onopentag(rawName, attribs) {
        const name = rawName.toLowerCase();
        if (dropDepth > 0) {
          if (DROP_WITH_CONTENT.has(name) && !isSelfClosingDropped(name)) dropDepth++;
          return;
        }
        if (DROP_WITH_CONTENT.has(name)) {
          if (!isSelfClosingDropped(name)) dropDepth++;
          return;
        }
        if (name === 'img') {
          emitImage(attribs);
          return;
        }
        if (VOID.has(name)) {
          if (name === 'hr' && insidePhrasingOnly()) return;
          out.push(`<${name} />`);
          return;
        }
        let tag: string | null = KEEP.has(name) ? name : null;
        if (tag === 'a') {
          const href = safeHref(attribs.href, opts.baseUrl);
          if (!href || insideEmitted('a')) tag = null;
          else attribs = { ...attribs, href };
        }
        if (tag && BLOCK.has(tag) && insidePhrasingOnly()) {
          if (CONTAINER.has(tag)) {
            tag = null; // a <div> inside a <p> just disappears
          } else {
            // Close the phrasing-only ancestors so the block can start cleanly.
            const first = open.findIndex((e) => e.tag !== null && PHRASING_ONLY.has(e.tag));
            closeFrom(first);
          }
        }
        if (tag === 'li' && !insideEmitted('ul') && !insideEmitted('ol')) tag = 'p';
        if ((tag === 'dt' || tag === 'dd') && !insideEmitted('dl')) tag = 'p';
        if (tag === 'figcaption' && !insideEmitted('figure')) tag = 'p';
        // A caption is only valid as a table's first child.
        if (tag === 'caption' && !(innermost()?.tag === 'table' && out[out.length - 1]?.startsWith('<table'))) {
          tag = insideEmitted('table') ? null : 'p';
        }
        if ((tag === 'td' || tag === 'th' || tag === 'tr' || tag === 'thead' || tag === 'tbody' || tag === 'tfoot') && !insideEmitted('table')) tag = null;
        // XHTML wants one thead first and one tfoot last. A footer, or a header
        // once rows have started, reads the same as a body section.
        if (tag === 'tfoot' || (tag === 'thead' && currentTable()?.hasBody)) tag = 'tbody';
        if ((tag === 'header' || tag === 'footer') && (insideEmitted('header') || insideEmitted('footer'))) tag = 'div';
        if (tag) fitInto(tag);
        if (tag) {
          out.push(`<${tag}${renderAttrs(tag, attribs)}>`);
          noteBody(tag);
        }
        open.push({ name, tag });
      },
      ontext(text) {
        if (dropDepth > 0) return;
        const parent = innermost()?.tag;
        if (parent && STRICT_CHILDREN[parent]) {
          if (!text.trim()) return;
          fitInto('#text');
        }
        out.push(escapeText(text));
      },
      onclosetag(rawName) {
        const name = rawName.toLowerCase();
        if (dropDepth > 0) {
          if (DROP_WITH_CONTENT.has(name) && !isSelfClosingDropped(name)) dropDepth--;
          return;
        }
        if (DROP_WITH_CONTENT.has(name) || VOID.has(name)) return;
        let idx = -1;
        for (let i = open.length - 1; i >= 0; i--) {
          if (open[i]!.name === name) {
            idx = i;
            break;
          }
        }
        if (idx === -1) return;
        closeFrom(idx);
        open.splice(idx);
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );

  function emitImage(attribs: Record<string, string>) {
    const src = resolveUrl(attribs.src ?? attribs['data-src'] ?? '', opts.baseUrl);
    const alt = (attribs.alt ?? '').trim();
    if (src && /^https?:/i.test(src) && !seenImages.has(src)) {
      seenImages.add(src);
      imageUrls.push(src);
    }
    const local = includeImages && src ? opts.imageMap?.get(src) : undefined;
    if (local) {
      out.push(`<img src="${escapeAttr(local)}" alt="${escapeAttr(alt)}" />`);
    } else if (alt) {
      out.push(`<span class="img-alt">[Image: ${escapeText(alt)}]</span>`);
    }
  }

  parser.write(html);
  parser.end();
  closeFrom(0);
  void emitted;
  return { xhtml: out.join(''), imageUrls };
}

/** Collect image URLs without producing output (used to plan downloads). */
export function extractImageUrls(html: string, baseUrl?: string | null): string[] {
  return cleanHtml(html, { baseUrl, includeImages: false }).imageUrls;
}

function isSelfClosingDropped(name: string) {
  return name === 'input' || name === 'meta' || name === 'link' || name === 'source' || name === 'track' || name === 'area' || name === 'embed';
}

function renderAttrs(tag: string, attribs: Record<string, string>): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return '';
  let s = '';
  for (const key of allowed) {
    const v = attribs[key];
    if (v === undefined) continue;
    if (key === 'reversed') {
      s += ' reversed="reversed"';
      continue;
    }
    const t = v.trim();
    if ((key === 'start' || key === 'value') && !/^-?\d+$/.test(t)) continue;
    if (key === 'colspan' && !(/^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 1000)) continue;
    if (key === 'rowspan' && !(/^\d+$/.test(t) && Number(t) <= 65534)) continue;
    if (key === 'type' && !/^[1aAiI]$/.test(t)) continue;
    if (key === 'scope' && !/^(row|col|rowgroup|colgroup)$/.test(t)) continue;
    if (key === 'href' && !t) continue;
    s += ` ${key}="${escapeAttr(key === 'colspan' || key === 'rowspan' || key === 'scope' || key === 'type' ? t : v)}"`;
  }
  return s;
}

function safeHref(href: string | undefined, base?: string | null): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith('#')) return null; // in-page anchors point at ids we strip
  const abs = resolveUrl(trimmed, base);
  if (!abs) return null;
  if (/^mailto:\s*$/i.test(abs)) return null;
  if (/^(https?:|mailto:)/i.test(abs)) return encodeUnsafe(abs);
  return null;
}

/**
 * Percent-encode what epubcheck rejects in a URL (spaces, pipes, braces, stray
 * percent signs) while leaving valid escapes and everything else alone.
 */
export function encodeUnsafe(url: string): string {
  return url
    .replace(/%(?![0-9a-fA-F]{2})/g, '%25')
    .replace(/[\s"<>\\^`{|}]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** Minimal URL resolution; React Native's URL implementation is incomplete. */
export function resolveUrl(href: string, base?: string | null): string {
  const h = href.trim();
  if (!h) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
  if (!base) return h.startsWith('//') ? `https:${h}` : '';
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)/i.exec(base);
  if (!m) return '';
  const [, scheme, host, path = '/'] = m;
  if (h.startsWith('//')) return `${scheme}${h}`;
  if (h.startsWith('/')) return `${scheme}//${host}${h}`;
  if (h.startsWith('?') || h.startsWith('#')) return `${scheme}//${host}${path}${h}`;
  const dir = path.replace(/[^/]*$/, '') || '/';
  const parts = `${dir}${h}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (resolved.length > 1) resolved.pop();
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  let joined = resolved.join('/');
  if (!joined.startsWith('/')) joined = `/${joined}`;
  return `${scheme}//${host}${joined}`;
}

export function escapeText(s: string): string {
  return stripInvalidXmlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** XML 1.0 forbids most control characters; they occasionally show up in scraped pages. */
function stripInvalidXmlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}
