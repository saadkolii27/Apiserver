import * as diffLib from "diff";
import { PNG } from "pngjs";
import _pixelmatch from "pixelmatch";
import fs from "fs";
import path from "path";
import { normalizeHtml, hasContentChanged } from "./contentHash";
import { logger } from "./logger";

const pixelmatch = typeof _pixelmatch === "function" ? _pixelmatch : (_pixelmatch as any).default;

const SCREENSHOTS_DIR = path.join(process.cwd(), "screenshots");

export interface HtmlDiffResult {
  hasChanged: boolean;
  diff: string;
  hashChanged: boolean;
}

export interface VisualDiffResult {
  diffScore: number;
  diffImagePath: string | null;
}

export function compareHtml(oldHtml: string, newHtml: string): HtmlDiffResult {
  const { changed: hashChanged } = hasContentChanged(oldHtml, newHtml);

  if (!hashChanged) {
    return { hasChanged: false, diff: "", hashChanged: false };
  }

  const normalizedOld = normalizeHtml(oldHtml);
  const normalizedNew = normalizeHtml(newHtml);

  const patch = diffLib.createPatch("content", normalizedOld, normalizedNew, "previous", "current");

  const lines = patch.split("\n");
  let realChanges = 0;
  for (const line of lines) {
    if ((line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---"))) {
      realChanges++;
    }
  }

  return {
    hasChanged: realChanges > 0,
    diff: realChanges > 0 ? patch : "",
    hashChanged,
  };
}

export function compareScreenshots(
  oldPath: string,
  newPath: string,
): VisualDiffResult {
  const oldAbs = path.join(process.cwd(), "screenshots", path.basename(oldPath));
  const newAbs = path.join(process.cwd(), "screenshots", path.basename(newPath));

  if (!fs.existsSync(oldAbs) || !fs.existsSync(newAbs)) {
    return { diffScore: 0, diffImagePath: null };
  }

  try {
    const img1 = PNG.sync.read(fs.readFileSync(oldAbs));
    const img2 = PNG.sync.read(fs.readFileSync(newAbs));

    const w = Math.min(img1.width, img2.width);
    const h = Math.min(img1.height, img2.height);
    if (w === 0 || h === 0) {
      return { diffScore: 1, diffImagePath: null };
    }
    const diff = new PNG({ width: w, height: h });

    const cropToCommon = (src: PNG): Buffer => {
      if (src.width === w && src.height === h) return src.data;
      const out = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) {
        const srcStart = (y * src.width) * 4;
        const dstStart = (y * w) * 4;
        src.data.copy(out, dstStart, srcStart, srcStart + w * 4);
      }
      return out;
    };

    const buf1 = cropToCommon(img1);
    const buf2 = cropToCommon(img2);

    const numDiff = pixelmatch(buf1, buf2, diff.data, w, h, { threshold: 0.1 });
    const widthDelta = Math.abs(img1.width - img2.width) / Math.max(img1.width, img2.width);
    const heightDelta = Math.abs(img1.height - img2.height) / Math.max(img1.height, img2.height);
    const sizeMismatchPenalty = (widthDelta + heightDelta) / 2;
    const score = Math.min(1, numDiff / (w * h) + sizeMismatchPenalty);

    const timestamp = Date.now();
    const diffFile = `diff_${timestamp}.png`;
    const diffAbs = path.join(SCREENSHOTS_DIR, diffFile);

    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    fs.writeFileSync(diffAbs, PNG.sync.write(diff));

    return { diffScore: score, diffImagePath: `/screenshots/${diffFile}` };
  } catch (err) {
    // Treat comparison failures as "unknown" — return a small non-zero score
    // so failures don't silently mask real changes, but don't trigger a false
    // positive change notification on transient errors either.
    logger.warn({ err }, "In-process screenshot comparison failed");
    return { diffScore: 0.0, diffImagePath: null };
  }
}
