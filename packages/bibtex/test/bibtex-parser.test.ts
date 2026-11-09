import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  entriesOf,
  getField,
  isArxivEntry,
  levenshtein,
  levenshteinBounded,
  levenshteinRatio,
  monthMacro,
  normalizeDoi,
  normalizeNameList,
  normalizeTitle,
  parseBibtex,
  parseName,
  plainText,
  serializeBibtex,
  splitNames,
  titleSimilarity,
  titleSimilarityAtLeast,
  tokenJaccard,
  type BibEntry,
} from "../src";

const fx = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("parseBibtex", () => {
  it("parses a Google Scholar export", () => {
    const f = parseBibtex(fx("scholar.bib"));
    expect(f.warnings).toEqual([]);
    const es = entriesOf(f);
    expect(es.map((e) => e.key)).toEqual(["vaswani2017attention", "devlin2019bert", "he2016deep", "kingma2014adam"]);
    expect(es[0].type).toBe("article");
    expect(getField(es[0], "author")).toContain("Kaiser, {\\L}ukasz");
    expect(es[1].line).toBe(9);
  });

  it("parses DBLP exports with multi-line values and keys containing slashes and colons", () => {
    const es = entriesOf(parseBibtex(fx("dblp.bib")));
    expect(es).toHaveLength(3);
    expect(es[0].key).toBe("DBLP:conf/nips/VaswaniSPUJGKP17");
    expect(getField(es[1], "title")).toMatch(/^\{BERT:\} Pre-training/);
    expect(getField(es[1], "eprinttype")).toBe("arXiv");
  });

  it("parses ACM exports with unbraced month macro and unicode dashes", () => {
    const es = entriesOf(parseBibtex(fx("acm.bib")));
    expect(es).toHaveLength(2);
    expect(es[1].fields.find((f) => f.name === "month")!.value).toEqual([{ type: "macro", name: "may" }]);
    expect(getField(es[0], "pages")).toBe("2623–2631");
  });

  it("handles @string, @preamble, @comment, quotes, bare numbers, concatenation and parentheses", () => {
    const f = parseBibtex(fx("strings.bib"));
    expect(f.warnings).toEqual([]);
    const kinds = f.items.map((i) => i.kind);
    expect(kinds).toEqual(["comment", "preamble", "string", "string", "comment", "entry", "entry"]);
    const [gan, misc] = entriesOf(f);
    expect(gan.type).toBe("article");
    expect(gan.fields.map((x) => x.name)).toEqual(["author", "title", "journal", "year", "month", "note"]);
    expect(gan.fields[2].value).toEqual([
      { type: "macro", name: "nips" },
      { type: "literal", value: " 27", delim: "quote" },
    ]);
    expect(getField(gan, "journal", { nips: "Advances in NIPS" })).toBe("Advances in NIPS 27");
    expect(gan.fields[3].value).toEqual([{ type: "literal", value: "2014", delim: "bare" }]);
    expect(getField(gan, "note")).toBe('Nested {braces {deep}} and "quotes" inside');
    expect(misc.key).toBe("Beethoven1808");
    expect(misc.fields.find((x) => x.name === "howpublished")!.value).toEqual([{ type: "macro", name: "pami" }]);
  });

  it("recovers from malformed entries and reports warnings with line numbers", () => {
    const f = parseBibtex(fx("malformed.bib"));
    const keys = entriesOf(f).map((e) => e.key);
    expect(keys).toEqual(["good1", "good2", "good3"]);
    const msgs = f.warnings.map((w) => `${w.line}: ${w.message}`);
    expect(msgs.some((m) => m.startsWith("7:") && /Unbalanced braces/.test(m))).toBe(true);
    expect(msgs.some((m) => /Missing citation key/.test(m))).toBe(true);
    expect(msgs.some((m) => /Duplicate field "title"/.test(m))).toBe(true);
    expect(getField(entriesOf(f)[2], "title")).toBe("Third Good");
  });

  it("does not throw on garbage, empty input, or a lone @", () => {
    expect(parseBibtex("").items).toEqual([]);
    expect(entriesOf(parseBibtex("just some text @ here"))).toEqual([]);
    const f = parseBibtex("@article{x, title = {never closed");
    expect(f.warnings).toHaveLength(1);
    expect(entriesOf(f)).toEqual([]);
  });

  it("accepts entries without fields, trailing commas and CRLF line endings", () => {
    const f = parseBibtex("@misc{empty}\r\n@misc{trail,\r\n  title = {T},\r\n}\r\n");
    expect(f.warnings).toEqual([]);
    expect(entriesOf(f).map((e) => [e.key, e.fields.length])).toEqual([
      ["empty", 0],
      ["trail", 1],
    ]);
  });

  it("round-trips through the serializer without losing information", () => {
    const src = fx("strings.bib") + "\n" + fx("dblp.bib") + "\n" + fx("acm.bib");
    const a = parseBibtex(src);
    const b = parseBibtex(serializeBibtex(a.items));
    const strip = (es: BibEntry[]) => es.map((e) => [e.type, e.key, e.fields]);
    expect(strip(entriesOf(b))).toEqual(
      strip(entriesOf(a)).map(([t, k, fs]) => [
        t,
        k,
        (fs as BibEntry["fields"]).map((f) => ({
          ...f,
          value: f.value.map((p) => (p.type === "literal" && p.delim === "quote" ? { ...p, delim: "brace" } : p)),
        })),
      ]),
    );
    expect(b.warnings).toEqual([]);
  });
});

