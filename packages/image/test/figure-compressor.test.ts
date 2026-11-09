import { describe, expect, it } from "vitest";
import { fitWithin, mimeOf, outputMime, outputName, percentSaved, searchQuality } from "../src";

describe("sizing and naming", () => {
  it("fits within a max dimension without upscaling", () => {
    expect(fitWithin(4000, 2000, 1000)).toEqual({ width: 1000, height: 500, scaled: true });
    expect(fitWithin(800, 600, 1000)).toEqual({ width: 800, height: 600, scaled: false });
    expect(fitWithin(800, 600, 0)).toEqual({ width: 800, height: 600, scaled: false });
    expect(fitWithin(3, 3000, 100)).toEqual({ width: 1, height: 100, scaled: true });
  });

  it("chooses output mime", () => {
    expect(outputMime("image/png", "keep")).toBe("image/png");
    expect(outputMime("image/jpeg", "keep")).toBe("image/jpeg");
    expect(outputMime("image/png", "jpeg")).toBe("image/jpeg");
    expect(outputMime("image/jpeg", "webp")).toBe("image/webp");
  });

  it("renames extensions", () => {
    expect(outputName("fig.v2.png", "image/jpeg")).toBe("fig.v2.jpg");
    expect(outputName("plot", "image/webp")).toBe("plot.webp");
    expect(outputName("a.pdf", "application/pdf")).toBe("a.pdf");
  });

  it("infers mime from extension", () => {
    expect(mimeOf("", "X.JPEG")).toBe("image/jpeg");
    expect(mimeOf("image/png", "x.jpg")).toBe("image/png");
  });

  it("computes percent saved", () => {
    expect(percentSaved(200, 50)).toBe(75);
    expect(percentSaved(100, 120)).toBe(-20);
    expect(percentSaved(0, 10)).toBe(0);
  });
});

describe("searchQuality", () => {
  // Fake encoder: size grows linearly with quality.
  const encoder = (calls: number[]) => async (q: number) => {
    calls.push(q);
    return Math.round(1000 + q * 9000);
  };

  it("returns max quality when it already fits", async () => {
    const r = await searchQuality(encoder([]), 50_000);
    expect(r).toMatchObject({ quality: 0.95, reachedTarget: true, steps: 1 });
  });

  it("finds the highest quality under the target", async () => {
    const calls: number[] = [];
    const r = await searchQuality(encoder(calls), 5000, { iterations: 10 });
    expect(r.reachedTarget).toBe(true);
    expect(r.size).toBeLessThanOrEqual(5000);
    expect(r.quality).toBeGreaterThan(0.43);
    expect(r.quality).toBeLessThanOrEqual(4000 / 9000);
    expect(calls).toHaveLength(12);
  });

  it("reports when the target is unreachable", async () => {
    const r = await searchQuality(encoder([]), 500);
    expect(r).toMatchObject({ quality: 0.05, reachedTarget: false });
  });
});
