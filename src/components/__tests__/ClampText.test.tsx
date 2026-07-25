import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClampText, isLongText, CLAMP_CHARS } from '../ClampText';
import { Markdown } from '../Markdown';

afterEach(cleanup);

const SHORT = 'Stop two reps short on every press.';
const LONG = 'x'.repeat(CLAMP_CHARS + 20);

describe('isLongText', () => {
  it('is false for short text and true past the clamp threshold', () => {
    expect(isLongText(SHORT)).toBe(false);
    expect(isLongText(LONG)).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(isLongText(`   ${'y'.repeat(CLAMP_CHARS)}   `)).toBe(false);
  });
});

describe('ClampText', () => {
  it('renders short text with no clamp and no toggle', () => {
    const { container } = render(<ClampText text={SHORT} />);
    expect(screen.getByText(SHORT)).toBeInTheDocument();
    expect(container.querySelector('.clamp__body--clamped')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('clamps long text and offers a More toggle', () => {
    const { container } = render(<ClampText text={LONG} />);
    expect(container.querySelector('.clamp__body--clamped')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('expands and re-collapses on the toggle', async () => {
    const user = userEvent.setup();
    const { container } = render(<ClampText text={LONG} />);

    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(container.querySelector('.clamp__body--clamped')).toBeNull();
    const less = screen.getByRole('button', { name: 'Less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');

    await user.click(less);
    expect(container.querySelector('.clamp__body--clamped')).not.toBeNull();
  });

  it('renders children (e.g. markdown) instead of the raw text when given', () => {
    const md = `**bold** ${LONG}`;
    const { container } = render(
      <ClampText text={md}>
        <Markdown text={md} />
      </ClampText>
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('.clamp__body--clamped')).not.toBeNull();
  });
});