describe("names", () => {
  it("parses all three BibTeX name forms", () => {
    expect(parseName("Ludwig van Beethoven")).toEqual({ first: "Ludwig", von: "van", last: "Beethoven", jr: "" });
    expect(parseName("van Beethoven, Ludwig")).toEqual({ first: "Ludwig", von: "van", last: "Beethoven", jr: "" });
    expect(parseName("King, Jr., Martin Luther")).toEqual({ first: "Martin Luther", von: "", last: "King", jr: "Jr." });
    expect(parseName("Martin Luther King Jr.")).toEqual({ first: "Martin Luther", von: "", last: "King", jr: "Jr." });
    expect(parseName("Jean de la Fontaine").von).toBe("de la");
    expect(parseName("{World Health Organization}").last).toBe("{World Health Organization}");
  });

  it("normalizes author lists to Last, First", () => {
    expect(normalizeNameList("Ashish Vaswani and\n   Noam Shazeer AND Aidan N. Gomez and others")).toBe(
      "Vaswani, Ashish and Shazeer, Noam and Gomez, Aidan N. and others",
    );
    expect(normalizeNameList("Kaiser, {\\L}ukasz and Ming{-}Wei Chang")).toBe("Kaiser, {\\L}ukasz and Chang, Ming{-}Wei");
    expect(normalizeNameList("{Barnes and Noble} and Jane Doe")).toBe("{Barnes and Noble} and Doe, Jane");
  });

  it("splits names only on top-level 'and'", () => {
    expect(splitNames("A and {B and C} and Dandy Anderson")).toEqual(["A", "{B and C}", "Dandy Anderson"]);
  });
});

describe("text helpers", () => {
  it("maps months to macros", () => {
    expect(["January", "jan.", "1", "01", "Sept", "dec", "July"].map(monthMacro)).toEqual(["jan", "jan", "jan", "jan", "sep", "dec", "jul"]);
    expect(monthMacro("13")).toBeNull();
    expect(monthMacro("Spring")).toBeNull();
    expect(monthMacro("ju")).toBeNull();
  });

  it("strips LaTeX for comparison", () => {
    expect(plainText("{\\\"O}zt{\\\"u}rk and Ka\\v{c}er: {BERT} \\emph{rocks} $x^2$")).toBe("ozturk and kacer bert rocks");
    expect(plainText("Stra{\\ss}e")).toBe("strasse");
    expect(plainText("Café Économie")).toBe("cafe economie");
  });

  it("normalizes DOIs", () => {
    expect(normalizeDoi("https://doi.org/10.1145/3065386")).toBe("10.1145/3065386");
    expect(normalizeDoi("doi:10.18653/V1/N19-1423")).toBe("10.18653/v1/n19-1423");
    expect(normalizeDoi("10.1000/a\\_b")).toBe("10.1000/a_b");
    expect(normalizeDoi("not a doi")).toBeUndefined();
  });

  it("detects arXiv entries across export styles", () => {
    const es = entriesOf(parseBibtex(fx("scholar.bib") + fx("dblp.bib") + fx("datacite-arxiv.bib")));
    const flags = Object.fromEntries(es.map((e) => [e.key, isArxivEntry(e)]));
    expect(flags["kingma2014adam"]).toBe(true);
    expect(flags["DBLP:journals/corr/abs-1810-04805"]).toBe(true);
    expect(flags["https://doi.org/10.48550/arxiv.1706.03762"]).toBe(true);
    expect(flags["vaswani2017attention"]).toBe(false);
    expect(flags["DBLP:conf/naacl/DevlinCLT19"]).toBe(false);
  });
});

