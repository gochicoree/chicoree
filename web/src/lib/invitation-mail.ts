// The invitation email, shared by better-auth's organization plugin (the
// members page) and the REST API's invitation endpoint.
import { env } from "./env";
import { buttonHtml, mailLayout, sendMail } from "./email";

export async function sendInvitationMail(input: {
  invitationId: string;
  email: string;
  organizationName: string;
  inviterName: string;
  inviterEmail: string;
  /** Instance name for the subject and layout. */
  brand: string;
}): Promise<void> {
  const url = `${env.appUrl}/accept-invitation/${input.invitationId}`;
  await sendMail({
    to: input.email,
    subject: `Join ${input.organizationName} on ${input.brand}`,
    text: `${input.inviterName} invited you to the ${input.organizationName} organization: ${url}`,
    html: mailLayout(
      `Join ${input.organizationName}`,
      `<p>${input.inviterName} (${input.inviterEmail}) invited you to the <strong>${input.organizationName}</strong> organization.</p><p>${buttonHtml(url, "Accept invitation")}</p>`,
      input.brand,
    ),
  });
}
