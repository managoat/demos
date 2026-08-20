/**
 * The dossier header: what the sage reported in its repo-map. Language bar,
 * component cards (click → GitHub), entry points, the how-it-works paragraph.
 */
import { blobUrl } from "../lib/github";
import type { RepoMap } from "../lib/protocol";

// A small, calm palette for the language bar; stable per language name.
const BAR_COLORS = ["#5e8d6d", "#7a9e7e", "#b3a369", "#8d7d5e", "#6d8d8a", "#9e7a7a", "#5e6d8d", "#8a6d8d"];

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return BAR_COLORS[h % BAR_COLORS.length]!;
}

function formatLoc(loc: number): string {
  if (loc >= 1_000_000) return `${(loc / 1_000_000).toFixed(1)}M`;
  if (loc >= 1_000) return `${Math.round(loc / 1_000)}k`;
  return String(loc);
}

export function Dossier(props: { map: RepoMap }) {
  const { map } = props;
  const total = map.languages.reduce((sum, l) => sum + l.share, 0);
  const languages = total > 0 ? map.languages.map((l) => ({ ...l, share: l.share / total })) : [];

  return (
    <section className="dossier">
      <div className="dossier-head">
        <a className="dossier-repo" href={`https://github.com/${map.repo}`} target="_blank" rel="noreferrer">
          {map.repo}
        </a>
        <span className="dossier-meta">
          {map.default_branch}
          {map.loc !== undefined && ` · ~${formatLoc(map.loc)} lines`}
        </span>
      </div>
      {map.description && <p className="dossier-desc">{map.description}</p>}

      {languages.length > 0 && (
        <div className="langs">
          <div className="langbar" role="img" aria-label="language mix">
            {languages.map((l) => (
              <span key={l.name} style={{ width: `${Math.max(l.share * 100, 1)}%`, background: colorFor(l.name) }} title={`${l.name} ${Math.round(l.share * 100)}%`} />
            ))}
          </div>
          <div className="langkey">
            {languages.map((l) => (
              <span key={l.name}>
                <i style={{ background: colorFor(l.name) }} />
                {l.name} {Math.round(l.share * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}

      {map.components.length > 0 && (
        <div className="components">
          {map.components.map((c) => (
            <a key={c.path + c.name} className="component" href={blobUrl(map.repo, map.default_branch, c.path)} target="_blank" rel="noreferrer">
              <b>{c.name}</b>
              <code>{c.path}</code>
              {c.role && <span>{c.role}</span>}
            </a>
          ))}
        </div>
      )}

      {map.entry_points.length > 0 && (
        <div className="entries">
          <span className="entries-label">starts at</span>
          {map.entry_points.map((p) => (
            <a key={p} href={blobUrl(map.repo, map.default_branch, p)} target="_blank" rel="noreferrer">
              <code>{p}</code>
            </a>
          ))}
        </div>
      )}

      {map.how_it_works && <p className="dossier-how">{map.how_it_works}</p>}
    </section>
  );
}
