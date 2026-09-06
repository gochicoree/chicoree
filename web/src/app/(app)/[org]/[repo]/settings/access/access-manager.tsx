"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { Plus, Users, X } from "lucide-react";
import { removeGrantAction, setGrantAction, type AccessActionResult } from "@/app/actions/repo-access";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { EntityLogo } from "@/components/entity-logo";
import type { LogoRef } from "@/lib/logo-shared";
import { REPO_PERMISSIONS, type RepoPermission } from "@/lib/repo-access-shared";

interface Grant {
  id: string;
  subjectType: "user" | "team";
  subjectId: string;
  label: string;
  detail: string;
  permission: RepoPermission;
  createdAt: string;
  logo?: LogoRef | null;
}

interface OrgMember {
  userId: string;
  name: string;
  email: string;
  role: string;
}

interface Team {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
}

function useResultToast(state: AccessActionResult | null) {
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.message) toast({ title: state.message, tone: "success" });
    if (state?.error) toast({ title: state.error, tone: "error" });
  }, [state, toast]);
}

function GrantForm({ orgSlug, repoName, members, teams, existing }: { orgSlug: string; repoName: string; members: OrgMember[]; teams: Team[]; existing: Grant[] }) {
  const [state, action, pending] = useActionState<AccessActionResult | null, FormData>(setGrantAction, null);
  useResultToast(state);
  const granted = new Set(existing.map((g) => `${g.subjectType}:${g.subjectId}`));
  // Owners and admins already have everything; grants for them would be noise.
  const people = members.filter((m) => m.role !== "owner" && m.role !== "admin" && !granted.has(`user:${m.userId}`));
  const groups = teams.filter((t) => !granted.has(`team:${t.id}`));
  const options = [
    ...groups.map((t) => ({ value: `team:${t.id}`, label: t.name, description: `team · ${t.memberCount} member${t.memberCount === 1 ? "" : "s"}` })),
    ...people.map((m) => ({ value: `user:${m.userId}`, label: m.name, description: `${m.email} · ${m.role}` })),
  ];
  const [subject, setSubject] = useState(options[0]?.value ?? "");
  const [permission, setPermission] = useState<RepoPermission>("push");
  useEffect(() => {
    if (!options.some((o) => o.value === subject)) setSubject(options[0]?.value ?? "");
  }, [options, subject]);
  if (options.length === 0) {
    return (
      <p className="text-sm text-ink-3">
        Everyone in the organization is covered: owners and admins manage every repository, and the other members and teams already have a grant here.
      </p>
    );
  }
  const [subjectType, subjectId] = subject.split(":", 2);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="repoName" value={repoName} />
      <input type="hidden" name="subjectType" value={subjectType} />
      <input type="hidden" name="subjectId" value={subjectId} />
      <input type="hidden" name="permission" value={permission} />
      <Select value={subject} onChange={setSubject} className="min-w-64 flex-1" aria-label="Person or team" options={options} />
      <Select value={permission} onChange={(v) => setPermission(v as RepoPermission)} className="w-40" aria-label="Permission" options={REPO_PERMISSIONS} />
      <Button type="submit" disabled={pending || !subject}>
        <Plus className="size-4" /> Grant
      </Button>
    </form>
  );
}

function GrantRow({ orgSlug, repoName, grant }: { orgSlug: string; repoName: string; grant: Grant }) {
  const [state, setAction, settingPending] = useActionState<AccessActionResult | null, FormData>(setGrantAction, null);
  const [removeState, removeAction, removing] = useActionState<AccessActionResult | null, FormData>(removeGrantAction, null);
  useResultToast(state);
  useResultToast(removeState);
  const [permission, setPermission] = useState<RepoPermission>(grant.permission);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      {grant.subjectType === "user" ? (
        <EntityLogo kind="user" name={grant.label} logo={grant.logo} size={28} />
      ) : (
        <span className="flex size-7 items-center justify-center rounded-lg bg-card-2 text-ink-3">
          <Users className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1 basis-40">
        <div className="truncate text-sm font-medium">
          {grant.label} {grant.subjectType === "team" && <Badge tone="info">team</Badge>}
        </div>
        <div className="truncate text-xs text-ink-2">{grant.detail}</div>
      </div>
      <form ref={formRef} action={setAction} className="contents">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="repoName" value={repoName} />
        <input type="hidden" name="subjectType" value={grant.subjectType} />
        <input type="hidden" name="subjectId" value={grant.subjectId} />
        <input type="hidden" name="permission" value={permission} />
        <Select
          value={permission}
          onChange={(v) => {
            setPermission(v as RepoPermission);
            queueMicrotask(() => formRef.current?.requestSubmit());
          }}
          size="sm"
          align="end"
          className="w-32"
          aria-label={`Permission of ${grant.label}`}
          options={REPO_PERMISSIONS}
        />
      </form>
      <form action={removeAction}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="repoName" value={repoName} />
        <input type="hidden" name="grantId" value={grant.id} />
        <button type="submit" disabled={removing || settingPending} aria-label={`Remove access for ${grant.label}`} className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer">
          <X className="size-4" />
        </button>
      </form>
    </li>
  );
}

/** Repository → Settings → Access: grants on top of the organization roles. */
export function AccessManager({ orgSlug, repoName, grants, members, teams }: { orgSlug: string; repoName: string; grants: Grant[]; members: OrgMember[]; teams: Team[] }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="Access"
          title="Who may do what here"
          description="The organization role is the baseline for every repository: viewers pull, members push, admins and owners manage. A grant raises what one person or one team may do in this repository; it never takes anything away."
        />
        <CardBody className="space-y-4">
          <GrantForm orgSlug={orgSlug} repoName={repoName} members={members} teams={teams} existing={grants} />
          {grants.length > 0 && (
            <ul className="divide-y divide-line border-t border-line">
              {grants.map((g) => (
                <GrantRow key={g.id} orgSlug={orgSlug} repoName={repoName} grant={g} />
              ))}
            </ul>
          )}
          <p className="text-xs text-ink-3">
            Teams are managed under the organization&apos;s{" "}
            <Link href={`/${orgSlug}/teams`} className="underline hover:text-ink">
              Teams
            </Link>{" "}
            tab. Leaving the organization removes a person&apos;s grants and team seats.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
