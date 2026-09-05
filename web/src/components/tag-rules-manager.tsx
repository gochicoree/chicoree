"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { addTagRule, removeTagRule, type TagRuleResult } from "@/app/actions/tag-rules";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FieldAction, Input } from "@/components/ui/field";
import { ConfirmModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

export interface TagRuleItem {
  id: string;
  pattern: string;
  immutable: boolean;
  protected: boolean;
  repositoryId: string | null;
  createdAt: string;
}

/** Lock badges for a rule's effects; also used next to tag names. */
export function RuleBadges({ immutable, isProtected, title }: { immutable: boolean; isProtected: boolean; title?: string }) {
  return (
    <>
      {immutable && (
        <Badge tone="info" title={title ?? "Immutable: cannot be re-pointed at another image"}>
          <Lock className="size-3" /> immutable
        </Badge>
      )}
      {isProtected && (
        <Badge tone="accent" title={title ?? "Protected: cannot be deleted"}>
          <ShieldCheck className="size-3" /> protected
        </Badge>
      )}
    </>
  );
}

function RemoveRuleButton({ rule }: { rule: TagRuleItem }) {
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function confirm() {
    const data = new FormData();
    data.set("id", rule.id);
    start(async () => {
      const res = await removeTagRule(data);
      if (res.error) toast({ title: "Could not remove the rule", description: res.error, tone: "error" });
      else toast({ title: `Removed rule ${rule.pattern}` });
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Remove rule ${rule.pattern}`}
        className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer pointer-coarse:p-2"
      >
        <Trash2 className="size-4" />
      </button>
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        busy={busy}
        tone="danger"
        confirmLabel={busy ? "Removing…" : "Remove rule"}
        title={`Remove rule ${rule.pattern}?`}
        description={
          rule.protected
            ? "Tags matching this pattern can be deleted again afterwards."
            : "Tags matching this pattern can be re-pointed again afterwards."
        }
      />
    </>
  );
}

function RuleTable({
  rules,
  scope,
  readOnly,
}: {
  rules: TagRuleItem[];
  scope: "organization" | "repository";
  readOnly?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left">
          <th className="px-4 py-2 text-xs font-medium text-ink-2 sm:px-5">Pattern</th>
          <th className="px-4 py-2 text-xs font-medium text-ink-2">Effect</th>
          <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 sm:table-cell">Scope</th>
          {!readOnly && <th className="w-10 px-2 py-2" aria-label="Actions" />}
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => (
          <tr key={rule.id} className="border-b border-line last:border-0">
            <td className="px-4 py-2.5 font-mono text-[13px] font-medium sm:px-5">{rule.pattern}</td>
            <td className="px-4 py-2.5">
              <span className="inline-flex flex-wrap gap-1">
                <RuleBadges immutable={rule.immutable} isProtected={rule.protected} />
              </span>
            </td>
            <td className="hidden px-4 py-2.5 text-xs text-ink-2 sm:table-cell">
              {rule.repositoryId ? "this repository" : scope === "repository" ? "organization-wide" : "every repository"}
            </td>
            {!readOnly && (
              <td className="px-2 py-1.5 text-right">
                <RemoveRuleButton rule={rule} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/**
 * Tag rules card: list, add and remove immutable / protected patterns for
 * an organization or one repository. Repository pages also show the
 * organization-wide rules they inherit, read-only.
 */
export function TagRulesManager({
  scope,
  organizationId,
  repositoryId,
  rules,
  inherited = [],
}: {
  scope: "organization" | "repository";
  organizationId: string;
  repositoryId?: string;
  rules: TagRuleItem[];
  inherited?: TagRuleItem[];
}) {
  const [state, action, pending] = useActionState<TagRuleResult | null, FormData>(addTagRule, null);
  const formRef = useRef<HTMLFormElement>(null);
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.saved) {
      toast({ title: "Tag rule added" });
      formRef.current?.reset();
    }
  }, [state, toast]);

  return (
    <Card>
      <CardHeader
        eyebrow="Tag rules"
        title="Immutable and protected tags"
        description={
          scope === "organization"
            ? "Immutable tags cannot be overwritten; protected tags cannot be deleted. Applies to every repository in the organization."
            : "Immutable tags cannot be overwritten; protected tags cannot be deleted. In addition to the organization's rules."
        }
      />
      {rules.length > 0 ? (
        <div className="overflow-x-auto border-b border-line">
          <RuleTable rules={rules} scope={scope} />
        </div>
      ) : (
        <p className="border-b border-line px-4 py-3 text-sm text-ink-3 sm:px-5">
          No rules yet. For example: <code className="font-mono">v*</code> immutable, <code className="font-mono">latest</code> protected. <code className="font-mono">*</code> matches
          anything, <code className="font-mono">?</code> one character.
        </p>
      )}
      <CardBody>
        <form ref={formRef} action={action} className="flex flex-wrap items-start gap-3">
          <input type="hidden" name="organizationId" value={organizationId} />
          {repositoryId && <input type="hidden" name="repositoryId" value={repositoryId} />}
          <div className="min-w-40 flex-1">
            <Field label="Pattern" htmlFor={`rule-pattern-${scope}`}>
              <Input id={`rule-pattern-${scope}`} name="pattern" required placeholder="v*" className="font-mono" maxLength={128} />
            </Field>
          </div>
          <FieldAction>
            <label className="flex items-center gap-2 py-2 text-sm text-ink-2">
              <input type="checkbox" name="immutable" className="size-4 accent-[var(--action)]" defaultChecked />
              Immutable
            </label>
          </FieldAction>
          <FieldAction>
            <label className="flex items-center gap-2 py-2 text-sm text-ink-2">
              <input type="checkbox" name="protected" className="size-4 accent-[var(--action)]" />
              Protected
            </label>
          </FieldAction>
          <FieldAction>
            <Button type="submit" variant="secondary" disabled={pending}>
              <Plus className="size-4" /> {pending ? "Adding…" : "Add rule"}
            </Button>
          </FieldAction>
          {state?.error && <p className="basis-full text-sm text-danger">{state.error}</p>}
        </form>
      </CardBody>
      {scope === "repository" && inherited.length > 0 && (
        <div className="border-t border-line">
          <div className="px-4 pt-3 sm:px-5">
            <div className="eyebrow">Inherited from the organization</div>
            <p className="mt-0.5 text-xs text-ink-3">Managed under Organization → Settings → Policies.</p>
          </div>
          <div className="overflow-x-auto">
            <RuleTable rules={inherited} scope="repository" readOnly />
          </div>
        </div>
      )}
    </Card>
  );
}
