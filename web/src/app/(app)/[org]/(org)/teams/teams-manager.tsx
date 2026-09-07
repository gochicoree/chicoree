"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { addTeamMemberAction, createTeamAction, deleteTeamAction, removeTeamMemberAction, updateTeamAction, type TeamActionResult } from "@/app/actions/teams";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FieldAction, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { EntityLogo } from "@/components/entity-logo";
import type { LogoRef } from "@/lib/logo-shared";
import { TEAM_NAME_MAX, teamSlugFrom } from "@/lib/repo-access-shared";

interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: string;
  logo?: LogoRef | null;
}

interface Team {
  id: string;
  slug: string;
  name: string;
  description: string;
  memberCount: number;
  createdAt: string;
  members: TeamMember[];
}

interface OrgMember {
  userId: string;
  name: string;
  email: string;
  role: string;
}

function useResultToast(state: TeamActionResult | null) {
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.message) toast({ title: state.message, tone: "success" });
    if (state?.error) toast({ title: state.error, tone: "error" });
  }, [state, toast]);
}

function CreateTeamForm({ orgSlug }: { orgSlug: string }) {
  const [state, action, pending] = useActionState<TeamActionResult | null, FormData>(createTeamAction, null);
  useResultToast(state);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.message) {
      formRef.current?.reset();
      setName("");
      setSlug("");
      setSlugTouched(false);
    }
  }, [state]);
  return (
    <form ref={formRef} action={action} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <Field label="Team name" htmlFor="team-name">
        <Input
          id="team-name"
          name="name"
          required
          maxLength={TEAM_NAME_MAX}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(teamSlugFrom(e.target.value));
          }}
          placeholder="Backend"
        />
      </Field>
      <Field label="Slug" htmlFor="team-slug" hint="Lowercase letters, digits, . _ -">
        <Input
          id="team-slug"
          name="slug"
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          className="font-mono"
          placeholder="backend"
        />
      </Field>
      <FieldAction>
        <Button type="submit" disabled={pending}>
          <Plus className="size-4" /> Create team
        </Button>
      </FieldAction>
      <div className="sm:col-span-3">
        <Field label="Description" htmlFor="team-description" hint="Optional, shown in the list.">
          <Input id="team-description" name="description" placeholder="Owns the API and the workers" />
        </Field>
      </div>
    </form>
  );
}

function AddMemberForm({ orgSlug, team, candidates }: { orgSlug: string; team: Team; candidates: OrgMember[] }) {
  const [state, action, pending] = useActionState<TeamActionResult | null, FormData>(addTeamMemberAction, null);
  useResultToast(state);
  const [userId, setUserId] = useState(candidates[0]?.userId ?? "");
  useEffect(() => {
    if (!candidates.some((c) => c.userId === userId)) setUserId(candidates[0]?.userId ?? "");
  }, [candidates, userId]);
  if (candidates.length === 0) return <p className="text-xs text-ink-3">Every member of the organization is already in this team.</p>;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="teamId" value={team.id} />
      <input type="hidden" name="userId" value={userId} />
      <Select
        value={userId}
        onChange={setUserId}
        size="sm"
        className="min-w-56"
        aria-label={`Add a member to ${team.name}`}
        options={candidates.map((c) => ({ value: c.userId, label: c.name, description: c.email }))}
      />
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !userId}>
        <UserPlus className="size-3.5" /> Add
      </Button>
    </form>
  );
}

function RemoveMemberButton({ orgSlug, team, member }: { orgSlug: string; team: Team; member: TeamMember }) {
  const [state, action, pending] = useActionState<TeamActionResult | null, FormData>(removeTeamMemberAction, null);
  useResultToast(state);
  return (
    <form action={action}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="teamId" value={team.id} />
      <input type="hidden" name="userId" value={member.userId} />
      <button type="submit" disabled={pending} aria-label={`Remove ${member.name} from ${team.name}`} className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer">
        <X className="size-4" />
      </button>
    </form>
  );
}

function DeleteTeamButton({ orgSlug, team }: { orgSlug: string; team: Team }) {
  const [state, action, pending] = useActionState<TeamActionResult | null, FormData>(deleteTeamAction, null);
  useResultToast(state);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Delete the team ${team.name}? Its repository grants go with it; nobody loses their organization membership.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="teamId" value={team.id} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        <Trash2 className="size-3.5" /> Delete team
      </Button>
    </form>
  );
}

function RenameTeamForm({ orgSlug, team, onDone }: { orgSlug: string; team: Team; onDone: () => void }) {
  const [state, action, pending] = useActionState<TeamActionResult | null, FormData>(updateTeamAction, null);
  useResultToast(state);
  useEffect(() => {
    if (state?.message) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="teamId" value={team.id} />
      <Field label="Name" htmlFor={`rename-${team.id}`}>
        <Input id={`rename-${team.id}`} name="name" defaultValue={team.name} required maxLength={TEAM_NAME_MAX} />
      </Field>
      <Field label="Slug" htmlFor={`slug-${team.id}`}>
        <Input id={`slug-${team.id}`} name="slug" defaultValue={team.slug} className="font-mono" />
      </Field>
      <Field label="Description" htmlFor={`desc-${team.id}`}>
        <Input id={`desc-${team.id}`} name="description" defaultValue={team.description} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Organization → Teams: groups of members that repository access can be granted to. */
export function TeamsManager({ orgSlug, canManage, teams, members }: { orgSlug: string; canManage: boolean; teams: Team[]; members: OrgMember[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      {canManage && (
        <Card>
          <CardHeader eyebrow="Access" title="New team" description="A team groups members so a repository can grant access to all of them at once (Repository → Settings → Access)." />
          <CardBody>
            <CreateTeamForm orgSlug={orgSlug} />
          </CardBody>
        </Card>
      )}
      {teams.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-3">
          No teams yet.{canManage ? " Create one above and grant it access to repositories under their Settings → Access." : ""}
        </p>
      ) : (
        teams.map((team) => {
          const inTeam = new Set(team.members.map((m) => m.userId));
          const candidates = members.filter((m) => !inTeam.has(m.userId));
          return (
            <Card key={team.id}>
              <CardHeader
                eyebrow={team.slug}
                title={team.name}
                description={team.description || undefined}
                action={
                  canManage ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(editing === team.id ? null : team.id)}>
                        Edit
                      </Button>
                      <DeleteTeamButton orgSlug={orgSlug} team={team} />
                    </div>
                  ) : undefined
                }
              />
              <CardBody className="space-y-4">
                {editing === team.id && canManage && <RenameTeamForm orgSlug={orgSlug} team={team} onDone={() => setEditing(null)} />}
                {team.members.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-ink-3">
                    <Users className="size-4" /> No members yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {team.members.map((m) => (
                      <li key={m.userId} className="flex flex-wrap items-center gap-3 py-2">
                        <EntityLogo kind="user" name={m.name} logo={m.logo} size={28} />
                        <div className="min-w-0 flex-1 basis-40">
                          <div className="truncate text-sm font-medium">{m.name}</div>
                          <div className="truncate text-xs text-ink-2">{m.email}</div>
                        </div>
                        <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role || "member"}</Badge>
                        {canManage && <RemoveMemberButton orgSlug={orgSlug} team={team} member={m} />}
                      </li>
                    ))}
                  </ul>
                )}
                {canManage && <AddMemberForm orgSlug={orgSlug} team={team} candidates={candidates} />}
              </CardBody>
            </Card>
          );
        })
      )}
    </div>
  );
}
