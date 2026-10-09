import React, { useEffect, useState } from 'react';
import { app } from './src/appInstance';
import { screens, type Screen } from './src/buttons';
import { closeView } from './src/host';
import { DoneScreen } from './src/ui/DoneScreen';
import { HighlightScreen } from './src/ui/HighlightScreen';
import { Button, Line, Page, Row, Section } from './src/ui/kit';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { SyncScreen } from './src/ui/SyncScreen';

/**
 * A JS error in a release bundle closes the plugin view with nothing on screen
 * (reported by other plugin authors). Catch it, log it, and say what happened.
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown, info: { componentStack?: string | null }) {
    const where = (info.componentStack ?? '').split('\n').find((l) => l.trim()) ?? '';
    app.log.add(`ui error: ${err instanceof Error ? err.stack ?? err.message : String(err)} ${where}`.trim()).catch(() => {});
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <Page title="Inkwise" onClose={closeView}>
        <Section>
          <Line strong>Something went wrong in Inkwise.</Line>
          <Line small>{this.state.error}</Line>
          <Line small>The details are in {app.log.path.replace('/storage/emulated/0/', '')}.</Line>
        </Section>
        <Row>
          <Button label="Try again" primary onPress={() => this.setState({ error: null })} />
        </Row>
      </Page>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Screens />
    </ErrorBoundary>
  );
}

function Screens() {
  const [screen, setScreen] = useState<Screen>(screens.screen);
  const [run, setRun] = useState(screens.pressCount);

  useEffect(
    () =>
      screens.subscribe((next) => {
        setScreen(next);
        setRun(screens.pressCount);
      }),
    [],
  );

  const openSettings = () => screens.set('settings');

  switch (screen) {
    case 'highlight':
      return <HighlightScreen app={app} onClose={closeView} onSettings={openSettings} />;
    case 'done':
      return <DoneScreen app={app} run={run} onClose={closeView} />;
    case 'settings':
      return <SettingsScreen app={app} onClose={closeView} />;
    default:
      return <SyncScreen app={app} run={run} onClose={closeView} onSettings={openSettings} />;
  }
}
