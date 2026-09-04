/**
 * The tab strip. Each tab is a conversation on the one machine; `+` opens
 * another. A tab that is mid-turn shows it, because while it is, the others
 * cannot take one.
 */
import type { Tab } from "../../shared/tabs";

export function Tabs({
  tabs,
  active,
  onSelect,
  onOpen,
  onClose,
  opening,
  canClose,
  canOpen,
}: {
  tabs: Tab[];
  active: string | null;
  onSelect: (slug: string) => void;
  onOpen: () => void;
  onClose: (slug: string) => void;
  opening: boolean;
  /**
   * Closing a tab ends it for everybody in it — including anyone invited to
   * that terminal — so it is the owner's alone. The × is hidden rather than
   * disabled for the others: an affordance that only ever answers "no" is
   * worse than no affordance.
   */
  canClose: boolean;
  /**
   * Whose machine gets another terminal is the owner's call. Somebody invited
   * to one tab has no business creating a second, so the + is not rendered
   * for them at all.
   */
  canOpen: boolean;
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <div key={t.conversation.id} className={`tab ${t.slug === active ? "active" : ""}`} onClick={() => onSelect(t.slug)}>
          <span className={`dot ${t.busy ? "busy" : ""}`} />
          <span className="tab-title">{t.title}</span>
          {t.stale && <span className="tab-flag" title="Started before the current settings">·</span>}
          {canClose && (
            <button
              className="x"
              title={`Close ${t.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.slug);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {canOpen && (
        <button className="tab add" onClick={onOpen} disabled={opening} title="New terminal on the same machine">
          {opening ? "…" : "+"}
        </button>
      )}
    </div>
  );
}
