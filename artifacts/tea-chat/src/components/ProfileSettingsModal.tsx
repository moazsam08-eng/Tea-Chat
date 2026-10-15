import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Camera, LoaderCircle, X } from 'lucide-react';

type ProfileSettingsModalProps = {
  userId: string;
  name: string;
  image: string | null;
  supabase: SupabaseClient;
  onClose: () => void;
  onSaved: (profile: { name: string; image: string | null }) => void;
};

const PHOTO_LIMIT_BYTES = 5 * 1024 * 1024;
const PHOTO_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function ProfileSettingsModal({
  userId,
  name: initialName,
  image: initialImage,
  supabase,
  onClose,
  onSaved,
}: ProfileSettingsModalProps) {
  const [name, setName] = useState(initialName);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState(initialImage ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!photo) {
      setPreview(initialImage ?? '');
      return;
    }
    const objectUrl = URL.createObjectURL(photo);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [photo, initialImage]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim();
    if (cleanName.length < 2 || cleanName.length > 60) {
      setError('Choose a name between 2 and 60 characters.');
      return;
    }

    setBusy(true);
    setError('');
    let imageUrl = initialImage;

    try {
      if (photo) {
        const extension = PHOTO_EXTENSIONS[photo.type];
        if (!extension || photo.size > PHOTO_LIMIT_BYTES) {
          throw new Error('Choose a JPG, PNG, or WebP photo smaller than 5 MB.');
        }
        const path = `${userId}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage
          .from('profile-photos')
          .upload(path, photo, {
            cacheControl: '3600',
            contentType: photo.type,
            upsert: false,
          });
        if (uploadError) {
          throw new Error(
            /bucket|policy|not found/i.test(uploadError.message)
              ? 'Profile photo storage is not set up yet. Apply supabase/setup.sql in your Supabase project.'
              : uploadError.message,
          );
        }
        imageUrl = supabase.storage.from('profile-photos').getPublicUrl(path).data.publicUrl;
      }

      const { error: metadataError } = await supabase.auth.updateUser({
        data: {
          full_name: cleanName,
          name: cleanName,
          avatar_url: imageUrl,
        },
      });
      if (metadataError) throw new Error(metadataError.message);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Your sign-in session expired. Sign in again and retry.');
      const response = await fetch('/api/stream/profile', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: cleanName, image: imageUrl }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || 'Your account profile was saved, but the chat profile could not be synced.');
      }

      onSaved({ name: cleanName, image: imageUrl });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save your profile. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function choosePhoto(file: File | undefined) {
    setError('');
    if (!file) return;
    if (!PHOTO_EXTENSIONS[file.type] || file.size > PHOTO_LIMIT_BYTES) {
      setError('Choose a JPG, PNG, or WebP photo smaller than 5 MB.');
      return;
    }
    setPhoto(file);
  }

  return (
    <div className="modal-scrim profile-modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title" data-testid="dialog-profile-settings">
        <div className="profile-modal-heading">
          <div>
            <span className="eyebrow">Your profile</span>
            <h2 id="profile-modal-title">Make it yours.</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close profile settings" disabled={busy} data-testid="button-close-profile-settings"><X size={18} /></button>
        </div>
        <form onSubmit={(event) => { void saveProfile(event); }}>
          <div className="profile-photo-picker">
            <div className="profile-photo-preview">
              {preview ? <img src={preview} alt="Profile preview" /> : <span>{name.trim().slice(0, 1).toUpperCase() || 'T'}</span>}
            </div>
            <div className="profile-photo-actions">
              <button className="secondary-action" type="button" onClick={() => inputRef.current?.click()} disabled={busy} data-testid="button-choose-profile-photo"><Camera size={15} />{photo ? 'Choose another photo' : 'Add a photo'}</button>
              <p>JPG, PNG, or WebP · up to 5 MB</p>
              <input
                ref={inputRef}
                className="visually-hidden"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => choosePhoto(event.currentTarget.files?.[0])}
                data-testid="input-profile-photo"
              />
            </div>
          </div>
          <label className="field-label" htmlFor="profile-display-name">Display name</label>
          <input
            id="profile-display-name"
            className="tea-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            autoComplete="name"
            required
            data-testid="input-profile-name"
          />
          {error && <p className="profile-form-error" role="alert" data-testid="status-profile-save-error">{error}</p>}
          <div className="profile-modal-actions">
            <button className="secondary-action" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary-action" type="submit" disabled={busy} data-testid="button-save-profile">
              {busy ? <><LoaderCircle size={15} className="animate-spin" />Saving…</> : 'Save profile'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
