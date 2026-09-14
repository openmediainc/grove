import { describe, expect, it } from "vitest";
import {
  BRAND_ASSET_ORIGIN,
  EMAIL_COLORS,
  MAGIC_LINK_SUBJECT,
  brandAssetBase,
  escapeHtml,
  renderMagicLinkEmail,
  renderNoticeEmail,
} from "../src/email-templates.js";

const TOKEN = "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const URL_ = `https://glasshouse.rendrr.app/login?token=${TOKEN}`;
const SITE = "https://glasshouse.rendrr.app";

describe("magic-link email (#76)", () => {
  const mail = renderMagicLinkEmail({ url: URL_, siteUrl: SITE });

  it("renders the HTML exactly (snapshot)", () => {
    expect(mail.html).toMatchSnapshot();
  });

  it("renders the text exactly (snapshot)", () => {
    expect(mail.text).toMatchSnapshot();
  });

  it("keeps the subject and the button", () => {
    expect(mail.subject).toBe("Enter Glasshouse");
    expect(MAGIC_LINK_SUBJECT).toBe("Enter Glasshouse");
    expect(mail.html).toMatch(/<a class="gh-btn" href="[^"]+"[^>]*>Enter Glasshouse<\/a>/);
  });

  it("puts the token only inside the link, in both parts", () => {
    // href on the button, href + visible text on the fallback: three copies of the URL, nothing else.
    expect(mail.html.split(URL_).length - 1).toBe(3);
    expect(mail.html.split(URL_).join("")).not.toContain(TOKEN);
    expect(mail.text.split(URL_).length - 1).toBe(1);
    expect(mail.text.split(URL_).join("")).not.toContain(TOKEN);
    expect(mail.subject).not.toContain(TOKEN);
  });

  it("escapes the URL in attributes and text", () => {
    const m = renderMagicLinkEmail({ url: `${SITE}/login?token=a&x="><b>`, siteUrl: SITE });
    expect(m.html).not.toContain('"><b>');
    expect(m.html).toContain("token=a&amp;x=&quot;&gt;&lt;b&gt;");
  });

  it("says the expiry and the ignore line, in both parts", () => {
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain("expires in 15 minutes");
      expect(part).toMatch(/Didn(&#39;|')t ask for this\? Ignore this email\./);
    }
  });

  it("is dark-mode friendly with safe fallbacks", () => {
    expect(mail.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(mail.html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(mail.html).toContain("@media (prefers-color-scheme: dark)");
    expect(mail.html).toContain("[data-ogsc] .gh-bg");
    // Inline light palette is the fallback for clients that ignore the query.
    expect(mail.html).toContain(`background-color:${EMAIL_COLORS.light.ground}`);
    expect(mail.html).toContain(`background-color: ${EMAIL_COLORS.night.ground} !important`);
    // Primary label is ink on signal (white on signal fails AA).
    expect(mail.html).toContain(`color:${EMAIL_COLORS.light.signalInk}`);
  });

  it("uses a hosted PNG mark, never a data URI", () => {
    expect(mail.html).toContain(`src="${SITE}/brand/email-mark-light.png"`);
    expect(mail.html).toContain(`src="${SITE}/brand/email-mark-night.png"`);
    expect(mail.html).not.toContain("data:image");
    expect(mail.html).toContain('width="600"');
  });

  it("never says Grove, Aetheria or campus", () => {
    expect(mail.html + mail.text + mail.subject).not.toMatch(/\b(Grove|Aetheria|campus)\b/i);
  });

  it("loads images from prod when the configured origin can't reach an inbox", () => {
    expect(brandAssetBase("http://localhost:3000")).toBe(BRAND_ASSET_ORIGIN);
    expect(brandAssetBase("https://127.0.0.1:3510/grove")).toBe(BRAND_ASSET_ORIGIN);
    expect(brandAssetBase("https://q-ai.tail735569.ts.net:3510/grove/")).toBe("https://q-ai.tail735569.ts.net:3510/grove");
    expect(renderMagicLinkEmail({ url: "http://localhost:3000/login?token=x", siteUrl: "http://localhost:3000" }).html).toContain(
      `${BRAND_ASSET_ORIGIN}/brand/email-mark-light.png`,
    );
  });
});

describe("notice email (#76, not sent yet)", () => {
  const mail = renderNoticeEmail({
    subject: "lantern: tool call failed",
    eyebrow: "Follow · agent",
    title: "lantern hit an error",
    lines: ["read_file failed after 42s.", "Library · 14:02 UTC"],
    action: { label: "Watch", url: `${SITE}/a/hello/lantern` },
    reason: "You follow lantern.",
    manageUrl: `${SITE}/me`,
    siteUrl: SITE,
  });

  it("renders HTML and text (snapshot)", () => {
    expect(mail.html).toMatchSnapshot();
    expect(mail.text).toMatchSnapshot();
  });

  it("escapes caller text", () => {
    const m = renderNoticeEmail({
      subject: "x",
      eyebrow: "<i>",
      title: "<script>alert(1)</script>",
      lines: ["a & b"],
      reason: "r",
      manageUrl: `${SITE}/me`,
      siteUrl: SITE,
    });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("a &amp; b");
    expect(m.html).not.toContain('class="gh-btn"');
  });

  it("escapeHtml covers quotes", () => {
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });
});
