import PDFDocument from "pdfkit";
import type { TranscriptChunk } from "./roomTranscriber.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const formatTimestamp = (ms: number): string =>
  new Date(ms).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });

const normalizeSpeakerLabel = (value?: string): string => {
  const next = (value || "").trim().replace(/\s+/g, " ");
  if (!next || /^unknown$/i.test(next) || UUID_PATTERN.test(next)) {
    return "Speaker";
  }
  if (next.length <= 36) return next;
  if (next.includes("@")) {
    const first = next.split("@")[0]?.trim();
    if (first) return first;
  }
  return next.slice(0, 36);
};

const ensurePageSpace = (doc: PDFKit.PDFDocument, estimatedLineCount = 2): void => {
  const minimumY = doc.page.height - doc.page.margins.bottom - estimatedLineCount * 14;
  if (doc.y > minimumY) {
    doc.addPage();
  }
};

const drawSectionTitle = (doc: PDFKit.PDFDocument, title: string): void => {
  ensurePageSpace(doc, 3);
  doc.font("Helvetica-Bold").fontSize(14).text(title);
  doc.moveDown(0.2);
  const startX = doc.page.margins.left;
  const endX = doc.page.width - doc.page.margins.right;
  const y = doc.y;
  doc.moveTo(startX, y).lineTo(endX, y).strokeColor("#C7CDD3").lineWidth(1).stroke();
  doc.moveDown(0.4);
  doc.strokeColor("black");
};

export function buildMinutesPdf(options: {
  roomId: string;
  summary: string;
  transcript: TranscriptChunk[];
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    doc.font("Helvetica-Bold").fontSize(21).text(`Meeting Minutes`, { align: "center" });
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(12).text(`Room: ${options.roomId}`);
    doc.text(`Generated: ${formatTimestamp(Date.now())}`);
    doc.moveDown();

    drawSectionTitle(doc, "Summary");
    const summarySections = (options.summary || "No summary available.")
      .split(/\n{2,}/)
      .map((section) => section.trim())
      .filter(Boolean);
    doc.font("Helvetica").fontSize(12);
    for (const section of summarySections) {
      ensurePageSpace(doc, 3);
      doc.text(`- ${section}`, {
        lineGap: 2,
      });
      doc.moveDown(0.35);
    }
    doc.moveDown();

    drawSectionTitle(doc, "Transcript");
    doc.font("Helvetica");

    if (!options.transcript.length) {
      doc.fontSize(11).text("No transcript captured.", { oblique: true });
      doc.end();
      return;
    }

    for (const entry of options.transcript) {
      ensurePageSpace(doc, 5);
      const start = formatTimestamp(entry.startMs);
      const speaker = normalizeSpeakerLabel(entry.speaker);

      doc.font("Helvetica-Bold").fontSize(10).text(`${speaker} - ${start}`);
      doc.font("Helvetica").fontSize(11).text(entry.text, {
        indent: 12,
        lineGap: 1.5,
      });
      doc.moveDown(0.55);
    }

    doc.end();
  });
}


//gameolan-
//use whisper ai as stt 
//ONLY SEND active users(We already capture that info in sfu state)
//OKAY NVM this takes too much cpu and also needs gpu even w v little users
//switching to vosk for now
//SWITCH TO BETTER STUFF IF NEEDED LATER
//USING VOSK
