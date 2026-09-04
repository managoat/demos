/**
 * The suite's ACP log parser — see `@managoat/fountain-app/acp`.
 *
 * Paddock renders these blocks as terminal scrollback rather than chat
 * bubbles (`components/Terminal.tsx`), but the parse is the same one every
 * app in the suite uses: text chunks concatenate, tool calls pair to their
 * result on `toolCallId`, everything else is dropped.
 */
export * from "@managoat/fountain-app/acp";
