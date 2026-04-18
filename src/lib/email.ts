import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { logger } from "./logger";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT ?? "587");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM ?? "WebMonitor <noreply@webmonitor.app>";

const SCREENSHOTS_DIR = path.join(process.cwd(), "screenshots");

function getTransporter() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

function getAppBaseUrl(): string {
  const domains = process.env.REPLIT_DOMAINS ?? process.env.REPLIT_DEV_DOMAIN ?? "";
  const first = domains.split(",")[0]?.trim();
  if (first) return `https://${first}`;
  return "http://localhost:8080";
}

function buildInlineImage(screenshotRelPath: string | null, cid: string): nodemailer.Attachment | null {
  if (!screenshotRelPath) return null;
  const filename = path.basename(screenshotRelPath);
  const abs = path.join(SCREENSHOTS_DIR, filename);
  if (!fs.existsSync(abs)) return null;
  return {
    filename,
    path: abs,
    cid,
    contentDisposition: "inline",
  };
}

function parseDiffSummary(htmlDiff: string | null): {
  added: number;
  removed: number;
  previewLines: { type: "added" | "removed"; text: string }[];
} {
  if (!htmlDiff) return { added: 0, removed: 0, previewLines: [] };

  const lines = htmlDiff.split("\n");
  let added = 0;
  let removed = 0;
  const previewLines: { type: "added" | "removed"; text: string }[] = [];

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
      if (previewLines.length < 8) {
        previewLines.push({ type: "added", text: line.slice(1).trim() });
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
      if (previewLines.length < 8) {
        previewLines.push({ type: "removed", text: line.slice(1).trim() });
      }
    }
  }

  return { added, removed, previewLines };
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(opts: {
  monitorName: string;
  url: string;
  monitorType: string;
  diffScore: number | null;
  checkedAt: Date;
  monitorId: number | null;
  htmlDiff: string | null;
  hasBefore: boolean;
  hasAfter: boolean;
  hasDiff: boolean;
  changeCount: number;
}): string {
  const {
    monitorName, url, monitorType, diffScore, checkedAt,
    monitorId, htmlDiff, hasBefore, hasAfter, hasDiff, changeCount,
  } = opts;

  const appUrl = getAppBaseUrl();
  const diffUrl = monitorId ? `${appUrl}/monitors/${monitorId}` : appUrl;

  const scorePercent = diffScore != null ? (diffScore * 100).toFixed(2) : null;
  const scoreBadgeColor = diffScore == null ? "#6b7280"
    : diffScore < 0.05 ? "#f59e0b"
    : diffScore < 0.20 ? "#f97316"
    : "#ef4444";

  const { added, removed, previewLines } = parseDiffSummary(htmlDiff);

  const typeLabel: Record<string, string> = {
    html: "HTML content",
    visual: "Visual screenshot",
    both: "HTML + Visual",
  };

  const checkedAtLocal = checkedAt.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });

  const screenshotBlocks: string[] = [];
  if (hasBefore) screenshotBlocks.push(`
    <td style="vertical-align:top;${hasBefore && hasAfter ? "padding-right:6px;" : ""}">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:#f1f5f9;border-radius:6px 6px 0 0;padding:6px 10px;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">Before</td></tr>
        <tr><td><img src="cid:before_screenshot" alt="Before" style="width:100%;display:block;border-radius:0 0 6px 6px;" /></td></tr>
      </table>
    </td>`);
  if (hasAfter) screenshotBlocks.push(`
    <td style="vertical-align:top;${hasAfter && hasDiff ? "padding-right:6px;" : ""}">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:#f1f5f9;border-radius:6px 6px 0 0;padding:6px 10px;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">After</td></tr>
        <tr><td><img src="cid:after_screenshot" alt="After" style="width:100%;display:block;border-radius:0 0 6px 6px;" /></td></tr>
      </table>
    </td>`);
  if (hasDiff) screenshotBlocks.push(`
    <td style="vertical-align:top;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:#fef2f2;border-radius:6px 6px 0 0;padding:6px 10px;font-size:10px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:.08em;">Diff</td></tr>
        <tr><td><img src="cid:diff_screenshot" alt="Diff" style="width:100%;display:block;border-radius:0 0 6px 6px;" /></td></tr>
      </table>
    </td>`);

  const screenshotSection = screenshotBlocks.length > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>${screenshotBlocks.join("")}</tr>
    </table>` : "";

  const diffRows = previewLines.slice(0, 6).map(l => `
    <tr>
      <td style="padding:0 0 0 0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="28" style="padding:5px 0;text-align:center;font-family:Menlo,Consolas,monospace;font-size:11px;font-weight:700;color:${l.type === "added" ? "#16a34a" : "#dc2626"};">${l.type === "added" ? "+" : "&minus;"}</td>
            <td style="padding:5px 10px;font-family:Menlo,Consolas,monospace;font-size:11px;color:#334155;background:${l.type === "added" ? "#f0fdf4" : "#fef2f2"};border-bottom:1px solid ${l.type === "added" ? "#dcfce7" : "#fecaca"};word-break:break-all;">${esc(l.text.slice(0, 180))}</td>
          </tr>
        </table>
      </td>
    </tr>`).join("");

  const htmlDiffSection = (added > 0 || removed > 0) ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding:14px 16px;background:#f0fdf4;border-radius:8px 0 0 8px;text-align:center;border-right:1px solid #e2e8f0;">
          <span style="font-size:20px;font-weight:800;color:#16a34a;">+${added}</span>
          <br/><span style="font-size:10px;font-weight:600;color:#15803d;text-transform:uppercase;letter-spacing:.06em;">added</span>
        </td>
        <td style="padding:14px 16px;background:#fef2f2;border-radius:0 8px 8px 0;text-align:center;">
          <span style="font-size:20px;font-weight:800;color:#dc2626;">&minus;${removed}</span>
          <br/><span style="font-size:10px;font-weight:600;color:#b91c1c;text-transform:uppercase;letter-spacing:.06em;">removed</span>
        </td>
      </tr>
    </table>
    ${diffRows ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:24px;">
      ${diffRows}
    </table>` : ""}` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Change detected — ${esc(monitorName)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">

<div style="display:none;max-height:0;overflow:hidden;color:#fff;">
  ${esc(monitorName)}: ${scorePercent != null ? scorePercent + "% visual change" : "content modified"} detected ${checkedAtLocal}
</div>

<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr>
    <td align="center" style="padding:0;">

      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="height:4px;background:linear-gradient(90deg,#3b82f6,#8b5cf6,#3b82f6);font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>

      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;padding:0 20px;">

        <tr>
          <td style="padding:32px 0 24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:middle;">
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="width:32px;height:32px;background:#3b82f6;border-radius:8px;text-align:center;vertical-align:middle;font-size:16px;color:#fff;">&#9673;</td>
                      <td style="padding-left:10px;font-size:15px;font-weight:700;color:#0f172a;letter-spacing:-.01em;">WebMonitor</td>
                    </tr>
                  </table>
                </td>
                <td align="right" style="vertical-align:middle;">
                  <span style="font-size:12px;color:#94a3b8;">${esc(checkedAtLocal)}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:0 0 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
              <tr>
                <td style="padding:20px 24px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td width="44" style="vertical-align:top;">
                        <table cellpadding="0" cellspacing="0">
                          <tr>
                            <td style="width:40px;height:40px;background:#eff6ff;border:1px solid #dbeafe;border-radius:10px;text-align:center;vertical-align:middle;">
                              <span style="font-size:20px;">&#128269;</span>
                            </td>
                          </tr>
                        </table>
                      </td>
                      <td style="padding-left:14px;vertical-align:top;">
                        <p style="margin:0 0 2px;font-size:16px;font-weight:700;color:#0f172a;line-height:1.3;">Change Detected</p>
                        <p style="margin:0;font-size:13px;color:#64748b;line-height:1.4;">${esc(monitorName)}${scorePercent != null ? ` &mdash; <strong style="color:${scoreBadgeColor};">${scorePercent}%</strong> pixels changed` : ""}</p>
                      </td>
                      <td align="right" style="vertical-align:top;white-space:nowrap;padding-left:12px;">
                        <span style="display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;color:#64748b;">Change #${changeCount}</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:0 0 24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="50%" style="vertical-align:top;padding-right:10px;">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;">URL</p>
                  <a href="${esc(url)}" style="font-size:13px;color:#3b82f6;text-decoration:none;word-break:break-all;line-height:1.4;">${esc(url)}</a>
                </td>
                <td width="25%" style="vertical-align:top;padding-right:10px;">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;">Type</p>
                  <p style="margin:0;font-size:13px;color:#334155;">${esc(typeLabel[monitorType] ?? monitorType)}</p>
                </td>
                <td width="25%" style="vertical-align:top;">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;">Status</p>
                  <p style="margin:0;font-size:13px;color:#334155;">Changed</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr><td style="padding:0 0 24px;"><table width="100%"><tr><td style="height:1px;background:#f1f5f9;font-size:0;">&nbsp;</td></tr></table></td></tr>

        ${screenshotSection ? `<tr><td style="padding:0 0 0;">${screenshotSection}</td></tr>` : ""}
        ${htmlDiffSection ? `<tr><td style="padding:0 0 0;">${htmlDiffSection}</td></tr>` : ""}

        <tr>
          <td style="padding:0 0 32px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center">
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="border-radius:8px;background:#0f172a;">
                        <a href="${esc(diffUrl)}" style="display:inline-block;padding:12px 32px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:-.01em;">
                          View Details &rarr;
                        </a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr><td><table width="100%"><tr><td style="height:1px;background:#f1f5f9;font-size:0;">&nbsp;</td></tr></table></td></tr>

        <tr>
          <td style="padding:20px 0 32px;text-align:center;">
            <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;line-height:1.5;">
              You received this from <strong style="color:#64748b;">WebMonitor</strong> because email alerts are enabled.
            </p>
            <p style="margin:0;font-size:11px;color:#cbd5e1;">
              Automated page change detection &middot; <a href="${esc(appUrl)}" style="color:#94a3b8;text-decoration:underline;">Open Dashboard</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export async function sendVerificationEmail(opts: {
  to: string;
  name: string;
  token: string;
}): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn("SMTP not configured — skipping verification email");
    return;
  }

  const baseUrl = getAppBaseUrl();
  const verifyUrl = `${baseUrl}/verify-email?token=${encodeURIComponent(opts.token)}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify your email — WebMonitor</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:520px;background:#1e293b;border-radius:16px;border:1px solid #334155;overflow:hidden;">
          <tr>
            <td style="padding:40px 40px 32px;text-align:center;border-bottom:1px solid #334155;">
              <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:14px;background:#3b82f6;margin-bottom:20px;">
                <svg width="22" height="22" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="7" cy="7" r="3" fill="white"/>
                  <circle cx="7" cy="7" r="6" stroke="white" stroke-width="1.5" fill="none"/>
                </svg>
              </div>
              <h1 style="margin:0;font-size:22px;font-weight:700;color:#f1f5f9;">Verify your email</h1>
              <p style="margin:8px 0 0;font-size:14px;color:#94a3b8;">One more step to get started with WebMonitor</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px;">
              <p style="margin:0 0 8px;font-size:14px;color:#cbd5e1;">Hi ${opts.name},</p>
              <p style="margin:0 0 28px;font-size:14px;color:#94a3b8;line-height:1.6;">Thanks for signing up! Click the button below to verify your email address and activate your account. This link expires in 24 hours.</p>
              <div style="text-align:center;margin-bottom:28px;">
                <a href="${verifyUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.01em;">Verify my email &rarr;</a>
              </div>
              <p style="margin:0;font-size:12px;color:#475569;line-height:1.6;">If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${verifyUrl}" style="color:#3b82f6;word-break:break-all;">${verifyUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px 28px;border-top:1px solid #334155;">
              <p style="margin:0;font-size:12px;color:#475569;text-align:center;">If you didn't create an account, you can safely ignore this email.<br/>
                <strong style="color:#64748b;">WebMonitor</strong> — Track website changes automatically</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: opts.to,
      subject: "Verify your WebMonitor email address",
      html,
    });
    logger.info({ to: opts.to }, "Verification email sent");
  } catch (err) {
    logger.error({ err, to: opts.to }, "Failed to send verification email");
  }
}

