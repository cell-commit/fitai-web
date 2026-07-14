import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * App-wide error boundary. Catches render/lifecycle errors anywhere below it and
 * shows a friendly recovery screen with a reload button instead of a blank
 * white page. Wraps <App /> in main.tsx.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the crash in the console for debugging; no remote logging.
    console.error('Uncaught error in app:', error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <div className="error-boundary__card">
            <h1 className="error-boundary__title">Something went wrong</h1>
            <p className="error-boundary__body">
              The app hit an unexpected error. Your data is safe on this device.
              Reloading usually fixes it.
            </p>
            {this.state.error.message && (
              <p className="error-boundary__detail">{this.state.error.message}</p>
            )}
            <button className="btn" onClick={this.handleReload}>
              Reload app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
