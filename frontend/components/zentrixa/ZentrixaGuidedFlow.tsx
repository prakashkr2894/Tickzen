"use client";

import { useState, useEffect, useRef } from "react";
import { Check, ChevronRight, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export type FlowStepType =
  | "text"
  | "select-project"
  | "select-task"
  | "select-user"
  | "select-status"
  | "textarea";

export type FlowStepDef = {
  key: string;
  question: string;
  type: FlowStepType;
  placeholder?: string;
  optional?: boolean;
};

export type FlowDef = {
  id: string;
  intent: string;
  intro: string;
  steps: FlowStepDef[];
};

export type FlowOption = { id: string; label: string; sub?: string };

export type ActiveFlow = {
  def: FlowDef;
  stepIndex: number;
  collected: Record<string, { id?: string; label: string }>;
};

// ─── Flow Definitions ────────────────────────────────────────────────────────

export const GUIDED_FLOWS: Record<string, FlowDef> = {
  "create task": {
    id: "create_task",
    intent: "create_task",
    intro: "Let's create a task. What should it be called?",
    steps: [
      { key: "title", question: "What's the task name?", type: "text", placeholder: "e.g. Fix login bug" },
      { key: "project", question: "Which project is this for?", type: "select-project" },
      { key: "assignee", question: "Assign to someone? (optional)", type: "select-user", optional: true },
    ],
  },
  "assign task": {
    id: "assign_task",
    intent: "assign_task",
    intro: "Sure! Which task do you want to assign?",
    steps: [
      { key: "task", question: "Which task do you want to assign?", type: "select-task" },
      { key: "assignee", question: "Who should it be assigned to?", type: "select-user" },
    ],
  },
  "change status": {
    id: "move_task",
    intent: "move_task",
    intro: "Which task's status do you want to change?",
    steps: [
      { key: "task", question: "Which task do you want to update?", type: "select-task" },
      { key: "status", question: "What status should it move to?", type: "select-status" },
    ],
  },
  "comment task": {
    id: "comment_task",
    intent: "comment_task",
    intro: "Which task do you want to comment on?",
    steps: [
      { key: "task", question: "Which task do you want to comment on?", type: "select-task" },
      { key: "comment", question: "What's your comment?", type: "textarea", placeholder: "Type your comment here..." },
    ],
  },
  "show overdue tasks": {
    id: "show_delayed",
    intent: "show_delayed",
    intro: "Let me check for overdue tasks...",
    steps: [],
  },
  "create project": {
    id: "create_project",
    intent: "create_project",
    intro: "Let's set up a new project. What should it be called?",
    steps: [
      { key: "name", question: "What's the project name?", type: "text", placeholder: "e.g. Mobile App Redesign" },
    ],
  },
};

const STATUS_OPTIONS: FlowOption[] = [
  { id: "pending", label: "To Do", sub: "Not started yet" },
  { id: "in-progress", label: "In Progress", sub: "Actively being worked on" },
  { id: "review", label: "In Review", sub: "Waiting for approval" },
  { id: "completed", label: "Done", sub: "Completed" },
];

// ─── Step Widget ─────────────────────────────────────────────────────────────

interface GuidedFlowWidgetProps {
  step: FlowStepDef;
  options: FlowOption[];
  loading: boolean;
  onAnswer: (value: { id?: string; label: string }) => void;
  onSkip?: () => void;
}

export function GuidedFlowWidget({
  step,
  options,
  loading,
  onAnswer,
  onSkip,
}: GuidedFlowWidgetProps) {
  const [textValue, setTextValue] = useState("");
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setTextValue("");
    setSearch("");
    const timer = setTimeout(() => {
      (inputRef.current as HTMLElement | null)?.focus();
    }, 80);
    return () => clearTimeout(timer);
  }, [step.key]);

  const filtered = options.filter((opt) => {
    const q = search.toLowerCase();
    return !q || opt.label.toLowerCase().includes(q) || opt.sub?.toLowerCase().includes(q);
  });

  if (step.type === "text") {
    return (
      <div className="w-full rounded-2xl border border-border/60 bg-muted/30 p-3 space-y-2 shadow-sm">
        <Input
          ref={inputRef as React.Ref<HTMLInputElement>}
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          placeholder={step.placeholder || "Type here..."}
          className="rounded-xl border-border/50 bg-background/70 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && textValue.trim()) {
              onAnswer({ label: textValue.trim() });
            }
          }}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            className="h-8 rounded-xl px-4 text-xs flex-1"
            disabled={!textValue.trim()}
            onClick={() => onAnswer({ label: textValue.trim() })}
          >
            Continue <ChevronRight className="ml-1 h-3 w-3" />
          </Button>
          {step.optional && (
            <Button size="sm" variant="ghost" className="h-8 rounded-xl px-3 text-xs" onClick={onSkip}>
              Skip
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (step.type === "textarea") {
    return (
      <div className="w-full rounded-2xl border border-border/60 bg-muted/30 p-3 space-y-2 shadow-sm">
        <Textarea
          ref={inputRef as React.Ref<HTMLTextAreaElement>}
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          placeholder={step.placeholder || "Type here..."}
          className="rounded-xl border-border/50 bg-background/70 text-sm resize-none"
          rows={3}
        />
        <Button
          size="sm"
          className="h-8 w-full rounded-xl text-xs"
          disabled={!textValue.trim()}
          onClick={() => onAnswer({ label: textValue.trim() })}
        >
          Continue <ChevronRight className="ml-1 h-3 w-3" />
        </Button>
      </div>
    );
  }

  if (step.type === "select-status") {
    return (
      <div className="w-full rounded-2xl border border-border/60 bg-muted/30 p-2 shadow-sm space-y-1">
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onAnswer({ id: opt.id, label: opt.label })}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-background/80 active:scale-[0.98]"
          >
            <span className={cn(
              "h-2 w-2 rounded-full shrink-0",
              opt.id === "pending" && "bg-muted-foreground/60",
              opt.id === "in-progress" && "bg-blue-500",
              opt.id === "review" && "bg-amber-500",
              opt.id === "completed" && "bg-green-500",
            )} />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium">{opt.label}</span>
              <span className="block text-[10px] text-muted-foreground">{opt.sub}</span>
            </span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
          </button>
        ))}
      </div>
    );
  }

  // select-project, select-task, select-user
  return (
    <div className="w-full rounded-2xl border border-border/60 bg-muted/30 shadow-sm overflow-hidden">
      {/* Search */}
      <div className="p-2 border-b border-border/40">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
          <Input
            ref={inputRef as React.Ref<HTMLInputElement>}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="pl-8 h-8 rounded-lg border-border/50 bg-background/70 text-xs"
          />
        </div>
      </div>

      {/* Options list */}
      <div className="max-h-44 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading...
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {search ? "No results found" : "Nothing available"}
          </div>
        ) : (
          <div className="p-1.5 space-y-0.5">
            {filtered.map((opt) => (
              <button
                key={opt.id}
                onClick={() => onAnswer({ id: opt.id, label: opt.label })}
                className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-background/80 active:scale-[0.99]"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium truncate">{opt.label}</span>
                  {opt.sub && <span className="block text-[10px] text-muted-foreground truncate">{opt.sub}</span>}
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {step.optional && (
        <div className="p-2 border-t border-border/40">
          <Button size="sm" variant="ghost" className="h-7 w-full rounded-xl text-xs" onClick={onSkip}>
            Skip this step
          </Button>
        </div>
      )}
    </div>
  );
}
