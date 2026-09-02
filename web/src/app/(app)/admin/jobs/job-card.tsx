"use client";

import { useActionState } from "react";
import { Play } from "lucide-react";
import { runJobAction, type JobActionResult } from "@/app/actions/jobs";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

interface JobInfo {
  name: string;
  title: string;
  description: string;
  params: { name: string; description: string; default: string }[];
}

export function JobCard({ job }: { job: JobInfo }) {
  const [state, action, pending] = useActionState<JobActionResult | null, FormData>(runJobAction, null);
  return (
    <Card>
      <CardHeader eyebrow={job.name} title={job.title} description={job.description} />
      <CardBody>
        <form action={action} className="space-y-3">
          <input type="hidden" name="job" value={job.name} />
          {job.params.map((p) => (
            <Field key={p.name} label={p.name} htmlFor={`${job.name}-${p.name}`} hint={p.description}>
              <Input id={`${job.name}-${p.name}`} name={p.name} placeholder={p.default} className="font-mono" />
            </Field>
          ))}
          <Button type="submit" variant="secondary" disabled={pending}>
            <Play className="size-4" /> {pending ? "Running…" : "Run now"}
          </Button>
          {state?.status === "succeeded" && (
            <p className="rounded-md bg-ok-soft px-3 py-2 font-mono text-xs text-ok">{JSON.stringify(state.result)}</p>
          )}
          {state?.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{state.error}</p>}
        </form>
      </CardBody>
    </Card>
  );
}
