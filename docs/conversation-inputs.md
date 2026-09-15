# Conversation input ownership

Migration: [#76](https://github.com/managoat/demos/issues/76).
SDK: `@managoat/fountain-sdk` 5.2.1, pinned in the Bun lockfile.
`@managoat/fountain-app/types` re-exports its generated `ConversationInput`
with a type-only import; plain-fetch servers acquire no SDK runtime behavior.

| Caller | Boundary after migration |
|---|---|
| Mission Control | `createConversation` forwards the complete generated input |
| Fountain Conversations | `StartInput` aliases the generated input; image media types come from it |
| Paddock browser | `startBox` strips its local agent-default hint and retains the persistent-machine policy; `openTab` forwards generated inputs and requires a sandbox ID |
| Workbench browser | `startBody` returns the generated input; work-item prompt/channel, image and join decisions remain app-owned |
| Salon server | Create and restore build generated inputs; plain fetch keeps host-key/proxy behavior |
| Drydock / Switchyard | `createConversation` forwards the entire generated input; separately named thread/track helpers retain ephemeral/persistent/fresh provisioning and old omission policies |
| Fountain Team | Side-thread helper derives its deliberately narrow identity/title input from the generated type; its identity and omission policy stays explicit |
| Workbench / Paddock proxies | Retain validated projections and tenant/project/machine checks. These are authorization boundaries, not generic field allowlists to widen |

Every app retains its own stream, prompt dispatch, tab persistence and permission
UI. No UI creation was replaced by `runRequest`: a promptless tab has no turn
for that helper to follow. New/fresh/resumed behavior remains in the existing
app tests; generic forwarding tests verify null/false/empty/nested/future fields
and assert that creation makes no follow-up prompt or stream request.

Workbench and Salon upgrade from SDK 1.25.0. Their rendering boundary converts
structured plan block bodies to text rather than handing an object array to
React. Permission pairing and stream ownership remain app-local and covered by
the existing suites. Fountain Conversations validates the four accepted image
media types while retaining the previous empty-MIME PNG fallback.

Other apps build task-specific prompts and API bodies directly. They have no
SDK launch helper or generic conversation-input field registry to migrate here.
This change does not replace independent response/domain views with the full
server schema.
