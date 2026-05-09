"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  AskUserQuestionAnswers,
  AskUserQuestionEntry,
  AskUserQuestionOption,
  AskUserQuestionRequest,
} from "@/lib/chat-types";

interface Props {
  request: AskUserQuestionRequest;
  onSubmit: (answers: AskUserQuestionAnswers) => Promise<void>;
  onCancel: () => Promise<void>;
}

// Selection state per question. Single-select stores the picked option's
// raw label string (must match exactly so the SDK can echo it back as the
// tool result). Multi-select stores a Set of labels; we comma-join on
// submit to match the SDK's documented format. The OTHER_LABEL sentinel
// is reserved for the synthetic "Other" option — the actual answer is
// the user's typed string (kept on a parallel state map), never the
// literal "Other".
type Selection = string | Set<string> | undefined;

// Sentinel used in selection state to track the synthetic Other option.
// Picked deliberately to avoid colliding with any real label; the SDK
// docs reserve "Other" for this purpose ("Users will always be able to
// select 'Other' to provide custom text input").
const OTHER_LABEL = "__cm_other__";

export function AskQuestionCard({ request, onSubmit, onCancel }: Props) {
  const [picks, setPicks] = useState<Record<number, Selection>>({});
  // Free text typed into each question's "Other" input. Stored
  // separately from `picks` so a user can type, click another option,
  // come back to Other, and still see what they wrote.
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<"submit" | "cancel" | null>(null);

  const total = request.questions.length;
  const answered = useMemo(
    () => countAnswered(request.questions, picks, otherTexts),
    [request.questions, picks, otherTexts],
  );

  const togglePick = (qIdx: number, q: AskUserQuestionEntry, label: string) => {
    setPicks((prev) => {
      const current = prev[qIdx];
      if (q.multiSelect) {
        const next = new Set(current instanceof Set ? current : []);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return { ...prev, [qIdx]: next };
      }
      // Click-to-toggle on single-select: clicking the picked option
      // again clears it (otherwise the user can never unpick a wrong
      // answer without picking another).
      return {
        ...prev,
        [qIdx]: current === label ? undefined : label,
      };
    });
  };

  const setOtherText = (qIdx: number, q: AskUserQuestionEntry, value: string) => {
    setOtherTexts((prev) => ({ ...prev, [qIdx]: value }));
    // Auto-pick Other once the user starts typing — saves them a
    // click. Only fires when going from empty → non-empty so toggling
    // Other off and continuing to edit doesn't immediately re-toggle.
    const wasEmpty = (otherTexts[qIdx] ?? "").trim().length === 0;
    if (wasEmpty && value.trim().length > 0) {
      setPicks((prev) => {
        const current = prev[qIdx];
        if (q.multiSelect) {
          const next = new Set(current instanceof Set ? current : []);
          next.add(OTHER_LABEL);
          return { ...prev, [qIdx]: next };
        }
        return { ...prev, [qIdx]: OTHER_LABEL };
      });
    }
  };

  const handleSubmit = async () => {
    setBusy("submit");
    try {
      const answers: AskUserQuestionAnswers = {};
      for (let i = 0; i < request.questions.length; i++) {
        const q = request.questions[i];
        const value = computeAnswer(q, picks[i], otherTexts[i]);
        if (value !== null) answers[q.question] = value;
      }
      await onSubmit(answers);
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async () => {
    setBusy("cancel");
    try {
      await onCancel();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border bg-muted/30 p-4 shadow-sm">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">Agent đang hỏi anh</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {answered}/{total} answered
        </span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Chọn từng câu rồi bấm Trả lời. Có thể bỏ qua câu không muốn trả lời.
      </p>

      <div className="space-y-4">
        {request.questions.map((q, i) => (
          <QuestionSection
            key={i}
            index={i}
            total={total}
            question={q}
            selection={picks[i]}
            otherText={otherTexts[i] ?? ""}
            onPick={(label) => togglePick(i, q, label)}
            onOtherTextChange={(v) => setOtherText(i, q, v)}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={handleCancel}
        >
          {busy === "cancel" ? "Đang hủy…" : "Hủy"}
        </Button>
        <Button
          size="sm"
          disabled={busy !== null || answered === 0}
          onClick={handleSubmit}
        >
          {busy === "submit" ? "Đang gửi…" : "Trả lời"}
        </Button>
      </div>
    </div>
  );
}

interface SectionProps {
  index: number;
  total: number;
  question: AskUserQuestionEntry;
  selection: Selection;
  otherText: string;
  onPick: (label: string) => void;
  onOtherTextChange: (value: string) => void;
}

function QuestionSection({
  index,
  total,
  question,
  selection,
  otherText,
  onPick,
  onOtherTextChange,
}: SectionProps) {
  const otherChecked = isPicked(selection, OTHER_LABEL);
  return (
    <section className="rounded-md border bg-background p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        {question.header && (
          <Badge variant="secondary" className="font-mono text-[10px]">
            {question.header}
          </Badge>
        )}
        <span className="font-mono text-[10px] text-muted-foreground">
          Câu {index + 1}/{total}
        </span>
        {question.multiSelect && (
          <Badge variant="outline" className="font-mono text-[10px]">
            chọn nhiều
          </Badge>
        )}
      </div>
      <p className="mb-2 text-sm font-medium leading-snug">
        {question.question}
      </p>
      <div className="space-y-1.5">
        {question.options.map((opt, j) => {
          const checked = isPicked(selection, opt.label);
          return (
            <OptionRow
              key={j}
              option={opt}
              multiSelect={!!question.multiSelect}
              checked={checked}
              onClick={() => onPick(opt.label)}
            />
          );
        })}
        {/* "Other" is always present so the user has an escape hatch
            when none of the proposed options fit. The harness adds it
            automatically for CLI users — we mirror that here. */}
        <OtherRow
          multiSelect={!!question.multiSelect}
          checked={otherChecked}
          text={otherText}
          onPick={() => onPick(OTHER_LABEL)}
          onTextChange={onOtherTextChange}
        />
      </div>
    </section>
  );
}

interface OptionRowProps {
  option: AskUserQuestionOption;
  multiSelect: boolean;
  checked: boolean;
  onClick: () => void;
}

function OptionRow({ option, multiSelect, checked, onClick }: OptionRowProps) {
  const { displayLabel, recommended } = parseLabel(option.label);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border bg-background p-2.5 text-left transition",
        "hover:border-foreground/30 hover:bg-muted/40",
        checked && "border-primary bg-primary/5 ring-1 ring-primary",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
          multiSelect ? "rounded-sm" : "rounded-full",
          checked ? "border-primary bg-primary" : "border-muted-foreground/40",
        )}
      >
        {checked &&
          (multiSelect ? (
            <CheckIcon className="h-3 w-3 text-primary-foreground" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
          ))}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium leading-snug">
            {displayLabel}
          </span>
          {recommended && (
            <Badge className="text-[10px]" variant="default">
              Recommended
            </Badge>
          )}
        </span>
        {option.description && (
          <span className="block text-xs text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
    </button>
  );
}

interface OtherRowProps {
  multiSelect: boolean;
  checked: boolean;
  text: string;
  onPick: () => void;
  onTextChange: (value: string) => void;
}

// OtherRow renders the synthetic "Other" entry alongside the model's
// proposed options. Visually it matches OptionRow, but the description
// slot becomes a text input for the user's free-form answer.
function OtherRow({
  multiSelect,
  checked,
  text,
  onPick,
  onTextChange,
}: OtherRowProps) {
  return (
    <div
      className={cn(
        "flex w-full items-start gap-3 rounded-md border bg-background p-2.5 text-left transition",
        checked
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "hover:border-foreground/30 hover:bg-muted/40",
      )}
    >
      {/* The radio/checkbox toggle is its own button so clicks on the
          input don't accidentally pick (or unpick) the row. */}
      <button
        type="button"
        onClick={onPick}
        aria-pressed={checked}
        aria-label={checked ? "Unpick Other" : "Pick Other"}
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
          multiSelect ? "rounded-sm" : "rounded-full",
          checked ? "border-primary bg-primary" : "border-muted-foreground/40",
        )}
      >
        {checked &&
          (multiSelect ? (
            <CheckIcon className="h-3 w-3 text-primary-foreground" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
          ))}
      </button>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-medium leading-snug">Khác (tự nhập)</div>
        <input
          type="text"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="Nhập câu trả lời tùy ý…"
          className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus:border-ring"
          // Pressing Enter inside the input shouldn't submit the form —
          // there's no <form> here, but base-ui dialogs can swallow Enter
          // for default actions. Stop the bubble to be safe.
          onKeyDown={(e) => e.key === "Enter" && e.stopPropagation()}
        />
      </div>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

// Recommended labels arrive as "Live link — instances mirror gốc (Recommended)".
// We strip the suffix for display and surface a Badge instead, but keep
// the original string when shipping the answer back to the SDK so it can
// match the option exactly.
function parseLabel(label: string): { displayLabel: string; recommended: boolean } {
  const m = /\s*\(Recommended\)\s*$/i.exec(label);
  if (!m) return { displayLabel: label, recommended: false };
  return {
    displayLabel: label.slice(0, m.index).trimEnd(),
    recommended: true,
  };
}

function isPicked(selection: Selection, label: string): boolean {
  if (selection === undefined) return false;
  if (selection instanceof Set) return selection.has(label);
  return selection === label;
}

function countAnswered(
  questions: AskUserQuestionEntry[],
  picks: Record<number, Selection>,
  otherTexts: Record<number, string>,
): number {
  let n = 0;
  for (let i = 0; i < questions.length; i++) {
    if (computeAnswer(questions[i], picks[i], otherTexts[i]) !== null) n++;
  }
  return n;
}

// computeAnswer resolves a single question's selection state into the
// string we'll ship back to the SDK. Returns null when the question is
// effectively unanswered (no picks, or only Other is picked but no
// text was entered). For multi-select with Other + options, the typed
// text gets appended to the comma list.
function computeAnswer(
  q: AskUserQuestionEntry,
  pick: Selection,
  otherText: string | undefined,
): string | null {
  const trimmed = (otherText ?? "").trim();
  if (pick === undefined) return null;
  if (pick instanceof Set) {
    if (pick.size === 0) return null;
    const parts: string[] = [];
    for (const label of pick) {
      if (label === OTHER_LABEL) {
        if (trimmed) parts.push(trimmed);
      } else {
        parts.push(label);
      }
    }
    if (parts.length === 0) return null;
    return parts.join(", ");
  }
  if (pick === OTHER_LABEL) return trimmed || null;
  return pick;
}
