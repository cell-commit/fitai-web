import { useEffect, useState } from 'react';
import {
  CalendarIcon,
  DumbbellIcon,
  ChatIcon,
  TrendingIcon,
  MoreIcon,
} from './components/icons';
import { Placeholder } from './panes/Placeholder';
import { MorePane } from './panes/MorePane';
import { SettingsPane } from './panes/SettingsPane';
import { refreshAll } from './services/driveSync';

type Tab = 'week' | 'today' | 'coach' | 'progress' | 'more';

const TABS: { id: Tab; label: string; Icon: typeof CalendarIcon }[] = [
  { id: 'week', label: 'Week', Icon: CalendarIcon },
  { id: 'today', label: 'Today', Icon: DumbbellIcon },
  { id: 'coach', label: 'Coach', Icon: ChatIcon },
  { id: 'progress', label: 'Progress', Icon: TrendingIcon },
  { id: 'more', label: 'More', Icon: MoreIcon },
];

const TITLES: Record<Tab, string> = {
  week: 'Week',
  today: 'Today',
  coach: 'Coach',
  progress: 'Progress',
  more: 'More',
};

export default function App() {
  const [tab, setTab] = useState<Tab>('today');
  const [showSettings, setShowSettings] = useState(false);

  // Pull the latest Drive files when the app regains focus. Silent no-op when
  // sync isn't configured (design §6 web pivot).
  useEffect(() => {
    const onFocus = () => {
      void refreshAll();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshAll();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    // Initial pull on mount.
    void refreshAll();
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const inSettings = tab === 'more' && showSettings;
  const headerTitle = inSettings ? 'Settings' : TITLES[tab];

  function selectTab(next: Tab) {
    setTab(next);
    if (next !== 'more') setShowSettings(false);
  }

  return (
    <div className="app-shell">
      <main className="app-main">
        <div className="pane__header">
          {inSettings && (
            <button
              className="btn btn--ghost btn--inline"
              style={{ marginBottom: 'var(--sp-sm)' }}
              onClick={() => setShowSettings(false)}
            >
              ‹ Back
            </button>
          )}
          <h1 className="pane__title">{headerTitle}</h1>
        </div>

        {tab === 'week' && (
          <Placeholder
            icon={<CalendarIcon />}
            title="Weekly program"
            badge="COMING IN W2"
            blurb="Your adaptive Push / Pull / Full-Body week, generated and amended by the coach."
          />
        )}
        {tab === 'today' && (
          <Placeholder
            icon={<DumbbellIcon />}
            title="Today's session"
            badge="COMING IN W3"
            blurb="Readiness check-in, exercise cards with images, and per-set logging."
          />
        )}
        {tab === 'coach' && (
          <Placeholder
            icon={<ChatIcon />}
            title="Coach chat"
            badge="COMING IN W4"
            blurb="Talk to your coach — it updates your program and training files as you chat."
          />
        )}
        {tab === 'progress' && (
          <Placeholder
            icon={<TrendingIcon />}
            title="Progress"
            badge="COMING IN W3/W5"
            blurb="Session history and progress photos with coach vision feedback."
          />
        )}
        {tab === 'more' &&
          (showSettings ? (
            <SettingsPane />
          ) : (
            <MorePane onOpenSettings={() => setShowSettings(true)} />
          ))}
      </main>

      <nav className="tabbar">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={
              'tabbar__tab' + (tab === id ? ' tabbar__tab--active' : '')
            }
            onClick={() => selectTab(id)}
            aria-current={tab === id ? 'page' : undefined}
          >
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
