import type { ReactNode } from 'react';

interface PlaceholderProps {
  icon: ReactNode;
  title: string;
  badge: string;
  blurb: string;
}

/** Styled empty-state pane for features arriving in later work packages. */
export function Placeholder({ icon, title, badge, blurb }: PlaceholderProps) {
  return (
    <div className="placeholder">
      <div className="placeholder__icon">{icon}</div>
      <div className="placeholder__title">{title}</div>
      <span className="placeholder__badge">{badge}</span>
      <p>{blurb}</p>
    </div>
  );
}
