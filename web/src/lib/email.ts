import nodemailer from "nodemailer";
import { env } from "./env";

// One transporter per process. Without SMTP configured, mail is logged to the
// server console so local development never blocks on email delivery.
const transporter = env.smtpHost
  ? nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
    })
  : null;

export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
  if (!transporter) {
    console.log(`[mail:not-configured] to=${opts.to} subject=${JSON.stringify(opts.subject)}\n${opts.text}`);
    return;
  }
  await transporter.sendMail({
    from: env.smtpFrom,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
}

// Shared minimal HTML wrapper so every mail reads as coming from the same
// product.
export function mailLayout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:32px;background:#f4f6f7;font-family:ui-sans-serif,system-ui,sans-serif;color:#14252e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d9e0e4;border-radius:12px">
      <tr><td style="padding:28px 32px 0 32px">
        <div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#5a6e79;font-weight:600">Chicorée Registry</div>
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
