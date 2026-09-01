/**
 * The two menus on the composer: the model pill on the right, and the "+"
 * on the left that adds a preset, a computer, secrets, an image or people.
 * Nothing here asks for an agent and an environment; a preset is an agent to
 * *start from*, and the computer and the vault are optional.
 */
import { useCallback, useState } from "react";
import { modelBlurb, modelLabel, modelProblem, runtimeBlurb, runtimeLabel, RUNTIMES, type Runtime } from "../../shared/models";
import type { ChatSettings } from "../../shared/settings";
import type { PresetsDto } from "../lib/api";
import { MenuHeading, MenuItem, Popover } from "./Menu";

const SHORTLIST = 4;

export function ModelPill({ settings, presets, onChange }: { settings: ChatSettings; presets: PresetsDto | null; onChange: (s: ChatSettings) => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"models" | "more" | "runtime">("models");
  const [custom, setCustom] = useState("");
  const close = useCallback(() => {
    setOpen(false);
    setView("models");
  }, []);

  const catalog = presets?.catalog.models[settings.runtime] ?? [];
  const known = catalog.includes(settings.model) ? catalog : [settings.model, ...catalog];
  const shortlist = known.slice(0, SHORTLIST);
  const rest = known.slice(SHORTLIST);

  const pick = (model: string) => {
    onChange({ ...settings, model });
    close();
  };
  const pickRuntime = (runtime: Runtime) => {
    const models = presets?.catalog.models[runtime] ?? [];
    const model = modelProblem(runtime, settings.model) === null ? settings.model : (models[0] ?? settings.model);
    onChange({ ...settings, runtime, model });
    setView("models");
  };
  const customProblem = custom.trim() ? modelProblem(settings.runtime, custom.trim()) : null;

  return (
    <div className="pill-wrap">
      <button type="button" className={`pill${open ? " on" : ""}`} onClick={() => (open ? close() : setOpen(true))} aria-haspopup="menu" aria-expanded={open}>
        <span className="pill-main">{modelLabel(settings.model)}</span>
        <span className="pill-sub">{runtimeLabel(settings.runtime)}</span>
        <span className="pill-caret">⌄</span>
      </button>
      <Popover open={open} onClose={close} align="right" className="model-menu">
        {view === "models" && (
          <>
            {shortlist.map((m) => (
              <MenuItem key={m} label={modelLabel(m)} detail={modelBlurb(m) ?? m} checked={m === settings.model} onClick={() => pick(m)} />
            ))}
            <div className="menu-sep" />
            <MenuItem label="Runtime" detail={runtimeLabel(settings.runtime)} arrow onClick={() => setView("runtime")} />
            <MenuItem label="More models" arrow onClick={() => setView("more")} />
          </>
        )}
        {view === "runtime" && (
          <>
            <button type="button" className="menu-back" onClick={() => setView("models")}>
              ‹ Back
            </button>
            {RUNTIMES.map((rt) => (
              <MenuItem key={rt} label={runtimeLabel(rt)} detail={runtimeBlurb(rt)} checked={rt === settings.runtime} onClick={() => pickRuntime(rt)} />
            ))}
          </>
        )}
        {view === "more" && (
          <>
            <button type="button" className="menu-back" onClick={() => setView("models")}>
              ‹ Back
            </button>
            {rest.length === 0 && <div className="menu-heading">Every suggestion is already listed.</div>}
            {rest.map((m) => (
              <MenuItem key={m} label={modelLabel(m)} detail={m} checked={m === settings.model} onClick={() => pick(m)} />
            ))}
            <div className="menu-sep" />
            <form
              className="menu-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (custom.trim() && !customProblem) pick(custom.trim());
              }}
            >
              <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={`any ${settings.runtime === "opencode" ? "provider" : (settings.runtime === "claude" ? "anthropic" : settings.runtime === "codex" ? "openai" : "google")}/model id`} spellCheck={false} />
              <button type="submit" className="small" disabled={!custom.trim() || !!customProblem}>
                Use
              </button>
              {customProblem && <div className="menu-problem">{customProblem}</div>}
            </form>
          </>
        )}
      </Popover>
    </div>
  );
}

export interface Extras {
  invitees: string[];
}

