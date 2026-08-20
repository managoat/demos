import { describe, expect, test } from "bun:test";
import { buildDataPrompt, hasReportFence, parseDataPrompt, parseReports, stripBlocks } from "./protocol";

const REPORT = `\`\`\`table-report
{"id":"rpt-1","title":"Sales at a glance","insights":["West sells the most.","Two rows had no revenue."],
 "stats":{"rows":123,"columns":[{"name":"region","type":"category","distinct":4,"top":"west"},{"name":"revenue","type":"number","min":0,"max":912,"mean":211.4,"nulls":2}]},
 "charts":[{"type":"bar","title":"Revenue by region","x":["west","east"],"series":[{"name":"revenue","y":[120,80]}]},
           {"type":"line","title":"Over time","x":["2026-01","2026-02"],"series":[{"name":"west","y":[10,20]},{"name":"east","y":[5,25]}]},
           {"type":"pie","title":"Share","x":["west","east"],"series":[{"name":"revenue","y":[120,80]}]}]}
\`\`\``;

describe("parseReports", () => {
  test("parses a full report: insights, stats, all three chart types", () => {
    const reports = parseReports(`Here you go.\n${REPORT}\nAsk me anything.`);
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r.id).toBe("rpt-1");
    expect(r.title).toBe("Sales at a glance");
    expect(r.insights).toHaveLength(2);
    expect(r.rows).toBe(123);
    expect(r.columns.map((c) => c.type)).toEqual(["category", "number"]);
    expect(r.columns[1]!.mean).toBe(211.4);
    expect(r.charts.map((c) => c.type)).toEqual(["bar", "line", "pie"]);
  });

  test("skips malformed JSON without dropping later blocks", () => {
    const reports = parseReports("```table-report\n{nope}\n```\n" + REPORT);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.id).toBe("rpt-1");
  });

  test("ignores ordinary code fences and other languages", () => {
    expect(parseReports("```python\nprint(1)\n```\n```csv\na,b\n```")).toHaveLength(0);
  });

  test("drops a chart with a bad type or no numbers, keeps the rest", () => {
    const reports = parseReports(
      '```table-report\n{"id":"rpt-2","insights":["ok"],"charts":[{"type":"scatter","x":["a"],"series":[{"y":[1]}]},{"type":"bar","x":["a"],"series":[{"name":"v","y":["NaN"]}]},{"type":"bar","x":["a","b"],"series":[{"name":"v","y":[1,2]}]}]}\n```',
    );
    expect(reports[0]!.charts).toHaveLength(1);
    expect(reports[0]!.charts[0]!.x).toEqual(["a", "b"]);
  });

  test("a pie keeps only its first series; numeric x labels become strings", () => {
    const reports = parseReports(
      '```table-report\n{"id":"rpt-3","insights":[],"charts":[{"type":"pie","x":[2024,2025],"series":[{"name":"a","y":[1,2]},{"name":"b","y":[3,4]}]}]}\n```',
    );
    const chart = reports[0]!.charts[0]!;
    expect(chart.x).toEqual(["2024", "2025"]);
    expect(chart.series).toHaveLength(1);
  });

  test("an empty report (nothing to show) is not a report", () => {
    expect(parseReports('```table-report\n{"id":"rpt-4","insights":[],"charts":[]}\n```')).toHaveLength(0);
  });

  test("a report missing its id still renders, under a fallback id", () => {
    const reports = parseReports('```table-report\n{"insights":["hello"]}\n```');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.id).toBe("rpt-unnamed-1");
  });
});

describe("stripBlocks / hasReportFence", () => {
  test("removes blocks, keeps prose", () => {
    const s = stripBlocks(`Before.\n${REPORT}\nAfter.`);
    expect(s).toContain("Before.");
    expect(s).toContain("After.");
    expect(s).not.toContain("table-report");
  });

  test("hasReportFence is true even when the JSON is broken", () => {
    expect(hasReportFence("```table-report\n{nope}\n```")).toBe(true);
    expect(hasReportFence("no blocks here")).toBe(false);
  });
});

describe("the dataset hand-off", () => {
  test("buildDataPrompt and parseDataPrompt agree", () => {
    const prompt = buildDataPrompt("sales q3.csv", "a,b\n1,2", null);
    expect(parseDataPrompt(prompt)).toEqual({ filename: "sales q3.csv" });
    expect(prompt).toContain("```csv\na,b\n1,2\n```");
  });

  test("a truncation notice rides along", () => {
    const prompt = buildDataPrompt("big.csv", "a\n1", "only the first 5,000 rows");
    expect(prompt).toContain("only the first 5,000 rows");
  });

  test("an ordinary question is not a hand-off", () => {
    expect(parseDataPrompt("which region sells the most?")).toBeNull();
    expect(parseDataPrompt("New dataset: fake.csv but no fence")).toBeNull();
  });
});
