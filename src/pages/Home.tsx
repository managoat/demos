/**
 * The empty page: a headline and a box. Settings are a pill and a "+", not a
 * form, and a chat starts the moment you press Enter.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  const { me, presets, presetsError, toast, refreshChats } = useSession();
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

  // A remembered pick that is gone from the account is dropped, quietly.
  useEffect(() => {
    if (!presets) return;
    const next = { ...settings };
    if (next.presetId && !presets.agents.some((a) => a.id === next.presetId)) next.presetId = null;
    if (next.environmentId && !presets.environments.some((e) => e.id === next.environmentId)) next.environmentId = null;
    if (next.vaultId && !presets.vaults.some((v) => v.id === next.vaultId)) next.vaultId = null;
    if (next.presetId !== settings.presetId || next.environmentId !== settings.environmentId || next.vaultId !== settings.vaultId) setSettings(next);
  }, [presets]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    const prompt = draft.trim();
    const images = attachments.payload;
    if ((!prompt && !images) || sending) return;
    const problem = modelProblem(settings.runtime, settings.model);
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
            <AddMenu settings={settings} presets={presets} presetsError={presetsError} onChange={setSettings} extras={extras} onExtras={setExtras} onAttach={() => composer.current?.pickFiles()} />
            <Chips settings={settings} presets={presets} extras={extras} onChange={setSettings} onExtras={setExtras} />
          </>
        }
        right={<ModelPill settings={settings} presets={presets} onChange={setSettings} />}
      />
      <p className="muted small hint">
        Starts on your Fountain as {me.email} — you pay for this chat. Invite people and they chat for free.
      </p>
    </div>
  );
}
