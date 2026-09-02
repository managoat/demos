/** The right pane before there is a team (after OpenMausBot's onboarding): what a teammate is, and the one button that matters. */
export function Onboarding({ onAdd, onAddExisting, busy, error }: { onAdd: () => void; onAddExisting: () => void; busy: boolean; error: string | null }) {
  return (
    <section className="thread placeholder">
      <div className="onboarding">
        <div className="glyph">👋</div>
        <h2>Your team, in your messages</h2>
        <p className="muted">
          A teammate is one of your Fountain agents with its own computer and one ongoing conversation with you. Message it
          like a coworker; it keeps working after you close the tab.
        </p>
        <ol className="steps">
          <li>
            <b>Press +</b> — they get a name, a brain (Claude Sonnet) and a face; rename or retune any time.
          </li>
          <li>
            <b>Say hello</b> — the first message starts its computer (a few seconds).
          </li>
          <li>
            <b>Let it build the rest</b> — send your first teammate <code>/create-team</code>: it asks what you want done and
            proposes and creates the others. Teammates can message each other.
          </li>
          <li>
            <b>Keep going</b> — queue notes while it works, paste screenshots, set a routine, search everything with <kbd>⌘K</kbd>.
          </li>
        </ol>
        {error ? (
          <div className="error">{error}</div>
        ) : (
          <div className="row">
            <button onClick={onAdd} disabled={busy}>
              {busy ? "Adding…" : "Add your first teammate"}
            </button>
            <button className="secondary" onClick={onAddExisting} disabled={busy}>
              Use an agent I already have
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
