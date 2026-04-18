import crypto from "crypto";

export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function normalizeHtml(html: string): string {
  let normalized = html;

  normalized = normalized.replace(/<script[\s\S]*?<\/script>/gi, "");

  normalized = normalized.replace(/<style[\s\S]*?<\/style>/gi, "");

  normalized = normalized.replace(/<!--[\s\S]*?-->/g, "");

  normalized = normalized.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  normalized = normalized.replace(
    /\b(data-reactid|data-react-checksum|data-v-[a-f0-9]+|data-testid|data-cy)\s*=\s*"[^"]*"/gi,
    "",
  );

  // ISO 8601: 2026-04-16T16:52:44.123Z
  normalized = normalized.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ+-]*/g, "TIMESTAMP");

  // ISO date alone: 2026-04-16
  normalized = normalized.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "DATE");

  // asctime / Java Date.toString(): "Thu Apr 16 16:52:44 WEST 2026"
  normalized = normalized.replace(
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\s+[A-Z]{2,5})?\s+\d{4}\b/g,
    "TIMESTAMP",
  );

  // RFC 1123 / HTTP-date: "Thu, 16 Apr 2026 16:52:44 GMT"
  normalized = normalized.replace(
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}(?:\s+[A-Z]{2,5})?\b/g,
    "TIMESTAMP",
  );

  // Slash/dash dates: 16/04/2026, 04-16-2026, 2026/04/16
  normalized = normalized.replace(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g, "DATE");
  normalized = normalized.replace(/\b\d{4}\/\d{1,2}\/\d{1,2}\b/g, "DATE");

  // Standalone clock times: 14:23, 14:23:45, with optional AM/PM
  normalized = normalized.replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?\b/g, "TIME");

  // Unix epoch (seconds or ms)
  normalized = normalized.replace(/\b\d{10,13}\b/g, "EPOCH");

  normalized = normalized.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "UUID",
  );

  normalized = normalized.replace(/\bcsrf[_-]?token\s*[=:]\s*["'][^"']*["']/gi, "CSRF_TOKEN");

  normalized = normalized.replace(/\bnonce\s*=\s*["'][^"']*["']/gi, 'nonce="NONCE"');

  normalized = normalized.replace(/\s+/g, " ");
  normalized = normalized.trim();

  return normalized;
}

export function hasContentChanged(
  previousHtml: string,
  currentHtml: string,
): { changed: boolean; previousHash: string; currentHash: string } {
  const normalizedPrev = normalizeHtml(previousHtml);
  const normalizedCurr = normalizeHtml(currentHtml);

  const previousHash = computeHash(normalizedPrev);
  const currentHash = computeHash(normalizedCurr);

  return {
    changed: previousHash !== currentHash,
    previousHash,
    currentHash,
  };
}
