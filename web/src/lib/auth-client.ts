import { createAuthClient } from "better-auth/react";
import {
  adminClient,
  emailOTPClient,
  magicLinkClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { orgAccessControl, orgRoles } from "./org-roles";

export const authClient = createAuthClient({
  plugins: [
    organizationClient({ ac: orgAccessControl, roles: orgRoles }),
    twoFactorClient({
      onTwoFactorRedirect() {
        window.location.href = "/two-factor";
      },
    }),
    magicLinkClient(),
    emailOTPClient(),
    passkeyClient(),
    adminClient(),
  ],
});

export type AuthClient = typeof authClient;
