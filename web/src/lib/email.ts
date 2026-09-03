import nodemailer, { type Transporter } from "nodemailer";
import { getInstanceSettings, type SmtpSettings } from "./instance-settings";

// The transporter follows the admin panel's SMTP settings (environment as
// default) and is rebuilt when they change. Without a host, mail is logged
// to the server console so local development never blocks on delivery.
let cached: { version: number; transporter: Transporter | null; from: string } | null = null;

function build(smtp: SmtpSettings): Transporter | null {
  if (!smtp.host) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
}

async function transport(): Promise<{ transporter: Transporter | null; from: string }> {
  const settings = await getInstanceSettings();
  if (!cached || cached.version !== settings.version) {
    cached = { version: settings.version, transporter: build(settings.smtp), from: settings.smtp.from };
  }
  return cached;
}

export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
  const { transporter, from } = await transport();
  if (!transporter) {
    console.log(`[mail:not-configured] to=${opts.to} subject=${JSON.stringify(opts.subject)}\n${opts.text}`);
    return;
  }
  await transporter.sendMail({ from, to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
}

/** Admin "send test email" with settings that may not be saved yet. */
export async function sendTestMail(smtp: SmtpSettings, to: string): Promise<void> {
  const transporter = build(smtp);
  if (!transporter) throw new Error("Enter an SMTP host first.");
  const brand = (await getInstanceSettings()).branding.instanceName || "Chicorée";
  await transporter.sendMail({
    from: smtp.from,
    to,
    subject: `${brand} test email`,
    text: `If you can read this, outgoing email from your ${brand} registry works.`,
    html: mailLayout("Test email", `<p>If you can read this, outgoing email from your ${brand} registry works.</p>`, brand),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Shared minimal HTML wrapper so every mail reads as coming from the same
// product. `brand` is the instance name from the branding settings.
export function mailLayout(title: string, bodyHtml: string, brand = "Chicorée"): string {
  return `<!doctype html>
<html><body style="margin:0;padding:32px;background:#f4f6f7;font-family:ui-sans-serif,system-ui,sans-serif;color:#14252e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d9e0e4;border-radius:12px">
      <tr><td style="padding:28px 32px 0 32px">
        <div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#5a6e79;font-weight:600">${escapeHtml(brand)}</div>
        <h1 style="font-size:20px;margin:12px 0 0 0">${title}</h1>
      </td></tr>
      <tr><td style="padding:16px 32px 28px 32px;font-size:14px;line-height:1.6">${bodyHtml}</td></tr>
    </table>
    <div style="font-size:12px;color:#5a6e79;padding-top:16px">If you didn't request this, you can safely ignore this email.</div>
  </td></tr></table>
</body></html>`;
}

export function buttonHtml(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:#0f3a4d;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600">${label}</a>`;
}

export function codeHtml(code: string): string {
  return `<div style="font-family:ui-monospace,monospace;font-size:24px;letter-spacing:0.35em;background:#f4f6f7;border:1px solid #d9e0e4;border-radius:8px;padding:14px 18px;text-align:center">${code}</div>`;
}
