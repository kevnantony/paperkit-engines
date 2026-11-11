import { describe, expect, it } from "vitest";
import { plainText, titleSimilarity } from "../src";
import { findDuplicates } from "../src";

// Reviewer feedback: the title normaliser must not drop non-Latin scripts (Ethiopic, CJK, Cyrillic, …),
// otherwise two different non-Latin titles both normalise to "" and look identical.
const TITLES: Record<string, [string, string]> = {
  ethiopic: ["የኢትዮጵያ ታሪክ", "የአማርኛ ሰዋሰው"],
  chinese: ["深度学习的数学基础", "自然语言处理导论"],
  japanese: ["機械学習入門", "量子コンピュータの基礎"],
  cyrillic: ["Теория вероятностей", "Линейная алгебра"],
  greek: ["Εισαγωγή στη θεωρία", "Αριθμητική ανάλυση"],
  arabic: ["مقدمة في الخوارزميات", "تعلم الآلة"],
  devanagari: ["संगणक विज्ञान", "गणित का इतिहास"],
};

describe("non-Latin titles", () => {
  for (const [script, [a, b]] of Object.entries(TITLES)) {
    it(`${script}: keeps the characters`, () => {
      expect(plainText(a).replace(/\s/g, "").length).toBeGreaterThan(0);
      expect(plainText(`{${a}}: A Study`)).toContain("a study");
    });
    it(`${script}: different titles are not similar, identical ones are`, () => {
      expect(titleSimilarity(a, b)).toBeLessThan(0.5);
      expect(titleSimilarity(a, a)).toBe(1);
    });
    it(`${script}: duplicate finder groups only real duplicates`, () => {
      const bib = `@book{x1, title={${a}}, author={Author, A.}, year={2020}}
@book{x2, title={${b}}, author={Author, A.}, year={2020}}
@book{x3, title={${a}}, author={Author, A.}, year={2020}, publisher={P}}`;
      const res = findDuplicates([{ name: "t.bib", text: bib }]);
      const groups = res.groups.map((g) => g.members.map((m) => m.entry.key).sort());
      expect(groups).toContainEqual(["x1", "x3"]);
      expect(groups.flat()).not.toContain("x2");
    });
  }
});

describe("short-title rule", () => {
  it("counts CJK characters as dense, but still ignores short Latin titles", async () => {
    const { titleWeight } = await import("../src");
    expect(titleWeight("reviews")).toBeLessThan(8);
    expect(titleWeight("機械学習入門")).toBeGreaterThanOrEqual(8);
    expect(titleWeight("양자 컴퓨팅")).toBeGreaterThanOrEqual(8);
  });
});
