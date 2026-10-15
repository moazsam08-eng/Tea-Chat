import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, AtSign, Leaf, LoaderCircle, Moon, Sun } from 'lucide-react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useTheme } from '@/components/ThemeContext';

type AuthScreenProps = { supabase: SupabaseClient | null; configurationError?: string };

export function AuthScreen({ supabase, configurationError }: AuthScreenProps) {
  const { theme, toggleTheme } = useTheme();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const configuredRedirectTo = import.meta.env.VITE_AUTH_REDIRECT_URL?.trim();
  const redirectTo = configuredRedirectTo || `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/auth/callback`;
  const redirectHost = new URL(redirectTo, window.location.origin).hostname;
  const isLocalRedirect = ['localhost', '127.0.0.1', '::1'].includes(redirectHost);

  function readableAuthError(message: string) {
    if (/unsupported provider|provider is not enabled/i.test(message)) {
      return 'Google sign-in is not enabled in Supabase yet. Enable Google under Authentication → Providers, then add its OAuth credentials.';
    }
    return message;
  }

  async function signInGoogle() {
    if (!supabase) return;
    setBusy(true);
    setError('');
    try {
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (authError) setError(readableAuthError(authError.message));
    } catch (reason) {
      setError(readableAuthError(reason instanceof Error ? reason.message : 'Could not start Google sign-in.'));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { error: authError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true, emailRedirectTo: redirectTo },
      });
      if (authError) setError(authError.message);
      else {
        setStep('code');
        setMessage(`A sign-in code is on its way to ${email.trim()}.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send a sign-in code.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { error: authError } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: 'email',
      });
      if (authError) setError(authError.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not verify this code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="tea-app auth-shell" data-testid="screen-auth">
      <button className="theme-toggle auth-theme-toggle" type="button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed={theme === 'dark'} data-testid="button-theme-toggle-auth">
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
      </button>
      <aside className="auth-aside">
        <div className="brand-mark" data-testid="brand-tea-chat">
          <span className="brand-glyph"><Leaf size={18} strokeWidth={1.7} /></span>
          <span>tea chat</span>
        </div>
        <div className="auth-story">
          <span className="eyebrow">A little more room to breathe</span>
          <h1>Good talks,<br />steeped slowly.</h1>
          <p>Your people, your conversations. A softer place to catch up, one thoughtful message at a time.</p>
        </div>
        <div className="tea-stamp"><span className="tea-stamp-line" />Private conversations, made simple</div>
      </aside>
      <section className="auth-main">
        <div className="mobile-auth-brand" data-testid="brand-tea-chat-mobile">
          <span className="brand-glyph"><Leaf size={18} strokeWidth={1.7} /></span>
          <span>tea chat</span>
        </div>
        <div className="auth-card">
          {step === 'code' && <button className="auth-back" type="button" data-testid="button-back-to-email" onClick={() => { setStep('email'); setError(''); setMessage(''); }}><ArrowLeft size={14} /> Change email</button>}
          <span className="eyebrow">{step === 'email' ? 'Come on in' : 'Check your inbox'}</span>
          <h2>{step === 'email' ? 'Make yourself at home.' : 'Your code is the key.'}</h2>
          <p className="auth-intro">{step === 'email' ? 'Sign in to pick up right where your conversations left off.' : `Enter the verification code we sent to ${email}.`}</p>
          {configurationError && <div className="auth-error" role="alert" data-testid="status-auth-configuration">{configurationError}</div>}
          {isLocalRedirect && <div className="auth-error" role="alert" data-testid="status-local-auth-redirect">Sign-in is set to return to localhost, which your phone cannot reach. Open Tea Chat from its public Replit URL, or set VITE_AUTH_REDIRECT_URL to the public callback URL (for example, https://your-app.example/auth/callback) and allow it in Supabase Authentication → URL Configuration.</div>}
          {error && <div className="auth-error" role="alert" data-testid="status-auth-error">{error}</div>}
          {message && <div className="auth-info" role="status" data-testid="status-auth-message">{message}</div>}
          {step === 'email' ? (
            <>
              <form onSubmit={sendCode}>
                <label className="field-label" htmlFor="email">Email address</label>
                <div style={{ position: 'relative' }}>
                  <AtSign size={16} style={{ position: 'absolute', left: 14, top: 16, color: '#87958a' }} />
                  <input id="email" className="tea-input" style={{ paddingLeft: 40 }} type="email" autoComplete="email" required placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} data-testid="input-email" />
                </div>
                <button className="auth-submit" type="submit" disabled={busy || !supabase || !!configurationError} data-testid="button-send-code">
                  {busy ? <LoaderCircle size={16} className="animate-spin" /> : <>Continue with email <ArrowRight size={15} /></>}
                </button>
              </form>
              <div className="auth-divider">or settle in with</div>
              <button className="google-submit" type="button" onClick={signInGoogle} disabled={busy || !supabase || !!configurationError} data-testid="button-google-signin">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <GoogleMark />}
                Continue with Google
              </button>
            </>
          ) : (
            <form onSubmit={verifyCode}>
              <label className="field-label" htmlFor="verification-code">Verification code</label>
              <input id="verification-code" className="tea-input" autoComplete="one-time-code" inputMode="numeric" required minLength={4} maxLength={12} placeholder="Enter your code" value={code} onChange={(event) => setCode(event.target.value)} data-testid="input-verification-code" />
              <button className="auth-submit" type="submit" disabled={busy || !supabase} data-testid="button-verify-code">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <>Verify and sign in <ArrowRight size={15} /></>}
              </button>
              <div style={{ textAlign: 'center', marginTop: 18 }}>
                <span style={{ color: '#89938a', fontSize: 12 }}>Didn't receive a code? </span>
                <button className="text-button" type="button" disabled={busy} data-testid="button-resend-code" onClick={() => { void sendCode(); }}>Send another</button>
              </div>
            </form>
          )}
          <p className="auth-footer">By continuing, you agree to keep the conversation kind.</p>
          <a className="contact-creator" href="https://wa.link/4pvnkw" target="_blank" rel="noopener noreferrer" data-testid="link-contact-creator">Contact the creator</a>
        </div>
      </section>
    </main>
  );
}

function GoogleMark() {
  return <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.9 6.1-15Z" /><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.2A20.4 20.4 0 0 0 24 44Z" /><path fill="#FBBC05" d="M12.6 27.7a12 12 0 0 1 0-7.4v-5.2H5.8a20.2 20.2 0 0 0 0 17.8l6.8-5.2Z" /><path fill="#EA4335" d="M24 11.9c3 0 5.7 1 7.8 3.1l5.9-5.9C34.1 5.8 29.5 4 24 4A20.4 20.4 0 0 0 5.8 15.1l6.8 5.2c1.6-4.8 6.1-8.4 11.4-8.4Z" /></svg>;
}
