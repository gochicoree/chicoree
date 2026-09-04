import Link from "next/link";
import { Check, Circle, X } from "lucide-react";
import { clsx } from "clsx";
import type { OnboardingState } from "@/lib/onboarding";
import { dismissOnboarding } from "@/app/actions/onboarding";
import { imageReference } from "@/lib/library";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CommandLine } from "@/components/ui/copy";
import { buttonClasses } from "@/components/ui/button";

/**
 * Three steps to a first push, each ticked automatically from the database.
 * The dashboard renders it until every step is done or the user closes it.
 */
export function OnboardingChecklist({ state, registryHost }: { state: OnboardingState; registryHost: string }) {
  const org = state.orgSlug ?? "<org>";
  const ref = imageReference(registryHost, org, "hello", "latest");
  const steps = [
    {
      key: "org",
      done: state.hasOrg,
      title: "Create or join an organization",
      text: "Organizations are the namespaces images live in; you push to <registry>/<org>/<image>.",
      action: state.hasOrg ? null : (
        <Link href="/orgs/new" className={buttonClasses("secondary", "sm")}>
          New organization
        </Link>
      ),
    },
    {
      key: "token",
      done: state.hasToken,
      title: "Create an access token",
      text: "docker login takes your email as the username and an access token as the password.",
      action: state.hasToken ? null : (
        <Link href="/settings/tokens" className={buttonClasses("secondary", "sm")}>
          Access tokens
        </Link>
      ),
    },
    {
      key: "push",
      done: state.hasPush,
      title: "Push your first image",
      text: "Tag any local image for this registry and push it; the repository is created on the fly.",
      action: state.hasPush ? null : (
        <div className="mt-2 w-full space-y-1.5">
          <CommandLine command={`docker login ${registryHost}`} />
          <CommandLine command={`docker tag alpine ${ref}`} />
          <CommandLine command={`docker push ${ref}`} />
        </div>
      ),
    },
  ];
  const done = steps.filter((s) => s.done).length;

  return (
    <Card className="border-accent/30" >
      <CardHeader
        eyebrow="Getting started"
        title={`${done} of ${steps.length} steps done`}
        description="Set up the registry for your first push. This card goes away once everything is ticked, or when you close it."
        action={
          <form action={dismissOnboarding}>
            <button type="submit" aria-label="Dismiss getting started" data-onboarding-dismiss className={buttonClasses("ghost", "sm")}>
              <X className="size-3.5" /> Dismiss
            </button>
          </form>
        }
      />
      <CardBody>
        <ol className="space-y-4" data-onboarding data-done={done}>
          {steps.map((step, i) => (
            <li key={step.key} className="flex gap-3" data-step={step.key} data-done={step.done ? "true" : "false"}>
              <span
                className={clsx(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                  step.done ? "border-ok bg-ok-soft text-ok" : "border-line-2 text-ink-2",
                )}
                aria-hidden
              >
                {step.done ? <Check className="size-3.5" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className={clsx("text-sm font-medium", step.done ? "text-ink-2 line-through decoration-ink-3" : "text-ink")}>{step.title}</div>
                <p className="mt-0.5 text-[13px] text-ink-2">{step.text}</p>
                {step.action && <div className="mt-2 flex flex-wrap items-center gap-2">{step.action}</div>}
              </div>
              {!step.done && <Circle className="mt-1 hidden size-3 text-ink-3 sm:block" aria-hidden />}
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
