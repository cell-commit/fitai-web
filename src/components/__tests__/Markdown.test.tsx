import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Markdown } from '../Markdown';

afterEach(cleanup);

function html(text: string, inline = false): string {
  const { container } = render(<Markdown text={text} inline={inline} />);
  return (container.querySelector('.md') as HTMLElement).innerHTML;
}

describe('Markdown — inline emphasis', () => {
  it('renders **bold** as <strong>', () => {
    render(<Markdown text="a **strong** b" />);
    const el = screen.getByText('strong');
    expect(el.tagName).toBe('STRONG');
  });

  it('renders *italic* and _italic_ as <em>', () => {
    expect(html('an *emph* word')).toContain('<em>emph</em>');
    expect(html('an _emph_ word')).toContain('<em>emph</em>');
  });

  it('renders `inline code` as <code>', () => {
    expect(html('run `npm test` now')).toContain('<code class="md-code">npm test</code>');
  });

  it('nests italic inside bold', () => {
    const out = html('**bold *and italic* here**');
    expect(out).toContain('<strong>');
    expect(out).toContain('<em>and italic</em>');
  });

  it('does not treat snake_case underscores as italic', () => {
    expect(html('call some_function_name here')).toContain('some_function_name');
    expect(html('call some_function_name here')).not.toContain('<em>');
  });

  it('leaves code span content unformatted', () => {
    const out = html('`**not bold**`');
    expect(out).toContain('<code class="md-code">**not bold**</code>');
    expect(out).not.toContain('<strong>');
  });
});

describe('Markdown — unmatched / stray markers render literally', () => {
  it('keeps an unmatched ** literal', () => {
    expect(html('this is **not closed')).toContain('**not closed');
    expect(html('this is **not closed')).not.toContain('<strong>');
  });

  it('keeps a stray single * literal', () => {
    expect(html('5 * 3 = 15')).toContain('5 * 3 = 15');
    expect(html('5 * 3 = 15')).not.toContain('<em>');
  });

  it('renders **** with no crash and no empty strong', () => {
    const out = html('****');
    expect(out).toContain('****');
    expect(out).not.toContain('<strong></strong>');
  });
});

describe('Markdown — links degrade to their label', () => {
  it('shows the link text and drops the url', () => {
    const out = html('see [the docs](https://example.com/x) please');
    expect(out).toContain('the docs');
    expect(out).not.toContain('https://example.com');
    expect(out).not.toContain('<a');
  });

  it('applies formatting inside link text', () => {
    const out = html('[**bold link**](https://x.y)');
    expect(out).toContain('<strong>bold link</strong>');
  });
});

describe('Markdown — block constructs', () => {
  it('renders headings as bold divs, larger for level 1', () => {
    const { container } = render(<Markdown text={'# Title\n\nbody'} />);
    const h1 = container.querySelector('.md-h1');
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe('Title');
  });

  it('renders ## and ### as headings too', () => {
    const { container } = render(<Markdown text={'## Two\n\n### Three'} />);
    expect(container.querySelector('.md-h2')!.textContent).toBe('Two');
    expect(container.querySelector('.md-h3')!.textContent).toBe('Three');
  });

  it('renders bulleted lists (- and *)', () => {
    const { container } = render(<Markdown text={'- one\n- two\n* three'} />);
    const ul = container.querySelector('ul.md-ul');
    expect(ul).not.toBeNull();
    expect(ul!.querySelectorAll('li')).toHaveLength(3);
    expect(ul!.querySelectorAll('li')[2].textContent).toBe('three');
  });

  it('renders numbered lists (1. and 1))', () => {
    const { container } = render(<Markdown text={'1. first\n2) second'} />);
    const ol = container.querySelector('ol.md-ol');
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll('li')).toHaveLength(2);
  });

  it('applies inline formatting inside list items', () => {
    const { container } = render(<Markdown text={'- eat **200g** protein'} />);
    expect(container.querySelector('li strong')!.textContent).toBe('200g');
  });

  it('splits blank-line-separated paragraphs', () => {
    const { container } = render(<Markdown text={'para one\n\npara two'} />);
    const ps = container.querySelectorAll('p.md-p');
    expect(ps).toHaveLength(2);
    expect(ps[0].textContent).toBe('para one');
    expect(ps[1].textContent).toBe('para two');
  });

  it('turns a single newline into a <br> within a paragraph', () => {
    const { container } = render(<Markdown text={'line one\nline two'} />);
    const ps = container.querySelectorAll('p.md-p');
    expect(ps).toHaveLength(1);
    expect(ps[0].querySelectorAll('br')).toHaveLength(1);
  });

  it('degrades a table to readable text without pipes or crashing', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const { container } = render(<Markdown text={md} />);
    const text = (container.querySelector('.md') as HTMLElement).textContent ?? '';
    expect(text).toContain('A');
    expect(text).toContain('2');
    expect(text).not.toContain('|');
    expect(text).not.toContain('---');
  });

  it('strips a leading blockquote marker', () => {
    const { container } = render(<Markdown text={'> quoted line'} />);
    const text = (container.querySelector('.md') as HTMLElement).textContent ?? '';
    expect(text).toBe('quoted line');
  });
});

describe('Markdown — inline mode', () => {
  it('ignores block syntax and formats inline only', () => {
    const { container } = render(<Markdown text="drop **RDLs** this week" inline />);
    const root = container.querySelector('.md--inline') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.querySelector('strong')!.textContent).toBe('RDLs');
    expect(root.querySelector('p')).toBeNull();
  });
});

describe('Markdown — robustness', () => {
  it('renders nothing for empty text', () => {
    const { container } = render(<Markdown text="" />);
    expect(container.querySelector('.md')).toBeNull();
  });

  it('does not crash on a very long single token', () => {
    const long = 'x'.repeat(20000);
    expect(() => render(<Markdown text={long} />)).not.toThrow();
  });

  it('does not crash on pathological marker soup', () => {
    const junk = '***_`[](' + '*'.repeat(500) + '__**```';
    expect(() => render(<Markdown text={junk} />)).not.toThrow();
  });

  it('treats HTML in the source as literal text (no injection)', () => {
    const out = html('<img src=x onerror=alert(1)> **safe**');
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('<img');
    expect(out).toContain('<strong>safe</strong>');
  });
});
