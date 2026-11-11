import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { entriesOf, getField, normalizeNameList, parseBibtex } from "../src";
import {
  combine,
  fetchDoi,
  fixCrossrefText,
  parseArxivAtom,
  parseIdentifier,
  parseInput,
  resolveAll,
  type FetchLike,
} from "../src";

const fx = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

type Route = (url: string, init?: { headers?: Record<string, string> }) => { status: number; body: string } | "network-error";
function mockFetch(route: Route) {
  return vi.fn<FetchLike>(async (url, init) => {
    const r = route(url, init);
    if (r === "network-error") throw new TypeError("Failed to fetch");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
  });
}

describe("parseIdentifier", () => {
  it.each([
    ["10.1145/3065386", { kind: "doi", id: "10.1145/3065386" }],
    ["doi:10.18653/v1/N19-1423", { kind: "doi", id: "10.18653/v1/N19-1423" }],
    ["https://doi.org/10.1038/nature14539.", { kind: "doi", id: "10.1038/nature14539" }],
    ["https://dx.doi.org/10.1000/a%2Fb", { kind: "doi", id: "10.1000/a/b" }],
    ["2101.00001", { kind: "arxiv", id: "2101.00001", version: undefined }],
    ["arXiv:2101.00001v2", { kind: "arxiv", id: "2101.00001", version: "v2" }],
    ["https://arxiv.org/abs/1706.03762v7", { kind: "arxiv", id: "1706.03762", version: "v7" }],
    ["https://arxiv.org/pdf/1706.03762.pdf", { kind: "arxiv", id: "1706.03762", version: undefined }],
    ["hep-th/9901001", { kind: "arxiv", id: "hep-th/9901001", version: undefined }],
    // The subject class is not part of an old-style ID: the arXiv API only knows "math/0309136".
    ["arxiv.org/abs/math.GT/0309136", { kind: "arxiv", id: "math/0309136", version: undefined }],
    ["math.GT/0309136v2", { kind: "arxiv", id: "math/0309136", version: "v2" }],
    ["HEP-TH/9901001", { kind: "arxiv", id: "hep-th/9901001", version: undefined }],
    ["arXiv:1706.03762.", { kind: "arxiv", id: "1706.03762", version: undefined }],
    ["10.48550/arXiv.hep-th/9901001", { kind: "arxiv", id: "hep-th/9901001", version: undefined }],
    ["10.48550/arXiv.2101.00001", { kind: "arxiv", id: "2101.00001", version: undefined }],
  ])("recognizes %s", (input, expected) => {
    expect(parseIdentifier(input)).toEqual(expected);
  });

  it("rejects titles and junk", () => {
    expect(parseIdentifier("Attention is all you need")).toBeNull();
    expect(parseIdentifier("12345")).toBeNull();
  });

  it("parses input lines, skipping blanks and comments", () => {
    const lines = parseInput("10.1145/3065386\n\n# comment\n  2101.00001  \nnot an id\n");
    expect(lines.map((l) => [l.line, l.ident?.kind ?? l.error])).toEqual([
      [1, "doi"],
      [4, "arxiv"],
      [5, "Not a DOI or arXiv ID"],
    ]);
  });
});

