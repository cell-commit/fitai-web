import { useState } from 'react';
import type { ReactNode } from 'react';

// Defensive clamp for model-generated copy.
//
// The generation/review prompts ask for short titles, cues and concerns, but a
// prompt is advisory — a model can still return a six-line essay. Rather than
// let one long note push the whole card off-screen, collapse anything long to
// ~3 lines (CSS line-clamp) behind a "More" toggle.
//
// The decision to show the toggle is made on CHARACTER COUNT, not measured
// layout: it is deterministic, needs no ref/resize observer, and works in
// jsdom, at the cost of occasionally offering "More" on text that happens to
// fit. Expanding is free, so that trade is fine.

/** Above this many characters the text is clamped and a toggle is offered. */
export const CLAMP_CHARS = 140;

interface ClampTextProps {
  /** Raw text — used only to decide whether clamping is needed. */
  text: string;
  /**
   * Rendered content. Defaults to the raw text; pass e.g. a <Markdown> element
   * when the surface renders formatted copy.
   */
  children?: ReactNode;
  className?: string;
}

/** True when `text` is long enough to be worth clamping. */
export function isLongText(text: string): boolean {
  return text.trim().length > CLAMP_CHARS;
}

/**
 * Render `children` (or the raw text) clamped to ~3 lines with a More/Less
 * toggle when the text is long. Short text renders untouched, with no toggle.
 */
export function ClampText({ text, children, className }: ClampTextProps) {
  const [expanded, setExpanded] = useState(false);
  const long = isLongText(text);
  const clamped = long && !expanded;

  return (
    <div className={['clamp', className].filter(Boolean).join(' ')}>
      <div className={`clamp__body${clamped ? ' clamp__body--clamped' : ''}`}>
        {children ?? text}
      </div>
      {long && (
        <button
          type="button"
          className="clamp__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}
