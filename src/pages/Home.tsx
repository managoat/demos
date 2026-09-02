/**
 * The empty page: a headline and a box. Settings are a pill and a "+", not a
 * form, and a chat starts the moment you press Enter.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { shortName } from "../../shared/author";
import { modelProblem } from "../../shared/models";
import type { ChatSettings } from "../../shared/settings";
import { api } from "../lib/api";
import { describeError } from "../lib/errors";
import { greeting } from "../lib/format";
import { useAttachments } from "../lib/images";
import { loadSettings, saveSettings } from "../lib/settings";
import { navigate } from "../router";
import { useSession } from "../store";
import { Composer, type ComposerHandle } from "../components/Composer";
import { Mark } from "../components/Mark";
import { AddMenu, Chips, ModelPill, type Extras } from "../components/SettingsMenu";

export function Home() {
  const { me, menu, menuError, toast, refreshChats, projects, refreshProjects } = useSession();
  const [settings, setSettingsState] = useState<ChatSettings>(loadSettings);
  const [extras, setExtras] = useState<Extras>({ invitees: [] });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const attachments = useAttachments(useCallback((m: string) => toast(m, "error"), [toast]));
  const composer = useRef<ComposerHandle>(null);

  const setSettings = useCallback((s: ChatSettings) => {
    setSettingsState(s);
    saveSettings(s);
  }, []);

  // A remembered project the account no longer has is dropped quietly, like a connector.
  useEffect(() => {
    if (settings.projectId && projects.length && !projects.some((p) => p.id === settings.projectId)) setSettings({ ...settings, projectId: null });
  }, [projects]); // eslint-disable-line react-hooks/exhaustive-deps

  // A remembered connector that is gone from the account, or cannot be used, is dropped quietly.
  useEffect(() => {
    if (!menu) return;
    const usable = new Set(menu.connectors.items.filter((c) => c.usable).map((c) => c.id));
    const connectorIds = settings.connectorIds.filter((id) => usable.has(id));
    if (connectorIds.length !== settings.connectorIds.length) setSettings({ ...settings, connectorIds });
  }, [menu]); // eslint-disable-line react-hooks/exhaustive-deps

  const project = settings.projectId ? (projects.find((p) => p.id === settings.projectId) ?? null) : null;

  async function start() {
    const prompt = draft.trim();
    const images = attachments.payload;
    if ((!prompt && !images) || sending) return;
    const problem = modelProblem(settings.model);
    if (problem) {
      toast(problem, "error");
      return;
    }
    setSending(true);
    try {
      const chat = await api.createChat({ prompt, images, settings });
      for (const email of extras.invitees) {
        try {
          await api.addMember(chat.id, email);
        } catch (err) {
          toast(`Could not invite ${email}: ${describeError(err)}`, "error");
        }
      }
      setDraft("");
      attachments.clear();
      setExtras({ invitees: [] });
      void refreshChats();
      navigate({ page: "chat", id: chat.id });
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="home">
      <h1 className="display">
        <Mark /> {greeting()}
      </h1>
      <Composer
        ref={composer}
        big
        autoFocus
        value={draft}
        onChange={setDraft}
        onSend={() => void start()}
        sending={sending}
        placeholder="Ask anything, or paste an image"
        attachments={attachments}
        left={
          <>
            <AddMenu settings={settings} menu={menu} menuError={menuError} onChange={setSettings} extras={extras} onExtras={setExtras} onAttach={() => composer.current?.pickFiles()} projects={projects} onProjectsChanged={() => void refreshProjects()} />
            <Chips settings={settings} menu={menu} extras={extras} onChange={setSettings} onExtras={setExtras} projects={projects} />
          </>
        }
        right={<ModelPill settings={settings} menu={menu} onChange={setSettings} />}
      />
      <p className="muted small hint">
        {project && project.ownerEmail !== me.email
          ? `Starts in ${project.name}, on ${shortName(project.ownerEmail)}'s Fountain — they pay for this chat, and everyone in the project is in it.`
          : project
            ? `Starts in ${project.name}, on your Fountain as ${me.email} — you pay for this chat, and everyone in the project is in it.`
            : `Starts on your Fountain as ${me.email} — you pay for this chat, and the people you invite chat for free.`}
      </p>
    </div>
  );
}