describe("network lookups (mocked fetch)", () => {
  it("fetches DOIs via content negotiation and decodes Crossref quirks", async () => {
    const fetch = mockFetch((url, init) => {
      expect(url).toBe("https://doi.org/10.1145/3292500.3330701");
      expect(init?.headers?.Accept).toMatch(/application\/x-bibtex/);
      return { status: 200, body: fx("crossref-optuna.bib") };
    });
    const e = await fetchDoi("10.1145/3292500.3330701", fetch);
    expect(e.key).toBe("Akiba_2019");
    expect(getField(e, "booktitle")).toContain("Knowledge Discovery \\& Data Mining");
    expect(fixCrossrefText("<i>E. coli</i> &amp; <sub>2</sub>")).toBe("E. coli \\& 2");
  });

  it("parses the arXiv Atom feed into BibTeX entries", () => {
    const recs = parseArxivAtom(fx("arxiv-atom.xml"));
    expect(recs.map((r) => r.id)).toEqual(["1706.03762", "1810.04805"]);
    const e = recs[0].entry;
    expect(getField(e, "title")).toBe("Attention Is All You Need");
    expect(getField(e, "author")).toMatch(/^Ashish Vaswani and Noam Shazeer and /);
    expect(getField(e, "year")).toBe("2017");
    expect(getField(e, "eprint")).toBe("1706.03762");
    expect(getField(e, "primaryclass")).toBe("cs.CL");
    expect(parseArxivAtom("<feed><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title></entry></feed>")).toEqual([]);
  });

  it("resolves a mixed list, reporting per-line status", async () => {
    const fetch = mockFetch((url) => {
      if (url.startsWith("https://export.arxiv.org/api/query")) {
        expect(url).toContain("id_list=1706.03762,2101.99999");
        return { status: 200, body: fx("arxiv-atom.xml") };
      }
      if (url === "https://doi.org/10.1145/3292500.3330701") return { status: 200, body: fx("crossref-optuna.bib") };
      if (url === "https://doi.org/10.9999/missing") return { status: 404, body: "" };
      if (url === "https://doi.org/10.5555/down") return { status: 503, body: "" };
      return "network-error";
    });
    const progress: number[] = [];
    const results = await resolveAll(
      parseInput("10.1145/3292500.3330701\narXiv:1706.03762v2\n2101.99999\n10.9999/missing\nhello\n10.5555/down\n10.1145/3292500.3330701"),
      { fetch, onProgress: (d) => progress.push(d), retry: { sleep: async () => {} } },
    );
    expect(results.map((r) => [r.line, r.status, r.message])).toEqual([
      [1, "ok", "doi.org"],
      [2, "ok", "arXiv API"],
      [3, "failed", "arXiv ID not found"],
      [4, "failed", "DOI not found"],
      [5, "failed", "Not a DOI or arXiv ID"],
      [6, "failed", "doi.org answered HTTP 503"],
      [7, "ok", "doi.org"],
    ]);
    expect(progress.at(-1)).toBe(6);
    // the duplicated DOI is only fetched once
    expect(fetch.mock.calls.filter(([u]) => u.includes("3292500")).length).toBe(1);

    const { output, count } = combine(results);
    expect(count).toBe(2);
    const keys = entriesOf(parseBibtex(output)).map((e) => e.key);
    expect(keys).toEqual(["akiba2019optuna", "vaswani2017attention"]);
    expect(output).toContain("month = jul,");
    expect(output).toContain("pages = {2623--2631},");
    expect(output).toContain("title = {Optuna: A Next-generation Hyperparameter Optimization Framework},");
    expect(output).not.toContain("url = {http://dx.doi.org");
  });

  it("falls back to the arXiv DataCite DOI when the arXiv API is blocked (CORS)", async () => {
    const fetch = mockFetch((url) => {
      if (url.startsWith("https://export.arxiv.org")) return "network-error";
      if (url === "https://doi.org/10.48550/arXiv.1706.03762") return { status: 200, body: fx("datacite-arxiv.bib") };
      if (url === "https://doi.org/10.48550/arXiv.2101.99999") return { status: 404, body: "" };
      return "network-error";
    });
    const results = await resolveAll(parseInput("1706.03762\n2101.99999"), { fetch });
    expect(results.map((r) => [r.status, r.message])).toEqual([
      ["ok", "DataCite DOI"],
      ["failed", "arXiv ID not found"],
    ]);
    const { output } = combine(results);
    const [e] = entriesOf(parseBibtex(output));
    expect(e.key).toBe("vaswani2017attention");
    expect(getField(e, "eprint")).toBe("1706.03762");
    expect(getField(e, "keywords")).toBeUndefined();
    expect(getField(e, "copyright")).toBeUndefined();
  });

  it("reports a clear error when both arXiv routes are unreachable", async () => {
    const fetch = mockFetch(() => "network-error");
    const results = await resolveAll(parseInput("1706.03762\n10.1145/3065386"), { fetch });
    expect(results.map((r) => r.message)).toEqual(["arXiv lookup blocked or offline", "Network error: check your connection"]);
    expect(combine(results)).toEqual({ output: "", count: 0 });
  });

  it("only sends identifiers over the network", async () => {
    const fetch = mockFetch(() => ({ status: 404, body: "" }));
    await resolveAll(parseInput("10.1/abc\n2101.00001"), { fetch });
    for (const [url] of fetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/(doi\.org\/10\.|export\.arxiv\.org\/api\/query\?id_list=)/);
    }
  });
});

describe("rate limiting (doi.org / Crossref answer 429 to bursts)", () => {
  const ok = { status: 200, body: "@article{K_2020, title={T}, author={Doe, Jane}, year={2020}}" };
  const noWait = { delays: [1, 1, 1], sleep: async () => {} };

  it("retries a 429 and succeeds", async () => {
    let n = 0;
    const fetch = mockFetch(() => (++n < 3 ? { status: 429, body: "" } : ok));
    const [r] = await resolveAll(parseInput("10.1000/a"), { fetch, retry: noWait });
    expect(r.status).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last retry with a clear message", async () => {
    const fetch = mockFetch(() => ({ status: 429, body: "" }));
    const [r] = await resolveAll(parseInput("10.1000/a"), { fetch, retry: noWait });
    expect(r).toMatchObject({ status: "failed", message: "Too many requests to doi.org: wait a minute and try again" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry a 404", async () => {
    const fetch = mockFetch(() => ({ status: 404, body: "" }));
    const [r] = await resolveAll(parseInput("10.1000/a"), { fetch, retry: noWait });
    expect(r.message).toBe("DOI not found");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the user cancels", async () => {
    const fetch = mockFetch(() => ({ status: 429, body: "" }));
    const ctrl = new AbortController();
    const p = fetchDoi("10.1/a", fetch, ctrl.signal, { delays: [60_000] });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps a DataCite corporate author with a trailing comma together", () => {
    // doi.org/10.5281/zenodo.3509134 returns: author = {The pandas development team, }
    expect(normalizeNameList("The pandas development team, ")).toBe("{The pandas development team}");
    expect(normalizeNameList("Smith, ")).toBe("Smith");
  });
});

describe("arXiv Atom edge cases", () => {
  const atom = (title: string, names: string[]) =>
    `<feed><entry><id>http://arxiv.org/abs/2001.00001v1</id><published>2020-01-01T00:00:00Z</published><title>${title}</title>${names
      .map((n) => `<author><name>${n}</name></author>`)
      .join("")}</entry></feed>`;

  it("does not escape inside math, but still escapes text specials", () => {
    const [r] = parseArxivAtom(atom("Sparse $\\ell_1$ recovery for 100% of A&amp;B_c", ["Ann Lee"]));
    expect(getField(r.entry, "title")).toBe("Sparse $\\ell_1$ recovery for 100\\% of A\\&B\\_c");
  });

  it("emits names BibTeX can parse, keeping von particles and suffixes", () => {
    const [r] = parseArxivAtom(atom("T", ["Jean-Pierre van der Berg", "John Smith Jr.", "Plato"]));
    const authors = getField(r.entry, "author")!;
    expect(authors).toBe("Jean-Pierre van der Berg and John Smith Jr. and Plato");
    expect(normalizeNameList(authors)).toBe("van der Berg, Jean-Pierre and Smith, Jr., John and Plato");
  });
});
