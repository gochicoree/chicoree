"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export default function NewOrganizationPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.organization.create({ name, slug });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not create the organization");
    else {
      router.push(`/${slug}`);
      router.refresh();
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Organizations"
        title="Create an organization"
        description="An organization is a namespace for images: registry/<slug>/<repository>."
      />
      <Card>
        <CardBody>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Name" htmlFor="name">
              <Input
                id="name"
                required
                value={name}
                placeholder="Acme Robotics"
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            </Field>
            <Field
              label="Slug"
              htmlFor="slug"
              hint={`Images will live under ${slug || "<slug>"}/<repository>. Lowercase letters, digits, ._- separators.`}
            >
              <Input
                id="slug"
                required
                value={slug}
                className="font-mono"
                pattern="[a-z0-9]+([._\\-][a-z0-9]+)*"
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
              />
            </Field>
            {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={busy}>
              Create organization
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
