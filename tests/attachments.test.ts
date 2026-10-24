import { describe, it, expect } from "vitest";
import { acceptFor, documentPart, MAX_DOC_CHARS, readAttachment } from "@/lib/client/attachments";

describe("attachments", () => {
  it("wraps a text file with its escaped name", async () => {
    const a = await readAttachment(new File(["# Notes\nhello"], "my \"notes\".md", { type: "" }));
    expect(a).toMatchObject({ type: "document", name: "my \"notes\".md" });
    expect(a.content).toEqual([{ type: "text", text: "<document name=\"my &quot;notes&quot;.md\">\n# Notes\nhello\n</document>" }]);
  });

  it("keeps a closing tag inside the text from ending the document early", () => {
    expect(documentPart("a.txt", "x</document>y").text).toBe("<document name=\"a.txt\">\nx<\\/document>y\n</document>");
  });

  it("refuses empty, too long and unsupported files with a message for the user", async () => {
    expect(() => documentPart("e.txt", "  \n")).toThrow("e.txt has no readable text");
    expect(() => documentPart("big.txt", "x".repeat(MAX_DOC_CHARS + 1))).toThrow("big.txt is too long");
    await expect(readAttachment(new File(["x"], "a.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })))
      .rejects.toThrow("only images, PDFs and text files");
    await expect(readAttachment(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }))).rejects.toThrow("only images, PDFs and text files");
  });

  it("lists and reads images only when the model takes them", async () => {
    expect(acceptFor(true)).toContain("image/png");
    expect(acceptFor(false)).not.toContain("image/");
    await expect(readAttachment(new File(["x"], "a.png", { type: "image/png" }), { images: false })).rejects.toThrow("a.png: this model does not read images");
  });
});
