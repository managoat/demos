import type { ConversationStatus } from "../types";

export function StatusPill({ status, sandbox }: { status: ConversationStatus; sandbox?: string | null }) {
  const label =
    status === "idle" && sandbox === "suspended" ? "asleep" : status === "idle" && sandbox === "terminated" ? "idle · no sandbox" : status;
  return <span className={`pill ${status}`}>{label}</span>;
}
