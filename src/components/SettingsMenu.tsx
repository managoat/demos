/**
 * The two menus on the composer: the model pill on the right, and the "+"
 * on the left — photos, skills, connectors, people. The shape is the one the
 * desktop chat apps taught. Nothing here asks for an agent or a computer;
 * the server derives those from these picks (server/agents.ts).
 */
import { useCallback, useState } from "react";
import { groupByProvider, modelBlurb, modelLabel, providerLabel } from "../../shared/models";
import type { ChatSettings } from "../../shared/settings";
import { SKILLS, skillNames } from "../../shared/skills";
import type { MenuDto } from "../lib/api";
import { MenuBack, MenuHeading, MenuItem, Popover } from "./Menu";

export function ModelPill({ settings, menu, onChange }: { settings: ChatSettings; menu: MenuDto | null; onChange: (s: ChatSettings) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const models = menu?.models ?? [];
  const groups = groupByProvider(models.includes(settings.model) ? models : [settings.model, ...models]);

  return (
    <div className="pill-wrap">
      <button type="button" className={`pill${open ? " on" : ""}`} onClick={() => (open ? close() : setOpen(true))} aria-haspopup="menu" aria-expanded={open}>
        <span className="pill-main">{modelLabel(settings.model)}</span>
        <span className="pill-caret">⌄</span>
      </button>
      <Popover open={open} onClose={close} align="right" className="model-menu">
        {!menu && <MenuHeading>Loading…</MenuHeading>}
        {groups.map((g) => (
          <div key={g.provider}>
            <MenuHeading>{providerLabel(g.provider)}</MenuHeading>
            {g.models.map((m) => (
              <MenuItem
                key={m}
                label={modelLabel(m)}
                detail={modelBlurb(m) ?? undefined}
                checked={m === settings.model}
                onClick={() => {
                  onChange({ ...settings, model: m });
                  close();
                }}
              />
            ))}
          </div>
        ))}
      </Popover>
    </div>
  );
}

export interface Extras {
  invitees: string[];
}

export function AddMenu({
  settings,
  menu,
  menuError,
  onChange,
  extras,
  onExtras,
  onAttach,
}: {
  settings: ChatSettings;
  menu: MenuDto | null;
  menuError: string | null;
  onChange: (s: ChatSettings) => void;
  extras: Extras;
  onExtras: (e: Extras) => void;
  onAttach: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "skills" | "connectors" | "people">("root");
  const [email, setEmail] = useState("");
  const close = useCallback(() => {
    setOpen(false);
    setView("root");
  }, []);

  const toggleSkill = (id: string) => {
    const skills = settings.skills.includes(id) ? settings.skills.filter((s) => s !== id) : [...settings.skills, id].sort();
    onChange({ ...settings, skills });
  };
  const toggleConnector = (id: string) => {
    const connectorIds = settings.connectorIds.includes(id) ? settings.connectorIds.filter((c) => c !== id) : [...settings.connectorIds, id].sort();
    onChange({ ...settings, connectorIds });
  };
  const chosenSkills = skillNames(settings.skills);
  const chosenConnectors = connectorLabels(settings.connectorIds, menu);

  const addEmail = () => {
    const e = email.trim().toLowerCase();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
    if (!extras.invitees.includes(e)) onExtras({ invitees: [...extras.invitees, e] });
    setEmail("");
  };

  const connectors = menu?.connectors ?? null;

  return (
    <div className="pill-wrap">
      <button type="button" className={`icon plus${open ? " on" : ""}`} onClick={() => (open ? close() : setOpen(true))} aria-label="Add" aria-haspopup="menu" aria-expanded={open}>
        +
      </button>
      <Popover open={open} onClose={close} className="add-menu">
        {view === "root" && (
          <>
            <MenuItem
              icon="📎"
              label="Add photos"
              detail="Or paste or drop them in"
              onClick={() => {
                close();
                onAttach();
              }}
            />
            <div className="menu-sep" />
            <MenuItem label="Skills" detail={chosenSkills.length ? chosenSkills.join(", ") : "PDFs, spreadsheets, slides and more"} arrow onClick={() => setView("skills")} />
            <MenuItem
              label="Connectors"
              detail={chosenConnectors.length ? chosenConnectors.join(", ") : connectors && !connectors.enabled ? "Not available on your account yet" : "Gmail and other accounts you have linked"}
              arrow
              onClick={() => setView("connectors")}
            />
            <div className="menu-sep" />
            <MenuItem label="People" detail={extras.invitees.length ? `${extras.invitees.length} invited` : "Invite by email; they see it when they sign in"} arrow onClick={() => setView("people")} />
            {menuError && <div className="menu-problem">{menuError}</div>}
          </>
        )}
        {view === "skills" && (
          <>
            <MenuBack onClick={() => setView("root")} />
            {SKILLS.map((s) => (
              <MenuItem key={s.id} toggle label={s.name} detail={s.blurb} checked={settings.skills.includes(s.id)} onClick={() => toggleSkill(s.id)} />
            ))}
            <MenuHeading>Each one teaches the chat how to work with that kind of file.</MenuHeading>
          </>
        )}
        {view === "connectors" && (
          <>
            <MenuBack onClick={() => setView("root")} />
            {!connectors && <MenuHeading>{menuError ?? "Loading…"}</MenuHeading>}
            {connectors && !connectors.enabled && (
              <MenuHeading>
                Connectors let a chat read and send from accounts you have linked on Fountain, such as Gmail. They are not switched on for your Fountain account yet — it is a limited-access feature, so ask Fountain to enable it for you.
              </MenuHeading>
            )}
            {connectors?.enabled && (
              <>
                {connectors.items.length === 0 && <MenuHeading>Nothing linked yet.</MenuHeading>}
                {connectors.items.map((c) => (
                  <MenuItem
                    key={c.id}
                    toggle
                    label={c.account ? `${c.label} · ${c.account}` : c.label}
                    detail={c.why ?? undefined}
                    checked={settings.connectorIds.includes(c.id)}
                    disabled={!c.usable}
                    onClick={() => toggleConnector(c.id)}
                  />
                ))}
                <div className="menu-sep" />
                <MenuItem label="Connect another…" detail="Opens the Connections page on your Fountain" onClick={() => window.open(connectors.connectUrl, "_blank", "noopener")} />
                {connectors.items.some((c) => c.usable) && <MenuHeading>Anyone in the chat can ask it to use what you turn on here.</MenuHeading>}
              </>
            )}
          </>
        )}
        {view === "people" && (
          <>
            <MenuBack onClick={() => setView("root")} />
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
            <MenuHeading>They sign in with Fountain and find the chat waiting. You can also share a link once it starts.</MenuHeading>
          </>
        )}
      </Popover>
    </div>
  );
}

/** "Gmail", "Linear" for the chosen connector ids; an id the menu no longer lists is left out. */
function connectorLabels(ids: readonly string[], menu: MenuDto | null): string[] {
  const items = menu?.connectors.items ?? [];
  return ids.flatMap((id) => {
    const c = items.find((x) => x.id === id);
    return c ? [c.label] : [];
  });
}

/** What the "+" has added, as chips on the composer. */
export function Chips({ settings, menu, extras, onChange, onExtras }: { settings: ChatSettings; menu: MenuDto | null; extras: Extras; onChange: (s: ChatSettings) => void; onExtras: (e: Extras) => void }) {
  const chips: { key: string; label: string; clear: () => void }[] = [];
  for (const s of SKILLS) if (settings.skills.includes(s.id)) chips.push({ key: `s:${s.id}`, label: s.name, clear: () => onChange({ ...settings, skills: settings.skills.filter((x) => x !== s.id) }) });
  for (const id of settings.connectorIds) {
    const c = menu?.connectors.items.find((x) => x.id === id);
    chips.push({ key: `c:${id}`, label: c ? c.label : "Connector", clear: () => onChange({ ...settings, connectorIds: settings.connectorIds.filter((x) => x !== id) }) });
  }
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
