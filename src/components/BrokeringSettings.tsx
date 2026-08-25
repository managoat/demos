/**
 * The owner's view of the egress broker's replacement config, joined to this
 * project: which of the environment's and vault's secrets are brokered — and
 * to which hosts, in what shape — and which reach the sandbox in the clear.
 *
 * Read-only. The bindings are account-wide and edited on Fountain's own
 * "Credential bindings" page; this is the project-shaped answer to "what will
 * a sandbox started here actually hold?", which that page does not give,
 * because it does not know which environment and vault a project pairs.
 *
 * `BrokeringPanel` is the pure half; `BrokeringSettings` fetches once on
 * mount and again when the environment or vault changes, since the join
 * changes with them.
 */
import { useEffect, useState } from "react";
import { useWorkbench } from "../store";
import { api, type BrokeringDto, type SecretBinding } from "../lib/api";
import { describeError } from "../lib/errors";

export function BrokeringSettings({ projectId, environmentId, vaultId }: { projectId: string; environmentId: string | null; vaultId: string | null }) {
  const { me } = useWorkbench();
  const [dto, setDto] = useState<BrokeringDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDto(null);
    api
      .brokering(projectId)
      .then((d) => {
        if (!cancelled) setDto(d);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, environmentId, vaultId]);
  return <BrokeringPanel dto={dto} error={error} bindingsUrl={`${me.fountainUrl}/account/bindings`} />;
}

/** One binding's auth shape, in a phrase. */
export function shapeOf(b: SecretBinding): string {
  switch (b.auth_type) {
    case "substitute":
      return "replaces the placeholder wherever it appears";
    case "bearer":
      return "Authorization: Bearer …";
    case "basic":
      return `basic auth as ${b.username ?? "?"}`;
    case "api_key":
      return `${b.header || "Authorization"}: ${b.prefix ?? ""}…`;
    case "custom":
      return Object.keys(b.headers ?? {}).join(", ") || "custom headers";
  }
}

export function BrokeringPanel({ dto, error, bindingsUrl }: { dto: BrokeringDto | null; error: string | null; bindingsUrl: string }) {
  if (error) return <p className="muted small">{error}</p>;
  if (!dto) return <p className="muted small">Loading…</p>;
  if (!dto.enabled) {
    return <p className="muted small">Not on for your account: sandboxes started here hold their credentials and reach the internet directly. Brokering is switched on per deployment, by its operator.</p>;
  }
  const clear = dto.secrets.filter((s) => s.hosts.length === 0);
  const brokered = dto.secrets.filter((s) => s.hosts.length > 0);
  return (
    <div className="stack tight">
      <p className="muted small">
        Sandboxes started here reach the internet only through the egress broker. A secret bound to a host is handed to the sandbox as a placeholder and put on the wire at the broker; one with no binding goes into the sandbox as it is.
      </p>
      {!dto.environment && !dto.vault ? (
        <p className="muted small">No environment or vault is set, so a sandbox started here holds no secrets at all.</p>
      ) : dto.secrets.length === 0 ? (
        <p className="muted small">The project's {dto.environment && dto.vault ? "environment and vault hold" : dto.environment ? "environment holds" : "vault holds"} no secrets.</p>
      ) : (
        <ul className="secret-list">
          {brokered.map((s) => (
            <li key={s.key} className="secret-row">
              <span className="egress-dot brokered" title="brokered" />
              <code>{s.key}</code>
              <span className="muted small">{s.source === "both" ? "vault (over the environment's)" : s.source}</span>
              <span className="secret-hosts">→ {s.hosts.join(", ")}</span>
            </li>
          ))}
          {clear.map((s) => (
            <li key={s.key} className="secret-row">
              <span className="egress-dot bare" title="in the clear" />
              <code>{s.key}</code>
              <span className="muted small">{s.source === "both" ? "vault (over the environment's)" : s.source}</span>
              <span className="secret-hosts muted">in the sandbox in the clear</span>
            </li>
          ))}
        </ul>
      )}
      {clear.length > 0 && (
        <p className="muted small">
          A secret in the clear is one the agent can read and send anywhere. Bind the ones that are credentials for a host; some — an SSH key, a Nostr key — cannot be brokered, because they are not sent over HTTP.
        </p>
      )}
      {(!dto.environment && dto.vault) || (dto.environment && !dto.vault) ? (
        <p className="muted small">{dto.environment ? "The vault" : "The environment"} is unset, or gone from Fountain; only the other's secrets are listed.</p>
      ) : null}
      <details className="subcard">
        <summary>
          Every binding on your account <span className="count">{dto.bindings.length}</span>
        </summary>
        {dto.bindings.length === 0 ? (
          <p className="muted small">None yet. GitHub tokens are brokered to GitHub even so — Fountain's catalog default.</p>
        ) : (
          <ul className="secret-list">
            {dto.bindings.map((b) => (
              <li key={b.id} className={`secret-row ${b.enabled ? "" : "muted"}`}>
                <code>{b.key}</code>
                <span className="secret-hosts">→ {b.host}</span>
                <span className="small">{shapeOf(b)}</span>
                {!b.enabled && <span className="tag">off</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="small">
          <a href={bindingsUrl} target="_blank" rel="noreferrer">
            Edit bindings on Fountain ↗
          </a>
        </p>
      </details>
    </div>
  );
}
