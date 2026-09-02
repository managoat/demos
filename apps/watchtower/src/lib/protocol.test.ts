import { describe, expect, test } from "bun:test";
import {
  effectiveWatchlist,
  foldConversation,
  parseBlocks,
  parseInvestigatePrompt,
  parseWatchlistPrompt,
  statusOf,
  stripBlocks,
  watchlistMessage,
  type SiteSample,
} from "./protocol";

const CONFIG = '```watch-config\n{"sites":["https://a.com","b.net"]}\n```';

const STATE_1 = `All quiet.

\`\`\`watch-state
{"checked_at":"2026-08-19T12:00:00Z","sites":[
  {"url":"https://a.com","up":true,"status":200,"latency_ms":184,"cert_days_left":42,"cert_expires_at":"2026-09-30T00:00:00Z","dns":["203.0.113.7"],"note":null},
  {"url":"b.net","up":false,"status":null,"latency_ms":null,"cert_days_left":null,"cert_expires_at":null,"dns":[],"note":"NXDOMAIN — the name never resolves"}]}
\`\`\``;

const STATE_2 = '```watch-state\n{"checked_at":"2026-08-19T12:30:00Z","sites":[{"url":"https://a.com","up":true,"status":200,"latency_ms":210,"cert_days_left":12,"cert_expires_at":"2026-08-31T00:00:00Z","dns":["203.0.113.7"],"note":null}]}\n```';

const INCIDENT =
  '```watch-incident\n{"url":"b.net","summary":"The name does not resolve at all.","suspected_cause":"expired registration","evidence":["dig +short b.net returns nothing","whois shows status: pendingDelete"],"checked_at":"2026-08-19T12:31:00Z"}\n```';

describe("parseBlocks", () => {
  test("parses config, state and incident blocks in order", () => {
    const blocks = parseBlocks(`${CONFIG}\n${STATE_1}\n${INCIDENT}`);
    expect(blocks.map((b) => b.kind)).toEqual(["config", "state", "incident"]);
  });

  test("skips malformed JSON and wrong shapes without crashing", () => {
    const text = '```watch-state\nnot json\n```\n```watch-config\n{"sites":"nope"}\n```\n' + STATE_2;
    const blocks = parseBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("state");
  });

  test("a site missing url or up is dropped; sloppy optionals become null", () => {
    const text =
      '```watch-state\n{"checked_at":"2026-08-19T12:00:00Z","sites":[{"up":true},{"url":"https://a.com","up":true,"latency_ms":"fast"}]}\n```';
    const blocks = parseBlocks(text);
    expect(blocks).toHaveLength(1);
    const state = blocks[0]!.kind === "state" ? blocks[0]!.state : null;
    expect(state!.sites).toEqual([
      { url: "https://a.com", up: true, status: null, latency_ms: null, cert_days_left: null, cert_expires_at: null, dns: [], note: null },
    ]);
  });
});

describe("stripBlocks", () => {
  test("removes the fences and leaves the prose", () => {
    expect(stripBlocks(STATE_1)).toBe("All quiet.");
  });
});

describe("watchlist prompts", () => {
  test("round-trips through watchlistMessage", () => {
    expect(parseWatchlistPrompt(watchlistMessage(["https://a.com", "b.net"]))).toEqual(["https://a.com", "b.net"]);
  });

  test("an empty list is a valid watchlist; other prompts are not", () => {
    expect(parseWatchlistPrompt("SET WATCHLIST\n[]")).toEqual([]);
    expect(parseWatchlistPrompt("Run checks and report watch-state.")).toBeNull();
    expect(parseWatchlistPrompt("SET WATCHLIST\nnot json")).toBeNull();
  });

  test("Investigate <url> parses; anything longer does not", () => {
    expect(parseInvestigatePrompt("Investigate https://a.com")).toBe("https://a.com");
    expect(parseInvestigatePrompt("Investigate https://a.com please")).toBeNull();
  });
});

describe("statusOf", () => {
  const base: SiteSample = {
    url: "https://a.com",
    checked_at: "2026-08-19T12:00:00Z",
    up: true,
    status: 200,
    latency_ms: 100,
    cert_days_left: 42,
    cert_expires_at: null,
    dns: [],
    note: null,
  };
  test("green up, amber cert < 14 days, red down, gray no data", () => {
    expect(statusOf(base)).toBe("ok");
    expect(statusOf({ ...base, cert_days_left: 13 })).toBe("warn");
    expect(statusOf({ ...base, up: false })).toBe("down");
    expect(statusOf(null)).toBe("pending");
  });
});

describe("foldConversation", () => {
  test("watchlist from newest config; samples accumulate per site; incidents newest first", () => {
    const view = foldConversation([
      { prompt: watchlistMessage(["https://a.com", "b.net"]), reply: CONFIG },
      { prompt: "Run checks and report watch-state.", reply: STATE_1 },
      { prompt: "Run checks and report watch-state.", reply: STATE_2 },
      { prompt: "Investigate b.net", reply: INCIDENT },
    ]);
    expect(view.watchlist).toEqual(["https://a.com", "b.net"]);
    expect(view.pending).toBeNull();
    expect(view.samples.get("https://a.com")!.map((s) => s.latency_ms)).toEqual([184, 210]);
    expect(view.samples.get("b.net")).toHaveLength(1);
    expect(view.lastCheckedAt).toBe("2026-08-19T12:30:00Z");
    expect(view.incidents).toHaveLength(1);
    expect(view.incidents[0]!.incident.suspected_cause).toBe("expired registration");
  });

  test("a SET WATCHLIST after the last confirmation shows as pending", () => {
    const view = foldConversation([
      { prompt: watchlistMessage(["https://a.com"]), reply: CONFIG },
      { prompt: watchlistMessage(["https://a.com", "https://new.io"]), reply: "" },
    ]);
    expect(view.watchlist).toEqual(["https://a.com", "b.net"]);
    expect(view.pending).toEqual(["https://a.com", "https://new.io"]);
    expect(effectiveWatchlist(view)).toEqual(["https://a.com", "https://new.io"]);
  });

  test("never configured: watchlist null, nothing derived", () => {
    const view = foldConversation([]);
    expect(view.watchlist).toBeNull();
    expect(effectiveWatchlist(view)).toBeNull();
    expect(view.lastCheckedAt).toBeNull();
  });
});
