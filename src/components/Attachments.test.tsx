import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachButton, AttachmentStrip } from "./Attachments";
import { IMAGE_MEDIA_TYPES } from "../../shared/images";
import type { Attachment } from "../lib/images";

const shot: Attachment = { id: "img-1", name: "shot.png", bytes: 2, image: { data: "aGk=", media_type: "image/png" } };
const noop = async () => {};

describe("AttachButton", () => {
  test("a real button, named, so a keyboard and a screen reader can both reach it", () => {
    const html = renderToStaticMarkup(<AttachButton add={noop} />);
    // A <button> is focusable and pressable by definition; the file input behind it is neither.
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="Attach images"');
    expect(html).toContain('title="Attach images"');
    // The glyph is decoration — the name comes from the label, and is not read twice.
    expect(html).toContain('<span aria-hidden="true">');
  });

  test("the picker offers only what Fountain stores, and more than one at a time", () => {
    const html = renderToStaticMarkup(<AttachButton add={noop} />);
    expect(html).toContain(`accept="${IMAGE_MEDIA_TYPES.join(",")}"`);
    expect(html).toContain("multiple");
    expect(html).toContain('type="file"');
    // Hidden, so it is the button that is in the tab order, not a second unlabelled stop.
    expect(html).toContain("hidden");
  });

  test("a retired composer cannot attach either", () => {
    expect(renderToStaticMarkup(<AttachButton add={noop} disabled />)).toContain("disabled");
    expect(renderToStaticMarkup(<AttachButton add={noop} label="Attach an image to this prompt" />)).toContain('aria-label="Attach an image to this prompt"');
  });
});

describe("AttachmentStrip", () => {
  test("nothing attached, nothing in the way", () => {
    expect(renderToStaticMarkup(<AttachmentStrip items={[]} onRemove={() => {}} />)).toBe("");
  });

  test("given a way to add, the strip is the way in even with nothing on it", () => {
    const html = renderToStaticMarkup(<AttachmentStrip items={[]} onRemove={() => {}} add={noop} />);
    expect(html).toContain('aria-label="Attach images"');
    expect(html).toContain('type="file"');
  });

  test("the button keeps its place once there are images beside it", () => {
    const html = renderToStaticMarkup(<AttachmentStrip items={[shot]} onRemove={() => {}} add={noop} />);
    expect(html.indexOf('aria-label="Attach images"')).toBeLessThan(html.indexOf('alt="shot.png"'));
  });

  test("a thumbnail of the bytes in hand, and a way to take it off again", () => {
    const html = renderToStaticMarkup(<AttachmentStrip items={[shot]} onRemove={() => {}} />);
    expect(html).toContain('src="data:image/png;base64,aGk="');
    expect(html).toContain('alt="shot.png"');
    expect(html).toContain('aria-label="Remove shot.png"');
  });
});
