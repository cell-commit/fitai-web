import { useEffect, useState } from 'react';
import {
  CalendarIcon,
  DumbbellIcon,
  ChatIcon,
  TrendingIcon,
  MoreIcon,
} from './components/icons';
import { WeekPane } from './panes/WeekPane';
import { TodayPane } from './panes/TodayPane';
import { CoachPane } from './panes/CoachPane';
import { ProgressPane } from './panes/ProgressPane';
import { MorePane } from './panes/MorePane';
import { SettingsPane } from './panes/SettingsPane';
import { HealthImportPane } from './panes/HealthImportPane';
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

type MoreView = 'root' | 'settings' | 'health';

const MORE_TITLES: Record<MoreView, string> = {
  root: 'More',
  settings: 'Settings',
  health: 'Health Import',
};

export default function App() {
  const [tab, setTab] = useState<Tab>('today');
  const [moreView, setMoreView] = useState<MoreView>('root');

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

  const inMoreSub = tab === 'more' && moreView !== 'root';
  const headerTitle = tab === 'more' ? MORE_TITLES[moreView] : TITLES[tab];

  function selectTab(next: Tab) {
    setTab(next);
    if (next !== 'more') setMoreView('root');
  }

  return (
    <div className="app-shell">
      <main className="app-main">
        <div className="pane__header">
          {inMoreSub && (
            <button
              className="btn btn--ghost btn--inline"
              style={{ marginBottom: 'var(--sp-sm)' }}
              onClick={() => setMoreView('root')}
            >
              ‹ Back
            </button>
          )}
          <h1 className="pane__title">{headerTitle}</h1>
        </div>

        {tab === 'week' && <WeekPane />}
        {tab === 'today' && <TodayPane onGoToWeek={() => selectTab('week')} />}
        {tab === 'coach' && <CoachPane />}
        {tab === 'progress' && <ProgressPane />}
        {tab === 'more' && moreView === 'root' && (
          <MorePane
            onOpenSettings={() => setMoreView('settings')}
            onOpenHealth={() => setMoreView('health')}
          />
        )}
        {tab === 'more' && moreView === 'settings' && <SettingsPane />}
        {tab === 'more' && moreView === 'health' && <HealthImportPane />}
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