export interface ChangeEmailOptions {
  to: string;
  monitorName: string;
  url: string;
  monitorType: string;
  diffScore: number | null;
  checkedAt: Date;
  monitorId: number | null;
  htmlDiff: string | null;
  previousScreenshotPath: string | null;
  newScreenshotPath: string | null;
  diffImagePath: string | null;
  changeCount: number;
}

export async function sendChangeNotificationEmail(opts: ChangeEmailOptions): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) {
    logger.info({ to: opts.to, monitorName: opts.monitorName }, "SMTP not configured, skipping email notification");
    return;
  }

  const beforeAttachment = buildInlineImage(opts.previousScreenshotPath, "before_screenshot");
  const afterAttachment = buildInlineImage(opts.newScreenshotPath, "after_screenshot");
  const diffAttachment = buildInlineImage(opts.diffImagePath, "diff_screenshot");

  const attachments: nodemailer.Attachment[] = [
    beforeAttachment,
    afterAttachment,
    diffAttachment,
  ].filter((a): a is nodemailer.Attachment => a !== null);

  const html = buildEmailHtml({
    monitorName: opts.monitorName,
    url: opts.url,
    monitorType: opts.monitorType,
    diffScore: opts.diffScore,
    checkedAt: opts.checkedAt,
    monitorId: opts.monitorId,
    htmlDiff: opts.htmlDiff,
    hasBefore: beforeAttachment !== null,
    hasAfter: afterAttachment !== null,
    hasDiff: diffAttachment !== null,
    changeCount: opts.changeCount,
  });

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: opts.to,
      subject: `🔔 Change detected on "${opts.monitorName}"`,
      html,
      attachments,
    });
    logger.info({ to: opts.to, monitorName: opts.monitorName }, "Change notification email sent");
  } catch (err) {
    logger.error({ err, to: opts.to, monitorName: opts.monitorName }, "Failed to send notification email");
  }
}
