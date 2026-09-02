// Organization roles, shared by the better-auth server config and the
// browser client so both agree on what each role may do.
//
//   owner  — everything, including deleting the organization
//   admin  — manage repositories, members, service accounts, settings
//   member — pull and push, create repositories
//   viewer — read-only: browse and pull private repositories, nothing else
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";

const statement = {
  ...defaultStatements,
  repository: ["create", "update", "delete", "push", "pull"],
} as const;

export const orgAccessControl = createAccessControl(statement);

export const orgRoles = {
  owner: orgAccessControl.newRole({
    ...ownerAc.statements,
    repository: ["create", "update", "delete", "push", "pull"],
  }),
  admin: orgAccessControl.newRole({
    ...adminAc.statements,
    repository: ["create", "update", "delete", "push", "pull"],
  }),
  member: orgAccessControl.newRole({
    ...memberAc.statements,
    repository: ["create", "push", "pull"],
  }),
  viewer: orgAccessControl.newRole({
    repository: ["pull"],
  }),
};

export type OrgRole = keyof typeof orgRoles;
export const ORG_ROLE_NAMES = Object.keys(orgRoles) as OrgRole[];

/** Roles an org admin may assign through the UI (owner is transferred, not assigned). */
export const ASSIGNABLE_ROLES: { value: OrgRole; label: string; description: string }[] = [
  { value: "viewer", label: "viewer", description: "Browse and pull private images only" },
  { value: "member", label: "member", description: "Pull, push and create repositories" },
  { value: "admin", label: "admin", description: "Also manage members, service accounts and settings" },
];

/** Registry actions granted to each role by the token service. */
export const ROLE_REGISTRY_ACTIONS: Record<OrgRole, ("pull" | "push" | "delete")[]> = {
  owner: ["pull", "push", "delete"],
  admin: ["pull", "push", "delete"],
  member: ["pull", "push"],
  viewer: ["pull"],
};

export const MANAGER_ROLES: OrgRole[] = ["owner", "admin"];
export const WRITER_ROLES: OrgRole[] = ["owner", "admin", "member"];
