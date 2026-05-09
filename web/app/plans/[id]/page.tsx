import { notFound } from "next/navigation";
import { findPlanById } from "@/lib/server/plans";
import { PhaseBoard } from "@/components/phases/phase-board";

interface Props {
  params: Promise<{ id: string }>;
}

// Server component: resolve the plan from disk on the request boundary
// so the initial paint already has phase/title data — no flash of
// loading skeletons. Live phase status comes client-side via polling
// /api/chat in PhaseBoard.
export default async function PlanPage({ params }: Props) {
  const { id } = await params;
  const plan = await findPlanById(id);
  if (!plan) notFound();
  return <PhaseBoard plan={plan} />;
}