export function AddMenu({
  settings,
  presets,
  presetsError,
  onChange,
  extras,
  onExtras,
  onAttach,
}: {
  settings: ChatSettings;
  presets: PresetsDto | null;
  presetsError: string | null;
  onChange: (s: ChatSettings) => void;
  extras: Extras;
  onExtras: (e: Extras) => void;
  onAttach: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "preset" | "environment" | "vault" | "people">("root");
  const [email, setEmail] = useState("");
  const close = useCallback(() => {
    setOpen(false);
    setView("root");
  }, []);

  const preset = presets?.agents.find((a) => a.id === settings.presetId) ?? null;
  const env = presets?.environments.find((e) => e.id === settings.environmentId) ?? null;
  const vault = presets?.vaults.find((v) => v.id === settings.vaultId) ?? null;

  const addEmail = () => {
    const e = email.trim().toLowerCase();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
    if (!extras.invitees.includes(e)) onExtras({ invitees: [...extras.invitees, e] });
    setEmail("");
  };

  return (
    <div className="pill-wrap">
      <button type="button" className={`icon plus${open ? " on" : ""}`} onClick={() => (open ? close() : setOpen(true))} aria-label="Add" aria-haspopup="menu" aria-expanded={open}>
        +
      </button>
      <Popover open={open} onClose={close} className="add-menu">
        {view === "root" && (
          <>
            <MenuHeading>Start from</MenuHeading>
            <MenuItem label="Preset" detail={preset ? preset.name : presets && presets.agents.length === 0 ? "No agents on your Fountain yet" : "One of your agents: its prompt, skills, servers"} arrow onClick={() => setView("preset")} disabled={!presets} />
            <MenuHeading>Give it</MenuHeading>
            <MenuItem label="A computer" detail={env ? env.name : "An environment: packages, repos, setup"} arrow onClick={() => setView("environment")} disabled={!presets} />
            <MenuItem label="Secrets" detail={vault ? vault.name : "A vault, attached when the computer starts"} arrow onClick={() => setView("vault")} disabled={!presets} />
            <MenuHeading>Add</MenuHeading>
            <MenuItem
              label="An image"
              detail="Paste or drop one, too"
              onClick={() => {
                close();
                onAttach();
              }}
            />
            <MenuItem label="People" detail={extras.invitees.length ? `${extras.invitees.length} invited` : "Invite by email; they see it when they sign in"} arrow onClick={() => setView("people")} />
            {presetsError && <div className="menu-problem">{presetsError}</div>}
          </>
        )}
        {view === "preset" && presets && (
          <>
            <button type="button" className="menu-back" onClick={() => setView("root")}>
              ‹ Back
            </button>
            <MenuItem
              label="None"
              detail="A plain agent on the model you picked"
              checked={!settings.presetId}
              onClick={() => {
                onChange({ ...settings, presetId: null });
                close();
              }}
            />
            {presets.agents.map((a) => (
              <MenuItem
                key={a.id}
                label={a.name}
                detail={`${runtimeLabel(a.runtime as Runtime)} · ${modelLabel(a.model)}${a.description ? ` — ${a.description}` : ""}`}
                checked={a.id === settings.presetId}
                onClick={() => {
                  // A preset brings its own runtime and model; the pill follows.
                  onChange({ ...settings, presetId: a.id, runtime: a.runtime as Runtime, model: a.model });
                  close();
                }}
              />
            ))}
          </>
        )}
        {view === "environment" && presets && (
          <>
            <button type="button" className="menu-back" onClick={() => setView("root")}>
              ‹ Back
            </button>
            <MenuItem
              label="Default"
              detail={preset?.environmentId ? "The preset's own computer" : "A plain computer"}
              checked={!settings.environmentId}
              onClick={() => {
                onChange({ ...settings, environmentId: null });
                close();
              }}
            />
            {presets.environments.map((e) => (
              <MenuItem
                key={e.id}
                label={e.name}
                checked={e.id === settings.environmentId}
                onClick={() => {
                  onChange({ ...settings, environmentId: e.id });
                  close();
                }}
              />
            ))}
            {presets.environments.length === 0 && <div className="menu-heading">No environments on your Fountain yet.</div>}
          </>
        )}
        {view === "vault" && presets && (
          <>
            <button type="button" className="menu-back" onClick={() => setView("root")}>
              ‹ Back
            </button>
            <MenuItem
              label="None"
              checked={!settings.vaultId}
              onClick={() => {
                onChange({ ...settings, vaultId: null });
                close();
              }}
            />
            {presets.vaults.map((v) => (
              <MenuItem
                key={v.id}
                label={v.name}
                checked={v.id === settings.vaultId}
                onClick={() => {
                  onChange({ ...settings, vaultId: v.id });
                  close();
                }}
              />
            ))}
            {presets.vaults.length === 0 && <div className="menu-heading">No vaults on your Fountain yet.</div>}
          </>
        )}
        {view === "people" && (
          <>
            <button type="button" className="menu-back" onClick={() => setView("root")}>
              ‹ Back
            </button>
            <form
              className="menu-form"
              onSubmit={(e) => {
                e.preventDefault();
                addEmail();
              }}
            >
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@example.com" autoFocus />
              <button type="submit" className="small" disabled={!email.trim()}>
                Invite
              </button>
            </form>
            {extras.invitees.map((e) => (
              <MenuItem key={e} label={e} detail="Remove" onClick={() => onExtras({ invitees: extras.invitees.filter((x) => x !== e) })} />
            ))}
            <div className="menu-heading">They sign in with Fountain and find the chat waiting. You can also share a link once it starts.</div>
          </>
        )}
      </Popover>
    </div>
  );
}

/** What the "+" has added, as chips on the composer. */
export function Chips({ settings, presets, extras, onChange, onExtras }: { settings: ChatSettings; presets: PresetsDto | null; extras: Extras; onChange: (s: ChatSettings) => void; onExtras: (e: Extras) => void }) {
  const chips: { key: string; label: string; clear: () => void }[] = [];
  const preset = presets?.agents.find((a) => a.id === settings.presetId);
  if (settings.presetId) chips.push({ key: "preset", label: `⚙ ${preset?.name ?? "preset"}`, clear: () => onChange({ ...settings, presetId: null }) });
  const env = presets?.environments.find((e) => e.id === settings.environmentId);
  if (settings.environmentId) chips.push({ key: "env", label: `🖥 ${env?.name ?? "computer"}`, clear: () => onChange({ ...settings, environmentId: null }) });
  const vault = presets?.vaults.find((v) => v.id === settings.vaultId);
  if (settings.vaultId) chips.push({ key: "vault", label: `🔑 ${vault?.name ?? "vault"}`, clear: () => onChange({ ...settings, vaultId: null }) });
  for (const e of extras.invitees) chips.push({ key: `p:${e}`, label: `@ ${e}`, clear: () => onExtras({ invitees: extras.invitees.filter((x) => x !== e) }) });
  if (chips.length === 0) return null;
  return (
    <div className="chips">
      {chips.map((c) => (
        <span key={c.key} className="chip">
          {c.label}
          <button type="button" className="chip-x" onClick={c.clear} aria-label={`Remove ${c.label}`}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
