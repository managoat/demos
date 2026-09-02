/**
 * The available half of the rail: repositories the App can already reach,
 * waiting to be enrolled.
 *
 * Enrolling used to mean typing `owner/name` into a box — which asks somebody
 * to remember the exact spelling of something we were already told about at
 * sign-in. So the rail shows both halves: what is enrolled above, and this
 * below, a list to get through one repository at a time. Enroll it, or wave it
 * away and it stops asking.
 *
 * The ordering and the filtering are in `lib/repos.ts`, tested there, because
 * "these are the ones you probably meant" is a claim rather than a layout.
 */
import { useMemo, useState } from "react";
import { describeCron, relativeTime } from "../lib/cron";
import { keyOfSlug, railRepos, type AccessibleRepo, type RepoFilter } from "../lib/repos";
import { CRON_PRESETS } from "../lib/spec";

export function RepoPicker(props: {
  repos: AccessibleRepo[];
  enrolledKeys: Set<string>;
  skipped: Set<string>;
  /** Enrolling is in flight for this repo key (`host/owner/name`), or null. */
  busy: string | null;
  /** Nothing can be enrolled until GitHub is signed in and the App is on. */
  ready: boolean;
  loading: boolean;
  /** The cadence a click on Enroll uses — remembered between visits. */
  cron: string;
  onCron: (cron: string) => void;
  onEnroll: (slug: string, cron: string) => void;
  onSkip: (slug: string) => void;
  onUnskip: (slug: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RepoFilter>("suggested");

  // Once per render is plenty, but `now` must not be read during render on
  // every keystroke or the sort could change under a click.
  const now = useMemo(() => Date.now(), [props.repos]);
  const { available, hiddenByFilter, skippedCount, totalAvailable } = useMemo(
    () => railRepos({ repos: props.repos, enrolledKeys: props.enrolledKeys, skipped: props.skipped, query, filter, now }),
    [props.repos, props.enrolledKeys, props.skipped, query, filter, now],
  );

  if (!props.ready) return null;
  if (props.loading && props.repos.length === 0) return <p className="fineprint">Looking at what the App can reach…</p>;
  if (totalAvailable === 0 && skippedCount === 0) {
    return <p className="fineprint">Every repository the App can reach is enrolled.</p>;
  }

  const chip = (value: RepoFilter, label: string, count?: number) => (
    <button className={filter === value ? "chip on" : "chip"} onClick={() => setFilter(value)} type="button">
      {label}
      {count !== undefined && count > 0 && <i>{count}</i>}
    </button>
  );

  return (
    <div className="picker">
      <div className="picker-head">
        <span className="railhead">Not enrolled</span>
        <input
          className="picker-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search repositories"
          aria-label="search repositories"
        />
        <div className="chips">
          {chip("suggested", "Active")}
          {chip("all", "All", totalAvailable)}
          {skippedCount > 0 && chip("skipped", "Skipped", skippedCount)}
        </div>
        {/* One cadence for the list rather than one per row: enrolling five
            repositories is five clicks, and answering the same question five
            times is not a choice, it is a toll. Each repo's own page can
            change it afterwards. */}
        <label className="picker-cadence">
          <span>Runs</span>
          <select value={props.cron} onChange={(e) => props.onCron(e.target.value)} aria-label="cadence for new repositories">
            {CRON_PRESETS.map((preset) => (
              <option key={preset.cron} value={preset.cron}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="picker-list">
        {available.map((r) => (
          <div className={r.archived ? "pickrow archived" : "pickrow"} key={r.slug}>
            <div className="pickmain">
              <code title={r.description ?? r.slug}>{r.slug}</code>
              <span className="pickmeta">
                {r.private && <i className="tag">private</i>}
                {r.fork && <i className="tag">fork</i>}
                {r.archived && <i className="tag warnTag">archived</i>}
                {r.pushedAt && <span title={r.pushedAt}>{relativeTime(r.pushedAt)}</span>}
              </span>
            </div>
            <div className="pickacts">
              {filter === "skipped" ? (
                <button className="linkish" onClick={() => props.onUnskip(r.slug)} type="button">
                  put back
                </button>
              ) : (
                <button className="linkish" onClick={() => props.onSkip(r.slug)} type="button" title="Hide it from this list">
                  skip
                </button>
              )}
              <button
                className="primary tiny"
                onClick={() => props.onEnroll(r.slug, props.cron)}
                disabled={props.busy !== null}
                type="button"
              >
                {props.busy === keyOfSlug(r.slug) ? "…" : "Enroll"}
              </button>
            </div>
          </div>
        ))}

        {available.length === 0 && (
          <p className="fineprint">
            {query.trim()
              ? "Nothing matches that."
              : filter === "skipped"
                ? "Nothing skipped."
                : "Nothing pushed to lately. Try All."}
          </p>
        )}
      </div>

      {filter === "suggested" && hiddenByFilter > 0 && (
        <button className="linkish" onClick={() => setFilter("all")} type="button">
          {hiddenByFilter} more, quiet or archived
        </button>
      )}
      <p className="fineprint">
        Enrolling runs it {describeCron(props.cron).toLowerCase()} and proposes both merge-worthy tiers. Both are
        yours to change afterwards.
      </p>
    </div>
  );
}
