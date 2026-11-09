import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { entriesOf, getField, parseBibtex } from "../src";
import { findDuplicates, mergeDuplicates, renameMapText, suggestKeep } from "../src";

const fx = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const files = () => [
  { name: "a.bib", text: fx("duplicates-a.bib") },
  { name: "b.bib", text: fx("duplicates-b.bib") },
];
const keysOf = (ids: number[], r: ReturnType<typeof findDuplicates>) => ids.map((i) => r.candidates[i].entry.key);

describe("findDuplicates", () => {
  it("groups by DOI, arXiv-vs-published, similar title and shared key", () => {
    const r = findDuplicates(files());
    expect(r.candidates).toHaveLength(8);
    const groups = r.groups.map((g) => ({ keys: keysOf(g.members.map((m) => m.id), r), reasons: g.reasons }));
    expect(groups).toEqual([
      { keys: ["devlin2018bert", "devlin2019bert"], reasons: ["arxiv-published"] },
      { keys: ["krizhevsky2017imagenet", "Krizhevsky_2017"], reasons: ["doi", "same-title"] },
      { keys: ["he2016deep", "he2016resnet", "he2016deep"], reasons: ["same-title", "same-key"] },
    ]);
  });

  it("suggests keeping the published version, then the most complete entry", () => {
    const r = findDuplicates(files());
    expect(keysOf([r.groups[0].suggested], r)).toEqual(["devlin2019bert"]);
    // both Krizhevsky entries are published; the Crossref one has more fields (publisher, month)
    expect(keysOf([r.groups[1].suggested], r)).toEqual(["Krizhevsky_2017"]);
    expect(suggestKeep([r.candidates[0]])).toBe(0);
  });

  it("does not link entries with different DOIs even if titles match", () => {
    const r = findDuplicates([
      { name: "x", text: "@inproceedings{c, title={Graph Attention Networks for Molecules}, doi={10.1145/1111}}\n@article{j, title={Graph Attention Networks for Molecules}, doi={10.1109/2222}}" },
    ]);
    expect(r.groups).toEqual([]);
  });

  it("respects the similarity threshold", () => {
    const text = "@misc{a, title={Learning to rank with graph neural networks}}\n@misc{b, title={Learning to rank with graph neural network}}";
    expect(findDuplicates([{ name: "x", text }], { threshold: 0.9 }).groups).toHaveLength(1);
    expect(findDuplicates([{ name: "x", text }], { threshold: 0.99 }).groups).toHaveLength(0);
  });

  it("defaults to keeping both entries when only the key collides", () => {
    const r = findDuplicates([
      { name: "a", text: "@misc{smith2020, title={Quantum error correction codes}}" },
      { name: "b", text: "@misc{smith2020, title={Protein folding at scale}}" },
    ]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].reasons).toEqual(["same-key"]);
    expect(r.groups[0].defaultChoice).toBe("all");
    expect(mergeDuplicates(r, {}).removed).toBe(0);
  });

  it("stays fast on large bibliographies and still finds the planted duplicate", () => {
    // Seeded PRNG + Zipf-like vocabulary: a few very common words ("learning", "for") and a long tail.
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const common = "learning for of the deep neural networks with a and model on".split(" ");
    const tail = Array.from({ length: 1500 }, (_, i) => `w${i.toString(36)}x`);
    const word = () => (rand() < 0.4 ? common[Math.floor(rand() * common.length)] : tail[Math.floor(rand() * rand() * tail.length)]);
    let text = "";
    for (let i = 0; i < 3000; i++) {
      const t = Array.from({ length: 6 + Math.floor(rand() * 8) }, word).join(" ");
      text += `@misc{k${i}, title = {${t}}, year = {2020}}\n`;
    }
    text += "@misc{dupA, title = {A unique planted title about zebras and quasars}}\n@misc{dupB, title = {A unique planted title about zebras and quasars.}}\n";
    const t0 = performance.now();
    const r = findDuplicates([{ name: "big", text }]);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.groups.some((g) => g.members.map((m) => m.entry.key).join() === "dupA,dupB")).toBe(true);
  });

  it("collects parse warnings per file and dedupes @string definitions", () => {
    const r = findDuplicates([
      { name: "one.bib", text: '@string{acl = "ACL"}\n@misc{a, title={T}}\n@misc{broken, title={x}' },
      { name: "two.bib", text: '@string{acl = "ACL"}\n@misc{b, title={U}}' },
    ]);
    expect(r.warnings.map((w) => w.source)).toEqual(["one.bib"]);
    expect(r.extras).toHaveLength(1);
  });
});

describe("mergeDuplicates", () => {
  it("keeps the default choice and produces a rename map", () => {
    const r = findDuplicates(files());
    const m = mergeDuplicates(r, {});
    expect(m.removed).toBe(4);
    expect(m.kept).toBe(4);
    expect(m.renames).toEqual([
      { from: "devlin2018bert", to: "devlin2019bert" },
      { from: "krizhevsky2017imagenet", to: "Krizhevsky_2017" },
      { from: "he2016deep", to: "he2016resnet" },
    ]);
    expect(renameMapText(m.renames)).toBe("devlin2018bert -> devlin2019bert\nkrizhevsky2017imagenet -> Krizhevsky_2017\nhe2016deep -> he2016resnet");
    const keys = entriesOf(parseBibtex(m.output)).map((e) => e.key);
    expect(keys).toEqual(["devlin2019bert", "Krizhevsky_2017", "he2016resnet", "lecun2015deep"]);
  });

  it("honours user choices, including keeping every member", () => {
    const r = findDuplicates(files());
    const [bert, alex, he] = r.groups;
    const m = mergeDuplicates(r, { [bert.id]: bert.members[0].id, [alex.id]: "all", [he.id]: he.members[0].id });
    const keys = entriesOf(parseBibtex(m.output)).map((e) => e.key);
    expect(keys).toEqual(["devlin2018bert", "krizhevsky2017imagenet", "he2016deep", "Krizhevsky_2017", "lecun2015deep"]);
    expect(m.renames).toEqual([
      { from: "devlin2019bert", to: "devlin2018bert" },
      { from: "he2016resnet", to: "he2016deep" },
    ]);
  });

  it("can fill missing fields from discarded duplicates", () => {
    const r = findDuplicates(files());
    const m = mergeDuplicates(r, {}, { fillMissing: true });
    const kept = entriesOf(parseBibtex(m.output)).find((e) => e.key === "Krizhevsky_2017")!;
    expect(getField(kept, "number")).toBe("6");
    expect(getField(kept, "title")).toBe("ImageNet Classification with Deep Convolutional Neural Networks");
  });

  it("returns an empty merge for empty input", () => {
    const r = findDuplicates([{ name: "x", text: "" }]);
    expect(r.groups).toEqual([]);
    expect(mergeDuplicates(r, {}).output).toBe("");
  });
});
