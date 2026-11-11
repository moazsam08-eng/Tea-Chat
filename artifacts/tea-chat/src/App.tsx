import { lazy, Suspense, type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetStreamToken, type StreamToken } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthScreen } from '@/components/AuthScreen';
import { ThemeProvider } from '@/components/ThemeContext';
import NotFound from '@/pages/not-found';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { LoaderCircle, Leaf, RotateCcw } from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();
const TeaWorkspace = lazy(() =>
  import('@/components/TeaWorkspace').then((module) => ({ default: module.TeaWorkspace })),
);
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const authConfigurationError = !supabaseUrl || !supabaseAnonKey
  ? 'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to the frontend environment.'
  : '';
const supabase: SupabaseClient | null = authConfigurationError
  ? null
  : createClient(supabaseUrl!, supabaseAnonKey!, { auth: { flowType: 'pkce', detectSessionInUrl: false } });

function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(Boolean(supabase));
  const [authError, setAuthError] = useState('');
  const [streamToken, setStreamToken] = useState<StreamToken | null>(null);
  const [tokenError, setTokenError] = useState('');
  const tokenMutation = useGetStreamToken({
    request: session ? { headers: { Authorization: `Bearer ${session.access_token}` } } : undefined,
  });
  const mutateAsyncRef = useRef(tokenMutation.mutateAsync);
  mutateAsyncRef.current = tokenMutation.mutateAsync;
  const requestedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!alive) return;
      setSession(nextSession);
      setAuthLoading(false);
      setAuthError('');
    });
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (error) setAuthError(error.message);
      setSession(data.session);
      setAuthLoading(false);
    }).catch((error: unknown) => {
      if (alive) {
        setAuthError(error instanceof Error ? error.message : 'Could not restore your sign-in session.');
        setAuthLoading(false);
      }
    });
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      requestedFor.current = null;
      setStreamToken(null);
      setTokenError('');
      return;
    }
    if (requestedFor.current === session.access_token) return;
    requestedFor.current = session.access_token;
    setStreamToken(null);
    setTokenError('');
    void mutateAsyncRef.current(undefined).then((result) => {
      setStreamToken(result);
    }).catch((error: unknown) => {
      requestedFor.current = null;
      setTokenError(error instanceof Error ? error.message : 'Could not prepare your conversations.');
    });
  }, [session?.access_token]);

  if (authLoading) return <div className="loading-screen" data-testid="status-auth-loading"><div className="loading-brand"><span className="loading-leaf" />Restoring your place…</div></div>;
  if (!session) return <AuthScreen supabase={supabase} configurationError={authConfigurationError || authError} />;
  if (tokenError) return (
    <div className="loading-screen" data-testid="status-stream-token-error">
      <div className="workspace-error">
        <h2>We couldn't prepare your chats.</h2>
        <p>{tokenError}</p>
        <button type="button" onClick={() => { requestedFor.current = null; setTokenError(''); if (session) void mutateAsyncRef.current(undefined).then(setStreamToken).catch((error: unknown) => setTokenError(error instanceof Error ? error.message : 'Please try again.')); }} data-testid="button-retry-stream-token"><RotateCcw size={14} style={{ verticalAlign: 'middle', marginRight: 7 }} />Try again</button>
        <button type="button" style={{ marginLeft: 9, background: 'transparent', color: '#61776a' }} onClick={() => { void supabase?.auth.signOut(); }} data-testid="button-sign-out-token-error">Sign out</button>
      </div>
    </div>
  );
  if (!streamToken) return <div className="loading-screen" data-testid="status-stream-token-loading"><div className="loading-brand"><LoaderCircle size={19} className="animate-spin" />Preparing your chats…</div></div>;
  if (!import.meta.env.VITE_STREAM_API_KEY) return (
    <div className="loading-screen"><div className="workspace-error" role="alert" data-testid="status-stream-configuration"><h2>Tea Chat needs one more ingredient.</h2><p>Set VITE_STREAM_API_KEY to connect Stream Chat. No messaging credentials are stored in the browser beyond the public API key and signed user token.</p><button type="button" onClick={() => { void supabase?.auth.signOut(); }} data-testid="button-sign-out-stream-configuration">Sign out</button></div></div>
  );
  return (
    <Suspense fallback={<div className="loading-screen" data-testid="status-workspace-loading"><div className="loading-brand"><LoaderCircle size={19} className="animate-spin" />Opening your conversations…</div></div>}>
      <TeaWorkspace user={session.user} streamToken={streamToken} supabase={supabase!} onSignOut={() => { setStreamToken(null); }} />
    </Suspense>
  );
}

function AuthCallback() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!supabase) {
      setError(authConfigurationError);
      return;
    }
    let active = true;
    async function completeRedirect() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const result = code ? await supabase!.auth.exchangeCodeForSession(code) : await supabase!.auth.getSession();
      if (!active) return;
      if (result.error) {
        setError(result.error.message);
        return;
      }
      if (result.data.session) setLocation('/');
      else setError('The sign-in link did not include an active session. Please try signing in again.');
    }
    void completeRedirect().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not finish signing in.');
    });
    return () => { active = false; };
  }, [setLocation]);

  return (
    <div className="loading-screen" data-testid="screen-auth-callback">
      <div className="workspace-error">
        {error ? <><h2>That sign-in didn't finish.</h2><p data-testid="status-auth-callback-error">{error}</p><button type="button" onClick={() => setLocation('/')} data-testid="button-callback-retry">Return to Tea Chat</button></> : <div className="loading-brand"><Leaf size={20} />Finishing your sign-in…</div>}
      </div>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/auth/callback" component={AuthCallback} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}


type MaintenanceState = { active: boolean; startedAt: string | null; endsAt: string | null };

function MaintenanceScreen({ endsAt }: { endsAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, (endsAt ? new Date(endsAt).getTime() : now) - now);
  const units = [
    { label: 'Days', value: Math.floor(remaining / 86400000) },
    { label: 'Hours', value: Math.floor((remaining % 86400000) / 3600000) },
    { label: 'Minutes', value: Math.floor((remaining % 3600000) / 60000) },
    { label: 'Seconds', value: Math.floor((remaining % 60000) / 1000) },
  ];
  return (
    <main className="maintenance-screen">
      <div className="maintenance-card">
        <div className="maintenance-mark"><Leaf size={25} /></div>
        <p className="maintenance-eyebrow">TEA CHAT · TEMPORARILY AWAY</p>
        <h1>We’ll be back soon.</h1>
        <p className="maintenance-copy">Tea Chat is taking a little break for scheduled maintenance. Thanks for your patience — your conversations will be waiting for you.</p>
        <div className="maintenance-countdown" aria-label="Time until Tea Chat returns">
          {units.map((unit) => <div className="maintenance-unit" key={unit.label}><strong>{String(unit.value).padStart(2, '0')}</strong><span>{unit.label}</span></div>)}
        </div>
        <p className="maintenance-foot">The countdown started when maintenance was activated.</p>
      </div>
    </main>
  );
}


function MaintenanceGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MaintenanceState | null>(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const response = await fetch('/api/maintenance/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Maintenance status unavailable');
        const next = await response.json() as MaintenanceState;
        if (alive) setState(next);
      } catch {
        if (alive) setState({ active: false, startedAt: null, endsAt: null });
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  if (!state) return <div className="loading-screen"><div className="loading-brand"><LoaderCircle size={19} className="animate-spin" />Checking Tea Chat…</div></div>;
  if (state.active) return <MaintenanceScreen endsAt={state.endsAt} />;
  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <MaintenanceGate>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <Router />
            </WouterRouter>
          </MaintenanceGate>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
