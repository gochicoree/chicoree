// LDAP / Active Directory sign-in, configured entirely through LDAP_* env
// variables (see lib/env.ts and .env.example).
//
// Flow: look the user up with the service account (or anonymously), bind as
// the found entry to check the password, then collect the entry's groups.
// The group DNs feed AUTH_GROUP_BINDINGS (lib/group-bindings.ts), which sets
// the instance role and organization memberships on every login.
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import { Client, InvalidCredentialsError, type Entry } from "ldapts";
import { env } from "./env";
import { syncGroupBindings } from "./group-bindings";

export class LdapError extends Error {
  constructor(
    message: string,
    /** True for wrong username/password (safe to show verbatim). */
    readonly invalidCredentials = false,
  ) {
    super(message);
    this.name = "LdapError";
  }
}

export interface LdapIdentity {
  dn: string;
  username: string;
  email: string;
  name: string;
  /** Group DNs (from the user entry's memberOf and/or the group search). */
  groups: string[];
}

/** RFC 4515: escape a value before interpolating it into a search filter. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => escapeFilterValue(vars[key] ?? ""));
}

/** Attribute lookup that ignores the case the server happens to use. */
function attrValues(entry: Entry, attr: string): string[] {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === attr.toLowerCase());
  if (!key) return [];
  const raw = entry[key];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((v) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v)))
    .filter((v) => v.length > 0);
}

function tlsOptions(): ConnectionOptions {
  const opts: ConnectionOptions = {};
  if (env.ldapTlsInsecure) opts.rejectUnauthorized = false;
  if (env.ldapTlsCaFile) opts.ca = readFileSync(env.ldapTlsCaFile);
  return opts;
}

const INVALID = "Invalid username or password";

/**
 * Verify directory credentials and return the user's identity and groups.
 * Throws LdapError for expected failures; anything else means the directory
 * itself misbehaved (unreachable, TLS, bad bind DN) and should be logged.
 */
export async function authenticateLdap(username: string, password: string): Promise<LdapIdentity> {
  if (!env.ldapEnabled) throw new LdapError("LDAP sign-in is not configured");
  const uname = username.trim();
  // An empty password is an "unauthenticated bind" that many servers accept
  // silently — never let it through as a login.
  if (!uname || !password) throw new LdapError(INVALID, true);
  if (!env.ldapUserBase) throw new LdapError("LDAP_USER_BASE is not configured");

  const client = new Client({
    url: env.ldapUrl,
    timeout: env.ldapTimeoutMs,
    connectTimeout: env.ldapTimeoutMs,
    tlsOptions: tlsOptions(),
  });

  try {
    if (env.ldapStartTls) await client.startTLS(tlsOptions());

    // 1. Find the entry.
    if (env.ldapBindDn) await client.bind(env.ldapBindDn, env.ldapBindPassword);
    const wanted = [env.ldapAttrEmail, env.ldapAttrName, env.ldapAttrGroups];
    const { searchEntries } = await client.search(env.ldapUserBase, {
      scope: "sub",
      filter: fillTemplate(env.ldapUserFilter, { username: uname }),
      attributes: [...new Set(wanted)],
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) throw new LdapError(INVALID, true);
    const entry = searchEntries[0];

    // 2. Check the password by binding as that entry.
    try {
      await client.bind(entry.dn, password);
    } catch (e) {
      if (e instanceof InvalidCredentialsError) throw new LdapError(INVALID, true);
      throw e;
    }

    // 3. Groups: whatever the entry lists, plus an explicit group search.
    const groups = new Set(attrValues(entry, env.ldapAttrGroups));
    if (env.ldapGroupBase) {
      // Search with the service account again: some directories hide group
      // membership from the members themselves.
      if (env.ldapBindDn) await client.bind(env.ldapBindDn, env.ldapBindPassword);
      const res = await client.search(env.ldapGroupBase, {
        scope: "sub",
        filter: fillTemplate(env.ldapGroupFilter, { dn: entry.dn, username: uname }),
        attributes: ["cn"],
        sizeLimit: 1000,
      });
      for (const g of res.searchEntries) groups.add(g.dn);
    }

    const email =
      attrValues(entry, env.ldapAttrEmail)[0]?.toLowerCase() ??
      (env.ldapEmailDomain ? `${uname.toLowerCase()}@${env.ldapEmailDomain}` : null);
    if (!email) {
      throw new LdapError(
        `Your directory entry has no "${env.ldapAttrEmail}" attribute. An administrator can set LDAP_EMAIL_DOMAIN to derive one.`,
      );
    }

    return {
      dn: entry.dn,
      username: uname,
      email,
      name: attrValues(entry, env.ldapAttrName)[0] ?? uname,
      groups: [...groups],
    };
  } finally {
    await client.unbind().catch(() => {});
  }
}

/** Apply the LDAP bindings for a user, given the group DNs from their login. */
export function syncLdapBindings(userId: string, groups: string[]): Promise<void> {
  return syncGroupBindings("ldap", userId, groups);
}
