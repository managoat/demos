/**
 * What a round did — the record a maintainer checks when a pull request
 * shows up, or when one doesn't.
 *
 * The unit is the file, because that is the unit the round worked in: one
 * cluster per file, one pull request per cluster. Each row is the whole story
 * of one file in one place — what chant flagged, what the agent changed, and
 * where that ended up. Following it to GitHub should be a choice, not the
 * only way to find out what happened.
 *
 * The statuses carry the whole story of an ambient tool, so none of them are
 * hidden: what it opened, what it had already opened, what you declined and
 * it will never raise again, what it held back, and what it tried and could
 * not verify.
 */
import { useState } from "react";
import { fileUrl, type RepoRef } from "../lib/hosts";
import { relativeTime } from "../lib/cron";
import {
  arrangeRound,
  clusterCounts,
  RECONSIDER_LABEL,
  ruleDocUrl,
  type Cluster,
  type ClusterStatus,
  type FileReport,
  type Finding,
  type RoundEntry,
} from "../lib/protocol";
import { Diff } from "./Diff";

const STATUS: Record<ClusterStatus, { label: string; tone: string; blurb: string }> = {
  opened: { label: "opened", tone: "ok", blurb: "a pull request went up this round" },
  "already-open": { label: "already open", tone: "brand", blurb: "proposed in an earlier round, still waiting on you" },
  declined: { label: "declined", tone: "mute", blurb: `you closed this one — it stays closed unless you label that pull request ${RECONSIDER_LABEL}` },
  deferred: { label: "held back", tone: "warn", blurb: "kept back to stay under the open pull request cap" },
  failed: { label: "failed", tone: "danger", blurb: "it could not verify the fix, or the server refused it, so nothing went up" },
  clean: { label: "no action", tone: "mute", blurb: "considered, nothing to do" },
};

/** No cluster at all: chant flagged it and the round never took it up. */
const UNTOUCHED = { label: "not proposed", tone: "mute", blurb: "flagged, but outside what this repo lets rounds propose" };

