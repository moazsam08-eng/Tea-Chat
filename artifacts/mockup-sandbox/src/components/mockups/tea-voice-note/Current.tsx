import './_group.css';

export function Current() {
  const assetBase = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return (
    <main className="tea-voice-note-preview">
      <h1 className="tea-voice-note-preview__heading">Current voice note · provided screenshot</h1>
      <section className="tea-voice-note-preview__message" aria-label="Existing voice message">
        <img
          className="tea-voice-note-preview__image"
          src={`${assetBase}tea-current-voice-note.png`}
          alt="Existing Tea Chat voice note with the generic audio file card"
        />
      </section>
    </main>
  );
}
