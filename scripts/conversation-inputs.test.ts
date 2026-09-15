import { expect, test } from "bun:test";
import type { ConversationInput } from "@managoat/fountain-app/types";
import { Fountain as Drydock } from "../apps/drydock/server/fountain";
import { Fountain as Switchyard } from "../apps/switchyard/server/fountain";

import { FountainClient as MissionControl } from "../apps/mission-control/src/api/client";
import { FountainClient as Conversations } from "../apps/fountain-conversations/src/api/client";
import { FountainClient as Paddock } from "../apps/paddock/src/api/client";
import { FountainClient as Salon } from "../apps/salon/server/fountain";

type Input = ConversationInput & { sandbox_id: string };
const clients: [string, (url: string) => (input: Input) => Promise<unknown>][] = [
  ["drydock", url => input => new Drydock(url, "fixture-key").createConversation(input)],
  ["switchyard", url => input => new Switchyard(url, "fixture-key").createConversation(input)],
  ["mission-control", url => input => new MissionControl({ baseUrl: url, apiKey: "fixture-key" }).createConversation(input)],
  ["fountain-conversations", url => input => new Conversations({ baseUrl: url, apiKey: "fixture-key" }).startConversation(input)],
  ["paddock", url => input => new Paddock(url).openTab(input)],
  ["salon", url => input => new Salon(url, "fixture-key").createConversation(input)],
];

for (const [name, create] of clients) {
  test(`${name} preserves API fields and promptless creation without starting a follower`, async () => {
    const seen: unknown[] = [];
    const server = Bun.serve({ port: 0, fetch: async req => {
      expect(new URL(req.url).pathname).toBe("/api/conversations");
      seen.push(await req.json());
      return Response.json({ data: { id: "c1" }, meta: { resumed: true } });
    }});
    try {
      const launch = create(server.url.href.replace(/\/$/, ""));
      const input = {
        agent_id: "a1", sandbox_id: "s1", title: "", vault_id: null, fresh: false, images: [],
        labels: {}, permission_policy: { ask_timeout: 0 }, future_field: { value: false },
      } satisfies Input & { future_field: { value: boolean } };
      expect(await launch(input)).toEqual({ id: "c1" });
      expect(seen).toEqual([input]);
    } finally { server.stop(true); }
  });
}