export function RoundView(props: { entries: RoundEntry[]; repo: RepoRef; running: boolean }) {
  const [showHistory, setShowHistory] = useState(false);
  const latest = props.entries[0];

  if (!latest) {
    return (
      <section className="round">
        <p className="fineprint">
          {props.running
            ? "First round in progress — it is cloning the repo and running chant now."
            : "No rounds yet. The first one runs on schedule, or press Run now."}
        </p>
      </section>
    );
  }

  const { round } = latest;
  const counts = clusterCounts(round);
  const view = arrangeRound(round);
  const branch = round.branch ?? "main";

  return (
    <>
      <section className="round">
        <div className="round-head">
          <h3>Latest round</h3>
          <span className="fineprint">
            {relativeTime(latest.ranAt ?? latest.round.at ?? null)}
            {round.commit && ` · ${branch}@${round.commit.slice(0, 7)}`}
            {round.scanned !== undefined && ` · ${round.scanned} files`}
          </span>
        </div>

        {round.error ? (
          <p className="error">{round.error}</p>
        ) : (
          <>
            {/* What happened, from the record rather than from a sentence the
                round wrote about itself. The last two only appear when they
                are not zero: a bot that reports "0 failed" every week is
                teaching you to stop reading it. */}
            <div className="tiles">
              <Tile n={round.summary.total} label="findings" />
              <Tile n={counts.opened} label="opened" tone={counts.opened > 0 ? "ok" : undefined} />
              <Tile n={round.openPrs} label="awaiting you" tone={round.openPrs > 0 ? "brand" : undefined} />
              {counts.deferred > 0 && <Tile n={counts.deferred} label="held back" tone="warn" />}
              {counts.failed > 0 && <Tile n={counts.failed} label="failed" tone="danger" />}
            </div>

            {view.files.length === 0 && view.orphans.length === 0 && (
              <p className="fineprint">Nothing to act on this round.</p>
            )}

            {view.files.length > 0 && (
              <div className="clusters">
                {view.files.map((f) => (
                  <FileRow key={f.file} report={f} repo={props.repo} branch={branch} />
                ))}
              </div>
            )}

            {/* A cluster the round reported without sending its findings —
                trimmed for size, or a file whose findings are already gone.
                It still has a status, so it still gets a row. */}
            {view.orphans.length > 0 && (
              <div className="clusters">
                {view.orphans.map((c) => (
                  <FileRow
                    key={c.key}
                    report={{ file: c.file, cluster: c, findings: [], ...(c.diff ? { diff: c.diff } : {}) }}
                    repo={props.repo}
                    branch={branch}
                  />
                ))}
              </div>
            )}

            {view.reportOnly.length > 0 && <Hygiene findings={view.reportOnly} />}
            {/* Always at round level, never inside the fold: a count of what
                the round did not tell us is exactly the thing that must not
                itself be hidden behind a disclosure. */}
            {round.omitted > 0 && <p className="fineprint">{`${round.omitted} further findings not listed.`}</p>}
          </>
        )}
      </section>

      {props.entries.length > 1 && (
        <section className="history">
          <button className="disclosure" onClick={() => setShowHistory((v) => !v)}>
            {`${showHistory ? "▾" : "▸"} Earlier rounds — ${props.entries.length - 1}`}
          </button>
          {showHistory && (
            <ul className="historylist">
              {props.entries.slice(1).map((e, i) => {
                const o = e.round.clusters.filter((c) => c.status === "opened").length;
                return (
                  <li key={i}>
                    <span className="when">{relativeTime(e.ranAt ?? e.round.at ?? null)}</span>
                    <span className="what">
                      {e.round.error
                        ? e.round.error
                        : o > 0
                          ? `opened ${o} pull request${o === 1 ? "" : "s"}`
                          : `${e.round.summary.total} findings, nothing new to propose`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

/** One file: what was flagged, what changed, and where it went. */
function FileRow(props: { report: FileReport; repo: RepoRef; branch: string }) {
  const { report } = props;
  const c: Cluster | null = report.cluster;
  const s = c ? STATUS[c.status] : UNTOUCHED;

  return (
    <div className={`cluster tone-${s.tone}`}>
      <div className="cluster-top">
        <span className={`status ${s.tone}`} title={s.blurb}>
          {s.label}
        </span>
        <a className="cfile" href={fileUrl(props.repo, props.branch, report.file)} target="_blank" rel="noreferrer">
          <code>{report.file}</code>
        </a>
        {c?.pr !== undefined &&
          (c.url ? (
            <a className="prnum" href={c.url} target="_blank" rel="noreferrer">
              #{c.pr} ↗
            </a>
          ) : (
            <span className="prnum">#{c.pr}</span>
          ))}
      </div>

      {c?.title && <div className="ctitle">{c.title}</div>}

      {report.findings.length > 0 ? (
        <ul className="findings">
          {report.findings.map((f, i) => (
            <FindingRow key={f.checkId + i} finding={f} />
          ))}
        </ul>
      ) : (
        // No findings came through for this file, but the cluster named its
        // rules — show those rather than an empty row.
        c &&
        c.checkIds.length > 0 && (
          <div className="cmeta">
            {c.checkIds.map((id) => (
              <a key={id} className="ruleid" href={ruleDocUrl(id)} target="_blank" rel="noreferrer">
                {id}
              </a>
            ))}
          </div>
        )
      )}

      {c?.note && <p className="cnote">{c.note}</p>}
      {/* The one way back, said where the "no" is visible — otherwise a
          cluster closed by mistake is unrecoverable and nothing says so. */}
      {c?.status === "declined" && (
        <p className="cnote">
          {c.pr !== undefined ? <>Label #{c.pr} </> : <>Label that pull request </>}
          <code>{RECONSIDER_LABEL}</code> on GitHub to have it proposed again.
        </p>
      )}
      {report.diff && <Diff diff={report.diff} />}
    </div>
  );
}

/**
 * A finding, with the agent's own line about it when there is one.
 *
 * `note` is what the agent changed; `remediation` is what chant advises. When
 * the fix happened the note is the truer sentence, so it wins — the advice is
 * only interesting for something nobody has acted on.
 */
function FindingRow(props: { finding: Finding }) {
  const f = props.finding;
  const said = f.note ?? f.remediation ?? f.message;
  return (
    <li className={`finding sev-${f.severity}`}>
      <div className="finding-top">
        <span className={`sev ${f.severity}`}>{f.severity}</span>
        <span className="ftitle">{f.title}</span>
        <a className="ruleid" href={ruleDocUrl(f.checkId)} target="_blank" rel="noreferrer">
          {f.checkId}
        </a>
        {f.fixKind === "guidance" && <span className="fjudgment" title="chant would not guess at this fix — the change is the agent's">judgment call</span>}
      </div>
      {f.entity && <code className="fentity">{f.entity}</code>}
      {said && <p className="fsaid">{said}</p>}
    </li>
  );
}

/**
 * The report-only tier: worth knowing, never worth a pull request. Collapsed,
 * because it is the part nobody has to act on — but present, because "chant
 * read this and had opinions it is not acting on" is a result.
 */
function Hygiene(props: { findings: Finding[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="hygiene">
      <button className="disclosure" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {`${open ? "▾" : "▸"} Noted, not proposed — ${props.findings.length}`}
      </button>
      {open && (
        <>
          <p className="fineprint">chant flags these but will not open a pull request for them.</p>
          <ul className="findings">
            {props.findings.map((f, i) => (
              <li key={f.checkId + i} className={`finding sev-${f.severity}`}>
                <div className="finding-top">
                  <span className={`sev ${f.severity}`}>{f.severity}</span>
                  <span className="ftitle">{f.title}</span>
                  <a className="ruleid" href={ruleDocUrl(f.checkId)} target="_blank" rel="noreferrer">
                    {f.checkId}
                  </a>
                </div>
                <code className="fentity">{f.file}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Tile(props: { n: number; label: string; tone?: string }) {
  return (
    <div className={props.tone ? `tile tone-${props.tone}` : "tile"}>
      <b>{props.n}</b>
      <span>{props.label}</span>
    </div>
  );
}
