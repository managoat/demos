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
}: {
  tabs: Tab[];
  active: string | null;
  onSelect: (slug: string) => void;
  onOpen: () => void;
  onClose: (slug: string) => void;
  opening: boolean;
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <div key={t.slug} className={`tab ${t.slug === active ? "active" : ""}`} onClick={() => onSelect(t.slug)}>
          <span className={`dot ${t.busy ? "busy" : ""}`} />
          <span className="tab-title">{t.title}</span>
          {t.stale && <span className="tab-flag" title="Started before the current settings">·</span>}
          {tabs.length > 1 && (
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
      <button className="tab add" onClick={onOpen} disabled={opening} title="New terminal on the same machine">
        {opening ? "…" : "+"}
      </button>
    </div>
  );
}
