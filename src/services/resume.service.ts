import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface ParsedResume {
  fileName: string;
  text: string;
  characterCount: number;
}

export async function parseResume(fileName: string, buffer: Buffer): Promise<ParsedResume> {
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
  }).promise;

  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();

    const pageText = content.items
      .filter(
        (item): item is typeof item & { str: string } =>
          "str" in item && typeof item.str === "string",
      )
      .map((item) => item.str)
      .join(" ");

    pages.push(pageText);
  }

  const text = pages.join("\n").trim();

  if (!text) {
    throw new Error(`No readable text found in ${fileName}. The PDF may contain scanned images.`);
  }

  return {
    fileName,
    text,
    characterCount: text.length,
  };
}
