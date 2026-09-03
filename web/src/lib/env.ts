// Central place for every environment variable the web app reads.
// Values with sane dev defaults fall back; anything security-relevant is
// required in production.

function required(name: string, devDefault?: string): string {
  const v = process.env[name];
  if (v) return v;
  if (process.env.NODE_ENV !== "production" && devDefault !== undefined) return devDefault;
  // During `next build` there is no runtime environment yet; fall back so the
  // build can prerender, real values are enforced when the server starts.
  if (process.env.NEXT_PHASE === "phase-production-build" && devDefault !== undefined) return devDefault;
  throw new Error(`Missing required environment variable ${name}`);
}

export const env = {
  get appUrl() {
    return process.env.APP_URL ?? "http://localhost:3000";
  },
  get databaseUrl() {
    return required("DATABASE_URL", "postgres://chicoree:chicoree@localhost:5432/chicoree");
  },
  get authSecret() {
    return required("AUTH_SECRET", "dev-secret-change-me");
  },

  /** Public registry host:port, what users type after `docker login`. */
  get registryHost() {
    return process.env.REGISTRY_HOST ?? "localhost:5000";
  },
  /** Where the web app itself reaches the registry (inside the compose network). */
  get registryInternalUrl() {
    return process.env.REGISTRY_INTERNAL_URL ?? "http://localhost:5000";
  },

  // Token service — must match registryd's TOKEN_* configuration.
  get tokenIssuer() {
    return process.env.TOKEN_ISSUER ?? "chicoree-web";
  },
  get tokenService() {
    return process.env.TOKEN_SERVICE ?? "chicoree-registry";
  },
  get tokenPrivateKeyFile() {
    return process.env.JWT_PRIVATE_KEY_FILE ?? "../secrets/registry-token.key";
  },

  get webhookSecret() {
    return required("WEBHOOK_SECRET", "dev-webhook-secret");
  },
  /** Static bearer token for automation calling /api/jobs (optional). */
  get jobsApiToken() {
    return process.env.JOBS_API_TOKEN ?? "";
  },

  // Clair
  get clairUrl() {
    return process.env.CLAIR_URL ?? "";
  },
  get clairEnabled() {
    return this.clairUrl !== "";
  },

  // SMTP
  get smtpHost() {
    return process.env.SMTP_HOST ?? "";
  },
  get smtpPort() {
    return Number(process.env.SMTP_PORT ?? 587);
  },
  get smtpSecure() {
    return process.env.SMTP_SECURE === "true";
  },
  get smtpUser() {
    return process.env.SMTP_USER ?? "";
  },
  get smtpPass() {
    return process.env.SMTP_PASS ?? "";
  },
  get smtpFrom() {
    return process.env.SMTP_FROM ?? "Chicorée <registry@localhost>";
  },

  // Social / OIDC sign-in (each provider activates when its vars are set)
  get githubClientId() {
    return process.env.GITHUB_CLIENT_ID ?? "";
  },
  get githubClientSecret() {
    return process.env.GITHUB_CLIENT_SECRET ?? "";
  },
  get googleClientId() {
    return process.env.GOOGLE_CLIENT_ID ?? "";
  },
  get googleClientSecret() {
    return process.env.GOOGLE_CLIENT_SECRET ?? "";
  },
  get oidcIssuer() {
    return process.env.OIDC_ISSUER ?? "";
  },
  get oidcClientId() {
    return process.env.OIDC_CLIENT_ID ?? "";
  },
  get oidcClientSecret() {
    return process.env.OIDC_CLIENT_SECRET ?? "";
  },
  get oidcName() {
    return process.env.OIDC_NAME ?? "SSO";
  },
  get oidcScopes() {
    return (process.env.OIDC_SCOPES ?? "openid profile email").split(/[\s,]+/).filter(Boolean);
  },
  /** ID-token claim holding the user's groups, for AUTH_GROUP_BINDINGS. */
  get oidcGroupsClaim() {
    return process.env.OIDC_GROUPS_CLAIM ?? "groups";
  },

  // LDAP / Active Directory sign-in (activates when LDAP_URL is set).
  // Users sign in with their directory username + password; accounts are
  // created on first login and AUTH_GROUP_BINDINGS maps groups to roles.
  get ldapUrl() {
    return process.env.LDAP_URL ?? "";
  },
  get ldapEnabled() {
    return this.ldapUrl !== "";
  },
  /** Label on the sign-in switcher, e.g. "Company directory". */
  get ldapName() {
    return process.env.LDAP_NAME ?? "LDAP";
  },
  /** Service account used to look users up; empty means anonymous search. */
  get ldapBindDn() {
    return process.env.LDAP_BIND_DN ?? "";
  },
  get ldapBindPassword() {
    return process.env.LDAP_BIND_PASSWORD ?? "";
  },
  get ldapUserBase() {
    return process.env.LDAP_USER_BASE ?? "";
  },
  /** {{username}} is replaced (escaped) with what the user typed. */
  get ldapUserFilter() {
    return process.env.LDAP_USER_FILTER ?? "(&(objectClass=person)(uid={{username}}))";
  },
  get ldapAttrEmail() {
    return process.env.LDAP_ATTR_EMAIL ?? "mail";
  },
  get ldapAttrName() {
    return process.env.LDAP_ATTR_NAME ?? "cn";
  },
  /** Multi-valued attribute on the user entry holding group DNs. */
  get ldapAttrGroups() {
    return process.env.LDAP_ATTR_GROUPS ?? "memberOf";
  },
  /** Optional group search (for directories without memberOf); {{dn}} and {{username}} are substituted. */
  get ldapGroupBase() {
    return process.env.LDAP_GROUP_BASE ?? "";
  },
  get ldapGroupFilter() {
    return process.env.LDAP_GROUP_FILTER ?? "(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))";
  },
  /** Used as <username>@<domain> for entries without an email attribute. */
  get ldapEmailDomain() {
    return process.env.LDAP_EMAIL_DOMAIN ?? "";
  },
  get ldapStartTls() {
    return process.env.LDAP_START_TLS === "true";
  },
  get ldapTlsInsecure() {
    return process.env.LDAP_TLS_INSECURE === "true";
  },
  get ldapTlsCaFile() {
    return process.env.LDAP_TLS_CA_FILE ?? "";
  },
  get ldapTimeoutMs() {
    return Number(process.env.LDAP_TIMEOUT_MS ?? 10000);
  },

  // Group → role bindings for every provider that reports groups
  // (LDAP, GitHub, Google, OIDC); format documented in lib/group-bindings.ts.
  get authGroupBindings() {
    return process.env.AUTH_GROUP_BINDINGS ?? "";
  },

  // Prometheus exporter defaults (the admin panel can override both).
  get metricsEnabled() {
    return process.env.METRICS_ENABLED === "true";
  },
  /** Bearer token Prometheus must present to /api/metrics. */
  get metricsToken() {
    return process.env.METRICS_TOKEN ?? "";
  },

  // WebAuthn relying party
  get passkeyRpId() {
    return process.env.PASSKEY_RP_ID ?? "localhost";
  },
  get passkeyRpName() {
    return process.env.PASSKEY_RP_NAME ?? "Chicorée Registry";
  },

  // Sign-up controls (defaults; Administration → Auth providers → Access overrides them).
  /** open | invite | closed */
  get signUpMode() {
    const v = process.env.SIGNUP_MODE ?? "open";
    return v === "invite" || v === "closed" ? v : "open";
  },
  /** Comma/space separated email domains allowed to register; empty = any. */
  get signUpAllowedDomains() {
    return (process.env.SIGNUP_ALLOWED_DOMAINS ?? "")
      .split(/[\s,;]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
  },
  /** everyone | admins */
  get orgCreation() {
    return process.env.ORG_CREATION === "admins" ? "admins" : "everyone";
  },

  // Branding defaults (Administration → Branding overrides them).
  get instanceName() {
    return process.env.INSTANCE_NAME ?? "";
  },
  get instanceTagline() {
    return process.env.INSTANCE_TAGLINE ?? "";
  },

  /** Audit log rows older than this are pruned (opportunistically, on insert). */
  get auditRetentionDays() {
    const n = Number(process.env.AUDIT_RETENTION_DAYS ?? 365);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 365;
  },
  // Pull rate limits ("<count>/<window>", e.g. 100/6h; empty = unlimited) as
  // defaults for the admin panel's Rate limits section. registryd reads the
  // same variables when the section was never saved.
  get rateLimitAnonymous() {
    return process.env.RATE_LIMIT_ANONYMOUS ?? "";
  },
  get rateLimitAuthenticated() {
    return process.env.RATE_LIMIT_AUTHENTICATED ?? "";
  },
  /** CIDRs whose X-Forwarded-For registryd trusts for the client address. */
  get rateLimitTrustedProxies() {
    return process.env.RATE_LIMIT_TRUSTED_PROXIES ?? "";
  },
};
