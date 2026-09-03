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
import { getInstanceSettings, type LdapSettings } from "./instance-settings";
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

function tlsOptions(cfg: LdapSettings): ConnectionOptions {
  const opts: ConnectionOptions = {};
  if (cfg.tlsInsecure) opts.rejectUnauthorized = false;
  if (cfg.tlsCaFile) opts.ca = readFileSync(cfg.tlsCaFile);
  return opts;
}

const INVALID = "Invalid username or password";

/**
 * Verify directory credentials and return the user's identity and groups.
 * Throws LdapError for expected failures; anything else means the directory
 * itself misbehaved (unreachable, TLS, bad bind DN) and should be logged.
 */
export async function authenticateLdap(
  username: string,
  password: string,
  override?: LdapSettings,
): Promise<LdapIdentity> {
  const cfg = override ?? (await getInstanceSettings()).ldap;
  if (!cfg.enabled || !cfg.url) throw new LdapError("LDAP sign-in is not configured");
  const uname = username.trim();
  // An empty password is an "unauthenticated bind" that many servers accept
  // silently — never let it through as a login.
  if (!uname || !password) throw new LdapError(INVALID, true);
  if (!cfg.userBase) throw new LdapError("The LDAP user search base is not configured");

  const client = new Client({
    url: cfg.url,
    timeout: cfg.timeoutMs,
    connectTimeout: cfg.timeoutMs,
    tlsOptions: tlsOptions(cfg),
  });

  try {
    if (cfg.startTls) await client.startTLS(tlsOptions(cfg));

    // 1. Find the entry (as the lookup account, whose failure is a config error, not the user's).
    if (cfg.bindDn) {
      try {
        await client.bind(cfg.bindDn, cfg.bindPassword);
      } catch (e) {
        if (e instanceof InvalidCredentialsError) {
          throw new LdapError("The directory rejected the lookup account; check the bind DN and password in the LDAP settings.");
        }
        throw e;
      }
    }
    const wanted = [cfg.attrEmail, cfg.attrName, cfg.attrGroups];
    const { searchEntries } = await client.search(cfg.userBase, {
      scope: "sub",
      filter: fillTemplate(cfg.userFilter, { username: uname }),
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
    const groups = new Set(attrValues(entry, cfg.attrGroups));
    if (cfg.groupBase) {
      // Search with the service account again: some directories hide group
      // membership from the members themselves.
      if (cfg.bindDn) await client.bind(cfg.bindDn, cfg.bindPassword);
      const res = await client.search(cfg.groupBase, {
        scope: "sub",
        filter: fillTemplate(cfg.groupFilter, { dn: entry.dn, username: uname }),
        attributes: ["cn"],
        sizeLimit: 1000,
      });
      for (const g of res.searchEntries) groups.add(g.dn);
    }

    const email =
      attrValues(entry, cfg.attrEmail)[0]?.toLowerCase() ??
      (cfg.emailDomain ? `${uname.toLowerCase()}@${cfg.emailDomain}` : null);
    if (!email) {
      throw new LdapError(
        `Your directory entry has no "${cfg.attrEmail}" attribute. An administrator can set an email domain in the LDAP settings to derive one.`,
      );
    }

    return {
      dn: entry.dn,
      username: uname,
      email,
      name: attrValues(entry, cfg.attrName)[0] ?? uname,
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

/** Admin "test connection": bind with the service account and count what the user filter finds. */
export async function testLdapConnection(cfg: LdapSettings, sampleUsername: string): Promise<{ entries: number; dn: string | null }> {
  const client = new Client({ url: cfg.url, timeout: cfg.timeoutMs, connectTimeout: cfg.timeoutMs, tlsOptions: tlsOptions(cfg) });
  try {
    if (cfg.startTls) await client.startTLS(tlsOptions(cfg));
    if (cfg.bindDn) await client.bind(cfg.bindDn, cfg.bindPassword);
    const { searchEntries } = await client.search(cfg.userBase, {
      scope: "sub",
      filter: fillTemplate(cfg.userFilter, { username: sampleUsername }),
      attributes: ["dn"],
      sizeLimit: 5,
    });
    return { entries: searchEntries.length, dn: searchEntries[0]?.dn ?? null };
  } finally {
    await client.unbind().catch(() => {});
  }
}
