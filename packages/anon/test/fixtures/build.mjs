// Builds the anonymity fixtures. Run: node packages/anon/test/fixtures/build.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";
import JSZip from "jszip";
import { makeJpegWithArtist, makePng } from "./images.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXED = new Date("2024-05-01T10:00:00Z");

const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>
   <pdf:Producer>pdfTeX-1.40.25</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

async function paper() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const write = (page, lines) => {
    let y = 760;
    for (const [text, size = 11, f = font] of lines) {
      page.drawText(text, { x: 72, y, size, font: f });
      y -= size + 9;
    }
  };
  write(doc.addPage([612, 792]), [
    ["Learning Sparse Things for Better Science", 18, bold],
    ["Jane Doe", 12],
    ["University of Somewhere", 11],
    ["jane.doe@somewhere.edu", 10],
    ["Abstract", 12, bold],
    ["We extend our previous work [3] on sparse things to the dense setting.", 11],
    ["Code is available at https://github.com/janedoe/sparse-things for everyone.", 11],
    ["1 Introduction", 12, bold],
    ["As we showed in [4], sparsity helps. Here we go further.", 11],
  ]);
  write(doc.addPage([612, 792]), [
    ["2 Method", 12, bold],
    ["Our method is simple and the anonymous code is at anonymous.4open.science/r/xyz.", 11],
    ["Acknowledgments", 12, bold],
    ["This work was supported by NSF grant IIS-1234567. We thank Bob for comments.", 11],
    ["References", 12, bold],
    ["[3] J. Doe and B. Roe. Sparse things. In NeurIPS, 2023.", 10],
    ["[4] Jane Doe. Even sparser things. In ICML, 2024.", 10],
  ]);
  doc.setTitle("Learning Sparse Things");
  doc.setAuthor("Jane Doe");
  doc.setSubject("Submission");
  doc.setKeywords(["sparsity", "science"]);
  doc.setCreator("/Users/janedoe/papers/sparse/main.tex");
  doc.setProducer("pdfTeX-1.40.25");
  doc.setCreationDate(FIXED);
  doc.setModificationDate(FIXED);
  const xmp = doc.context.stream(XMP, { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(xmp));
  doc.catalog.set(PDFName.of("PieceInfo"), doc.context.obj({ Illustrator: { Private: "janedoe-private" } }));
  return doc.save({ useObjectStreams: false });
}

async function figurePdf(author) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 120]);
  page.drawRectangle({ x: 20, y: 20, width: 160, height: 80, borderWidth: 2 });
  if (author) doc.setAuthor(author);
  doc.setCreator("matplotlib 3.8");
  doc.setProducer("matplotlib pdf backend");
  return doc.save({ useObjectStreams: false });
}

/** A PDF that leaks through annotations: author/date/rich text on a note + popup, attachments, a file:// link. */
async function annotatedPdf() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Anonymous submission with reviewer notes", { x: 72, y: 720, size: 12, font });
  const ctx = doc.context;
  const S = (v) => PDFString.of(v);
  const date = S("D:20240501100000Z");
  const popupRef = ctx.nextRef();
  const noteRef = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [72, 600, 92, 620], Contents: S("Check this claim"), T: S("Reviewer Ann Author"), M: date, CreationDate: date, Subj: S("Ann Author note"), RC: S("<body><p>Ann Author: check this claim</p></body>"), Popup: popupRef }),
  );
  ctx.assign(popupRef, ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [100, 560, 300, 640], Parent: noteRef, T: S("Reviewer Ann Author"), M: date }));
  const attached = ctx.stream("lab notebook body: ann private results", { Type: "EmbeddedFile" });
  const fileSpec = ctx.obj({ Type: "Filespec", F: S("ann-lab-notebook.txt"), UF: PDFHexString.fromText("ann-lab-notebook.txt"), EF: { F: ctx.register(attached) } });
  const attachRef = ctx.register(ctx.obj({ Type: "Annot", Subtype: "FileAttachment", Rect: [72, 500, 92, 520], FS: fileSpec, Contents: S("notebook"), T: S("Reviewer Ann Author") }));
  const linkRef = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 450, 300, 470], Border: [0, 0, 0], A: { S: "URI", URI: S("file:///Users/annauthor/results/table.csv") } }),
  );
  const webRef = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 420, 300, 440], Border: [0, 0, 0], A: { S: "URI", URI: S("https://example.org/paper") } }));
  page.node.set(PDFName.of("Annots"), ctx.obj([noteRef, popupRef, attachRef, linkRef, webRef]));
  const field = doc.getForm().createTextField("reviewer.notes");
  field.addToPage(page, { x: 72, y: 380, width: 200, height: 20, font });
  await doc.attach(new TextEncoder().encode("supplement body: ann private data"), "ann-supplement.zip", { mimeType: "application/zip", description: "Supplement", creationDate: FIXED, modificationDate: FIXED });
  return doc.save({ useObjectStreams: false });
}

const MAIN_TEX = String.raw`\documentclass{article}
\usepackage[final]{neurips_2024}
\usepackage{graphicx}
\title{Learning Sparse Things}
\author{Jane Doe\thanks{Work done while at Somewhere Labs.} \\
  University of Somewhere \\
  \texttt{jane.doe@somewhere.edu}}
\begin{document}
\maketitle
% TODO(jane): ask Bob about the dense case
\section{Introduction}
In our prior paper [3], we
previously showed that sparsity helps. % Jane Doe wrote this paragraph
Code: \url{https://github.com/janedoe/sparse-things}.
\includegraphics{figures/photo.jpg}
\input{sections/related}
\section*{Acknowledgments}
This work was supported by NSF grant IIS-1234567.
\end{document}
`;

const RELATED_TEX = String.raw`\section{Related work}
Sparse methods are popular. As we have
shown before, they scale.
`;

async function sourceZip() {
  const zip = new JSZip();
  const opts = { date: FIXED };
  zip.file("main.tex", MAIN_TEX, opts);
  zip.file("sections/related.tex", RELATED_TEX, opts);
  zip.file("figures/photo.jpg", makeJpegWithArtist("Jane Doe"), opts);
  zip.file("figures/plot.png", makePng(8, 8, [200, 80, 80], { Author: "Jane Doe" }), opts);
  zip.file("figures/clean.png", makePng(8, 8), opts);
  zip.file("figures/chart.pdf", await figurePdf("Jane Doe"), opts);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

writeFileSync(join(here, "paper.pdf"), await paper());
writeFileSync(join(here, "figure.pdf"), await figurePdf("J. Doe"));
writeFileSync(join(here, "source.zip"), await sourceZip());
writeFileSync(join(here, "annotated.pdf"), await annotatedPdf());
console.log("anon fixtures written");
