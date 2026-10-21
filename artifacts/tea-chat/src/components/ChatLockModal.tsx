import { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LoaderCircle, LockKeyhole, Mail, X } from 'lucide-react';

type CodeType = 'numbers' | 'letters' | 'both';
type LockMode = 'setup' | 'unlock' | 'remove';
type RecoveryScreen = 'form' | 'send-code' | 'verify-code' | 'recovered';

type ChatLockModalProps = {
  mode: 'setup' | 'unlock';
  channelCid: string;
  channelTitle: string;
  email: string;
  hasPasscode: boolean;
  supabase: SupabaseClient;
  onClose: () => void;
  onLocked: (channelCid: string) => void;
  onUnlocked: (channelCid: string) => void;
  onRemoved: (channelCid: string) => void;
};

const CODE_TYPES: { value: CodeType; label: string }[] = [
  { value: 'numbers', label: 'Numbers' },
  { value: 'letters', label: 'Letters' },
  { value: 'both', label: 'Both' },
];

function isValidCode(code: string, type: CodeType) {
  if (type === 'numbers') return /^[0-9]{4,32}$/.test(code);
  if (type === 'letters') return /^[A-Za-z]{4,32}$/.test(code);
  return /^[A-Za-z0-9]{4,32}$/.test(code);
}

function readableLockError(message: string) {
  if (/schema cache|function .* does not exist|could not find the function|relation .* does not exist/i.test(message)) {
    return 'Chat locks are not set up yet. Apply supabase/chat-locks.sql in your Supabase SQL Editor, then try again.';
  }
  if (/verify your account again/i.test(message)) {
    return 'Verify your email before changing the lock code.';
  }
  return message || 'The chat lock could not be updated. Please try again.';
}

