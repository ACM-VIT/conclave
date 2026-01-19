import PDFDocument from "pdfkit";
import type { TranscriptChunk } from "./roomTranscriber.js";

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

    doc.fontSize(16).text(`Meeting Minutes`, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Room: ${options.roomId}`);
    doc.text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown();

    doc.fontSize(14).text(`Summary`, { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(12).text(options.summary || "No summary available.");
    doc.moveDown();

    doc.fontSize(14).text(`Transcript`, { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(11);
    for (const entry of options.transcript) {
      const start = new Date(entry.startMs).toISOString();
      const speaker = entry.speaker || "unknown";
      doc.text(`[${start}] ${speaker}: ${entry.text}`);
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