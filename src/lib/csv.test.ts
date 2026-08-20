import { describe, expect, test } from "bun:test";
import { MAX_BYTES, MAX_ROWS, parseCsv, prepareDataset, serializeCsv } from "./csv";

describe("parseCsv", () => {
  test("plain rows", () => {
    const { headers, rows } = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(headers).toEqual(["a", "b", "c"]);
    expect(rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  test("quoted fields with commas, escaped quotes, and newlines inside quotes", () => {
    const { headers, rows } = parseCsv('name,notes\n"Smith, Jane","said ""hi""\nthen left"\n');
    expect(headers).toEqual(["name", "notes"]);
    expect(rows).toEqual([["Smith, Jane", 'said "hi"\nthen left']]);
  });

  test("CRLF and lone CR line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseCsv("a,b\r1,2\r3,4").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("blank trailing lines are dropped; empty cells survive", () => {
    const { rows } = parseCsv("a,b\n1,\n,2\n\n");
    expect(rows).toEqual([
      ["1", ""],
      ["", "2"],
    ]);
  });

  test("rejects what is not a CSV", () => {
    expect(() => parseCsv("")).toThrow();
    expect(() => parseCsv("just-a-header\n")).toThrow(/no rows/);
    expect(() => parseCsv("a,b\u0000c\n1,2")).toThrow(/text/);
  });
});

describe("serializeCsv", () => {
  test("round-trips quoting", () => {
    const headers = ["name", "notes"];
    const rows = [["Smith, Jane", 'said "hi"\nthen left']];
    const back = parseCsv(serializeCsv(headers, rows));
    expect(back.headers).toEqual(headers);
    expect(back.rows).toEqual(rows);
  });
});

describe("prepareDataset", () => {
  test("small file: untouched, no notice", () => {
    const d = prepareDataset("sales.csv", "a,b\n1,2\n");
    expect(d.truncated).toBe(false);
    expect(d.notice).toBeNull();
    expect(d.csvText).toBe("a,b\n1,2");
  });

  test("caps rows at MAX_ROWS with a notice", () => {
    const text = "n\n" + Array.from({ length: MAX_ROWS + 10 }, (_, i) => String(i)).join("\n");
    const d = prepareDataset("big.csv", text);
    expect(d.rows.length).toBe(MAX_ROWS);
    expect(d.truncated).toBe(true);
    expect(d.notice).toContain("5,000");
  });

  test("caps bytes at MAX_BYTES, cutting at a row boundary", () => {
    const row = "x".repeat(99) + "\n";
    const text = "col\n" + row.repeat(Math.ceil(MAX_BYTES / 100) + 50);
    const d = prepareDataset("huge.csv", text);
    expect(d.truncated).toBe(true);
    expect(d.csvText.length).toBeLessThanOrEqual(MAX_BYTES);
    // every surviving row is whole
    expect(d.rows.every((r) => r[0]!.length === 99)).toBe(true);
  });
});
