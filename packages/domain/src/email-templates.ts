/**
 * Glasshouse emails (queue #76, DECISIONS #7 brand). Pure renderers: no I/O,
 * no config lookups, so a snapshot pins exactly what an inbox receives.
 *
 * Built for the clients people actually open mail in:
 *  - table layout, inline styles, 600px max, no web fonts required (the brand
 *    faces are named first and fall back to system sans / mono);
 *  - dark mode via `color-scheme` meta + `prefers-color-scheme` classes, with
 *    `[data-ogsc]` twins for Outlook.com. Clients that ignore the media query
 *    (Gmail) get the light palette, which reads on its own;
 *  - the mark is a hosted PNG (Gmail blocks data: URIs), light by default,
 *    swapped for the night tile where the client honours the media query.
 *
 * Colours mirror `packages/ui/tokens/values.ts` (Clear Pane day, Nightwatch
 * night). The primary button label is ink on signal: white on #E2542B fails AA.
 *
 * Voice (DESIGN.md §7): terse, factual, no exclamation marks, no hype.
 */

/** The public prod origin: where hosted brand images live when the configured origin can't serve an inbox. */
export const BRAND_ASSET_ORIGIN = "https://glasshouse.rendrr.app";

export const EMAIL_COLORS = {
  light: {
    ground: "#F3F6F8",
    surface: "#FFFFFF",
    ink: "#0E1B2B",
    muted: "#4A5A6C",
    line: "#C9D4DD",
    signal: "#E2542B",
    signalInk: "#0E1B2B",
    link: "#3E7CB1",
  },
  night: {
    ground: "#0A0B14",
    surface: "#12142A",
    ink: "#E4E2F0",
    muted: "#A9A6C0",
    line: "#2A2E52",
    signal: "#E2542B",
    signalInk: "#0A0B14",
    link: "#B7A6F2",
  },
} as const;

const SANS = "'Schibsted Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'Fragment Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Where hosted images are loaded from: the configured public origin when an
 * inbox can reach it (https, not localhost), else the prod origin.
 */
