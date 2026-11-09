# @paperkit/bibtex

A tolerant BibTeX parser and serializer, plus the cleaning, duplicate-detection and DOI/arXiv-to-BibTeX logic used by PaperKit. No dependencies, and no DOM: it runs in Node 18+ and in any modern browser.

## Install

```sh
npm install @paperkit/bibtex
```

## Usage

```js
import { parseBibtex, entriesOf, getField, cleanBibtex, findDuplicates, parseIdentifier } from "@paperkit/bibtex";

const src = `@article{vaswani2017,
  title = {Attention is All you Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  journal = {NeurIPS}, year = 2017, pages = {5998-6008}
}`;

const [entry] = entriesOf(parseBibtex(src));
console.log(getField(entry, "title")); // "Attention is All you Need"

const { output, stats } = cleanBibtex(src);
console.log(stats.entries, output.includes("5998--6008")); // 1 true

const dupes = findDuplicates([
  { name: "a.bib", text: src },
  { name: "b.bib", text: src.replace("vaswani2017", "attention") },
]);
console.log(dupes.groups.length); // 1

console.log(parseIdentifier("https://arxiv.org/abs/1706.03762v7")); // { kind: "arxiv", id: "1706.03762", version: "v7" }
```

Network lookups never use a global: pass your own `fetch` (or a mock):

```ts
import { parseInput, resolveAll, combine } from "@paperkit/bibtex";

const results = await resolveAll(parseInput("10.1145/3065386\n1706.03762"), { fetch: (url, init) => fetch(url, init) });
console.log(combine(results).output);
```

## API

- **Parse / serialize:** `parseBibtex`, `entriesOf`, `serializeBibtex`, `serializeEntry`, `serializeItem`, `serializeValue`. Keeps `@string`, `@preamble`, comments and parse warnings.
- **Fields and text:** `getField`, `setField`, `hasField`, `valueText`, `plainText`, `yearOf`, `normalizeDoi`, `isArxivEntry`, `monthMacro`, `MONTHS`, `splitTopLevel`, `splitNames`.
- **Names:** `parseName`, `formatName`, `normalizeNameList`.
- **Similarity:** `normalizeTitle`, `titleSimilarity`, `titleSimilarityAtLeast`, `tokenJaccard`, `levenshtein`, `levenshteinRatio`, `levenshteinBounded`.
- **Cleaning:** `cleanBibtex`, `cleanItems`, `defaultCleanOptions`, `FIELD_ORDER`, `fixPageRange`, `protectCapitals`, `makeKey`.
- **Duplicates:** `findDuplicates`, `suggestKeep`, `mergeDuplicates`, `renameMapText`, `reasonLabel`.
- **DOI / arXiv lookup:** `parseIdentifier`, `parseInput`, `fetchDoi`, `fetchArxivBatch`, `fetchArxivViaDoi`, `parseArxivAtom`, `fixCrossrefText`, `resolveAll`, `combine`, `doiCleanOptions`, `LookupError`. Every fetching function takes an injectable `FetchLike`.

## Part of PaperKit

This package is one of the open-source engines behind **[PaperKit](https://paperkit.pages.dev)** — free research paper tools that run in your browser. Everything runs locally: no uploads, no server round-trips.

Source, issues and the other engines: [kevnantony/paperkit-engines](https://github.com/kevnantony/paperkit-engines).

## License

MIT © 2026 Kevin Antony
