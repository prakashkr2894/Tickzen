"use client";

import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import type { Project, Panel, Task, ProjectRequest, Notification, User } from "./types";
import { useAuth } from "./auth-context";
import { apiRequest, ApiError, getSocketIoBaseUrl, getToken } from "./api";
import { playInvitationSound, playZentrixaPing } from "./notification-sounds";
import { io, Socket } from "socket.io-client";

interface DataContextType {
  projects: Project[];
  requests: ProjectRequest[];
  notifications: Notification[];
  isLoading: boolean;
  createProject: (data: CreateProjectData) => Promise<Project>;
  updateProject: (id: string, data: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  addPanel: (projectId: string, name: string) => Promise<Panel>;
  updatePanel: (projectId: string, panelId: string, data: Partial<Panel>) => Promise<void>;
  deletePanel: (projectId: string, panelId: string) => Promise<void>;
  reorderPanels: (projectId: string, panelOrder: string[]) => Promise<void>;
  createTask: (data: CreateTaskData) => Promise<Task>;
  updateTask: (taskId: string, data: Partial<Task>) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  moveTask: (taskId: string, newPanelId: string, order?: number) => Promise<void>;
  addComment: (taskId: string, content: string) => Promise<void>;
  toggleSubtask: (taskId: string, subtaskId: string) => Promise<void>;
  addSubtask: (taskId: string, title: string) => Promise<void>;
  sendInvitation: (projectId: string, email: string, message?: string) => Promise<void>;
  removeProjectMember: (projectId: string, memberId: string) => Promise<void>;
  respondToRequest: (requestId: string, accept: boolean) => Promise<void>;
  markNotificationRead: (notificationId: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  clearNotifications: (notificationIds?: string[]) => Promise<void>;
  getProjectById: (id: string) => Project | undefined;
  getTaskById: (id: string) => Task | undefined;
  getMyTasks: () => Task[];
  addAdminToProject: (projectId: string, adminId: string) => Promise<void>;
  /** Toggle the current user's star on a project. Updates optimistically. */
  toggleStarProject: (projectId: string) => Promise<void>;
  /** Force a full reload of projects/panels/tasks from the server. */
  refreshProjects: () => Promise<void>;
}

interface CreateProjectData {
  name: string;
  description: string;
  githubRepository?: string;
}

interface CreateTaskData {
  title: string;
  description: string;
  panelId: string;
  projectId: string;
  priority: Task["priority"];
  dueDate?: string;
  assigneeId?: string;
  attachments?: File[];
}

const DataContext = createContext<DataContextType | undefined>(undefined);
const splitName = (name: string) => {
  const parts = (name || "").trim().split(/\s+/);
  return {
    firstName: parts[0] || "User",
    lastName: parts.slice(1).join(" ") || "",
  };
};

const mapApiUser = (user: any): User => {
  if (!user) {
    return {
      id: "",
      email: "",
      firstName: "Deleted",
      lastName: "User",
      role: "developer",
      createdAt: new Date().toISOString(),
    };
  }
  const { firstName, lastName } = splitName(user.name);
  return {
    id: (user.id || user._id || "").toString(),
    email: user.email || "",
    firstName,
    lastName,
    role: user.role === "admin" ? "admin" : "developer",
    createdAt: user.createdAt || new Date().toISOString(),
  };
};

const mapTaskStatus = (task: any, viewerRole?: User["role"]): Task["status"] => {
  if (viewerRole === "developer") {
    if (task?.completedByDeveloper && !task?.approvedByAdmin) return "done";
    if (task?.status === "review") return "done";
  }
  if (task?.status === "completed") return "done";
  if (task?.status === "review") return "review";
  if (task?.status === "in-progress") return "in_progress";
  return "todo";
};

const toApiTaskStatus = (status: Task["status"]): string => {
  if (status === "in_progress") return "in-progress";
  if (status === "review") return "review";
  if (status === "done") return "completed";
  return "pending";
};

const mapAttachment = (attachment: any, index: number, projectId: string, taskId: string) => {
  const filename = attachment?.filename || attachment?.originalName || `attachment-${index + 1}`;
  const fileNameFromPath = typeof attachment?.path === "string"
    ? attachment.path.split(/[\\/]/).pop()
    : "";
  const resolvedFilename = attachment?.filename || fileNameFromPath || filename;

  return {
    id: `${taskId}-attachment-${index}`,
    filename: attachment?.originalName || filename,
    url: attachment?.url || `/uploads/${resolvedFilename}`,
    size: attachment?.size || 0,
    uploadedBy: {
      id: "",
      email: "",
      firstName: "Team",
      lastName: "Member",
      role: "developer" as const,
      createdAt: new Date().toISOString(),
    },
    uploadedAt: attachment?.uploadedAt || new Date().toISOString(),
  };
};

const mapComment = (comment: any, index: number): Task["comments"][number] => ({
  id: comment?._id?.toString() || `comment-${index}`,
  content: comment?.content || "",
  author: mapApiUser(comment?.author || { id: "", name: "Team Member", email: "", role: "developer" }),
  createdAt: comment?.createdAt || new Date().toISOString(),
  updatedAt: comment?.updatedAt || comment?.createdAt || new Date().toISOString(),
});

const mapNotification = (notification: any): Notification => ({
  id: notification._id.toString(),
  userId: notification.userId?.toString() || "",
  sender: notification.senderId ? mapApiUser(notification.senderId) : undefined,
  taskId: notification.taskId?._id?.toString() || notification.taskId?.toString(),
  projectId: notification.projectId?._id?.toString() || notification.projectId?.toString(),
  type: notification.type,
  title: notification.title,
  message: notification.message,
  read: Boolean(notification.read),
  createdAt: notification.createdAt || new Date().toISOString(),
  updatedAt: notification.updatedAt || notification.createdAt || new Date().toISOString(),
});

const shouldPingZentrixa = (notification: Notification) =>
  [
    "task_assigned",
    "comment_mentioned",
    "project_chat_dm",
    "meeting_reminder",
    "project_added",
    "task_overdue",
    "deadline_risk",
    "need_help",
  ].includes(notification.type);

const mapProjectRequest = (request: any, viewer: User): ProjectRequest => ({
  id: request._id.toString(),
  project: {
    id: request.projectId?._id?.toString() || request.projectId?.toString() || "",
    name: request.projectId?.name || "Project",
    description: request.projectId?.description || "",
    status: "active" as const,
    owner: mapApiUser(request.senderId || { id: "", name: "User", email: "", role: "developer" }),
    members: [],
    admins: [],
    panels: [],
    starred: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  sender: request.senderId ? mapApiUser(request.senderId) : mapApiUser({ id: "", name: "User", email: "", role: "developer" }),
  recipient: viewer,
  status: request.status,
  message: request.message,
  createdAt: request.createdAt || new Date().toISOString(),
});

const getPanelStatus = (panelName: string): Task["status"] => {
  const normalized = panelName.toLowerCase();
  if (normalized.includes("progress")) return "in_progress";
  if (normalized.includes("review")) return "review";
  if (normalized.includes("done") || normalized.includes("complete")) return "done";
  return "todo";
};

const canUserModifyTask = (user: User | null, task: Task | undefined) => {
  if (!user || !task) return false;
  if (user.role === "admin") return true;
  return task.reporter.id === user.id;
};

export function DataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [requests, setRequests] = useState<ProjectRequest[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const loadedNotificationsRef = useRef(false);
  const notificationIdsRef = useRef<Set<string>>(new Set());
  const loadedRequestsRef = useRef(false);
  const requestIdsRef = useRef<Set<string>>(new Set());
  const socketRef = useRef<Socket | null>(null);
  const loadProjects = async () => {
    if (!user) return;
    // Single request returns all projects with panels and tasks embedded
    const dashResponse = await apiRequest<{ projects: Array<any>; requests?: Array<any> }>("/projects/dashboard");
    const normalizedProjects = (dashResponse.projects || []).map((apiProject: any) => {
      const projectId = apiProject._id.toString();
      const apiTasks = apiProject.tasks || [];

      const tasksByPanel: Record<string, Task[]> = {};
      apiTasks.forEach((apiTask: any, index: number) => {
        const panelId = apiTask.panelId?.toString() || "";
        const rawAttachments = Array.isArray(apiTask.attachments) && apiTask.attachments.length > 0
          ? apiTask.attachments
          : apiTask.attachmentFile ? [apiTask.attachmentFile] : [];
        if (!tasksByPanel[panelId]) tasksByPanel[panelId] = [];
        tasksByPanel[panelId].push({
          id: apiTask._id.toString(),
          title: apiTask.title,
          description: apiTask.description || "",
          status: mapTaskStatus(apiTask, user?.role),
          priority: apiTask.priority || "medium",
          assignee: apiTask.assignedDeveloper ? mapApiUser(apiTask.assignedDeveloper) : undefined,
          reporter: apiTask.createdBy ? mapApiUser(apiTask.createdBy) : user,
          panelId,
          projectId,
          dueDate: apiTask.deadline ? new Date(apiTask.deadline).toISOString() : undefined,
          attachments: rawAttachments.map((attachment: any, attachmentIndex: number) =>
            mapAttachment(attachment, attachmentIndex, projectId, apiTask._id.toString())
          ),
          comments: Array.isArray(apiTask.comments)
            ? apiTask.comments.map((comment: any, commentIndex: number) => mapComment(comment, commentIndex))
            : [],
          subtasks: [],
          order: typeof apiTask.order === "number" ? apiTask.order : index,
          createdAt: apiTask.createdAt || new Date().toISOString(),
          updatedAt: apiTask.updatedAt || new Date().toISOString(),
        });
      });

      const owner = apiProject.createdBy ? mapApiUser(apiProject.createdBy) : user;
      const developerMembers = (apiProject.developers || [])
        .filter(Boolean)
        .map((dev: any) => ({
          user: mapApiUser(dev),
          role: "member" as const,
          joinedAt: new Date().toISOString(),
        }));
      const members = [{ user: owner, role: "owner" as const, joinedAt: new Date().toISOString() }, ...developerMembers];
      const admins = (apiProject.admins || [])
        .filter(Boolean)
        .map((a: any) => mapApiUser(a));

      return {
        id: projectId,
        name: apiProject.name,
        description: apiProject.description || "",
        githubRepository: apiProject.githubRepository || "",
        status: apiProject.status || "active",
        starred: Array.isArray(apiProject.starredBy)
          ? apiProject.starredBy.some((uid: string) => uid === user?.id || uid?.toString() === user?.id)
          : false,
        owner,
        members,
        admins,
        panels: (apiProject.panels || []).map((p: any) => ({
          id: p._id.toString(),
          name: p.name,
          order: p.order || 0,
          projectId,
          width: p.width || 320,
          height: p.height || 520,
          tasks: (tasksByPanel[p._id.toString()] || []).sort((a, b) => a.order - b.order),
        })),
        createdAt: apiProject.createdAt || new Date().toISOString(),
        updatedAt: apiProject.updatedAt || new Date().toISOString(),
      } as Project;
    });
    setProjects(normalizedProjects);
  };


  const loadRequests = async () => {
    if (!user) return;
    const response = await apiRequest<{ requests: Array<any> }>("/requests/history");
    const normalized = (response.requests || []).map((r: any) => ({
      id: r._id.toString(),
      project: {
        id: r.projectId?._id?.toString() || "",
        name: r.projectId?.name || "Project",
        description: r.projectId?.description || "",
        status: "active" as const,
        owner: user,
        admins: [],
        members: [],
        panels: [],
        starred: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      sender: r.senderId ? mapApiUser(r.senderId) : user,
      recipient: user,
      status: r.status,
      message: r.message,
      createdAt: r.createdAt || new Date().toISOString(),
    }));

    if (loadedRequestsRef.current) {
      for (const request of normalized) {
        const senderRole = request.sender?.role;
        const isNewRequest = !requestIdsRef.current.has(request.id);
        const isIncoming = request.sender?.id !== user.id && request.status === "pending";
        if (isNewRequest && isIncoming) {
          playInvitationSound(senderRole);
        }
      }
    }

    requestIdsRef.current = new Set(normalized.map((request) => request.id));
    loadedRequestsRef.current = true;
    setRequests(normalized);
  };

  const loadNotifications = async () => {
    if (!user) return;
    // Limit to 50 most recent — prevents loading hundreds of stale records
    const response = await apiRequest<{ notifications: Array<any> }>("/notifications?limit=50");
    const nextNotifications = (response.notifications || []).map(mapNotification);
    const nextIds = new Set(nextNotifications.map((notification) => notification.id));

    if (loadedNotificationsRef.current) {
      for (const notification of nextNotifications) {
        if (!notification.read && !notificationIdsRef.current.has(notification.id)) {
          if (shouldPingZentrixa(notification)) {
            playZentrixaPing();
          }
        }
      }
    }

    notificationIdsRef.current = nextIds;
    loadedNotificationsRef.current = true;
    setNotifications(nextNotifications);
  };


  useEffect(() => {
    if (!user || typeof window === "undefined") return;

    const token = getToken();
    if (!token) return;

    const socket = io(getSocketIoBaseUrl(), {
      transports: ["websocket"],
      auth: { token },
    });

    socketRef.current = socket;

    socket.on("notification:new", (payload: { notification?: any }) => {
      const notification = payload?.notification;
      if (!notification?._id) return;
      const mapped = mapNotification(notification);
      setNotifications((current) => {
        if (current.some((item) => item.id === mapped.id)) return current;
        return [mapped, ...current];
      });
      notificationIdsRef.current.add(mapped.id);
      if (shouldPingZentrixa(mapped)) playZentrixaPing();
    });

    socket.on("request:new", (payload: { request?: any }) => {
      const request = payload?.request;
      if (!request?._id) return;
      const mapped = mapProjectRequest(request, user);
      setRequests((current) => {
        if (current.some((item) => item.id === mapped.id)) return current;
        return [mapped, ...current];
      });
      requestIdsRef.current.add(mapped.id);
      playInvitationSound(mapped.sender?.role);
    });

    // Reload project data when the backend signals any mutation.
    // This replaces the 1-second setInterval polling loop — the server
    // now pushes changes instead of the client continuously pulling.
    socket.on("project:updated", () => {
      void loadProjects();
    });

    return () => {
      socketRef.current = null;
      socket.disconnect();
    };
  }, [user]);


  useEffect(() => {
    if (!user) {
      setProjects([]);
      setRequests([]);
      setNotifications([]);
      setIsLoading(false);
      loadedNotificationsRef.current = false;
      notificationIdsRef.current = new Set();
      loadedRequestsRef.current = false;
      requestIdsRef.current = new Set();
      return;
    }
    let isMounted = true;
    setIsLoading(true);

    const initialLoad = async () => {
      try {
        // Load projects+panels+tasks in ONE request, requests and notifications in parallel
        await Promise.all([loadProjects(), loadRequests(), loadNotifications()]);
      } catch (error) {
        if (isMounted) console.error("Failed to load dashboard data:", error);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    void initialLoad();
    // No setInterval — the backend now emits 'project:updated' via Socket.IO
    // whenever data changes, which triggers loadProjects() in the socket useEffect above.

    return () => { isMounted = false; };
  }, [user]);


  const createProject = async (data: CreateProjectData): Promise<Project> => {
    const response = await apiRequest<{ project: any }>("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: data.name,
        description: data.description,
        githubRepository: data.githubRepository || "",
        panels: [{ name: "To Do" }, { name: "In Progress" }, { name: "Done" }],
      }),
    });
    await loadProjects();
    return {
      id: response.project._id.toString(),
      name: response.project.name,
      description: response.project.description || "",
      githubRepository: response.project.githubRepository || data.githubRepository || "",
      status: response.project.status || "active",
      owner: user!,
      admins: [],
      members: [{ user: user!, role: "owner", joinedAt: new Date().toISOString() }],
      panels: [],
      starred: false,
      createdAt: response.project.createdAt || new Date().toISOString(),
      updatedAt: response.project.updatedAt || new Date().toISOString(),
    };
  };

  const updateProject = async (id: string, data: Partial<Project>) => {
    await apiRequest(`/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: data.name,
        description: data.description,
        status: data.status,
        githubRepository: data.githubRepository,
      }),
    });
    await loadProjects();
  };

  const deleteProject = async (id: string) => {
    await apiRequest(`/projects/${id}`, { method: "DELETE" });
    setProjects((prev) => prev.filter((p) => p.id !== id));
  };

  const addPanel = async (projectId: string, name: string): Promise<Panel> => {
    const response = await apiRequest<{ panel: any }>("/panels", {
      method: "POST",
      body: JSON.stringify({ name, projectId }),
    });
    await loadProjects();
    return {
      id: response.panel._id.toString(),
      name: response.panel.name,
      order: response.panel.order || 0,
      projectId,
      width: response.panel.width || 224,
      height: response.panel.height || 364,
      tasks: [],
    };
  };

  const updatePanel = async (_projectId: string, panelId: string, data: Partial<Panel>) => {
    await apiRequest(`/panels/${panelId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: data.name,
        description: (data as { description?: string }).description,
        color: (data as { color?: string }).color,
        order: data.order,
        width: data.width,
        height: data.height,
      }),
    });
    await loadProjects();
  };

  const deletePanel = async (projectId: string, panelId: string) => {
    await apiRequest(`/panels/${panelId}`, { method: "DELETE" });
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, panels: p.panels.filter((panel) => panel.id !== panelId) } : p
      )
    );
  };

  const reorderPanels = async (projectId: string, panelOrder: string[]) => {
    await apiRequest("/panels/reorder", {
      method: "PUT",
      body: JSON.stringify({ projectId, panelOrder }),
    });
    await loadProjects();
  };

  const createTask = async (data: CreateTaskData): Promise<Task> => {
    const hasFiles = Array.isArray(data.attachments) && data.attachments.length > 0;
    const response = hasFiles
      ? await apiRequest<{ task: any }>("/tasks", {
        method: "POST",
        body: (() => {
          const formData = new FormData();
          formData.append("title", data.title);
          formData.append("description", data.description);
          formData.append("projectId", data.projectId);
          formData.append("panelId", data.panelId);
          formData.append("priority", data.priority);
          if (data.assigneeId) formData.append("assignedDeveloper", data.assigneeId);
          if (data.dueDate) formData.append("deadline", data.dueDate);
          data.attachments?.forEach((file) => {
            formData.append("attachments", file);
          });
          return formData;
        })(),
      })
      : await apiRequest<{ task: any }>("/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: data.title,
          description: data.description,
          projectId: data.projectId,
          panelId: data.panelId,
          assignedDeveloper: data.assigneeId,
          priority: data.priority,
          deadline: data.dueDate,
        }),
      });
    await loadProjects();
    const rawAttachments = Array.isArray(response.task.attachments) && response.task.attachments.length > 0
      ? response.task.attachments
      : response.task.attachmentFile
        ? [response.task.attachmentFile]
        : [];
    return {
      id: response.task._id.toString(),
      title: response.task.title,
      description: response.task.description || "",
      status: mapTaskStatus(response.task, user?.role),
      priority: response.task.priority,
      reporter: user!,
      panelId: response.task.panelId?.toString() || data.panelId,
      projectId: response.task.projectId?.toString() || data.projectId,
      dueDate: response.task.deadline ? new Date(response.task.deadline).toISOString() : undefined,
      order: typeof response.task.order === "number" ? response.task.order : 0,
      attachments: rawAttachments.map((attachment: any, attachmentIndex: number) =>
        mapAttachment(attachment, attachmentIndex, data.projectId, response.task._id.toString())
      ),
      comments: Array.isArray(response.task.comments)
        ? response.task.comments.map((comment: any, commentIndex: number) => mapComment(comment, commentIndex))
        : [],
      subtasks: [],
      createdAt: response.task.createdAt || new Date().toISOString(),
      updatedAt: response.task.updatedAt || new Date().toISOString(),
    };
  };

  const updateTask = async (taskId: string, data: Partial<Task>) => {
    const payload: any = {};
    if (data.status) payload.status = toApiTaskStatus(data.status);
    if (data.priority) payload.priority = data.priority;
    if (data.title !== undefined) payload.title = data.title;
    if (data.description !== undefined) payload.description = data.description;
    if (data.dueDate !== undefined) payload.deadline = data.dueDate;
    if (data.panelId) payload.panelId = data.panelId;
    if (data.order !== undefined) payload.order = data.order;
    if (Object.keys(payload).length === 1 && payload.status) {
      await apiRequest(`/tasks/${taskId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: payload.status }),
      });
    } else {
      const task = projects
        .flatMap((project) => project.panels)
        .flatMap((panel) => panel.tasks)
        .find((currentTask) => currentTask.id === taskId);

      if (!canUserModifyTask(user, task)) {
        throw new Error("You cannot modify tasks created by an admin.");
      }

      await apiRequest(`/tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    }
    await loadProjects();
  };

  const deleteTask = async (taskId: string) => {
    const task = projects
      .flatMap((project) => project.panels)
      .flatMap((panel) => panel.tasks)
      .find((currentTask) => currentTask.id === taskId);

    if (!canUserModifyTask(user, task)) {
      throw new Error("You cannot modify tasks created by an admin.");
    }

    await apiRequest(`/tasks/${taskId}`, { method: "DELETE" });
    setProjects((prev) =>
      prev.map((p) => ({
        ...p,
        panels: p.panels.map((panel) => ({
          ...panel,
          tasks: panel.tasks.filter((task) => task.id !== taskId),
        })),
      }))
    );
  };

  const moveTask = async (taskId: string, newPanelId: string, order?: number) => {
    const targetPanel = projects
      .flatMap((project) => project.panels)
      .find((panel) => panel.id === newPanelId);

    if (user?.role === "developer") {
      const panelStatus = targetPanel ? getPanelStatus(targetPanel.name) : "in_progress";
      await apiRequest(`/tasks/${taskId}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          panelId: newPanelId,
          order,
          status: toApiTaskStatus(panelStatus),
        }),
      });
      await loadProjects();
      return;
    }

    await updateTask(taskId, { panelId: newPanelId, order });
  };

  const addComment = async (taskId: string, content: string) => {
    if (!user) return;

    await apiRequest(`/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    await loadProjects();
  };

  const markNotificationRead = async (notificationId: string) => {
    await apiRequest(`/notifications/${notificationId}/read`, { method: "PATCH" });
    await loadNotifications();
  };

  const markAllNotificationsRead = async () => {
    await apiRequest("/notifications/read-all", { method: "PATCH" });
    await loadNotifications();
  };

  const clearNotifications = async (notificationIds?: string[]) => {
    const clearedIds = Array.isArray(notificationIds) ? notificationIds.filter(Boolean) : [];
    await apiRequest("/zentrixa/notifications", {
      method: "DELETE",
      body: JSON.stringify({ clearedIds }),
    });

    setNotifications((current) => {
      if (clearedIds.length === 0) {
        return current.filter((notification) => notification.read);
      }
      const cleared = new Set(clearedIds);
      return current.filter((notification) => !cleared.has(notification.id));
    });

    const nextIds = new Set(notificationIdsRef.current);
    if (clearedIds.length === 0) {
      for (const notification of notifications) {
        if (!notification.read) {
          nextIds.delete(notification.id);
        }
      }
    } else {
      for (const id of clearedIds) nextIds.delete(id);
    }
    notificationIdsRef.current = nextIds;
  };

  const toggleSubtask = async (taskId: string, subtaskId: string) => {
    const task = getTaskById(taskId);

    if (!canUserModifyTask(user, task)) {
      throw new Error("You cannot modify tasks created by an admin.");
    }

    setProjects((prev) =>
      prev.map((p) => ({
        ...p,
        panels: p.panels.map((panel) => ({
          ...panel,
          tasks: panel.tasks.map((task) =>
            task.id === taskId
              ? {
                ...task,
                subtasks: task.subtasks.map((st) =>
                  st.id === subtaskId ? { ...st, completed: !st.completed } : st
                ),
              }
              : task
          ),
        })),
      }))
    );
  };

  const addSubtask = async (taskId: string, title: string) => {
    const task = getTaskById(taskId);

    if (!canUserModifyTask(user, task)) {
      throw new Error("You cannot modify tasks created by an admin.");
    }

    const newSubtask = {
      id: `subtask-${Date.now()}`,
      title,
      completed: false,
    };

    setProjects((prev) =>
      prev.map((p) => ({
        ...p,
        panels: p.panels.map((panel) => ({
          ...panel,
          tasks: panel.tasks.map((task) =>
            task.id === taskId
              ? { ...task, subtasks: [...task.subtasks, newSubtask] }
              : task
          ),
        })),
      }))
    );
  };

  const sendInvitation = async (projectId: string, email: string, message?: string) => {
    if (!user) return;
    // Send email directly — backend resolves the developer internally.
    // Previously this fetched all users just to find one by email.
    await apiRequest(`/projects/${projectId}/invite`, {
      method: "POST",
      body: JSON.stringify({ email, message }),
    });
    await loadRequests();
  };

  const removeProjectMember = async (projectId: string, memberId: string) => {
    await apiRequest(`/projects/${projectId}/members/${memberId}`, {
      method: "DELETE",
    });
    await loadProjects();
  };

  const respondToRequest = async (requestId: string, accept: boolean) => {
    await apiRequest(`/requests/${requestId}/${accept ? "accept" : "reject"}`, {
      method: "PUT",
    });
    await Promise.all([loadProjects(), loadRequests()]);
  };

  const getProjectById = (id: string) => projects.find((p) => p.id === id);

  const addAdminToProject = async (projectId: string, adminId: string) => {
    await apiRequest(`/projects/${projectId}/add-admin`, {
      method: "POST",
      body: JSON.stringify({ adminId }),
    });
    await loadProjects();
  };

  /**
   * Toggle star on a project for the current user.
   * Optimistically flips `starred` in local state immediately,
   * then confirms with the backend. Rolls back on error.
   */
  const toggleStarProject = async (projectId: string) => {
    // Optimistic update
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, starred: !p.starred } : p))
    );
    try {
      await apiRequest(`/projects/${projectId}/star`, { method: "PATCH" });
    } catch (error) {
      // Roll back on failure
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, starred: !p.starred } : p))
      );
      throw error;
    }
  };

  const getTaskById = (id: string): Task | undefined => {
    for (const project of projects) {
      for (const panel of project.panels) {
        const task = panel.tasks.find((t) => t.id === id);
        if (task) return task;
      }
    }
    return undefined;
  };

  const getMyTasks = (): Task[] => {
    if (!user) return [];
    const tasks: Task[] = [];
    for (const project of projects) {
      for (const panel of project.panels) {
        for (const task of panel.tasks) {
          if (task.assignee?.id === user.id || task.reporter.id === user.id) {
            tasks.push(task);
          }
        }
      }
    }
    return tasks;
  };

  return (
    <DataContext.Provider
      value={{
        projects,
        requests,
        notifications,
        isLoading,
        createProject,
        updateProject,
        deleteProject,
        addPanel,
        updatePanel,
        deletePanel,
        reorderPanels,
        createTask,
        updateTask,
        deleteTask,
        moveTask,
        addComment,
        toggleSubtask,
        addSubtask,
        sendInvitation,
        removeProjectMember,
        respondToRequest,
        markNotificationRead,
        markAllNotificationsRead,
        clearNotifications,
        getProjectById,
        getTaskById,
        getMyTasks,
        addAdminToProject,
        toggleStarProject,
        refreshProjects: loadProjects,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const context = useContext(DataContext);
  if (context === undefined) {
    throw new Error("useData must be used within a DataProvider");
  }
  return context;
}
