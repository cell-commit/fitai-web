import { Fragment } from 'react';
import type { ReactNode } from 'react';

// ─────────────────────────────────────────────────────────────
// Tiny, dependency-free markdown renderer for untrusted LLM text.
//
// SECURITY: this is a deliberate choice not to pull in marked / react-markdown
// / DOMPurify. Coach + nutrition replies are model-generated (untrusted) and
// are shown verbatim. We NEVER build an HTML string or touch
// dangerouslySetInnerHTML — every node below is a real React element, so there
// is no HTML-injection path. A stray `<script>` or `<img onerror=…>` in the
// text is just rendered as literal characters by React.
//
// Supported, on purpose kept small:
//   **bold**            → <strong>
//   *italic* / _italic_ → <em>
//   `inline code`       → <code>
//   # / ## / ### head   → bold line (slightly larger for #)
//   - / * / + bullets   → <ul><li>
//   1. / 1) numbered    → <ol><li>
//   blank line          → paragraph break
//   single newline      → <br> within a paragraph
//
// Everything unsupported degrades to readable text: links show their label,
// blockquote markers and table pipes are stripped, and any stray / unmatched
// emphasis marker is rendered literally.
// ─────────────────────────────────────────────────────────────

interface MarkdownProps {
  text: string;
  /**
   * Inline mode: ignore block constructs (headings / lists / paragraphs) and
   * render a single run of formatted text. For one-line contexts such as an
   * exercise note where block spacing would look wrong.
   */
  inline?: boolean;
  className?: string;
}

const isWordChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9]/.test(c);

/** Find the next lone `*` (not part of a `**` run) at or after `from`. */
function findLoneStar(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '*') {
      if (s[j + 1] === '*') {
        j++; // skip the `**` pair so bold runs don't close an italic
        continue;
      }
      return j;
    }
  }
  return -1;
}

/**
 * Parse a single line/run of inline markdown into React nodes. Recursive for
 * nesting (e.g. bold containing italic). Returns a mix of strings and elements;
 * every element gets a locally-unique key.
 */
function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buf = '';
  let key = 0;
  let i = 0;

  const flush = () => {
    if (buf) {
      nodes.push(buf);
      buf = '';
    }
  };

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    // `inline code`
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        nodes.push(
          <code className="md-code" key={key++}>
            {text.slice(i + 1, end)}
          </code>
        );
        i = end + 1;
        continue;
      }
    }

    // [label](url) → label (recurse so the label can carry formatting)
    if (c === '[') {
      const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(i));
      if (m && m[1]) {
        flush();
        nodes.push(<Fragment key={key++}>{parseInline(m[1])}</Fragment>);
        i += m[0].length;
        continue;
      }
    }

    // **bold**
    if (c === '*' && next === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        if (inner) {
          flush();
          nodes.push(<strong key={key++}>{parseInline(inner)}</strong>);
          i = end + 2;
          continue;
        }
      }
      buf += '**'; // stray / empty → literal
      i += 2;
      continue;
    }

    // *italic*
    if (c === '*') {
      const end = findLoneStar(text, i + 1);
      if (end !== -1) {
        const inner = text.slice(i + 1, end);
        if (inner) {
          flush();
          nodes.push(<em key={key++}>{parseInline(inner)}</em>);
          i = end + 1;
          continue;
        }
      }
      buf += '*'; // stray → literal
      i += 1;
      continue;
    }

    // _italic_ — only at word boundaries so snake_case survives untouched
    if (c === '_' && !isWordChar(text[i - 1])) {
      let end = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '_' && !isWordChar(text[j + 1])) {
          end = j;
          break;
        }
      }
      if (end !== -1) {
        const inner = text.slice(i + 1, end);
        if (inner) {
          flush();
          nodes.push(<em key={key++}>{parseInline(inner)}</em>);
          i = end + 1;
          continue;
        }
      }
      buf += '_';
      i += 1;
      continue;
    }

    buf += c;
    i += 1;
  }

  flush();
  return nodes;
}

/** Strip table pipes / separator noise from a line so tables read as plain text. */
function stripTablePipes(s: string): string {
  const t = s.trim();
  if (t.startsWith('|') || / \| /.test(s)) {
    return s
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .replace(/\s*\|\s*/g, '  ')
      .trim();
  }
  return s;
}

const RE_HEADING = /^\s{0,3}(#{1,3})\s+(.*\S)\s*$/;
const RE_BULLET = /^\s*[-*+]\s+/;
const RE_NUMBERED = /^\s*\d+[.)]\s+/;
const RE_TABLE_SEP = /^\s*\|?[\s:|-]+\|?\s*$/;

/** Parse full block-level markdown into React nodes. */
function parseBlocks(text: string): ReactNode[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // Drop table separator rows (|---|---|) everywhere so tables read cleanly.
    .filter((l) => !(l.includes('|') && l.includes('-') && RE_TABLE_SEP.test(l)));
  const blocks: ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];

    if (raw.trim() === '') {
      i++;
      continue;
    }

    // Headings → bold line, slightly larger for level 1.
    const h = RE_HEADING.exec(raw);
    if (h) {
      const level = h[1].length;
      blocks.push(
        <div key={key++} className={`md-h md-h${level}`}>
          {parseInline(stripTablePipes(h[2]))}
        </div>
      );
      i++;
      continue;
    }

    // Bullet list.
    if (RE_BULLET.test(raw)) {
      const items: ReactNode[] = [];
      while (i < lines.length && RE_BULLET.test(lines[i])) {
        const item = lines[i].replace(RE_BULLET, '');
        items.push(<li key={items.length}>{parseInline(stripTablePipes(item))}</li>);
        i++;
      }
      blocks.push(
        <ul key={key++} className="md-ul">
          {items}
        </ul>
      );
      continue;
    }

    // Numbered list.
    if (RE_NUMBERED.test(raw)) {
      const items: ReactNode[] = [];
      while (i < lines.length && RE_NUMBERED.test(lines[i])) {
        const item = lines[i].replace(RE_NUMBERED, '');
        items.push(<li key={items.length}>{parseInline(stripTablePipes(item))}</li>);
        i++;
      }
      blocks.push(
        <ol key={key++} className="md-ol">
          {items}
        </ol>
      );
      continue;
    }

    // Paragraph — gather consecutive lines until a blank line or a new block.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !RE_HEADING.test(lines[i]) &&
      !RE_BULLET.test(lines[i]) &&
      !RE_NUMBERED.test(lines[i])
    ) {
      // Strip a leading blockquote marker so `> quote` reads as plain text.
      paraLines.push(stripTablePipes(lines[i].replace(/^\s*>\s?/, '')));
      i++;
    }

    const children: ReactNode[] = [];
    paraLines.forEach((line, idx) => {
      if (idx > 0) children.push(<br key={`br-${idx}`} />);
      parseInline(line).forEach((n, j) =>
        children.push(<Fragment key={`n-${idx}-${j}`}>{n}</Fragment>)
      );
    });

    blocks.push(
      <p key={key++} className="md-p">
        {children}
      </p>
    );
  }

  return blocks;
}

/**
 * Render model-generated markdown as React elements (never raw HTML). Use for
 * any surface that shows coach / nutrition text. Pass `inline` for single-line
 * contexts that should ignore block syntax.
 */
export function Markdown({ text, inline = false, className }: MarkdownProps) {
  if (!text) return null;

  const content = inline ? parseInline(text) : parseBlocks(text);
  const cls = ['md', inline ? 'md--inline' : null, className].filter(Boolean).join(' ');

  return <div className={cls}>{content}</div>;
}
