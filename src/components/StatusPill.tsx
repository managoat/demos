import type { ConversationStatus } from "../api/types";

export function StatusPill({ status, sandbox, tiny }: { status: ConversationStatus; sandbox?: string | null; tiny?: boolean }) {
  const label =
    status === "idle" && sandbox === "suspended" ? "asleep" : status === "idle" && sandbox === "terminated" ? "idle · no sandbox" : status;
  return <span className={`pill ${status} ${tiny ? "tiny" : ""}`}>{label}</span>;
}
