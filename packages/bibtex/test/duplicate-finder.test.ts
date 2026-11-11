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
      { keys: ["he2016deep", "he2016resnet"], reasons: ["same-title"] },
      // Same key, different papers: its own group, never merged by default.
      { keys: ["he2016deep", "he2016deep"], reasons: ["same-key"] },
    ]);
    expect(r.groups.map((g) => [g.kind, g.defaultChoice === "all"])).toEqual([
      ["duplicates", false],
      ["duplicates", false],
      ["duplicates", false],
      ["same-key", true],
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
    expect(m.removed).toBe(3);
    expect(m.kept).toBe(5);
    expect(m.renames).toEqual([
      { from: "devlin2018bert", to: "devlin2019bert" },
      { from: "krizhevsky2017imagenet", to: "Krizhevsky_2017" },
      { from: "he2016deep", to: "he2016resnet" },
    ]);
    expect(renameMapText(m.renames)).toBe("devlin2018bert -> devlin2019bert\nkrizhevsky2017imagenet -> Krizhevsky_2017\nhe2016deep -> he2016resnet");
    const keys = entriesOf(parseBibtex(m.output)).map((e) => e.key);
    expect(keys).toEqual(["devlin2019bert", "Krizhevsky_2017", "he2016resnet", "he2016deep", "lecun2015deep"]);
    expect(m.output).toContain("Identity mappings in deep residual networks");
  });

  it("honours user choices, including keeping every member", () => {
    const r = findDuplicates(files());
    const [bert, alex, he] = r.groups;
    const m = mergeDuplicates(r, { [bert.id]: bert.members[0].id, [alex.id]: "all", [he.id]: he.members[0].id });
    const keys = entriesOf(parseBibtex(m.output)).map((e) => e.key);
    expect(keys).toEqual(["devlin2018bert", "krizhevsky2017imagenet", "he2016deep", "Krizhevsky_2017", "he2016deep", "lecun2015deep"]);
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

describe("findDuplicates never drops distinct papers by default", () => {
  const keysIn = (r: ReturnType<typeof findDuplicates>) => entriesOf(parseBibtex(mergeDuplicates(r, {}).output)).map((e) => e.key);

  it("does not group numbered parts of a series published in different years", () => {
    const r = findDuplicates([
      {
        name: "x",
        text:
          "@article{p1, title={Deep learning for protein folding: Part I}, year={2019}}\n" +
          "@article{p2, title={Deep learning for protein folding: Part II}, year={2020}}",
      },
    ]);
    expect(r.groups).toEqual([]);
    expect(keysIn(r)).toEqual(["p1", "p2"]);
  });

  it("does not group titles that differ only in a numeral, part or volume", () => {
    const pairs = [
      ["Proceedings of the Conference on Robot Learning 2019", "Proceedings of the Conference on Robot Learning 2020"],
      ["Deep learning for protein folding: Part I", "Deep learning for protein folding: Part II"],
      ["Handbook of statistical methods, Volume A", "Handbook of statistical methods, Volume B"],
      ["The art of computer programming, vol. 3", "The art of computer programming, vol. 4"],
    ];
    for (const [a, b] of pairs) {
      const r = findDuplicates([{ name: "x", text: `@misc{a, title={${a}}}\n@misc{b, title={${b}}}` }]);
      expect(r.groups, `${a} / ${b}`).toEqual([]);
    }
  });

  it("does not group identical titles whose years differ, except arXiv vs published within a year", () => {
    const same = (y1: string, y2: string, arxivFirst = false) =>
      findDuplicates([
        {
          name: "x",
          text:
            `@article{a, title={Attention mechanisms in sequence models}, year={${y1}}${arxivFirst ? ", journal={arXiv preprint arXiv:1234.5678}" : ""}}\n` +
            `@inproceedings{b, title={Attention mechanisms in sequence models}, year={${y2}}, booktitle={ICML}}`,
        },
      ]).groups;
    expect(same("2019", "2020")).toEqual([]);
    expect(same("2019", "2019")).toHaveLength(1);
    expect(same("2019", "")).toHaveLength(1);
    expect(same("2019", "2020", true).map((g) => g.reasons)).toEqual([["arxiv-published"]]);
    expect(same("2017", "2020", true)).toEqual([]);
  });

  it("keeps shared keys apart from title groups and defaults them to keep all", () => {
    const r = findDuplicates([
      { name: "a.bib", text: "@article{smith2020, title={Graph neural networks for chemistry}, year={2020}}" },
      {
        name: "b.bib",
        text:
          "@article{smith2020, title={Reinforcement learning for robot control}, year={2020}, journal={JMLR}}\n" +
          "@article{rl2, title={Reinforcement learning for robot control}, year={2020}, journal={JMLR}, volume={21}}",
      },
    ]);
    const shape = r.groups.map((g) => ({ kind: g.kind, keys: g.members.map((m) => `${m.source}:${m.entry.key}`), reasons: g.reasons, def: g.defaultChoice }));
    expect(shape).toEqual([
      { kind: "same-key", keys: ["a.bib:smith2020", "b.bib:smith2020"], reasons: ["same-key"], def: "all" },
      { kind: "duplicates", keys: ["b.bib:smith2020", "b.bib:rl2"], reasons: ["same-title"], def: 2 },
    ]);
    const out = mergeDuplicates(r, {}).output;
    expect(out).toContain("Graph neural networks for chemistry");
    expect(out).toContain("@article{rl2,");
    expect(keysIn(r)).toEqual(["smith2020", "rl2"]);
  });

  it("does not report a shared key separately when the entries are already grouped as duplicates", () => {
    const r = findDuplicates([
      { name: "a.bib", text: "@article{x1, title={Same paper}, doi={10.1234/abc}}" },
      { name: "b.bib", text: "@article{x1, title={Same paper}, doi={10.1234/abc}, pages={1--2}}" },
    ]);
    expect(r.groups.map((g) => [g.kind, g.reasons])).toEqual([["duplicates", ["doi", "same-title"]]]);
  });

  it("never drops an entry the user explicitly kept in an overlapping group", () => {
    const r = findDuplicates(files());
    const key = r.groups.find((g) => g.kind === "same-key")!;
    const title = r.groups.find((g) => g.members.some((m) => m.entry.key === "he2016resnet"))!;
    const a = key.members[0].id; // he2016deep from a.bib, also in the title group with he2016resnet
    const m = mergeDuplicates(r, { [key.id]: a, [title.id]: title.members.find((x) => x.entry.key === "he2016resnet")!.id });
    const titles = entriesOf(parseBibtex(m.output)).map((e) => getField(e, "title"));
    expect(titles).toContain("Deep residual learning for image recognition");
    expect(titles).not.toContain("Identity mappings in deep residual networks");
  });
});

describe("mergeDuplicates keeps entries the parser could not read", () => {
  it("copies unparseable chunks through unchanged, in their original position", () => {
    const text = "@misc{a, title={Alpha}}\n\n@misc{bad, title={Beta}\n  author={Doe, Jane}}\n\n@misc{c, title={Gamma}}\n";
    const r = findDuplicates([{ name: "x", text }]);
    expect(r.warnings).toHaveLength(1);
    expect(mergeDuplicates(r, {}).output).toBe(text);
  });
});

describe("no false duplicates on real-library patterns", () => {
  const bib = (...entries: string[]) => [{ name: "x.bib", text: entries.join("\n\n") }];
  const grouped = (r: ReturnType<typeof findDuplicates>) => r.groups.filter((g) => g.kind === "duplicates").map((g) => g.members.map((m) => m.entry.key));

  it("keeps \\TeX and \\METAFONT books apart (Beebe texbook1.bib)", () => {
    const r = findDuplicates(
      bib("@book{a, author={Donald E. Knuth}, title={{\\TeX}: The Program}, year=1986}", "@book{b, author={Donald E. Knuth}, title={{\\METAFONT}: The Program}, year=1986}"),
    );
    expect(grouped(r)).toEqual([]);
  });

  it("does not treat the same words in another order as the same title (xampl.bib)", () => {
    const r = findDuplicates(
      bib("@book{whole-set, title={The Art of Computer Programming}, year=1988}", "@booklet{booklet, title={The Programming of Computer Art}, year=1988}"),
    );
    expect(grouped(r)).toEqual([]);
  });

  it("does not merge a shared DOI on unrelated letters by different authors (Beebe cacm1950.bib)", () => {
    const r = findDuplicates(
      bib(
        "@article{Perlis, author={Alan J. Perlis}, title={Letters to the editor}, journal={CACM}, year=1959, doi={10.1145/368325.1064211}}",
        "@article{Bright, author={H. S. Bright}, title={Card Code for {IAL}}, journal={CACM}, year=1959, doi={10.1145/368325.1064211}}",
      ),
    );
    expect(grouped(r)).toEqual([]);
    // Same DOI with a related title is still a duplicate.
    const ok = findDuplicates(
      bib(
        "@article{a, author={H. S. Bright}, title={Standards: Proposed standard flow chart symbols}, year=1959, doi={10.1145/368453.368641}}",
        "@article{b, author={W. Barkley Fritz}, title={Proposed Standard Flow Chart Symbols}, year=1959, doi={10.1145/368453.368641}}",
      ),
    );
    expect(grouped(ok)).toEqual([["a", "b"]]);
  });

  it("does not group equal titles by different authors, even with shared proceedings editors (ACL Anthology)", () => {
    const r = findDuplicates(
      bib(
        "@inproceedings{kay, title={Concluding Remarks}, author={Kay, Martin}, editor={Nagao, Makoto}, booktitle={TINLAP}, year=1987}",
        "@inproceedings{rolling, title={Concluding Remarks}, author={Rolling, Loll}, editor={Nagao, Makoto}, booktitle={TINLAP}, year=1987}",
      ),
    );
    expect(grouped(r)).toEqual([]);
  });

  it("keeps anonymous front matter from different issues apart (ACL Anthology)", () => {
    const r = findDuplicates(
      bib(
        '@article{ad3, title="Advertisements", journal="Computational Linguistics", volume="14", number="3", year="1988", url="https://aclanthology.org/J88-3021/"}',
        '@article{ad4, title="Advertisements", journal="Computational Linguistics", volume="14", number="4", year="1988", url="https://aclanthology.org/J88-4016/"}',
        '@article{br1, title="Book Reviews", journal="Computational Linguistics", volume="13", year="1987", url="https://aclanthology.org/J87-1008/"}',
        '@article{br3, title="Book Reviews", journal="Computational Linguistics", volume="13", year="1987", url="https://aclanthology.org/J87-3010/"}',
        '@book{dec, title="{A}merican Journal of Computational Linguistics ({D}ecember 1977)", year="1977"}',
        '@book{sep, title="{A}merican Journal of Computational Linguistics ({S}eptember 1977)", year="1977"}',
      ),
    );
    expect(grouped(r)).toEqual([]);
  });

  it("still pairs an arXiv preprint with its published version", () => {
    const r = findDuplicates(
      bib(
        "@article{he2015, author={He, Kaiming and Zhang, Xiangyu}, title={Deep residual learning for image recognition}, journal={arXiv preprint arXiv:1512.03385}, year={2015}}",
        "@inproceedings{he2016, author={Kaiming He and Xiangyu Zhang}, title={Deep Residual Learning for Image Recognition}, booktitle={CVPR}, pages={770--778}, year={2016}}",
      ),
    );
    expect(r.groups.map((g) => g.reasons)).toEqual([["arxiv-published"]]);
  });

  it("suggests the complete record over a title-and-URL stub (awesome-o1.bib)", () => {
    const r = findDuplicates(
      bib(
        '@MISC{stub, title="Generative Verifiers: Reward Modeling as Next-Token Prediction", howpublished="\\url{https://arxiv.org/html/2408.15240v1}"}',
        '@ARTICLE{Zhang2024, title="Generative verifiers: Reward modeling as next-token prediction", author="Zhang, Lunjun and Hosseini, Arian", journal="arXiv [cs.LG]", year=2024}',
      ),
    );
    expect(r.groups).toHaveLength(1);
    expect(r.candidates[r.groups[0].suggested].entry.key).toBe("Zhang2024");
    expect(r.groups[0].reasons).toEqual(["same-title"]); // both are preprints
  });
});
