import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { entriesOf, getField, parseBibtex } from "../src";
import { cleanBibtex, defaultCleanOptions, fixPageRange, makeKey, protectCapitals, type CleanOptions } from "../src";

const fx = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const opts = (o: Partial<CleanOptions> = {}): CleanOptions => ({ ...defaultCleanOptions, ...o });
const none: CleanOptions = {
  regenerateKeys: false,
  sort: "none",
  protectCapitals: false,
  normalizeAuthors: false,
  removeAbstract: false,
  removeKeywords: false,
  removeFile: false,
  removeUrlWhenDoi: false,
  pageRanges: false,
  monthMacros: false,
  fieldOrder: false,
  trimWhitespace: false,
};

describe("protectCapitals", () => {
  it("braces acronyms and mixed-case words only", () => {
    expect(protectCapitals("BERT: Pre-training of Deep Bidirectional Transformers")).toBe("{BERT}: Pre-training of Deep Bidirectional Transformers");
    expect(protectCapitals("ImageNet classification on GPUs with PyTorch")).toBe("{ImageNet} classification on {GPUs} with {PyTorch}");
    expect(protectCapitals("COVID-19 and 3D scenes on an iPhone (LSTM)")).toBe("{COVID-19} and {3D} scenes on an {iPhone} ({LSTM})");
    expect(protectCapitals("A Study of Pre-Training")).toBe("A Study of Pre-Training");
  });

  it("leaves braced groups, math, commands and fully braced titles alone", () => {
    expect(protectCapitals("{BERT}: and {LSTM}-based {GPU} work")).toBe("{BERT}: and {LSTM}-based {GPU} work");
    expect(protectCapitals("Bounds for $O(N)$ and \\textsc{SAT} solvers")).toBe("Bounds for $O(N)$ and \\textsc{SAT} solvers");
    expect(protectCapitals("{Whole Title In BRACES}")).toBe("{Whole Title In BRACES}");
  });
});

describe("fixPageRange", () => {
  it("normalizes separators", () => {
    expect(fixPageRange("4171-4186")).toBe("4171--4186");
    expect(fixPageRange("84 - 90")).toBe("84--90");
    expect(fixPageRange("2623–2631")).toBe("2623--2631");
    expect(fixPageRange("1---9")).toBe("1--9");
    expect(fixPageRange("e1003")).toBe("e1003");
    expect(fixPageRange("12, 15-17")).toBe("12, 15-17");
  });
});

describe("makeKey", () => {
  it("builds authorYEARword keys, skipping stopwords and LaTeX", () => {
    const [e] = entriesOf(parseBibtex("@article{x, author = {{\\\"O}zt{\\\"u}rk, Ali and Doe, J}, title = {The {BERT} effect}, year = {2020}}"));
    expect(makeKey(e)).toBe("ozturk2020bert");
    const [v] = entriesOf(parseBibtex("@book{y, editor = {Ludwig van Beethoven}, title = {On Symphonies}, year = 1808}"));
    expect(makeKey(v)).toBe("beethoven1808symphonies");
    const [anon] = entriesOf(parseBibtex("@misc{z, title = {A}}"));
    expect(makeKey(anon)).toBe("anona");
  });
});