export function ChatLockModal({
  mode: initialMode,
  channelCid,
  channelTitle,
  email: accountEmail,
  hasPasscode,
  supabase,
  onClose,
  onLocked,
  onUnlocked,
  onRemoved,
}: ChatLockModalProps) {
  const [mode, setMode] = useState<LockMode>(initialMode);
  const [screen, setScreen] = useState<RecoveryScreen>('form');
  const [codeType, setCodeType] = useState<CodeType>('numbers');
  const [passcode, setPasscode] = useState('');
  const [confirmPasscode, setConfirmPasscode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const email = accountEmail.trim();

  function validateNewCode() {
    if (!isValidCode(passcode, codeType)) {
      setError(codeType === 'numbers'
        ? 'Use 4–32 numbers.'
        : codeType === 'letters'
          ? 'Use 4–32 letters.'
          : 'Use 4–32 letters and numbers.');
      return false;
    }
    if (passcode !== confirmPasscode) {
      setError('The two passcodes do not match.');
      return false;
    }
    return true;
  }

  async function submitSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!hasPasscode && !validateNewCode()) return;
    setBusy(true);
    try {
      if (!hasPasscode) {
        const { error: codeError } = await supabase.rpc('set_chat_lock_code', {
          p_code: passcode,
          p_code_type: codeType,
        });
        if (codeError) throw new Error(readableLockError(codeError.message));
      }
      const { error: lockError } = await supabase.rpc('add_chat_lock', {
        p_channel_cid: channelCid,
      });
      if (lockError) throw new Error(readableLockError(lockError.message));
      onLocked(channelCid);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The chat could not be locked. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const { data, error: verifyError } = await supabase.rpc('verify_chat_lock', {
        p_channel_cid: channelCid,
        p_code: passcode,
      });
      if (verifyError) throw new Error(readableLockError(verifyError.message));
      if (data !== true) {
        setError('That code did not match. After five incorrect tries, you’ll need to wait five minutes.');
        return;
      }
      onUnlocked(channelCid);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not check that code. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitRemove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const { data, error: removeError } = await supabase.rpc('remove_chat_lock', {
        p_channel_cid: channelCid,
        p_code: passcode,
      });
      if (removeError) throw new Error(readableLockError(removeError.message));
      if (data !== true) {
        setError('That code did not match. After five incorrect tries, you’ll need to wait five minutes.');
        return;
      }
      onRemoved(channelCid);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove this lock. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function sendRecoveryCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!email) {
      setError('This account does not have an email address for recovery.');
      return;
    }
    setBusy(true);
    try {
      const { error: sendError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: new URL('/auth/callback', window.location.origin).toString(),
        },
      });
      if (sendError) throw new Error(sendError.message);
      setScreen('verify-code');
      setMessage('A verification code was sent to ' + email + '. Choose a new lock code below.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send an account verification code.');
    } finally {
      setBusy(false);
    }
  }

  async function submitRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!emailCode.trim()) {
      setError('Enter the verification code from your email.');
      return;
    }
    if (!validateNewCode()) return;
    setBusy(true);
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: emailCode.trim(),
        type: 'email',
      });
      if (verifyError) throw new Error(verifyError.message);
      const { error: resetError } = await supabase.rpc('set_chat_lock_code', {
        p_code: passcode,
        p_code_type: codeType,
      });
      if (resetError) throw new Error(readableLockError(resetError.message));
      setScreen('recovered');
      setMessage('Your lock code was reset. Reopen this chat and use the new code.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reset the lock code. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const isSetup = mode === 'setup';
  const title = screen === 'recovered'
    ? 'Code reset'
    : screen === 'send-code' || screen === 'verify-code'
      ? 'Recover your lock code'
      : isSetup
        ? hasPasscode ? 'Lock this chat' : 'Create your lock code'
        : mode === 'remove'
          ? 'Remove this lock'
          : 'This chat is locked';

  return (
    <div className="modal-scrim lock-modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="profile-modal lock-modal" role="dialog" aria-modal="true" aria-labelledby="chat-lock-title" data-testid="dialog-chat-lock">
        <div className="profile-modal-heading">
          <div>
            <span className="eyebrow">Private chats</span>
            <h2 id="chat-lock-title">{title}</h2>
            <p className="lock-modal-description">{channelTitle}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close chat lock" disabled={busy} data-testid="button-close-chat-lock"><X size={18} /></button>
        </div>

        {screen === 'send-code' && (
          <form onSubmit={(event) => { void sendRecoveryCode(event); }}>
            <p className="lock-modal-help">We’ll verify your Tea Chat account by email before changing the code. {email ? 'The code will go to ' + email + '.' : 'This account does not have a recovery email.'}</p>
            {error && <p className="lock-modal-error" role="alert">{error}</p>}
            <div className="profile-modal-actions lock-modal-actions">
              <button className="secondary-action" type="button" onClick={() => { setScreen('form'); setError(''); }} disabled={busy}>Back</button>
              <button className="primary-action" type="submit" disabled={busy || !email} data-testid="button-send-lock-recovery-code">
                {busy ? <><LoaderCircle size={15} className="animate-spin" />Sending…</> : <><Mail size={15} />Send verification code</>}
              </button>
            </div>
          </form>
        )}

        {screen === 'verify-code' && (
          <form onSubmit={(event) => { void submitRecovery(event); }}>
            <p className="lock-modal-help">Enter the email code and choose a replacement lock code. Verifying the email also signs your account in again.</p>
            <label className="field-label" htmlFor="chat-lock-email-code">Email verification code</label>
            <input id="chat-lock-email-code" className="tea-input" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={12} required value={emailCode} onChange={(event) => setEmailCode(event.target.value)} data-testid="input-lock-email-code" />
            <CodeTypePicker codeType={codeType} onChange={setCodeType} />
            <NewCodeFields codeType={codeType} passcode={passcode} confirmPasscode={confirmPasscode} onPasscodeChange={setPasscode} onConfirmChange={setConfirmPasscode} />
            {message && <p className="lock-modal-message" role="status">{message}</p>}
            {error && <p className="lock-modal-error" role="alert">{error}</p>}
            <div className="profile-modal-actions lock-modal-actions">
              <button className="secondary-action" type="button" onClick={() => { setScreen('send-code'); setError(''); }} disabled={busy}>Resend code</button>
              <button className="primary-action" type="submit" disabled={busy} data-testid="button-reset-chat-lock-code">
                {busy ? <><LoaderCircle size={15} className="animate-spin" />Verifying…</> : 'Verify and reset code'}
              </button>
            </div>
          </form>
        )}

        {screen === 'recovered' && (
          <div>
            <p className="lock-modal-message" role="status">{message}</p>
            <div className="profile-modal-actions lock-modal-actions">
              <button className="primary-action" type="button" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {screen === 'form' && isSetup && (
          <form onSubmit={(event) => { void submitSetup(event); }}>
            <p className="lock-modal-help">{hasPasscode ? 'Your existing passcode will protect this conversation too.' : 'Create one passcode for every chat you lock. Use at least 4 characters and choose its format.'}</p>
            {!hasPasscode && (
              <>
                <CodeTypePicker codeType={codeType} onChange={setCodeType} />
                <NewCodeFields codeType={codeType} passcode={passcode} confirmPasscode={confirmPasscode} onPasscodeChange={setPasscode} onConfirmChange={setConfirmPasscode} />
              </>
            )}
            {error && <p className="lock-modal-error" role="alert">{error}</p>}
            <div className="profile-modal-actions lock-modal-actions">
              <button className="secondary-action" type="button" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="primary-action" type="submit" disabled={busy} data-testid="button-create-chat-lock">
                {busy ? <><LoaderCircle size={15} className="animate-spin" />Locking…</> : <><LockKeyhole size={15} />{hasPasscode ? 'Lock chat' : 'Create code and lock chat'}</>}
              </button>
            </div>
          </form>
        )}

        {screen === 'form' && !isSetup && (
          <form onSubmit={(event) => { void (mode === 'remove' ? submitRemove(event) : submitUnlock(event)); }}>
            <p className="lock-modal-help">Enter your passcode to {mode === 'remove' ? 'remove the lock from' : 'open'} this conversation.</p>
            <label className="field-label" htmlFor="chat-lock-passcode">Passcode</label>
            <input id="chat-lock-passcode" className="tea-input" type="password" autoComplete="off" inputMode="text" maxLength={32} required value={passcode} onChange={(event) => setPasscode(event.target.value)} data-testid="input-chat-lock-passcode" />
            {error && <p className="lock-modal-error" role="alert">{error}</p>}
            <div className="profile-modal-actions lock-modal-actions">
              <button className="secondary-action" type="button" onClick={() => { setScreen('send-code'); setError(''); }} disabled={busy} data-testid="button-forgot-chat-lock-code">Forgot code?</button>
              <button className="primary-action" type="submit" disabled={busy} data-testid={mode === 'remove' ? 'button-remove-chat-lock' : 'button-unlock-chat'}>
                {busy ? <><LoaderCircle size={15} className="animate-spin" />Checking…</> : mode === 'remove' ? 'Remove lock' : 'Open chat'}
              </button>
            </div>
            {mode === 'unlock' && <button className="lock-modal-link" type="button" onClick={() => { setMode('remove'); setPasscode(''); setError(''); }} disabled={busy} data-testid="button-change-lock-remove">Remove the lock permanently</button>}
            {mode === 'remove' && <button className="lock-modal-link" type="button" onClick={() => { setMode('unlock'); setPasscode(''); setError(''); }} disabled={busy}>Keep the lock</button>}
          </form>
        )}
      </section>
    </div>
  );
}

function CodeTypePicker({ codeType, onChange }: { codeType: CodeType; onChange: (type: CodeType) => void }) {
  return (
    <fieldset className="lock-code-type-picker">
      <legend className="field-label">Passcode format</legend>
      <div className="lock-code-type-options">
        {CODE_TYPES.map((option) => (
          <button key={option.value} className="lock-code-type" type="button" aria-pressed={codeType === option.value} onClick={() => onChange(option.value)}>{option.label}</button>
        ))}
      </div>
      <span className="lock-code-hint">{codeType === 'numbers' ? '4–32 digits' : codeType === 'letters' ? '4–32 letters' : '4–32 letters and numbers'}</span>
    </fieldset>
  );
}

function NewCodeFields({
  codeType,
  passcode,
  confirmPasscode,
  onPasscodeChange,
  onConfirmChange,
}: {
  codeType: CodeType;
  passcode: string;
  confirmPasscode: string;
  onPasscodeChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
}) {
  const inputMode = codeType === 'numbers' ? 'numeric' : 'text';
  return (
    <div className="lock-new-code-fields">
      <label className="field-label" htmlFor="chat-lock-new-code">New passcode</label>
      <input id="chat-lock-new-code" className="tea-input" type="password" autoComplete="new-password" inputMode={inputMode} minLength={4} maxLength={32} required value={passcode} onChange={(event) => onPasscodeChange(event.target.value)} data-testid="input-new-chat-lock-code" />
      <label className="field-label" htmlFor="chat-lock-confirm-code">Confirm passcode</label>
      <input id="chat-lock-confirm-code" className="tea-input" type="password" autoComplete="new-password" inputMode={inputMode} minLength={4} maxLength={32} required value={confirmPasscode} onChange={(event) => onConfirmChange(event.target.value)} data-testid="input-confirm-chat-lock-code" />
    </div>
  );
}
