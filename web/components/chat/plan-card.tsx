"use client";

import { useState } from "react";
import type { PlanRecord } from "@/lib/plan-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

interface Props {
  plan: PlanRecord;
  onApprove: (planId: string) => Promise<void>;
}

export function PlanCard({ plan, onApprove }: Props) {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    try {
      await onApprove(plan.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border bg-muted/30 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{plan.title}</h3>
            <PlanStatusBadge status={plan.status} />
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            plan {plan.id.slice(0, 8)} · {plan.phases.length} phase
            {plan.phases.length === 1 ? "" : "s"}
          </div>
        </div>
        {plan.status !== "approved" && (
          <Button size="sm" onClick={onClick} disabled={busy}>
            {busy ? "Creating worktrees…" : plan.status === "failed" ? "Retry" : "Approve"}
          </Button>
        )}
      </div>

      <ol className="mt-3 space-y-2">
        {plan.phases.map((phase, i) => {
          const wt = plan.worktrees?.find((w) => w.phase_slug === phase.slug);
          return (
            <li key={phase.slug} className="rounded-md border bg-background p-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
                <span className="font-medium">{phase.title}</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {phase.slug}
                </Badge>
                {phase.depends_on?.map((dep) => (
                  <Badge key={dep} variant="secondary" className="font-mono text-[10px]">
                    ← {dep}
                  </Badge>
                ))}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {phase.description}
              </p>
              {wt && (
                <div className="mt-2 font-mono text-xs">
                  <span className="text-muted-foreground">worktree: </span>
                  <span>{wt.path}</span>
                  <span className="mx-1 text-muted-foreground">·</span>
                  <span>{wt.branch}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {plan.status === "failed" && plan.error && (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Worktree creation failed</AlertTitle>
          <AlertDescription className="font-mono text-xs">{plan.error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function PlanStatusBadge({ status }: { status: PlanRecord["status"] }) {
  if (status === "approved") return <Badge>approved</Badge>;
  if (status === "failed") return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="secondary">awaiting approval</Badge>;
}