export function brandAssetBase(publicUrl: string | null | undefined): string {
  const u = (publicUrl ?? "").replace(/\/+$/, "");
  if (/^https:\/\//.test(u) && !/^https:\/\/(localhost|127\.|0\.0\.0\.0)/.test(u)) return u;
  return BRAND_ASSET_ORIGIN;
}

type Shell = {
  /** Hidden inbox preview line. Never carries a secret. */
  preheader: string;
  /** Inner rows (already-escaped HTML). */
  body: string;
  siteUrl: string;
  assetBase: string;
  footer: string;
};

const L = EMAIL_COLORS.light;
const N = EMAIL_COLORS.night;

function darkCss(): string {
  // Each rule twice: the media query (Apple Mail, iOS, Outlook for Mac) and
  // [data-ogsc] (Outlook.com / Outlook apps' forced dark mode).
  const rules = (p: string) => `
${p} .gh-bg { background-color: ${N.ground} !important; }
${p} .gh-card { background-color: ${N.surface} !important; border-color: ${N.line} !important; }
${p} .gh-ink { color: ${N.ink} !important; }
${p} .gh-muted { color: ${N.muted} !important; }
${p} .gh-line { border-color: ${N.line} !important; }
${p} .gh-link { color: ${N.link} !important; }
${p} .gh-btn { background-color: ${N.signal} !important; border-color: ${N.signal} !important; color: ${N.signalInk} !important; }
${p} .gh-mark-light { display: none !important; }
${p} .gh-mark-night { display: block !important; width: 44px !important; height: 44px !important; max-height: none !important; overflow: visible !important; }`;
  return `@media (prefers-color-scheme: dark) {${rules("  :root")}\n}\n${rules("[data-ogsc]")}`;
}

function shell({ preheader, body, siteUrl, assetBase, footer }: Shell): string {
  const site = escapeHtml(siteUrl);
  const light = escapeHtml(`${assetBase}/brand/email-mark-light.png`);
  const night = escapeHtml(`${assetBase}/brand/email-mark-night.png`);
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="x-ua-compatible" content="ie=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<title>Glasshouse</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; }
table { border-collapse: collapse; }
img { border: 0; outline: none; text-decoration: none; }
a.gh-link { word-break: break-all; }
@media (max-width: 620px) { .gh-pad { padding-left: 24px !important; padding-right: 24px !important; } }
${darkCss()}
</style>
</head>
<body class="gh-bg" style="margin:0;padding:0;background-color:${L.ground};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${L.ground};opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="gh-bg" style="background-color:${L.ground};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="gh-card" style="width:100%;max-width:600px;background-color:${L.surface};border:1px solid ${L.line};border-radius:12px;">
<tr><td class="gh-pad" style="padding:32px 40px 8px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;padding-right:12px;">
<a href="${site}" style="text-decoration:none;"><img class="gh-mark-light" src="${light}" width="44" height="44" alt="Glasshouse" style="display:block;width:44px;height:44px;"><!--[if !mso]><!--><img class="gh-mark-night" src="${night}" width="44" height="44" alt="" style="display:none;width:0;height:0;max-height:0;overflow:hidden;mso-hide:all;"><!--<![endif]--></a>
</td>
<td class="gh-ink" style="vertical-align:middle;font-family:${SANS};font-size:22px;font-weight:800;letter-spacing:-0.02em;color:${L.ink};">glasshouse</td>
</tr></table>
</td></tr>
${body}
<tr><td class="gh-pad" style="padding:8px 40px 32px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="gh-line gh-muted" style="border-top:1px solid ${L.line};padding-top:16px;font-family:${SANS};font-size:13px;line-height:20px;color:${L.muted};">${footer}</td></tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

function eyebrowRow(label: string): string {
  return `<tr><td class="gh-pad gh-muted" style="padding:24px 40px 0 40px;font-family:${MONO};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${L.muted};">${escapeHtml(label)}</td></tr>`;
}

function titleRow(title: string): string {
  return `<tr><td class="gh-pad gh-ink" style="padding:8px 40px 0 40px;font-family:${SANS};font-size:30px;line-height:36px;font-weight:800;letter-spacing:-0.02em;color:${L.ink};">${escapeHtml(title)}</td></tr>`;
}

function paragraphRow(text: string, opts: { muted?: boolean; top?: number } = {}): string {
  const cls = opts.muted ? "gh-muted" : "gh-ink";
  const color = opts.muted ? L.muted : L.ink;
  const size = opts.muted ? 14 : 16;
  return `<tr><td class="gh-pad ${cls}" style="padding:${opts.top ?? 16}px 40px 0 40px;font-family:${SANS};font-size:${size}px;line-height:${size + 8}px;color:${color};">${escapeHtml(text)}</td></tr>`;
}

/** A bulletproof button: the border paints the padding in Outlook, where `padding` on <a> is ignored. */
function buttonRow(label: string, href: string): string {
  const h = escapeHtml(href);
  return `<tr><td class="gh-pad" style="padding:28px 40px 0 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="gh-btn" bgcolor="${L.signal}" style="border-radius:999px;background-color:${L.signal};">
<a class="gh-btn" href="${h}" target="_blank" style="display:inline-block;padding:0;border:14px solid ${L.signal};border-left-width:28px;border-right-width:28px;border-radius:999px;background-color:${L.signal};color:${L.signalInk};font-family:${SANS};font-size:16px;line-height:20px;font-weight:700;text-decoration:none;">${escapeHtml(label)}</a>
</td>
</tr></table>
</td></tr>`;
}

function linkFallbackRow(href: string): string {
  const h = escapeHtml(href);
  return `<tr><td class="gh-pad gh-muted" style="padding:24px 40px 0 40px;font-family:${SANS};font-size:14px;line-height:22px;color:${L.muted};">Button not working? Paste this link into your browser:</td></tr>
<tr><td class="gh-pad" style="padding:6px 40px 0 40px;font-family:${MONO};font-size:13px;line-height:20px;word-break:break-all;"><a class="gh-link" href="${h}" target="_blank" style="color:${L.link};text-decoration:underline;word-break:break-all;">${h}</a></td></tr>`;
}

function footerHtml(siteUrl: string, reason: string): string {
  const site = escapeHtml(siteUrl);
  return `${escapeHtml(reason)}<br><a class="gh-link" href="${site}" style="color:${L.link};text-decoration:none;">Glasshouse</a> · a world you watch`;
}

// ---------------------------------------------------------------- magic link

export const MAGIC_LINK_SUBJECT = "Enter Glasshouse";

export interface MagicLinkEmailInput {
  /** The sign-in URL. Carries the token; it appears ONLY as this link. */
  url: string;
  /** The public site (GROVE_PUBLIC_URL); also where the mark is loaded from when reachable. */
  siteUrl: string;
  expiresInMinutes?: number;
}

/**
 * The magic-link email. The token lives inside `url` and nowhere else: not in
 * the subject, the preheader, alt text or the footer (a test checks that
 * removing every copy of the URL removes the token).
 */
export function renderMagicLinkEmail({ url, siteUrl, expiresInMinutes = 15 }: MagicLinkEmailInput): RenderedEmail {
  const site = siteUrl.replace(/\/+$/, "");
  const expiry = `It works once and expires in ${expiresInMinutes} minutes.`;
  const ignore = "Didn't ask for this? Ignore this email. Nobody gets in without the link.";
  const body = [
    eyebrowRow("Sign in"),
    titleRow(MAGIC_LINK_SUBJECT),
    paragraphRow(`Use the button to sign in. ${expiry}`),
    buttonRow(MAGIC_LINK_SUBJECT, url),
    linkFallbackRow(url),
    paragraphRow(ignore, { muted: true, top: 24 }),
    `<tr><td style="padding:24px 0 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>`,
  ].join("\n");
  const html = shell({
    preheader: `Your sign-in link. ${expiry}`,
    body,
    siteUrl: site,
    assetBase: brandAssetBase(site),
    footer: footerHtml(site, "Someone asked to sign in to Glasshouse with this address."),
  });
  const text = [
    MAGIC_LINK_SUBJECT,
    "",
    `Open this link to sign in. ${expiry}`,
    "",
    url,
    "",
    ignore,
    "",
    "--",
    "Glasshouse · a world you watch",
    site,
    "",
  ].join("\n");
  return { subject: MAGIC_LINK_SUBJECT, html, text };
}

// ---------------------------------------------------------------- notice

export interface NoticeEmailInput {
  /** Subject line, terse: "lantern: tool call failed". */
  subject: string;
  /** Mono eyebrow: "Follow · agent". */
  eyebrow: string;
  title: string;
  /** Short factual lines, plain text (escaped here). */
  lines: string[];
  action?: { label: string; url: string };
  /** Why this person got it: "You follow lantern." */
  reason: string;
  /** Where to turn these off. */
  manageUrl: string;
  siteUrl: string;
}

/**
 * A generic notice (a follow notice, an operator heads-up). Ready for use, not
 * sent today: follow notices are in-app only (queue #7). Everything passed in
 * is escaped, and a caller must feed it only what the recipient may see.
 */
export function renderNoticeEmail(input: NoticeEmailInput): RenderedEmail {
  const site = input.siteUrl.replace(/\/+$/, "");
  const manage = escapeHtml(input.manageUrl);
  const body = [
    eyebrowRow(input.eyebrow),
    titleRow(input.title),
    ...input.lines.map((l, i) => paragraphRow(l, { top: i === 0 ? 16 : 8 })),
    input.action ? buttonRow(input.action.label, input.action.url) : "",
    `<tr><td style="padding:24px 0 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>`,
  ]
    .filter(Boolean)
    .join("\n");
  const footer = `${footerHtml(site, input.reason)}<br><a class="gh-link" href="${manage}" style="color:${L.link};text-decoration:underline;">Manage notices</a>`;
  const html = shell({ preheader: input.lines[0] ?? input.title, body, siteUrl: site, assetBase: brandAssetBase(site), footer });
  const text = [
    input.title,
    "",
    ...input.lines,
    ...(input.action ? ["", `${input.action.label}: ${input.action.url}`] : []),
    "",
    "--",
    input.reason,
    `Manage notices: ${input.manageUrl}`,
    "Glasshouse · a world you watch",
    site,
    "",
  ].join("\n");
  return { subject: input.subject, html, text };
}
