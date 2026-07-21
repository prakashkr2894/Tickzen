"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "boneyard-js/react";
import { useData } from "@/lib/data-context";
import { KanbanBoard } from "@/components/projects/kanban-board";
import { ProjectHeader } from "@/components/projects/project-header";
import { ProjectCollaborationPanel } from "@/components/projects/project-collaboration-panel";
import { TaskDialog } from "@/components/tasks/task-dialog";
import { CreateTaskDialog } from "@/components/tasks/create-task-dialog";
import type { Task } from "@/lib/types";

export default function ProjectPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { getProjectById } = useData();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [createTaskPanelId, setCreateTaskPanelId] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);

  const project = getProjectById(params.id as string);
  const taskFromRoute = searchParams.get("task")?.trim() || "";
  const selectedTask = useMemo(() => {
    if (!project || !selectedTaskId) return null;
    for (const panel of project.panels) {
      const task = panel.tasks.find((currentTask) => currentTask.id === selectedTaskId);
      if (task) return task;
    }
    return null;
  }, [project, selectedTaskId]);

  useEffect(() => {
    if (taskFromRoute) {
      setSelectedTaskId(taskFromRoute);
    }
  }, [taskFromRoute]);

  useEffect(() => {
    if (!selectedTaskId || !project) return;
    const currentTask = project.panels.flatMap((panel) => panel.tasks).find((task) => task.id === selectedTaskId);
    if (!currentTask) {
      setSelectedTaskId(null);
    }
  }, [project, selectedTaskId]);

  useEffect(() => {
    setShowSkeleton(true);
    const timer = window.setTimeout(() => setShowSkeleton(false), 420);
    return () => window.clearTimeout(timer);
  }, [params.id]);

  if (!project && !showSkeleton) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold">Project not found</h2>
          <p className="mt-2 text-muted-foreground">
            The project you&apos;re looking for doesn&apos;t exist.
          </p>
          <button
            onClick={() => router.push("/dashboard")}
            className="mt-4 text-primary hover:underline"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <Skeleton
      name="project-page"
      loading={showSkeleton}
      animate="shimmer"
      transition={320}
      fixture={
        <div className="space-y-6">
          <div className="h-24 w-full rounded-3xl bg-muted/30" />
          <div className="h-[28rem] w-full rounded-3xl bg-muted/30" />
          <div className="h-64 w-full rounded-3xl bg-muted/30" />
        </div>
      }
      fallback={
        <div className="space-y-4">
          <div className="h-24 w-full rounded-3xl bg-muted/30" />
          <div className="h-[28rem] w-full rounded-3xl bg-muted/30" />
          <div className="h-64 w-full rounded-3xl bg-muted/30" />
        </div>
      }
    >
      {project ? (
        <div className="space-y-6">
          <ProjectHeader project={project} />
          <KanbanBoard
            project={project}
            onTaskClick={(task) => setSelectedTaskId(task.id)}
            onAddTask={setCreateTaskPanelId}
          />

          <ProjectCollaborationPanel project={project} />

          <TaskDialog
            task={selectedTask}
            project={project}
            onClose={() => setSelectedTaskId(null)}
          />

          <CreateTaskDialog
            projectId={project.id}
            panelId={createTaskPanelId}
            onClose={() => setCreateTaskPanelId(null)}
          />
        </div>
      ) : null}
    </Skeleton>
  );
}
