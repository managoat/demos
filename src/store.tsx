/**
 * The signed-in person's store: who they are, their chats (hosted and
 * invited to), the presets menu's contents, and toasts. It talks to the
 * Salon server (src/lib/api.ts). Fountain itself is reached per chat through
 * the SDK at `/f/<chat>` (`makeChatClient`).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Fountain } from "@agentshit/fountain-sdk";
import { api, ApiError, chatFountainBase, type ChatDto, type Me, type PresetsDto } from "./lib/api";
import { describeError } from "./lib/errors";

/** How often the chat list is re-read while the tab is on screen. */
const SURVEY_MS = 30_000;

export interface Session {
  me: Me;
  chats: ChatDto[];
  chatsLoaded: boolean;
  refreshChats: () => Promise<ChatDto[] | null>;
  presets: PresetsDto | null;
  presetsError: string | null;
  loadPresets: () => Promise<PresetsDto | null>;
  toast: (text: string, kind?: "info" | "error") => void;
  signOut: () => void;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export function SessionProvider({ me, onSignOut, children }: { me: Me; onSignOut: () => void; children: ReactNode }) {
  const [chats, setChats] = useState<ChatDto[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [presets, setPresets] = useState<PresetsDto | null>(null);
  const [presetsError, setPresetsError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6000);
  }, []);

  const refreshChats = useCallback(async () => {
    try {
      const list = await api.chats();
      setChats(list);
      setChatsLoaded(true);
      return list;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      else toast(describeError(err), "error");
      return null;
    }
  }, [onSignOut, toast]);

  const loadPresets = useCallback(async () => {
    try {
      const p = await api.presets();
      setPresets(p);
      setPresetsError(null);
      return p;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      setPresetsError(describeError(err));
      return null;
    }
  }, [onSignOut]);

  useEffect(() => {
    void refreshChats();
    void loadPresets();
  }, [refreshChats, loadPresets]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refreshChats();
    };
    const timer = window.setInterval(tick, SURVEY_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshChats]);

  const signOut = useCallback(() => {
    void api.signOut().catch(() => undefined);
    onSignOut();
  }, [onSignOut]);

  const value = useMemo<Session>(
    () => ({ me, chats, chatsLoaded, refreshChats, presets, presetsError, loadPresets, toast, signOut }),
    [me, chats, chatsLoaded, refreshChats, presets, presetsError, loadPresets, toast, signOut],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** An SDK client for one chat. The bearer is a placeholder: the server authenticates the cookie and swaps in the host's key. */
export function makeChatClient(chatId: string): Fountain {
  return new Fountain({ baseUrl: chatFountainBase(chatId), apiKey: "session", appUrl: "", timeoutMs: 120_000 });
}
