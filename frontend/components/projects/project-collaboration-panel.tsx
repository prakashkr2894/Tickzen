"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { format, parseISO } from "date-fns";
import { apiRequest, getSocketIoBaseUrl, getToken } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useData } from "@/lib/data-context";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, MessageSquare, Search, Send, Video, Users, Plus, Link2, Copy } from "lucide-react";
import { toast } from "sonner";
import type { Meeting, Project, ChatMessage, User } from "@/lib/types";
import { playProjectChatSound } from "@/lib/notification-sounds";
import { io, Socket } from "socket.io-client";

interface ProjectCollaborationPanelProps {
  project: Project;
}

const PUBLIC_CHAT = "public";

const splitName = (name: string) => {
  const parts = (name || "").trim().split(/\s+/);
  return {
    firstName: parts[0] || "User",
    lastName: parts.slice(1).join(" ") || "",
  };
};

const mapUser = (user: any) => {
  const name = user?.name || "";
  const { firstName, lastName } = splitName(name);
  return {
    id: (user?._id || user?.id || "").toString(),
    email: user?.email || "",
    firstName,
    lastName,
    role: (user?.role === "admin" ? "admin" : "developer") as "admin" | "developer",
    createdAt: new Date().toISOString(),
  };
};

const mapChatMessage = (message: any): ChatMessage => ({
  id: (message?._id || message?.id || "").toString(),
  projectId: (message?.projectId?._id || message?.projectId || "").toString(),
  sender: mapUser(message?.senderId),
  recipient: message?.recipientId ? mapUser(message.recipientId) : null,
  content: message?.content || "",
  createdAt: message?.createdAt || new Date().toISOString(),
  updatedAt: message?.updatedAt || message?.createdAt || new Date().toISOString(),
});

const mapMeeting = (meeting: any): Meeting => ({
  id: (meeting?._id || meeting?.id || "").toString(),
  projectId: (meeting?.projectId?._id || meeting?.projectId || "").toString(),
  createdBy: mapUser(meeting?.createdBy),
  title: meeting?.title || "",
  scheduledFor: meeting?.scheduledFor || new Date().toISOString(),
  notes: meeting?.notes || "",
  createdAt: meeting?.createdAt || new Date().toISOString(),
  updatedAt: meeting?.updatedAt || meeting?.createdAt || new Date().toISOString(),
});

const mapAuthUser = (user: any): User => {
  const name = user?.name || `${user?.firstName || "User"} ${user?.lastName || ""}`.trim();
  const parts = name.split(/\s+/);
  return {
    id: (user?._id || user?.id || "").toString(),
    email: user?.email || "",
    firstName: parts[0] || "User",
    lastName: parts.slice(1).join(" ") || "",
    role: (user?.role === "admin" ? "admin" : "developer") as "admin" | "developer",
    createdAt: new Date().toISOString(),
  };
};