describe("cleanBibtex", () => {
  it("is a pure formatter when every option is off", () => {
    const r = cleanBibtex(fx("scholar.bib"), none);
    expect(r.stats.entries).toBe(4);
    expect(r.stats.entriesChanged).toBe(0);
    expect(r.stats.fieldsRemoved).toBe(0);
    expect(r.output).toContain("@article{vaswani2017attention,\n  title = {Attention is all you need},\n");
  });

  it("cleans an ACM export (golden)", () => {
    const r = cleanBibtex(fx("acm.bib"), opts({ removeUrlWhenDoi: true }));
    expect(r.output).toBe(`@inproceedings{10.1145/3292500.3330701,
  author = {Akiba, Takuya and Sano, Shotaro and Yanase, Toshihiko and Ohta, Takeru and Koyama, Masanori},
  title = {Optuna: A Next-generation Hyperparameter Optimization Framework},
  booktitle = {Proceedings of the 25th ACM SIGKDD International Conference on Knowledge Discovery \\& Data Mining},
  series = {KDD '19},
  pages = {2623--2631},
  year = {2019},
  month = jul,
  publisher = {Association for Computing Machinery},
  address = {New York, NY, USA},
  location = {Anchorage, AK, USA},
  isbn = {9781450362016},
  doi = {10.1145/3292500.3330701},
  numpages = {9},
}

@article{10.1145/3065386,
  author = {Krizhevsky, Alex and Sutskever, Ilya and Hinton, Geoffrey E.},
  title = {{ImageNet} classification with deep convolutional neural networks},
  journal = {Commun. ACM},
  volume = {60},
  number = {6},
  pages = {84--90},
  year = {2017},
  month = may,
  publisher = {Association for Computing Machinery},
  address = {New York, NY, USA},
  issn = {0001-0782},
  doi = {10.1145/3065386},
  issue_date = {June 2017},
  numpages = {7},
}
`);
    // abstract, keywords, url (x2), file
    expect(r.stats.fieldsRemoved).toBe(5);
    expect(r.stats.entriesChanged).toBe(2);
  });

  it("keeps url when there is no DOI, and when the option is off", () => {
    const src = "@misc{a, url = {https://x.org}, title = {T}}\n@misc{b, url = {https://y.org}, doi = {10.1/x}}";
    expect(cleanBibtex(src, opts({ removeUrlWhenDoi: true })).output).toContain("https://x.org");
    expect(cleanBibtex(src, opts({ removeUrlWhenDoi: true })).output).not.toContain("https://y.org");
    expect(cleanBibtex(src, opts({ removeUrlWhenDoi: false })).output).toContain("https://y.org");
  });

  it("normalizes DBLP author lists and collapses multi-line values", () => {
    const r = cleanBibtex(fx("dblp.bib"), opts());
    const [v] = entriesOf(parseBibtex(r.output));
    expect(getField(v, "author")).toBe(
      "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia",
    );
    expect(getField(v, "editor")).toBe("Guyon, Isabelle and von Luxburg, Ulrike and Bengio, Samy");
    expect(getField(v, "booktitle")).not.toContain("\n");
    expect(r.stats.warnings).toEqual([]);
  });

  it("regenerates keys with collision suffixes and reports the rename map", () => {
    const r = cleanBibtex(fx("dblp.bib"), opts({ regenerateKeys: true }));
    expect(r.keyChanges).toEqual([
      { from: "DBLP:conf/nips/VaswaniSPUJGKP17", to: "vaswani2017attention" },
      { from: "DBLP:journals/corr/abs-1810-04805", to: "devlin2018bert" },
      { from: "DBLP:conf/naacl/DevlinCLT19", to: "devlin2019bert" },
    ]);
    const dup = cleanBibtex("@misc{a, author={Doe, J}, title={Graphs}, year=2020}\n@misc{b, author={Doe, J}, title={Graphs II}, year=2020}", opts({ regenerateKeys: true }));
    expect(dup.keyChanges.map((k) => k.to)).toEqual(["doe2020graphsa", "doe2020graphsb"]);
  });

  it("sorts by key or year, keeping @string/@preamble first", () => {
    const src = fx("scholar.bib") + fx("strings.bib");
    const byKey = entriesOf(parseBibtex(cleanBibtex(src, opts({ sort: "key" })).output)).map((e) => e.key);
    expect(byKey).toEqual(["Beethoven1808", "devlin2019bert", "Goodfellow:GAN", "he2016deep", "kingma2014adam", "vaswani2017attention"]);
    const byYear = entriesOf(parseBibtex(cleanBibtex(src, opts({ sort: "year" })).output)).map((e) => e.key);
    expect(byYear).toEqual(["Beethoven1808", "Goodfellow:GAN", "kingma2014adam", "he2016deep", "vaswani2017attention", "devlin2019bert"]);
    expect(cleanBibtex(src, opts({ sort: "year" })).output.startsWith("@preamble{")).toBe(true);
  });

  it("preserves @string macros, concatenation and @comment blocks", () => {
    const r = cleanBibtex(fx("strings.bib"), opts());
    expect(r.output).toContain('@string{nips = {Advances in Neural Information Processing Systems}}');
    expect(r.output).toContain("journal = nips # { 27},");
    expect(r.output).toContain("howpublished = pami,");
    expect(r.output).toContain("month = dec,");
    expect(r.output).toContain("@comment{jabref-meta: databaseType:bibtex;}");
    expect(r.output).toContain("author = {Goodfellow, Ian and Pouget-Abadie, Jean and Mirza, Mehdi and others},");
    expect(r.output).toContain("author = {van Beethoven, Ludwig and King, Jr., Martin Luther and {World Health Organization}},");
    expect(r.output).toContain("title = {Symphony No. 5 in {C} minor for an {LSTM}-based {GPU} cluster},");
    expect(r.output).not.toContain("Contact: someone");
    // reparse is clean
    expect(parseBibtex(r.output).warnings).toEqual([]);
  });

  it("reports parse warnings and still cleans the rest", () => {
    const r = cleanBibtex(fx("malformed.bib"), opts());
    expect(r.stats.entries).toBe(3);
    expect(r.stats.warnings.length).toBe(3);
    expect(r.output).toContain("@book{good3,");
  });

  it("drops empty fields and counts them as removed", () => {
    const r = cleanBibtex("@misc{a, title = {T}, note = {  }, abstract = {x}}", opts({ removeAbstract: false }));
    expect(r.output).toBe("@misc{a,\n  title = {T},\n  abstract = {x},\n}\n");
    expect(r.stats.fieldsRemoved).toBe(1);
  });

  it("returns an empty result for empty input", () => {
    const r = cleanBibtex("   \n", opts());
    expect(r.output).toBe("");
    expect(r.stats).toEqual({ entries: 0, fieldsRemoved: 0, entriesChanged: 0, warnings: [] });
  });
});
