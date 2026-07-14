import { SettingsIcon, ForkIcon, HeartIcon, ChevronRightIcon } from '../components/icons';

interface MorePaneProps {
  onOpenSettings: () => void;
  onOpenHealth: () => void;
}

/** The "More" tab — entry to Settings, Health Import, plus stubs. */
export function MorePane({ onOpenSettings, onOpenHealth }: MorePaneProps) {
  return (
    <div className="pane">
      <div className="section-label">App</div>
      <div className="list">
        <button className="row row--button" onClick={onOpenSettings}>
          <SettingsIcon className="row__icon" />
          <span className="row__label">Settings</span>
          <ChevronRightIcon className="row__chevron" />
        </button>
        <button className="row row--button" onClick={onOpenHealth}>
          <HeartIcon className="row__icon" />
          <span className="row__label">Health Import</span>
          <ChevronRightIcon className="row__chevron" />
        </button>
      </div>

      <div className="section-label">Coming soon</div>
      <div className="list">
        <div className="row row--disabled">
          <ForkIcon className="row__icon" />
          <span className="row__label">Food Log</span>
          <span className="row__hint">W-later</span>
        </div>
      </div>
    </div>
  );
}