export function ProjectCollaborationPanel({ project }: ProjectCollaborationPanelProps) {
  const { user } = useAuth();
  const { notifications } = useData();
  const [conversationWith, setConversationWith] = useState<string>(PUBLIC_CHAT);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatFinderOpen, setChatFinderOpen] = useState(false);
  const [chatFinderQuery, setChatFinderQuery] = useState("");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [typingUsers, setTypingUsers] = useState<Array<{ senderId: string; senderName: string }>>([]);
  const [messageContent, setMessageContent] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [meetingTime, setMeetingTime] = useState("");
  const [meetingNotes, setMeetingNotes] = useState("");
  const [meetingLink, setMeetingLink] = useState("");
  const [meetingLinkInput, setMeetingLinkInput] = useState("");
  const [showLinkPastePrompt, setShowLinkPastePrompt] = useState(false);
  const [dateMode, setDateMode] = useState<"today" | "tomorrow" | "pick" | "">("today");
  const [chatHistoryHeight, setChatHistoryHeight] = useState(260);
  const [isSending, setIsSending] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberSearchOpen, setMemberSearchOpen] = useState(false);
  const typingTimerRef = useRef<number | null>(null);
  const typingClearTimersRef = useRef<Map<string, number>>(new Map());
  const socketRef = useRef<Socket | null>(null);
  const pendingMentionIdsRef = useRef<Set<string>>(new Set());
  const messageRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const chatViewportWrapperRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const chatResizeRef = useRef<{
    startY: number;
    startHeight: number;
  } | null>(null);
  const chatResizeFrameRef = useRef<number | null>(null);
  const pendingChatHeightRef = useRef<number | null>(null);
  const meetingStorageKey = useMemo(() => `zentrixa:meeting-link:${project.id}`, [project.id]);
  const chatHistoryStorageKey = useMemo(() => `zentrixa:chat-height:${project.id}`, [project.id]);

  const members = useMemo(() => {
    const seen = new Set<string>();
    return project.members.filter((member) => {
      if (member.user.id === user?.id) return false;
      if (seen.has(member.user.id)) return false;
      seen.add(member.user.id);
      return true;
    });
  }, [project.members, user?.id]);

  const visibleMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return members;
    return members.filter((member) => {
      const fullName = `${member.user.firstName} ${member.user.lastName}`.toLowerCase();
      return (
        fullName.includes(query) ||
        member.user.email.toLowerCase().includes(query) ||
        member.user.role.toLowerCase().includes(query)
      );
    });
  }, [memberSearch, members]);

  const selectedMemberUnreadCount = useMemo(() => {
    if (conversationWith === PUBLIC_CHAT) return 0;
    return notifications.filter(
      (notification) =>
        notification.projectId === project.id &&
        !notification.read &&
        notification.sender?.id === conversationWith &&
        notification.type === "project_chat_dm"
    ).length;
  }, [conversationWith, notifications, project.id]);

  const publicMentionUnreadCount = useMemo(() => {
    return notifications.filter(
      (notification) =>
        notification.projectId === project.id &&
        !notification.read &&
        notification.type === "comment_mentioned"
    ).length;
  }, [notifications, project.id]);

  const selectedMember = members.find((member) => member.user.id === conversationWith);
  const currentUser = useMemo(() => mapAuthUser(user), [user]);
  const mentionQuery = useMemo(() => {
    const match = messageContent.match(/(?:^|\s)@([\w.-]*)$/);
    return match?.[1] || "";
  }, [messageContent]);
  const mentionSuggestions = useMemo(() => {
    if (!mentionQuery) return [];
    const query = mentionQuery.toLowerCase();
    return members
      .filter((member) => {
        const fullName = `${member.user.firstName} ${member.user.lastName}`.toLowerCase();
        return fullName.includes(query) || member.user.email.toLowerCase().includes(query);
      })
      .slice(0, 5);
  }, [mentionQuery, members]);

  const chatFinderResults = useMemo(() => {
    const query = chatFinderQuery.trim().toLowerCase();
    if (!query) return [];

    return messages.filter((message) => {
      const senderName = `${message.sender.firstName} ${message.sender.lastName}`.toLowerCase();
      const recipientName = message.recipient
        ? `${message.recipient.firstName} ${message.recipient.lastName}`.toLowerCase()
        : "";
      const createdAtText = new Date(message.createdAt).toLocaleString().toLowerCase();
      return (
        message.content.toLowerCase().includes(query) ||
        senderName.includes(query) ||
        recipientName.includes(query) ||
        createdAtText.includes(query)
      );
    });
  }, [chatFinderQuery, messages]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const isFindShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f";
      if (!isFindShortcut) return;
      event.preventDefault();
      setChatFinderOpen(true);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!chatFinderOpen || !chatFinderQuery.trim()) return;
    const firstMatch = chatFinderResults[0];
    if (!firstMatch) return;

    const timer = window.setTimeout(() => {
      messageRefs.current.get(firstMatch.id)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 100);

    return () => window.clearTimeout(timer);
  }, [chatFinderOpen, chatFinderQuery, chatFinderResults]);

  useEffect(() => {
    const viewport = chatViewportWrapperRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLDivElement | null;

    if (!viewport) return;

    const isAtBottom = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;

    shouldAutoScrollRef.current = true;

    const handleScroll = () => {
      shouldAutoScrollRef.current = isAtBottom();
    };

    handleScroll();
    viewport.addEventListener("scroll", handleScroll, { passive: true });

    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [conversationWith]);

  useEffect(() => {
    const viewport = chatViewportWrapperRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLDivElement | null;

    if (!viewport || !shouldAutoScrollRef.current) return;

    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: "smooth",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [messages, conversationWith]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedLink = window.localStorage.getItem(meetingStorageKey);
    if (storedLink) {
      setMeetingLink(storedLink);
    }
  }, [meetingStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (meetingLink) {
      window.localStorage.setItem(meetingStorageKey, meetingLink);
    } else {
      window.localStorage.removeItem(meetingStorageKey);
    }
  }, [meetingLink, meetingStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedHeight = window.localStorage.getItem(chatHistoryStorageKey);
    if (!storedHeight) return;
    const parsed = Number(storedHeight);
    if (!Number.isNaN(parsed)) {
      setChatHistoryHeight(Math.max(220, Math.min(380, parsed)));
    }
  }, [chatHistoryStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(chatHistoryStorageKey, String(chatHistoryHeight));
  }, [chatHistoryHeight, chatHistoryStorageKey]);

  useEffect(() => {
    if (conversationWith !== PUBLIC_CHAT && !selectedMember) {
      setConversationWith(PUBLIC_CHAT);
    }
  }, [conversationWith, selectedMember]);

  useEffect(() => {
    let isMounted = true;
    let refreshTimer: number | null = null;

    const load = async (options?: { silent?: boolean }) => {
      try {
        const chatPath =
          conversationWith === PUBLIC_CHAT
            ? `/projects/${project.id}/chat`
            : `/projects/${project.id}/chat?conversationWith=${conversationWith}`;
        const typingPath =
          conversationWith === PUBLIC_CHAT
            ? `/projects/${project.id}/chat/typing`
            : `/projects/${project.id}/chat/typing?recipientId=${conversationWith}`;

        const [chatResponse, typingResponse, meetingsResponse] = await Promise.all([
          apiRequest<{ messages: Array<any> }>(chatPath),
          apiRequest<{ typingUsers: Array<any> }>(typingPath),
          apiRequest<{ meetings: Array<any> }>(`/projects/${project.id}/meetings`),
        ]);

        if (!isMounted) return;
        setMessages((chatResponse.messages || []).map(mapChatMessage));
        setTypingUsers((typingResponse.typingUsers || []).map((typingUser: any) => ({
          senderId: typingUser.senderId?.toString?.() || "",
          senderName: typingUser.senderName || "Someone",
        })));
        setMeetings((meetingsResponse.meetings || []).map(mapMeeting));
      } catch (error) {
        if (!isMounted) return;
        if (!options?.silent) {
          const message = error instanceof Error ? error.message : "Unable to load collaboration data";
          toast.error(message);
        }
      }
    };

    void load();
    refreshTimer = window.setInterval(() => {
      void load({ silent: true });
    }, 2000);

    return () => {
      isMounted = false;
      if (refreshTimer) {
        window.clearInterval(refreshTimer);
      }
    };
  }, [conversationWith, project.id]);

  useEffect(() => {
    if (!user) return;
    const token = getToken();
    if (!token || typeof window === "undefined" || typeof io === "undefined") {
      return;
    }

    const socket = io(getSocketIoBaseUrl(), {
      transports: ["websocket"],
      auth: { token },
      query: {
        projectId: project.id,
        conversationWith,
      },
    });
    socketRef.current = socket;
    setTypingUsers([]);

    socket.on("chat:message", (payload: any) => {
      try {
        const nextMessage = mapChatMessage(payload);
        const isOwnMessage = nextMessage.sender.id === user?.id;
        const isPublicChat = !nextMessage.recipient;

        if (!isOwnMessage && isPublicChat) {
          playProjectChatSound({
            isPublicChat,
            senderRole: nextMessage.sender.role,
          });
        }

        setMessages((prev) => {
          const withoutDuplicate = prev.filter((message) => message.id !== nextMessage.id);
          return [...withoutDuplicate, nextMessage].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        });
      } catch (error) {
        console.error("Failed to process chat socket event:", error);
      }
    });

    socket.on("chat:typing", (payload: { senderId?: string; senderName?: string }) => {
      if (!payload?.senderId || payload.senderId === user?.id) return;

      setTypingUsers((current) => {
        const next = current.filter((typingUser) => typingUser.senderId !== payload.senderId);
        return [...next, { senderId: payload.senderId, senderName: payload.senderName || "Someone" }];
      });

      const existingTimer = typingClearTimersRef.current.get(payload.senderId);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
      }

      const timer = window.setTimeout(() => {
        setTypingUsers((current) => current.filter((typingUser) => typingUser.senderId !== payload.senderId));
        typingClearTimersRef.current.delete(payload.senderId);
      }, 4000);
      typingClearTimersRef.current.set(payload.senderId, timer);
    });

    socket.on("chat:error", (payload: { message?: string }) => {
      if (payload?.message) {
        console.error("Chat socket error:", payload.message);
      }
    });

    return () => {
      socketRef.current = null;
      typingClearTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      typingClearTimersRef.current.clear();
      socket.disconnect();
    };
  }, [conversationWith, project.id, user]);

  useEffect(() => {
    if (!user || !messageContent.trim()) {
      return;
    }

    if (typingTimerRef.current) {
      window.clearTimeout(typingTimerRef.current);
    }

    const pingTyping = async () => {
      try {
        await apiRequest(`/projects/${project.id}/chat/typing`, {
          method: "POST",
          body: JSON.stringify({
            recipientId: conversationWith === PUBLIC_CHAT ? undefined : conversationWith,
          }),
        });
      } catch {
        // Typing is best-effort and should not block chat.
      }
    };

    typingTimerRef.current = window.setTimeout(() => {
      const socket = socketRef.current;
      if (socket?.connected) {
        socket.emit("chat:typing");
        return;
      }
      void pingTyping();
    }, 250);

    return () => {
      if (typingTimerRef.current) {
        window.clearTimeout(typingTimerRef.current);
      }
    };
  }, [conversationWith, messageContent, project.id, user]);

  const handleSendMessage = async () => {
    if (!messageContent.trim()) return;

    const tempId = `temp-${Date.now()}`;
    const optimisticMessage: ChatMessage = {
      id: tempId,
      projectId: project.id,
      sender: currentUser,
      recipient: conversationWith === PUBLIC_CHAT ? null : selectedMember?.user || null,
      content: messageContent.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    setMessageContent("");
    setTypingUsers([]);

    try {
      setIsSending(true);
      const socket = socketRef.current;
      const mentionedUserIds = Array.from(pendingMentionIdsRef.current);

      if (socket?.connected) {
        socket.emit("chat:message", {
          content: optimisticMessage.content,
          recipientId: conversationWith === PUBLIC_CHAT ? null : conversationWith,
          mentionedUserIds,
        });
      } else {
        const response = await apiRequest<{ chatMessage?: any }>(`/projects/${project.id}/chat`, {
          method: "POST",
          body: JSON.stringify({
            content: optimisticMessage.content,
            recipientId: conversationWith === PUBLIC_CHAT ? undefined : conversationWith,
            mentionedUserIds,
          }),
        });
        if (response.chatMessage) {
          const savedMessage = mapChatMessage(response.chatMessage);
          setMessages((prev) =>
            prev
              .filter((message) => message.id !== tempId && message.id !== savedMessage.id)
              .concat(savedMessage)
              .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
          );
        }
      }
      pendingMentionIdsRef.current.clear();
    } catch (error) {
      setMessages((prev) => prev.filter((message) => message.id !== tempId));
      setMessageContent(optimisticMessage.content);
      const message = error instanceof Error ? error.message : "Unable to send chat message";
      toast.error(message);
    } finally {
      setIsSending(false);
    }
  };

  const handleScheduleMeeting = async () => {
    if (!meetingTitle.trim() || !meetingDate || !meetingTime) {
      toast.error("Add a title, date, and time first.");
      return;
    }

    try {
      setIsScheduling(true);
      await apiRequest(`/projects/${project.id}/meetings`, {
        method: "POST",
        body: JSON.stringify({
          title: meetingTitle,
          scheduledFor: new Date(`${meetingDate}T${meetingTime}:00`).toISOString(),
          notes: meetingNotes,
          meetingLink: meetingLinkInput.trim(),
        }),
      });
      setMeetingTitle("");
      setMeetingDate("");
      setMeetingTime("");
      setMeetingNotes("");
      setMeetingLinkInput("");
      setDateMode("today");
      const response = await apiRequest<{ meetings: Array<any> }>(`/projects/${project.id}/meetings`);
      setMeetings((response.meetings || []).map(mapMeeting));
      toast.success("Meeting scheduled");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to schedule meeting";
      toast.error(message);
    } finally {
      setIsScheduling(false);
    }
  };

  const handleCreateMeeting = () => {
    window.open("https://meet.google.com/new", "_blank", "noopener,noreferrer");
    setShowLinkPastePrompt(true);
    toast.success("Google Meet opened — paste the link below once your meeting room loads.");
  };

  const handlePostMeetingLink = async () => {
    const link = meetingLinkInput.trim() || meetingLink.trim();
    if (!link) return;

    try {
      await apiRequest(`/projects/${project.id}/chat`, {
        method: "POST",
        body: JSON.stringify({
          content: `📅 Meeting link: ${link}`,
          recipientId: undefined,
        }),
      });
      toast.success("Meeting link posted to chat");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to post meeting link";
      toast.error(message);
    }
  };

  const copyMeetingLink = async () => {
    const link = meetingLinkInput.trim() || meetingLink.trim();
    if (!link) return;
    await navigator.clipboard.writeText(link);
    toast.success("Meeting link copied");
  };

  const startChatResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    chatResizeRef.current = {
      startY: event.clientY,
      startHeight: chatHistoryHeight,
    };

    const handleMove = (moveEvent: PointerEvent) => {
      const state = chatResizeRef.current;
      if (!state) return;

      const nextHeight = Math.max(220, Math.min(380, state.startHeight + (moveEvent.clientY - state.startY)));
      pendingChatHeightRef.current = Math.round(nextHeight);

      if (chatResizeFrameRef.current !== null) return;
      chatResizeFrameRef.current = window.requestAnimationFrame(() => {
        chatResizeFrameRef.current = null;
        if (pendingChatHeightRef.current) {
          setChatHistoryHeight(pendingChatHeightRef.current);
        }
      });
    };

    const handleUp = () => {
      chatResizeRef.current = null;
      pendingChatHeightRef.current = null;
      if (chatResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(chatResizeFrameRef.current);
        chatResizeFrameRef.current = null;
      }

      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };

  const insertMention = (memberId: string) => {
    const member = members.find((item) => item.user.id === memberId);
    if (!member) return;

    const mentionLabel = `@${member.user.firstName} ${member.user.lastName}`.trim();
    setMessageContent((current) => {
      const replaced = current.match(/(?:^|\s)@[\w.-]*$/)
        ? current.replace(/(?:^|\s)@[\w.-]*$/, ` ${mentionLabel} `).replace(/^ /, "")
        : `${current}${current && !current.endsWith(" ") ? " " : ""}${mentionLabel} `;
      return replaced;
    });
    pendingMentionIdsRef.current.add(member.user.id);
  };

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
      {/* ── Left Column: Project Chat Workspace ── */}
      <Card className="relative min-w-0 overflow-hidden border-border/70 bg-card/80 backdrop-blur-xl shadow-xl rounded-3xl flex flex-col">
        <CardHeader className="border-b border-border/50 pb-4 pt-5 px-5 sm:px-6 flex flex-row items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/20 shadow-inner">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-lg sm:text-xl font-extrabold tracking-tight text-foreground flex items-center gap-2 truncate">
                Project Chat
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground truncate">
                {conversationWith === PUBLIC_CHAT
                  ? "Public project channel for all team members"
                  : `Private channel with ${selectedMember?.user.firstName} ${selectedMember?.user.lastName}`}
              </CardDescription>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 rounded-full border-border/60 text-xs font-medium bg-background/60 hover:bg-background shadow-xs shrink-0"
            onClick={() => setChatFinderOpen(true)}
          >
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden sm:inline-flex h-4 items-center rounded border border-border bg-muted px-1 text-[9px] font-semibold text-muted-foreground">
              ⌘F
            </kbd>
          </Button>
        </CardHeader>

        <CardContent className="flex flex-col min-w-0 p-4 sm:p-6 space-y-4 flex-1">
          {/* ── Teammates & Conversation Selector ── */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
              <Button
                type="button"
                variant={conversationWith === PUBLIC_CHAT ? "default" : "outline"}
                size="sm"
                className={cn(
                  "h-9 rounded-full px-4 text-xs font-semibold transition-all shrink-0",
                  conversationWith === PUBLIC_CHAT
                    ? "bg-primary text-primary-foreground shadow-md"
                    : "border-border/60 bg-background/60 hover:bg-background"
                )}
                onClick={() => setConversationWith(PUBLIC_CHAT)}
              >
                <Users className="mr-1.5 h-3.5 w-3.5" />
                Everyone
                {publicMentionUnreadCount > 0 && (
                  <span className="ml-2 inline-flex h-2 w-2 rounded-full bg-destructive animate-pulse" />
                )}
              </Button>

              {selectedMember && conversationWith !== PUBLIC_CHAT && (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="h-9 rounded-full px-4 text-xs font-semibold bg-primary text-primary-foreground shadow-md shrink-0"
                  onClick={() => setConversationWith(selectedMember.user.id)}
                >
                  <Avatar className="mr-1.5 h-4 w-4">
                    <AvatarFallback className="text-[9px] bg-primary-foreground/20 text-primary-foreground">
                      {selectedMember.user.firstName.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  {selectedMember.user.firstName} {selectedMember.user.lastName}
                  {selectedMemberUnreadCount > 0 && (
                    <span className="ml-2 inline-flex h-2 w-2 rounded-full bg-destructive animate-pulse" />
                  )}
                </Button>
              )}
            </div>

            {/* Teammate Search Dropdown */}
            <div className="relative w-full sm:w-64 shrink-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={memberSearch}
                onChange={(e) => {
                  setMemberSearch(e.target.value);
                  setMemberSearchOpen(true);
                }}
                onFocus={() => setMemberSearchOpen(true)}
                onBlur={() => {
                  window.setTimeout(() => setMemberSearchOpen(false), 150);
                }}
                placeholder="Direct message teammate..."
                className="h-9 rounded-full border-border/60 bg-background/60 pl-9 text-xs placeholder:text-muted-foreground/70 focus-visible:ring-primary/40"
              />
              {memberSearchOpen && memberSearch.trim() && visibleMembers.length > 0 && (
                <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 max-h-60 overflow-y-auto rounded-2xl border border-border/80 bg-popover/95 p-1 shadow-2xl backdrop-blur-xl">
                  {visibleMembers.map((member) => {
                    const isUnread = notifications.some(
                      (notification) =>
                        notification.projectId === project.id &&
                        !notification.read &&
                        notification.sender?.id === member.user.id &&
                        notification.type === "project_chat_dm"
                    );
                    return (
                      <button
                        key={member.user.id}
                        type="button"
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-muted/70"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          setConversationWith(member.user.id);
                          setMemberSearch("");
                          setMemberSearchOpen(false);
                        }}
                      >
                        <Avatar className="h-8 w-8 border border-border/50">
                          <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">
                            {member.user.firstName.charAt(0)}
                            {member.user.lastName.charAt(0)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-bold text-foreground">
                              {member.user.firstName} {member.user.lastName}
                            </span>
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 capitalize">
                              {member.user.role}
                            </Badge>
                            {isUnread && (
                              <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-primary animate-pulse" />
                            )}
                          </div>
                          <p className="truncate text-[10px] text-muted-foreground">
                            {member.user.email}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {memberSearchOpen && memberSearch.trim() && visibleMembers.length === 0 && (
                <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 rounded-2xl border border-border/80 bg-popover/95 p-3 text-xs text-muted-foreground shadow-2xl backdrop-blur-xl">
                  No teammates match your search.
                </div>
              )}
            </div>
          </div>

          {/* ── Chat Messages Stream Box ── */}
          <div ref={chatViewportWrapperRef} className="relative flex-1 rounded-2xl border border-border/60 bg-muted/20 overflow-hidden shadow-inner">
            <ScrollArea style={{ height: `${chatHistoryHeight}px` }} className="w-full">
              <div className="space-y-4 p-4 sm:p-5">
                {messages.map((message) => {
                  const isMine = message.sender.id === user?.id;
                  return (
                    <div
                      key={message.id}
                      ref={(node) => {
                        messageRefs.current.set(message.id, node);
                      }}
                      className={`flex items-start gap-3 ${isMine ? "flex-row-reverse" : "flex-row"}`}
                    >
                      <Avatar className="h-8 w-8 shrink-0 mt-0.5 border border-border/50 shadow-xs">
                        <AvatarFallback className={cn("text-xs font-bold", isMine ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground")}>
                          {message.sender.firstName.charAt(0)}
                          {message.sender.lastName.charAt(0)}
                        </AvatarFallback>
                      </Avatar>

                      <div className={`flex flex-col max-w-[85%] sm:max-w-[75%] ${isMine ? "items-end" : "items-start"}`}>
                        <div className="flex items-center gap-2 mb-1 px-1 text-[11px] text-muted-foreground">
                          <span className="font-semibold text-foreground/90">
                            {isMine ? "You" : `${message.sender.firstName} ${message.sender.lastName}`}
                          </span>
                          {message.recipient && (
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-medium">
                              Private to {message.recipient.firstName}
                            </Badge>
                          )}
                          <span className="text-[10px] opacity-70">
                            {format(parseISO(message.createdAt), "h:mm a")}
                          </span>
                        </div>

                        <div
                          className={cn(
                            "rounded-2xl px-4 py-2.5 text-xs sm:text-sm leading-relaxed shadow-xs transition-all",
                            isMine
                              ? "bg-primary text-primary-foreground rounded-tr-xs font-normal"
                              : "bg-card border border-border/70 text-foreground rounded-tl-xs shadow-xs"
                          )}
                        >
                          <p className="whitespace-pre-wrap break-words">{message.content}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {messages.length === 0 && (
                  <div className="py-16 text-center text-xs sm:text-sm text-muted-foreground flex flex-col items-center justify-center gap-2">
                    <MessageSquare className="h-8 w-8 opacity-30 text-primary mb-1" />
                    <p className="font-semibold">No messages in this channel yet.</p>
                    <p className="text-xs text-muted-foreground/70">Send a message or @mention a teammate to start collaborating!</p>
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Resize Handle */}
            <button
              type="button"
              onPointerDown={startChatResize}
              className="absolute bottom-1 right-1 h-5 w-5 cursor-nwse-resize rounded-md border border-border/60 bg-background/80 opacity-70 shadow-xs transition hover:opacity-100"
              aria-label="Resize project chat"
              title="Drag to resize chat height"
            >
              <div className="absolute bottom-1 right-1 h-1.5 w-1.5 border-r-2 border-b-2 border-muted-foreground" />
            </button>
          </div>

          {/* Typing Indicator */}
          {typingUsers.length > 0 && (
            <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground animate-fadeIn">
              <span className="inline-flex h-2 w-2 animate-ping rounded-full bg-primary" />
              <span className="font-medium text-primary">
                {typingUsers.map((typingUser) => typingUser.senderName).join(", ")}
                {typingUsers.length === 1 ? " is typing..." : " are typing..."}
              </span>
            </div>
          )}

          {/* ── Chat Input Bar ── */}
          <div className="relative pt-1">
            <div className="flex min-w-0 items-center gap-2 rounded-2xl border border-border/70 bg-background/80 p-1.5 shadow-md backdrop-blur-md focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20 transition-all">
              <Input
                value={messageContent}
                onChange={(e) => setMessageContent(e.target.value)}
                placeholder={
                  conversationWith === PUBLIC_CHAT
                    ? "Type your message or @name to mention..."
                    : `Private message to ${selectedMember?.user.firstName}...`
                }
                className="min-w-0 flex-1 border-0 bg-transparent px-3 text-xs sm:text-sm placeholder:text-muted-foreground/60 focus-visible:ring-0"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendMessage();
                  }
                }}
              />
              <Button
                onClick={handleSendMessage}
                disabled={isSending || !messageContent.trim()}
                size="sm"
                className="h-9 rounded-xl px-4 text-xs font-bold shadow-sm transition-all shrink-0"
              >
                <Send className="h-3.5 w-3.5 mr-1.5" />
                <span>Send</span>
              </Button>
            </div>

            {/* Mention Suggestions Popup */}
            {mentionSuggestions.length > 0 && (
              <div className="absolute bottom-full left-0 z-30 mb-2 w-full max-w-sm overflow-hidden rounded-2xl border border-border/80 bg-popover/95 p-1 shadow-2xl backdrop-blur-xl">
                {mentionSuggestions.map((member) => (
                  <button
                    key={member.user.id}
                    type="button"
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-muted/70"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insertMention(member.user.id);
                    }}
                  >
                    <Avatar className="h-7 w-7 border border-border/50">
                      <AvatarFallback className="text-[10px] font-bold bg-primary/10 text-primary">
                        {member.user.firstName.charAt(0)}
                        {member.user.lastName.charAt(0)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-bold text-foreground">
                          {member.user.firstName} {member.user.lastName}
                        </span>
                        <Badge variant="secondary" className="text-[9px] px-1 py-0 capitalize">
                          {member.user.role}
                        </Badge>
                      </div>
                      <p className="truncate text-[10px] text-muted-foreground">{member.user.email}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Dialog open={chatFinderOpen} onOpenChange={setChatFinderOpen}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Find in chat</DialogTitle>
                <DialogDescription>
                  Search messages, sender names, recipient names, and timestamps. Press Ctrl+F anytime while this chat is open.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  autoFocus
                  value={chatFinderQuery}
                  onChange={(e) => setChatFinderQuery(e.target.value)}
                  placeholder="Search inside chat..."
                />
                <div className="max-h-96 overflow-auto rounded-xl border bg-muted/10">
                  {chatFinderQuery.trim() ? (
                    chatFinderResults.length > 0 ? (
                      <div className="space-y-2 p-3">
                        {chatFinderResults.map((message) => (
                          <button
                            key={message.id}
                            type="button"
                            className="flex w-full items-start gap-3 rounded-xl border bg-background p-3 text-left transition hover:bg-muted/50"
                            onClick={() => {
                              setChatFinderOpen(false);
                              window.setTimeout(() => {
                                messageRefs.current.get(message.id)?.scrollIntoView({
                                  behavior: "smooth",
                                  block: "center",
                                });
                              }, 100);
                            }}
                          >
                            <Avatar className="h-8 w-8">
                              <AvatarFallback className="text-xs">
                                {message.sender.firstName.charAt(0)}
                                {message.sender.lastName.charAt(0)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">
                                  {message.sender.firstName} {message.sender.lastName}
                                </span>
                                {message.recipient && (
                                  <span>Private to {message.recipient.firstName}</span>
                                )}
                                <span>{format(parseISO(message.createdAt), "MMM d, h:mm a")}</span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-sm">{message.content}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="p-6 text-center text-sm text-muted-foreground">
                        No chat results matched your search.
                      </div>
                    )
                  ) : (
                    <div className="p-6 text-center text-sm text-muted-foreground">
                      Type to search the conversation.
                    </div>
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      {/* ── Right Column: Meeting & Schedule Panel ── */}
      <Card className="min-w-0 overflow-hidden border-border/70 bg-card/80 backdrop-blur-xl shadow-xl rounded-3xl flex flex-col">
        <CardHeader className="border-b border-border/50 pb-4 pt-5 px-5 sm:px-6">
          <CardTitle className="text-lg sm:text-xl font-extrabold tracking-tight text-foreground flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/20 shadow-inner">
              <Video className="h-4.5 w-4.5" />
            </div>
            Meeting Schedule
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground mt-1">
            Admins can schedule project meetings for everyone connected to this project.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-4 p-4 sm:p-6 flex-1">
          {user?.role === "admin" ? (
            <>
              {/* Start meeting now — opens Google Meet and shows paste prompt */}
              <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
                <div className="flex max-w-full flex-col gap-2 sm:flex-row">
                  <Button type="button" variant="outline" onClick={handleCreateMeeting} className="max-[767px]:text-[1rem]">
                    <Plus className="mr-2 h-4 w-4 max-[767px]:h-5 max-[767px]:w-5" />
                    Start Meeting Now
                  </Button>
                  <Button onClick={handleScheduleMeeting} disabled={isScheduling} className="max-[767px]:text-[1rem]">
                    <Calendar className="mr-2 h-4 w-4 max-[767px]:h-5 max-[767px]:w-5" />
                    {isScheduling ? "Scheduling..." : "Schedule Meeting"}
                  </Button>
                </div>

                {/* Meeting title */}
                <Input
                  value={meetingTitle}
                  onChange={(e) => setMeetingTitle(e.target.value)}
                  placeholder="Meeting title"
                />

                {/* Date quick-picks */}
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {(["today", "tomorrow", "pick"] as const).map((mode) => {
                      const label = mode === "today" ? "Today" : mode === "tomorrow" ? "Tomorrow" : "Pick Date";
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => {
                            setDateMode(mode);
                            if (mode === "today") {
                              const d = new Date();
                              setMeetingDate(d.toISOString().split("T")[0]);
                            } else if (mode === "tomorrow") {
                              const d = new Date();
                              d.setDate(d.getDate() + 1);
                              setMeetingDate(d.toISOString().split("T")[0]);
                            } else {
                              setMeetingDate("");
                            }
                          }}
                          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                            dateMode === mode
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background hover:bg-muted/60"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {dateMode === "pick" && (
                    <Input
                      type="date"
                      value={meetingDate}
                      onChange={(e) => setMeetingDate(e.target.value)}
                      className="max-w-[200px]"
                    />
                  )}
                  {meetingDate && (
                    <p className="text-xs text-muted-foreground">
                      Date: {new Date(meetingDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                    </p>
                  )}
                </div>

                {/* Time picker */}
                <Input
                  type="time"
                  value={meetingTime}
                  onChange={(e) => setMeetingTime(e.target.value)}
                  className="max-w-[160px]"
                />

                {/* Notes */}
                <Textarea
                  value={meetingNotes}
                  onChange={(e) => setMeetingNotes(e.target.value)}
                  placeholder="Notes or agenda..."
                  rows={2}
                />

                {/* Meeting link input (in form) */}
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Meeting Link (optional)</label>
                  <Input
                    value={meetingLinkInput}
                    onChange={(e) => setMeetingLinkInput(e.target.value)}
                    placeholder="Paste Google Meet / Zoom link here..."
                  />
                </div>
              </div>

              {/* Paste prompt — appears after clicking Start Meeting Now */}
              {showLinkPastePrompt && (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Link2 className="h-4 w-4" />
                      Paste your meeting link
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowLinkPastePrompt(false)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      ✕
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Google Meet opened in a new tab. Once your room loads, copy the link from the address bar and paste it below.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={meetingLink}
                      onChange={(e) => setMeetingLink(e.target.value)}
                      placeholder="https://meet.google.com/abc-defg-hij"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={copyMeetingLink}
                      disabled={!meetingLink.trim()}
                    >
                      <Copy className="mr-1 h-3.5 w-3.5" />
                      Copy
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handlePostMeetingLink()}
                      disabled={!meetingLink.trim()}
                    >
                      <MessageSquare className="mr-1 h-3.5 w-3.5" />
                      Post to Chat
                    </Button>
                  </div>
                </div>
              )}

              {/* Persistent meeting link display (when link set but paste prompt hidden) */}
              {meetingLink && !showLinkPastePrompt && (
                <div className="max-w-[32rem] rounded-xl border bg-background p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Link2 className="h-4 w-4" />
                    Meeting link
                  </div>
                  <div className="mt-2 flex max-w-full flex-col gap-2 sm:flex-row">
                    <Input
                      value={meetingLink}
                      onChange={(e) => setMeetingLink(e.target.value)}
                      placeholder="https://meet.google.com/..."
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" onClick={copyMeetingLink} className="max-[767px]:text-[1rem]">
                      <Copy className="mr-2 h-4 w-4" />
                      Copy
                    </Button>
                    <Button type="button" onClick={() => void handlePostMeetingLink()} className="max-[767px]:text-[1rem]">
                      <MessageSquare className="mr-2 h-4 w-4" />
                      Post to chat
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground">
              Meeting scheduling is available to admins. You can still view the upcoming meetings below.
            </div>
          )}

          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 max-[767px]:h-5 max-[767px]:w-5" />
              <p className="text-sm font-medium max-[767px]:text-[1rem]">Upcoming Meetings</p>
            </div>
            <ScrollArea className="h-[180px] max-w-full rounded-lg border">
              <div className="space-y-2 p-3">
                {meetings.map((meeting) => (
                  <div key={meeting.id} className="rounded-xl border p-3 space-y-1">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{meeting.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {format(parseISO(meeting.scheduledFor), "MMM d, yyyy 'at' h:mm a")}
                        </p>
                      </div>
                      <Badge variant="outline">
                        {meeting.createdBy.firstName}
                      </Badge>
                    </div>
                    {meeting.notes && (
                      <p className="text-sm text-muted-foreground">{meeting.notes}</p>
                    )}
                    {(meeting as any).meetingLink && (
                      <a
                        href={(meeting as any).meetingLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Link2 className="h-3 w-3" />
                        Join meeting
                      </a>
                    )}
                  </div>
                ))}
                {meetings.length === 0 && (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    No meetings scheduled yet.
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
