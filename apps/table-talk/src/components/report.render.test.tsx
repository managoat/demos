import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { parseReports } from "../lib/protocol";
import { ReportView } from "./Report";

// Render smoke: a parsed report becomes insight cards, a column strip, and
// SVG charts with human-formatted numbers; the tool trail collapses under
// "How I got this".

const REPLY = `Done.
\`\`\`table-report
{"id":"rpt-1","title":"Sales at a glance","insights":["West brings in most of the money."],
 "stats":{"rows":1234,"columns":[{"name":"region","type":"category","distinct":4,"top":"west"},{"name":"revenue","type":"number","min":0,"max":1234.5,"mean":211.4,"nulls":2}]},
 "charts":[{"type":"bar","title":"Revenue by region","x":["west","east"],"series":[{"name":"revenue","y":[1200,800]}]},
           {"type":"line","title":"Over time","x":["2026-01","2026-02"],"series":[{"name":"west","y":[10,20]},{"name":"east","y":[5,25]}]},
           {"type":"pie","title":"Share","x":["west","east"],"series":[{"name":"revenue","y":[120,80]}]}]}
\`\`\``;

/** renderToString peppers text with `<!-- -->` separators — drop them before matching. */
function render(el: Parameters<typeof renderToString>[0]): string {
  return renderToString(el).replace(/<!-- -->/g, "");
}

describe("ReportView", () => {
  const report = parseReports(REPLY)[0]!;

  test("insights, column strip, and row count render human-formatted", () => {
    const html = render(<ReportView report={report} tools={[]} />);
    expect(html).toContain("Sales at a glance");
    expect(html).toContain("West brings in most of the money.");
    expect(html).toContain("1,234 rows");
    expect(html).toContain("region");
    expect(html).toContain("4 kinds");
    expect(html).toContain("1,234.5"); // max, formatted
    expect(html).toContain("2 blank");
    expect(html).not.toContain("How I got this"); // no tools passed
  });

  test("all three chart kinds draw: bars, polyline, pie slices with percentages", () => {
    const html = render(<ReportView report={report} tools={[]} />);
    expect(html).toContain("Revenue by region");
    expect((html.match(/<rect/g) ?? []).length).toBe(2); // two bars
    expect(html).toContain("<polyline");
    expect(html).toContain("west"); // legend + axis labels
    expect(html).toContain("60%"); // pie share of 120/200
    expect(html).toContain("40%");
  });

  test("the tool trail renders collapsed with name, summary, output", () => {
    const html = render(
      <ReportView
        report={report}
        tools={[{ kind: "tool", id: "t1", name: "Run python", summary: "analyze.py", status: "done", output: "rows: 1234", startedAt: null, endedAt: null }]}
      />,
    );
    expect(html).toContain("How I got this");
    expect(html).toContain("Run python");
    expect(html).toContain("analyze.py");
    expect(html).toContain("rows: 1234");
  });
});
