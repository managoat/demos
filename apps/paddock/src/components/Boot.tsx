/**
 * First run: choose the runtime, then start the machine.
 *
 * The runtime is asked for once and up front because it is the one choice
 * that cannot be revisited on a running box — it is baked into the disk, and
 * changing it later is `sandbox_runtime_mismatch` and a new machine. Model,
 * repositories, packages, secrets, MCP servers and skills are all deliberately
 * *not* asked here: every one of them can be changed on the box afterwards,
 * and putting them in a setup wizard would suggest otherwise.
 */
import { useState } from "react";
import type { Catalog } from "../api/types";

export function Boot({
  catalog,
  starting,
  error,
  onStart,
}: {
  catalog: Catalog | null;
  starting: boolean;
  error: string | null;
  onStart: (choice: { runtime: string; model: string }) => void;
}) {
  const runtimes = catalog?.runtimes?.length ? catalog.runtimes : ["claude"];
  const [runtime, setRuntime] = useState(runtimes[0]!);
  const models = catalog?.models?.[runtime] ?? [];
  const [model, setModel] = useState<string>("");
  const chosenModel = model || models[0] || "";

  return (
    <div className="connect">
      <div className="connect-card">
        <h1>
          <span className="glyph">🐐</span> Your machine
        </h1>
        <p className="lede">
          One computer, yours, that stays up between visits. Terminal tabs are threads on it, and everything you change about it
          afterwards is changed <em>on</em> it rather than by replacing it.
        </p>

        <label>
          Runtime
          <select value={runtime} onChange={(e) => { setRuntime(e.target.value); setModel(""); }}>
            {runtimes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        {models.length > 0 && (
          <label>
            Model
            <select value={chosenModel} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}

        <p className="fine">
          The runtime is the one thing here that is baked into the disk. Everything else — repositories, packages, secrets, MCP
          servers, skills — you add later, from the Machine panel, without losing the box.
        </p>

        <button className="primary" onClick={() => onStart({ runtime, model: chosenModel })} disabled={starting || !chosenModel}>
          {starting ? "starting your machine…" : "Start my machine"}
        </button>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
