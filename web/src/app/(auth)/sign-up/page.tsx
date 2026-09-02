"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, CardBody } from "@/components/ui/card";

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signUp.email({ name, email, password, callbackURL: "/dashboard" });
    setBusy(false);
    if (error) setError(error.message ?? "Sign-up failed");
    else router.push("/dashboard");
  }

  return (
    <Card>
      <CardBody className="space-y-4 py-5">
        <div>
          <h1 className="font-display text-lg font-semibold">Create your account</h1>
          <p className="text-sm text-ink-2">
            The first account on a fresh install becomes the administrator.
          </p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name" htmlFor="name">
            <Input id="name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="password" hint="At least 10 characters.">
            <Input
              id="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            Create account
          </Button>
        </form>
        <p className="text-center text-sm text-ink-2">
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-ink underline-offset-2 hover:underline">
            Sign in
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
