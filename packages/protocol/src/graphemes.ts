let segmenter: Intl.Segmenter | null = null;

function getSegmenter(): Intl.Segmenter {
  if (!segmenter) {
    segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  }
  return segmenter;
}

export function graphemeCount(text: string): number {
  let n = 0;
  for (const _ of getSegmenter().segment(text)) n += 1;
  return n;
}

export function assertGraphemeLimit(text: string, limit: number): void {
  if (graphemeCount(text) > limit) {
    const err = new Error("BODY_TOO_LONG");
    (err as Error & { code: string }).code = "BODY_TOO_LONG";
    throw err;
  }
}
