import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentStrip } from "./Attachments";
import type { Attachment } from "../lib/images";

const shot: Attachment = { id: "img-1", name: "shot.png", bytes: 2, image: { data: "aGk=", media_type: "image/png" } };

describe("AttachmentStrip", () => {
  test("nothing attached, nothing in the way", () => {
    expect(renderToStaticMarkup(<AttachmentStrip items={[]} onRemove={() => {}} />)).toBe("");
  });

  test("a thumbnail of the bytes in hand, and a way to take it off again", () => {
    const html = renderToStaticMarkup(<AttachmentStrip items={[shot]} onRemove={() => {}} />);
    expect(html).toContain('src="data:image/png;base64,aGk="');
    expect(html).toContain('alt="shot.png"');
    expect(html).toContain('aria-label="Remove shot.png"');
  });
});
