"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Fingerprint, KeyRound, Mail, Wand2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, CardBody } from "@/components/ui/card";

type Mode = "password" | "ldap" | "magic-link" | "email-otp";

export function SignInForm({
  providers,
  signUp = { mode: "open", invitationId: "" },
  next = "/dashboard",
}: {
  providers: {
    github: boolean;
    google: boolean;
    oidc: boolean;
    oidcName: string;
    ldap: boolean;
    ldapName: string;
  };
  /** Sign-up controls: the "create an account" link follows the mode. */
  signUp?: { mode: "open" | "invite" | "closed"; invitationId: string };
  /** Same-origin path to land on afterwards (e.g. an invitation). */
  next?: string;
}) {
  const router = useRouter();
  const callbackURL = next;
  const showSignUp = signUp.mode === "open" || (signUp.mode === "invite" && !!signUp.invitationId);
  const signUpHref = signUp.invitationId ? `/sign-up?invitation=${encodeURIComponent(signUp.invitationId)}` : "/sign-up";
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await withBusy(async () => {
      if (mode === "password") {
        const { error } = await authClient.signIn.email({ email, password, callbackURL });
        if (error) setError(error.message ?? "Sign-in failed");
        else router.push(callbackURL);
      } else if (mode === "ldap") {
        // Custom endpoint from the server-side ldap plugin; the two-factor
        // client plugin still sees the response and redirects when needed.
        const res = await authClient.$fetch<{ twoFactorRedirect?: boolean }>("/sign-in/ldap", {
          method: "POST",
          body: { username, password, callbackURL },
        });
        if (res.error) setError(res.error.message ?? "Sign-in failed");
        else if (!res.data?.twoFactorRedirect) router.push(callbackURL);
      } else if (mode === "magic-link") {
        const { error } = await authClient.signIn.magicLink({ email, callbackURL });
        if (error) setError(error.message ?? "Could not send the link");
        else setNotice(`Sign-in link sent to ${email}. Check your inbox.`);
      } else {
        const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
        if (error) setError(error.message ?? "Could not send the code");
        else router.push(`/email-otp?email=${encodeURIComponent(email)}`);
      }
    });
  }

  async function passkey() {
    await withBusy(async () => {
      const res = await authClient.signIn.passkey();
      if (res?.error) setError(res.error.message ?? "Passkey sign-in failed");
      else router.push(callbackURL);
    });
  }

  const anySocial = providers.github || providers.google || providers.oidc;
  const modes = [
    ["password", "Password", KeyRound],
    ...(providers.ldap ? ([["ldap", providers.ldapName, Building2]] as const) : []),
    ["magic-link", "Magic link", Wand2],
    ["email-otp", "Email code", Mail],
  ] as const;

  return (
    <Card>
      <CardBody className="space-y-4 py-5">
        <div>
          <h1 className="font-display text-lg font-semibold">Sign in</h1>
          <p className="text-sm text-ink-2">Manage images, organizations and access.</p>
        </div>

        <div
          className={`grid gap-1 rounded-lg border border-line bg-card-2 p-1 ${modes.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}
        >
          {modes.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`flex flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-xs font-medium transition-colors cursor-pointer sm:flex-row sm:gap-1.5 sm:px-2 sm:text-[13px] ${
                mode === value ? "bg-card text-ink shadow-sm" : "text-ink-2 hover:text-ink"
              }`}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === "ldap" ? (
            <Field label="Username" htmlFor="ldap-username" hint="Your directory account, not an email address.">
              <Input
                id="ldap-username"
                required
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="jdoe"
              />
            </Field>
          ) : (
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                required
                autoComplete="email webauthn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
          )}
          {mode === "ldap" && (
            <Field label="Password" htmlFor="ldap-password">
              <Input
                id="ldap-password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}
          {mode === "password" && (
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="mt-1.5 text-right">
                <Link href="/forgot-password" className="text-xs text-ink-2 hover:text-ink">
                  Forgot password?
                </Link>
              </div>
            </Field>
          )}
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          {notice && <p className="rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">{notice}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            {mode === "password" || mode === "ldap" ? "Sign in" : mode === "magic-link" ? "Send sign-in link" : "Send code"}
          </Button>
        </form>

        <div className="flex items-center gap-3 text-xs text-ink-3">
          <div className="h-px flex-1 bg-line" />
          or
          <div className="h-px flex-1 bg-line" />
        </div>

        <div className="space-y-2">
          <Button variant="secondary" className="w-full" disabled={busy} onClick={passkey}>
            <Fingerprint className="size-4" /> Sign in with a passkey
          </Button>
          {providers.github && (
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={() => authClient.signIn.social({ provider: "github", callbackURL })}
            >
              Continue with GitHub
            </Button>
          )}
          {providers.google && (
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={() => authClient.signIn.social({ provider: "google", callbackURL })}
            >
              Continue with Google
            </Button>
          )}
          {providers.oidc && (
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={() =>
                // Generic OIDC providers register as first-class social providers.
                authClient.signIn.social({
                  provider: "oidc" as Parameters<typeof authClient.signIn.social>[0]["provider"],
                  callbackURL,
                })
              }
            >
              Continue with {providers.oidcName}
            </Button>
          )}
        </div>

        {!anySocial && null}
        {showSignUp ? (
          <p className="text-center text-sm text-ink-2">
            New here?{" "}
            <Link href={signUpHref} className="font-medium text-ink underline-offset-2 hover:underline">
              Create an account
            </Link>
          </p>
        ) : (
          <p className="text-center text-xs text-ink-3">
            {signUp.mode === "invite" ? "New accounts are created by invitation only." : "This registry does not accept new accounts."}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
