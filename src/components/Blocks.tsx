import { renderMarkdown } from "../lib/markdown";
import type { ShownBlock } from "../lib/blocks";

/** One block, in either view. Chat mode passes `bubble` for text. */
export function BlockView({ block, bubble = false }: { block: ShownBlock; bubble?: boolean }) {
  switch (block.kind) {
    case "text":
      return bubble ? (
        <div className="bubble them">
          <div className="body md">{renderMarkdown(block.body ?? "")}</div>
        </div>
      ) : (
        <div className="block text md">{renderMarkdown(block.body ?? "")}</div>
      );
    case "thinking":
      return (
        <details className="block thinking">
          <summary>thinking</summary>
          <div className="body">{block.body}</div>
        </details>
      );
    case "tool_use": {
      const b = block as Extract<ShownBlock, { kind: "tool_use" }>;
      const status = b.result ? (b.result.error ? "error" : "done") : "running";
      return (
        <details className={`block tool ${status}`}>
          <summary>
            <span className="tool-name">{b.name ?? "tool"}</span>
            {b.summary && <span className="tool-summary">{b.summary}</span>}
            <span className="tool-status">{status === "running" ? "…" : status === "done" ? "✓" : "✕"}</span>
          </summary>
          {b.body && (
            <div className="tool-section">
              <div className="label">input</div>
              <pre>{b.body}</pre>
            </div>
          )}
          {b.result && (
            <div className="tool-section">
              <div className="label">{b.result.error ? "error" : "result"}</div>
              <pre className={b.result.error ? "err" : ""}>{b.result.body}</pre>
            </div>
          )}
        </details>
      );
    }
    case "tool_result":
      return (
        <details className={`block tool ${block.error ? "error" : "done"}`}>
          <summary>
            <span className="tool-name">result</span>
            <span className="tool-summary mono">{block.tool_id}</span>
          </summary>
          <pre>{block.body}</pre>
        </details>
      );
    case "init":
      return (
        <details className="block init">
          <summary>{block.summary ?? "session started"}</summary>
          {block.body && <pre>{block.body}</pre>}
        </details>
      );
    case "result":
      return (
        <details className="block result">
          <summary>✓ {block.body}</summary>
          {block.raw && <pre>{block.raw}</pre>}
        </details>
      );
    case "error":
      return <div className="block error">✕ {block.body}</div>;
    case "raw":
    default:
      return (
        <details className="block raw">
          <summary>{block.summary ?? "raw"}</summary>
          <pre>{block.body}</pre>
        </details>
      );
  }
}