describe("similarity", () => {
  it("scores titles", () => {
    const a = normalizeTitle("{BERT}: Pre-training of Deep Bidirectional Transformers");
    const b = normalizeTitle("Bert: Pre-training of deep bidirectional transformers.");
    expect(a).toBe(b);
    expect(titleSimilarity(a, b)).toBe(1);
    expect(tokenJaccard("a b c", "a b d")).toBeCloseTo(0.5);
    expect(levenshteinRatio("kitten", "sitting")).toBeCloseTo(1 - 3 / 7);
    expect(titleSimilarity("deep residual learning for image recognition", "deep residual learning for image recognitions")).toBeGreaterThan(0.9);
    expect(titleSimilarity("deep residual learning for image recognition", "identity mappings in deep residual networks")).toBeLessThan(0.5);
    expect(titleSimilarity("", "x")).toBe(0);
  });

  it("bounded edit distance agrees with the full one", () => {
    const pairs: [string, string][] = [
      ["kitten", "sitting"],
      ["deep residual learning", "deep residual learnings"],
      ["abc", "abc"],
      ["", "abc"],
      ["attention is all you need", "attention is all we need"],
    ];
    for (const [a, b] of pairs) {
      const d = levenshtein(a, b);
      for (const k of [0, 1, 2, 3, 5, 10]) expect(levenshteinBounded(a, b, k)).toBe(d <= k ? d : k + 1);
    }
  });

  it("titleSimilarityAtLeast matches titleSimilarity above the threshold and is 0 below", () => {
    const titles = [
      "deep residual learning for image recognition",
      "deep residual learning for image recognitions",
      "deep residual learning for visual recognition",
      "identity mappings in deep residual networks",
      "attention is all you need",
    ];
    for (const a of titles)
      for (const b of titles)
        for (const t of [0.8, 0.9, 0.95]) {
          const full = titleSimilarity(a, b);
          const bounded = titleSimilarityAtLeast(a, b, t);
          if (full >= t) expect(bounded).toBeCloseTo(full);
          else expect(bounded).toBe(0);
        }
  });
});

describe("comments and unparseable chunks inside entries", () => {
  it("treats %-lines between fields as comments", () => {
    const f = parseBibtex("@article{k,\n  title = {T},\n  % author = {old},\n  author = {New, Author},\n  %year = {1999}\n  year = {2020}\n}\n");
    expect(f.warnings).toEqual([]);
    const [e] = entriesOf(f);
    expect(e.fields.map((x) => [x.name, getField(e, x.name)])).toEqual([
      ["title", "T"],
      ["author", "New, Author"],
      ["year", "2020"],
    ]);
  });

  it("keeps % inside braced and quoted values", () => {
    const [e] = entriesOf(parseBibtex('@misc{k, note = {50\\% off\n% not a comment}, title = "a % b"}'));
    expect(getField(e, "note")).toBe("50\\% off\n% not a comment");
    expect(getField(e, "title")).toBe("a % b");
  });

  it("keeps an unparseable chunk as an item, in order, with its raw text", () => {
    const f = parseBibtex("@misc{a, title={A}}\n@misc{b, title={B}\n  year={2020}}\n@misc{c, title={C}}\n");
    expect(f.warnings).toHaveLength(1);
    expect(f.items.map((i) => i.kind)).toEqual(["entry", "unparsed", "entry"]);
    const bad = f.items[1];
    expect(bad.kind === "unparsed" && bad.raw).toBe("@misc{b, title={B}\n  year={2020}}");
    expect(serializeBibtex(f.items)).toContain("@misc{b, title={B}\n  year={2020}}");
  });
});
