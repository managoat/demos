import { describe, expect, test } from "bun:test";
import { base64Of, rejectImage } from "./images";

describe("composer images", () => {
  test("accepts the server's allowlist and refuses the rest", () => {
    expect(rejectImage({ type: "image/png", size: 10 })).toBeNull();
    expect(rejectImage({ type: "image/webp", size: 10 })).toBeNull();
    expect(rejectImage({ type: "image/svg+xml", size: 10 })).toMatch(/not a supported image/);
    expect(rejectImage({ type: "", size: 10 })).toMatch(/that file/);
  });

  test("refuses images over 10 MB before uploading them", () => {
    expect(rejectImage({ type: "image/png", size: 10 * 1024 * 1024 })).toBeNull();
    expect(rejectImage({ type: "image/png", size: 10 * 1024 * 1024 + 1 })).toMatch(/10 MB/);
  });

  test("base64 matches the platform encoder, including past the chunk boundary", () => {
    const bytes = new Uint8Array(0x8000 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    expect(base64Of(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(base64Of(new Uint8Array([]))).toBe("");
  });
});
