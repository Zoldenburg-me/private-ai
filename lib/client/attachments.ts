import type { CreateAttachment } from "@assistant-ui/react";

/**
 * Files are read here, in the browser: images become inline data URLs, documents become text.
 * Nothing is uploaded on its own; it goes to the model inside the message, like typed text.
 */
const DOCS = "application/pdf,text/*,.md,.txt,.csv,.tsv,.json,.xml,.yaml,.yml,.log";
/** The file picker's filter: images only when the selected model reads them. */
export const acceptFor = (images: boolean) => (images ? `image/png,image/jpeg,image/webp,image/gif,${DOCS}` : DOCS);
/** Longest image side sent to the model; vision models downscale to about this anyway, and it keeps photos well under the 4 MB body cap. */
const IMAGE_MAX_SIDE = 1568;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Characters of document text per file (about 65k tokens by the server's estimate). */
export const MAX_DOC_CHARS = 200_000;

const escapeName = (n: string) => n.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Wraps a document's text so the model knows where it starts and ends and what it was called. */
export function documentPart(name: string, text: string): { type: "text"; text: string } {
  if (!text.trim()) throw new Error(`${name} has no readable text`);
  if (text.length > MAX_DOC_CHARS) throw new Error(`${name} is too long (over ${MAX_DOC_CHARS.toLocaleString("en")} characters)`);
  // A closing tag inside the text must not end the document early (for the model, and for storedView on reload).
  return { type: "text", text: `<document name="${escapeName(name)}">\n${text.replaceAll("</document>", "<\\/document>")}\n</document>` };
}

const isImage = (f: File) => /^image\/(png|jpeg|webp|gif)$/.test(f.type);
const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isText = (f: File) => f.type.startsWith("text/") || /\.(md|txt|csv|tsv|json|xml|ya?ml|log)$/i.test(f.name);

/** Reads a picked file into a ready attachment, or throws a message fit to show the user. */
export async function readAttachment(file: File, { images = true } = {}): Promise<CreateAttachment> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 20 MB`);
  const base = { name: file.name, contentType: file.type };
  if (isImage(file) && !images) throw new Error(`${file.name}: this model does not read images; pick one that does`);
  if (isImage(file)) return { ...base, type: "image", content: [{ type: "image", image: await downscale(file) }] };
  if (isPdf(file)) return { ...base, type: "document", content: [documentPart(file.name, await pdfText(file))] };
  if (isText(file)) return { ...base, type: "document", content: [documentPart(file.name, await file.text())] };
  throw new Error(`${file.name}: only images, PDFs and text files can be attached`);
}

/** JPEG at most IMAGE_MAX_SIDE px on the longest side (an animated GIF keeps its first frame). */
async function downscale(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`${file.name} could not be read as an image`); });
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) { bitmap.close(); throw new Error("this browser cannot process images"); }
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); // transparent PNGs: white, not black, behind them
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Text of every page. pdf.js loads only when a PDF is picked, and runs on this thread: the CSP allows no worker URL. */
async function pdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // @ts-expect-error the worker bundle ships no types
  await import("pdfjs-dist/build/pdf.worker.min.mjs"); // registers globalThis.pdfjsWorker, which pdf.js uses instead of a Worker
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const doc = await task.promise.catch(() => { throw new Error(`${file.name} could not be opened as a PDF`); });
    const pages: string[] = [];
    let chars = 0;
    for (let i = 1; i <= doc.numPages && chars <= MAX_DOC_CHARS; i++) { // past the limit documentPart reports it as too long
      const { items } = await (await doc.getPage(i)).getTextContent();
      const page = items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
      pages.push(page); chars += page.length;
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}
