"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bot, ChevronDown, ChevronRight, Loader2, Mic, MicOff, Pencil, Save, Send, Square, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useVoiceRecognition } from "@/hooks/use-voice-recognition";
import { useVoiceAction } from "@/hooks/use-voice-action";
import { useAuth } from "@/lib/auth-context";
import { useData } from "@/lib/data-context";
import {
  playZentrixaListeningCue,
  playZentrixaReplyCue,
  playZentrixaThinkingCue,
} from "@/lib/notification-sounds";
import {
  type ZentrixaContext,
  type ZentrixaAction,
  confirmZentrixaCommand,
  dispatchZentrixaCommand,
  getZentrixaMessages,
  sendZentrixaChat,
} from "@/lib/zentrixa-api";
import { ZentrixaAiRing } from "./ZentrixaAiRing";
import { ZentrixaTypingDots } from "./ZentrixaTyping";
import { GUIDED_FLOWS, GuidedFlowWidget, type ActiveFlow, type FlowOption } from "./ZentrixaGuidedFlow";

type Message = {
  id: string;
  role: "assistant" | "user";
  content: string;
  /** Source of the AI reply — used to render the colored dot indicator */
  path?: "local" | "llm" | "guided";
  createdAt?: string;
};
type ProjectLookup = (id: string) => { name?: string } | undefined;
type ZentrixaAiMode = "thinking" | "listening" | "replying" | null;
type PendingConfirmation = {
  command: string;
  message: string;
  payload: Record<string, unknown>;
};

type DeveloperOption = {
  id: string;
  name: string;
  email: string;
};

const QUICK_COMMANDS = [
  "create task",
  "assign task",
  "change status",
  "comment task",
  "show overdue tasks",
  "create project",
];

const buildProjectContext = (
  context: ZentrixaContext | undefined,
  routeProjectId: string | undefined,
  getProjectById: ProjectLookup
) => {
  const projectId = context?.projectId || routeProjectId || undefined;
  const project = projectId ? getProjectById(projectId) : undefined;

  return {
    projectId,
    projectName: project?.name,
  };
};

export function ZentrixaAssistant({ context }: { context?: ZentrixaContext }) {
  const { user } = useAuth();
  const { getProjectById, projects, refreshProjects } = useData();
  const pathname = usePathname();

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showNewMessagesPill, setShowNewMessagesPill] = useState(false);

  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const isInitialScrollDoneRef = useRef(false);
  const [aiMode, setAiMode] = useState<ZentrixaAiMode>(null);
  const [manualVoiceExit, setManualVoiceExit] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<Record<string, unknown> | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [voiceTranscript, setVoiceTranscript] = useState<string>("");
  const [voiceReply, setVoiceReply] = useState<string>("");
  const [confirmationEditMode, setConfirmationEditMode] = useState(false);
  const [confirmationDraftTitle, setConfirmationDraftTitle] = useState("");
  const [confirmationDraftDescription, setConfirmationDraftDescription] = useState("");
  const [confirmationDescriptionEditMode, setConfirmationDescriptionEditMode] = useState(false);
  const [developers, setDevelopers] = useState<DeveloperOption[]>([]);
  const [developerSearch, setDeveloperSearch] = useState("");
  const [selectedDeveloperId, setSelectedDeveloperId] = useState("");
  const [loadingDevelopers, setLoadingDevelopers] = useState(false);

  // ── Guided flow state ──────────────────────────────────────────────────────
  const [activeFlow, setActiveFlow] = useState<ActiveFlow | null>(null);
  const [flowOptions, setFlowOptions] = useState<FlowOption[]>([]);
  const [flowOptionsLoading, setFlowOptionsLoading] = useState(false);
  // Pending confirmation before dispatching a guided flow action
  const [pendingGuidedExecution, setPendingGuidedExecution] = useState<{
    def: ActiveFlow["def"];
    collected: ActiveFlow["collected"];
    summary: string;
  } | null>(null);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const openFrameRef = useRef<number | null>(null);
  const replyModeTimerRef = useRef<number | null>(null);
  const pendingResponseRef = useRef(false);
  const voiceSessionRef = useRef(false);
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const startListeningRef = useRef<(() => void) | null>(null);
  const pendingConfirmationRef = useRef<PendingConfirmation | null>(null);

  useEffect(() => {
    pendingConfirmationRef.current = pendingConfirmation;
  }, [pendingConfirmation]);

  const routeProjectId = useMemo(() => {
    const match = pathname?.match(/^\/projects\/([^/?#]+)/);
    return match?.[1];
  }, [pathname]);

  const activeProject = useMemo(
    () => buildProjectContext(context, routeProjectId, getProjectById),
    [context, getProjectById, routeProjectId]
  );

  const clearReplyModeTimer = () => {
    if (replyModeTimerRef.current !== null) {
      window.clearTimeout(replyModeTimerRef.current);
      replyModeTimerRef.current = null;
    }
  };

  const showReplyModeBriefly = () => {
    clearReplyModeTimer();
    setAiMode("replying");
    replyModeTimerRef.current = window.setTimeout(() => {
      setAiMode((current) => (current === "replying" ? null : current));
      replyModeTimerRef.current = null;
    }, 900);
  };

  const cachedVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const updateCachedVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices || voices.length === 0) return;
      const savedVoiceURI = typeof localStorage !== "undefined" ? localStorage.getItem("zentrixa_voice_uri") : null;
      let chosen = savedVoiceURI ? voices.find((v) => v.voiceURI === savedVoiceURI) : null;
      if (!chosen) {
        chosen =
          voices.find((v) => (v.name.includes("Natural") || v.name.includes("Google") || v.name.includes("Neural") || v.name.includes("Samantha")) && v.lang.startsWith("en")) ||
          voices.find((v) => v.lang.startsWith("en-US") || v.lang.startsWith("en-GB") || v.lang.startsWith("en"));
      }
      if (chosen) {
        cachedVoiceRef.current = chosen;
      }
    };

    updateCachedVoice();
    window.speechSynthesis.onvoiceschanged = updateCachedVoice;
  }, []);

  const getBestVoice = (): SpeechSynthesisVoice | null => {
    if (typeof window === "undefined" || !window.speechSynthesis) return null;
    if (cachedVoiceRef.current) return cachedVoiceRef.current;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    const savedVoiceURI = typeof localStorage !== "undefined" ? localStorage.getItem("zentrixa_voice_uri") : null;
    let chosen = savedVoiceURI ? voices.find((v) => v.voiceURI === savedVoiceURI) : null;
    if (!chosen) {
      chosen =
        voices.find((v) => (v.name.includes("Natural") || v.name.includes("Google") || v.name.includes("Neural") || v.name.includes("Samantha")) && v.lang.startsWith("en")) ||
        voices.find((v) => v.lang.startsWith("en-US") || v.lang.startsWith("en-GB") || v.lang.startsWith("en"));
    }
    if (chosen) {
      cachedVoiceRef.current = chosen;
    }
    return chosen || voices[0] || null;
  };

  const stopSpeaking = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    speechUtteranceRef.current = null;
  };

  const speakReply = (text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    // Sanitize text for clean spoken prose (strip markdown stars, hashes, code blocks)
    const cleanedText = text
      .replace(/[*#_`~>]/g, "")
      .replace(/https?:\/\/\S+/g, "link")
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}]/gu, "")
      .trim();

    if (!cleanedText) return;

    // STOP MIC FIRST so Bluetooth headsets don't switch AG Hands-Free / A2DP audio profiles mid-speech!
    stopListening();
    stopSpeaking();

    setAiMode("replying");
    setVoiceReply(cleanedText);

    const utterance = new SpeechSynthesisUtterance(cleanedText);
    const chosenVoice = getBestVoice();

    if (chosenVoice) {
      utterance.voice = chosenVoice;
      utterance.lang = chosenVoice.lang;
    } else {
      utterance.lang = "en-US";
    }

    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    speechUtteranceRef.current = utterance;

    utterance.onend = () => {
      if (speechUtteranceRef.current === utterance) {
        speechUtteranceRef.current = null;
      }
      if (voiceSessionRef.current) {
        pendingResponseRef.current = false;
        window.setTimeout(() => {
          if (voiceSessionRef.current) {
            try {
              setAiMode("listening");
              startListeningRef.current?.();
            } catch {
              // Ignore mic restart errors — voice session stays active
            }
          }
        }, 300);
      }
    };

    utterance.onerror = () => {
      speechUtteranceRef.current = null;
      if (voiceSessionRef.current) {
        pendingResponseRef.current = false;
        setAiMode("listening");
        startListeningRef.current?.();
      }
    };

    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (openFrameRef.current !== null) {
        window.cancelAnimationFrame(openFrameRef.current);
      }
      openFrameRef.current = window.requestAnimationFrame(() => {
        setPanelVisible(true);
        openFrameRef.current = null;
      });
      return;
    }

    // Panel is closing — reset so next open reloads fresh history from DB
    setHistoryLoaded(false);
    setMessages([]);  // clear so stale messages don't flash on next open
    setPanelVisible(false);
    if (openFrameRef.current !== null) {
      window.cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }

    closeTimerRef.current = window.setTimeout(() => {
      setMounted(false);
      closeTimerRef.current = null;
    }, 240);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // Keep panel open when clicking inside the Zentrixa shell
      if (shellRef.current?.contains(target)) return;
      // Keep panel open when clicking navigation elements (sidebar links, anchors, etc.)
      const el = target as Element;
      if (
        el.closest("a") ||
        el.closest("[data-sidebar]") ||
        el.closest("nav") ||
        el.closest("[role='navigation']") ||
        el.closest("[data-slot='sidebar']")
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // ── 1. Initial Load: Fetch latest 5 messages on open ───────────────────────
  useEffect(() => {
    if (!open || !user || historyLoaded) return;
    let cancelled = false;

    const loadInitialHistory = async () => {
      try {
        const res = await getZentrixaMessages(null, 5);
        if (cancelled) return;

        // Backend returns descending (newest first); reverse to render chronologically
        const chronMessages: Message[] = [...res.messages].reverse().map((item) => ({
          id: item.id,
          role: item.role as "user" | "assistant",
          content: item.content,
          path: item.role === "assistant" ? (item.mode === "command" ? "local" : "llm") : undefined,
          createdAt: item.createdAt,
        }));

        setMessages(chronMessages);
        setHasMoreHistory(res.hasMore);
        setNextCursor(res.nextCursor);
      } catch (err) {
        if (process.env.NODE_ENV !== "production") console.error("History load error", err);
      } finally {
        if (!cancelled) {
          setHistoryLoaded(true);
          isInitialScrollDoneRef.current = false;
        }
      }
    };

    void loadInitialHistory();
    return () => { cancelled = true; };
  }, [open, user, historyLoaded]);

  const isLoadingHistoryRef = useRef(false);

  // Lock body scroll while Zentrixa Assistant panel is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // ── 2. Upward Infinite Scroll: Fetch older messages when top threshold is reached ───
  const fetchOlderMessages = async () => {
    if (!hasMoreHistory || !nextCursor || loadingOlder || isLoadingHistoryRef.current) return;

    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    isLoadingHistoryRef.current = true;
    setLoadingOlder(true);

    const oldScrollHeight = viewport.scrollHeight;
    const oldScrollTop = viewport.scrollTop;

    try {
      const res = await getZentrixaMessages(nextCursor, 10);

      const olderChron: Message[] = [...res.messages].reverse().map((item) => ({
        id: item.id,
        role: item.role as "user" | "assistant",
        content: item.content,
        path: item.role === "assistant" ? (item.mode === "command" ? "local" : "llm") : undefined,
        createdAt: item.createdAt,
      }));

      setMessages((prev) => [...olderChron, ...prev]);
      setHasMoreHistory(res.hasMore);
      setNextCursor(res.nextCursor);

      // Preserve exact scroll position so viewport doesn't jump
      requestAnimationFrame(() => {
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight - oldScrollHeight + oldScrollTop;
        }
      });
    } catch (err) {
      if (process.env.NODE_ENV !== "production") console.error("Error loading older messages", err);
    } finally {
      setLoadingOlder(false);
      isLoadingHistoryRef.current = false;
    }
  };

  // ── 3. Handle Scroll Events ────────────────────────────────────────────────
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    scrollViewportRef.current = target;

    // Check if near bottom (< 80px)
    const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
    isNearBottomRef.current = isNearBottom;

    if (isNearBottom && showNewMessagesPill) {
      setShowNewMessagesPill(false);
    }

    // Trigger infinite load when user reaches top threshold (scrollTop <= 20px)
    if (target.scrollTop <= 20 && hasMoreHistory && !loadingOlder && !isLoadingHistoryRef.current) {
      void fetchOlderMessages();
    }
  };


  const scrollToBottom = () => {
    if (scrollViewportRef.current) {
      scrollViewportRef.current.scrollTop = scrollViewportRef.current.scrollHeight;
    }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const scrollToBottomInstant = () => {
    if (scrollViewportRef.current) {
      scrollViewportRef.current.scrollTop = scrollViewportRef.current.scrollHeight;
    }
    endRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
  };

  // Strip ALL punctuation before matching so "Yes.", "Yes!", "Sure!" all work correctly
  const stripPunct = (value: string) => value.trim().replace(/[.!?,;:]+/g, "").trim();
  const isAffirmativeReply = (value: string) => /^(yes|yep|yeah|confirm|do it|add|proceed|ok|okay|sure|yes please|absolutely|go ahead|definitely)$/i.test(stripPunct(value));
  const isNegativeReply = (value: string) => /^(no|nope|cancel|stop|never mind|nevermind|don't|dont|nah|negative|abort)$/i.test(stripPunct(value));

  const postAssistantMessage = (content: string, path?: Message["path"]) => {
    const newMessage: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "assistant",
      content,
      path,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, newMessage]);
    if (!isNearBottomRef.current) {
      setShowNewMessagesPill(true);
    }
  };

  const sendConfirmationDecision = async (
    confirmed: boolean,
    label: string,
    payloadOverride?: Record<string, unknown>
  ) => {
    if (!pendingConfirmation || !user) return;
    const payload = payloadOverride || pendingConfirmation.payload;

    setLoading(true);
    setIsThinking(true);
    setAiMode("thinking");
    pendingResponseRef.current = true;
    setMessages((current) => [...current, { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "user", content: label, createdAt: new Date().toISOString() }]);

    try {
      // ── Voice-originated confirmation: re-call /voice/process with confirmed=true ──
      const isVoiceConfirm = Boolean(payload._voiceTranscript);
      let replyText: string;

      if (isVoiceConfirm && confirmed) {
        // If user edited the title/name in the confirmation box, use updated payload name
        const updatedTitle = (payload.title || payload.project_name || payload.projectName || payload.name) as string | undefined;
        const voiceText = (payload._voiceTranscript as string) || (updatedTitle ? `create project ${updatedTitle}` : "");

        const voiceRes = await apiRequest<{ reply: string; message?: string; executed: boolean }>(
          "/zentrixa/voice/process",
          {
            method: "POST",
            body: JSON.stringify({
              text:      voiceText,
              context:   {
                ...context,
                ...activeProject,
                ...(updatedTitle ? { name: updatedTitle, title: updatedTitle, project_name: updatedTitle } : {}),
              },
              confirmed: true,
            }),
          }
        );
        replyText = voiceRes.reply || voiceRes.message || "Done!";
        void refreshProjects();
      } else if (isVoiceConfirm && !confirmed) {
        replyText = "No problem! Let me know if you need anything else.";
      } else {
        // ── Text-chat confirmation ────────────────────────────────────────────
        const result = await confirmZentrixaCommand({
          confirmed,
          text: label,
          payload,
          context: {
            ...context,
            ...activeProject,
            pendingCommand,
          },
        });
        replyText = result.reply || result.message || "I'm here with you.";
      }

      playZentrixaReplyCue();
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      showReplyModeBriefly();
      postAssistantMessage(replyText, "local");
      setPendingConfirmation(null);
      setPendingCommand(null);
      if (voiceSessionRef.current) {
        // In voice mode: speak reply — onend will auto-restart mic for seamless conversation
        speakReply(replyText);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "I couldn't complete that.";
      postAssistantMessage(message, "local");
      toast.error(message);
      // On error in voice mode, re-open mic so user can try again
      if (voiceSessionRef.current) {
        pendingResponseRef.current = false;
        window.setTimeout(() => {
          if (voiceSessionRef.current) {
            setAiMode("listening");
            startListeningRef.current?.();
          }
        }, 600);
      }
    } finally {
      setIsThinking(false);
      setLoading(false);
      if (!voiceSessionRef.current) {
        pendingResponseRef.current = false;
      }
      scrollToBottom();
    }
  };

  useEffect(() => {
    if (!pendingConfirmation) {
      setConfirmationEditMode(false);
      setConfirmationDraftTitle("");
      setConfirmationDraftDescription("");
      setConfirmationDescriptionEditMode(false);
      setDevelopers([]);
      setDeveloperSearch("");
      setSelectedDeveloperId("");
      return;
    }

    const initialTitle = typeof pendingConfirmation.payload.title === "string" ? pendingConfirmation.payload.title : "";
    const initialDescription = typeof pendingConfirmation.payload.description === "string" ? pendingConfirmation.payload.description : "";
    setConfirmationDraftTitle(initialTitle);
    setConfirmationDraftDescription(initialDescription);
    setConfirmationEditMode(false);
    setConfirmationDescriptionEditMode(false);
  }, [pendingConfirmation]);

  useEffect(() => {
    if (!pendingConfirmation || String(pendingConfirmation.command || "").toUpperCase() !== "CREATE_TASK") return;

    let cancelled = false;
    const loadDevelopers = async () => {
      try {
        setLoadingDevelopers(true);
        const response = await apiRequest<{ developers: Array<any> }>("/auth/developers");
        if (cancelled) return;
        setDevelopers(
          (response.developers || []).map((developer) => ({
            id: (developer._id || developer.id).toString(),
            name: developer.name,
            email: developer.email,
          }))
        );
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "Unable to load developers");
        }
      } finally {
        if (!cancelled) {
          setLoadingDevelopers(false);
        }
      }
    };

    void loadDevelopers();
    return () => {
      cancelled = true;
    };
  }, [pendingConfirmation]);

  const filteredDevelopers = useMemo(() => {
    const term = developerSearch.trim().toLowerCase();
    if (!term) return developers;
    return developers.filter((developer) => {
      const haystack = `${developer.name} ${developer.email}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [developers, developerSearch]);

  const applyConfirmationDraft = () => {
    if (!pendingConfirmation) return;
    const cleanedTitle = confirmationDraftTitle.trim();
    if (!cleanedTitle) {
      toast.error("Task name cannot be empty.");
      return;
    }

    setPendingConfirmation((current) => {
      if (!current) return current;
      return {
        ...current,
        message: current.command === "CREATE_PROJECT" || current.payload._voiceIntent === "create_project"
          ? `Are you sure you want to create project "${cleanedTitle}"?`
          : (current.command === "CREATE_TASK" && current.payload.projectName
              ? `Create task ${cleanedTitle} in ${String(current.payload.projectName)} and assign it to ${String(current.payload.userName || "someone")}?`
              : current.message),
        payload: {
          ...current.payload,
          title: cleanedTitle,
          project_name: cleanedTitle,
          projectName: cleanedTitle,
          name: cleanedTitle,
        },
      };
    });
    setConfirmationEditMode(false);
    toast.success("Task name updated.");
  };

  const applyConfirmationDescription = () => {
    if (!pendingConfirmation) return;
    const cleanedDescription = confirmationDraftDescription.trim();

    setPendingConfirmation((current) => {
      if (!current) return current;
      return {
        ...current,
        payload: {
          ...current.payload,
          description: cleanedDescription,
        },
      };
    });
    setConfirmationDescriptionEditMode(false);
    toast.success(cleanedDescription ? "Description saved." : "Description cleared.");
  };

  const buildCreateTaskPayload = () => {
    if (!pendingConfirmation) return null;

    const selectedDeveloper = developers.find((developer) => developer.id === selectedDeveloperId);
    return {
      ...pendingConfirmation.payload,
      description: confirmationDraftDescription.trim(),
      ...(selectedDeveloper
        ? {
            userId: selectedDeveloper.id,
            userName: selectedDeveloper.name,
          }
        : {
            userId: null,
            userName: null,
          }),
    };
  };

  const handleSend = async (rawText: string) => {
    const cleaned = rawText.trim();
    if (!cleaned || loading || !user) return;

    // Confirmation check: MUST be handled before anything else to avoid leaking
    // affirmative/negative text into the chat AI and getting nonsense responses.
    if (pendingConfirmation) {
      if (isAffirmativeReply(cleaned)) {
        setInput("");
        await sendConfirmationDecision(true, cleaned);
        return;
      }
      if (isNegativeReply(cleaned)) {
        setInput("");
        await sendConfirmationDecision(false, cleaned);
        return;
      }
      // User typed something else while confirmation is pending:
      // treat it as a new command — clear the old confirmation first
      setPendingConfirmation(null);
      setPendingCommand(null);
    }

    setInput("");
    setLoading(true);
    setIsThinking(true);
    setAiMode("thinking");
    pendingResponseRef.current = true;
    setMessages((current) => [...current, { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "user", content: cleaned, createdAt: new Date().toISOString() }]);

    try {
      const result = await sendZentrixaChat({
        message: cleaned,
        context: {
          ...context,
          ...activeProject,
          // If there's a pending confirmation, include its payload so
          // the backend can execute even if "yes" routes through /chat.
          pendingCommand: pendingConfirmation?.payload ?? pendingCommand ?? null,
        },
      });

      const reply = result.reply || result.message || "I’m here with you.";
      playZentrixaReplyCue();
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      showReplyModeBriefly();
      postAssistantMessage(reply, result.path === "local" ? "local" : "llm");
      if (voiceSessionRef.current) {
        speakReply(reply);
        /* Don't reset voiceSessionRef – keep voice mode active
           for continuous conversation */
      }

      if (result.type === "CONFIRM" || result.requiresConfirmation) {
        setPendingConfirmation(
          result.payload && result.command
            ? {
                command: result.command,
                message: reply,
                payload: result.payload,
              }
            : null
        );
        setPendingCommand(null);
      } else if (result.requiresClarification || (result.missing && result.missing.length > 0)) {
        setPendingCommand((result.pendingCommand as Record<string, unknown> | null) || {
          intent: result.intent,
          missing: result.missing || [],
          text: cleaned,
        });
        setPendingConfirmation(null);
      } else {
        // Only clear pending state if there was no confirmation triggered by this response
        setPendingCommand(null);
        if (!result.requiresConfirmation && (result.type as string) !== "CONFIRM") {
          setPendingConfirmation(null);
        }
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : "I couldn’t understand that.";
      setMessages((current) => [...current, { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "assistant", content: message, path: "llm" as const, createdAt: new Date().toISOString() }]);
      toast.error(message);
    } finally {
      setIsThinking(false);
      setLoading(false);
      pendingResponseRef.current = false;
      scrollToBottom();
    }
  };

  const [pendingVoiceContext, setPendingVoiceContext] = useState<Record<string, unknown>>({});
  const [voiceProjectOptions, setVoiceProjectOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [voiceProjectSearch, setVoiceProjectSearch] = useState("");

  const combinedVoiceContext = useMemo(() => ({
    ...(activeProject as Record<string, unknown>),
    ...pendingVoiceContext,
  }), [activeProject, pendingVoiceContext]);

  const { processTranscript, reset: resetVoiceAction } = useVoiceAction({
    context: combinedVoiceContext,
    debounceMs: 300,
    onActionExecuted: (result) => {
      // Voice command executed directly -> brief toast & message
      setPendingVoiceContext({});
      setVoiceProjectOptions([]);
      setVoiceProjectSearch("");
      pendingResponseRef.current = false;
      setLoading(false);
      setIsThinking(false);
      playZentrixaReplyCue();
      void refreshProjects();
      postAssistantMessage(result.message, "local");
      if (voiceSessionRef.current) {
        speakReply(result.message);
      } else {
        setAiMode(null);
      }
    },
    onFallback: (result) => {
      if ((result as any).path === "pending_project" || result.entities?.awaiting_project_name) {
        setPendingVoiceContext({
          awaiting_project_name: true,
          pending_task_name: result.entities?.task_name || "",
        });
      }
      if (result.projects && result.projects.length > 0) {
        setVoiceProjectOptions(result.projects);
      }
      // Non-command voice → show AI reply in message list
      pendingResponseRef.current = false;
      setLoading(false);
      setIsThinking(false);
      playZentrixaReplyCue();
      postAssistantMessage(result.message, "llm");
      if (voiceSessionRef.current) {
        speakReply(result.message);
      } else {
        setAiMode(null);
      }
    },
    onRepeat: (message) => {
      // Confidence too low — show polite retry message without calling LLM
      pendingResponseRef.current = false;
      setLoading(false);
      setIsThinking(false);
      postAssistantMessage(message, "llm");
      if (voiceSessionRef.current) {
        speakReply(message);
      } else {
        setAiMode(null);
      }
    },
    onConfirmNeeded: (result) => {
      if ((result as any).path === "pending_project" || result.entities?.awaiting_project_name) {
        setPendingVoiceContext({
          awaiting_project_name: true,
          pending_task_name: result.entities?.task_name || "",
        });
      }
      if (result.projects && result.projects.length > 0) {
        setVoiceProjectOptions(result.projects);
      }
      // Voice engine classified intent and needs user confirmation before executing.
      pendingResponseRef.current = false;
      setLoading(false);
      setIsThinking(false);
      playZentrixaReplyCue();
      postAssistantMessage(result.message, "local");

      const extractedTitle = (
        result.entities?.project_name ||
        result.entities?.title ||
        result.entities?.name ||
        result.entities?.projectName
      ) as string | undefined;

      // Feed into the existing pendingConfirmation system so Yes/No UI appears
      setPendingConfirmation({
        command: result.action ?? "",
        message: result.message,
        payload: {
          ...(result.entities as Record<string, unknown> ?? {}),
          ...(extractedTitle ? {
            title: extractedTitle,
            name: extractedTitle,
            project_name: extractedTitle,
            projectName: extractedTitle,
          } : {}),
          // Ensure confirmZentrixaCommand receives raw user transcript for re-execution
          _voiceTranscript: (result as any).transcript || result.message,
          _voiceIntent:     result.action,
          _voiceEntities:   result.entities,
        },
      });

      if (voiceSessionRef.current) {
        speakReply(result.message);
      } else {
        setAiMode(null);
      }
    },
    onError: (msg) => {
      pendingResponseRef.current = false;
      voiceSessionRef.current = false;
      setLoading(false);
      setIsThinking(false);
      setAiMode(null);
      if (msg && !/no speech detected|audio file is empty|detail/i.test(msg)) {
        toast.error(msg);
      }
    },
  });

  const { supported, isListening, isProcessing, isMuted, error, micScale, startListening, stopListening, toggleMute } = useVoiceRecognition({
    onStart: () => {
      setAiMode("listening");
      playZentrixaListeningCue();
    },
    onEnd: () => {
      // Recording stopped but transcription still running → switch ring to thinking
      playZentrixaThinkingCue();
      setAiMode("thinking");
    },
    onError: (message) => {
      pendingResponseRef.current = false;
      voiceSessionRef.current = false;
      resetVoiceAction();
      setAiMode(null);
      setIsThinking(false);
      setLoading(false);
      if (process.env.NODE_ENV !== "production") {
        console.debug("[Zentrixa voice]", message);
      }
    },
    onFinalResult: (text) => {
      // Voice path → strict action system (NOT handleSend / chatbot)
      setInput("");
      setIsThinking(true);
      setLoading(true);
      pendingResponseRef.current = true;
      voiceSessionRef.current = true;
      setVoiceTranscript(text);
      // Show what was heard as a user bubble
      setMessages((current) => [...current, { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "user", content: text, createdAt: new Date().toISOString() }]);

      if (pendingConfirmation && isAffirmativeReply(text)) {
        void sendConfirmationDecision(true, text);
        return;
      }
      if (pendingConfirmation && isNegativeReply(text)) {
        void sendConfirmationDecision(false, text);
        return;
      }

      processTranscript(text);
    },
  });

  /* Keep startListeningRef in sync so speakReply can call it */
  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const isVoiceModeActive = !manualVoiceExit && Boolean(voiceSessionRef.current || isListening || isProcessing || aiMode === "listening" || aiMode === "replying");

  // Auto-scroll to bottom when quitting Voice Mode, opening panel, or initial history load
  useEffect(() => {
    if (open && !isVoiceModeActive && historyLoaded) {
      const timer = setTimeout(() => {
        scrollToBottomInstant();
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [open, isVoiceModeActive, historyLoaded]);

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  useEffect(() => {
    if (!open && aiMode === "listening") {
      stopListening();
      setAiMode(null);
    }
  }, [aiMode, open, stopListening]);

  useEffect(() => {
    return () => {
      clearReplyModeTimer();
      pendingResponseRef.current = false;
      voiceSessionRef.current = false;
      stopSpeaking();
    };
  }, []);

  // Scroll to bottom on initial history load
  useEffect(() => {
    if (!open || !historyLoaded || isInitialScrollDoneRef.current) return;
    const timer = window.setTimeout(() => {
      if (endRef.current) {
        endRef.current.scrollIntoView({ behavior: "auto", block: "end" });
        isInitialScrollDoneRef.current = true;
        isNearBottomRef.current = true;
      }
    }, 20);
    return () => window.clearTimeout(timer);
  }, [open, historyLoaded]);

  // Auto-scroll when new messages arrive, ONLY if near bottom
  useEffect(() => {
    if (!open || !isInitialScrollDoneRef.current) return;

    if (isNearBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      setShowNewMessagesPill(true);
    }
  }, [messages.length, isThinking, pendingCommand, pendingConfirmation]);

  // ── Guided flow helpers ────────────────────────────────────────────────────

  /** Build the option list for the current flow step */
  const buildFlowOptions = async (stepType: string): Promise<FlowOption[]> => {
    if (stepType === "select-project") {
      return projects.map((p) => ({ id: p.id, label: p.name, sub: `${p.panels.flatMap((pan) => pan.tasks).length} tasks` }));
    }
    if (stepType === "select-task") {
      return projects.flatMap((p) =>
        p.panels.flatMap((pan) =>
          pan.tasks.map((t) => ({ id: t.id, label: t.title, sub: p.name }))
        )
      );
    }
    if (stepType === "select-user") {
      try {
        const response = await apiRequest<{ developers: Array<any> }>("/auth/developers");
        return (response.developers || []).map((d) => ({
          id: (d._id || d.id).toString(),
          label: d.name,
          sub: d.email,
        }));
      } catch {
        return [];
      }
    }
    return [];
  };

  /** Start a guided flow when a quick command chip is clicked */
  const startGuidedFlow = async (command: string) => {
    const def = GUIDED_FLOWS[command];
    if (!def) return;
    setOpen(true);
    setPendingConfirmation(null);
    setPendingCommand(null);

    // If no steps (e.g. show overdue tasks) — send immediately
    if (def.steps.length === 0) {
      setMessages((c) => [
        ...c,
        { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "user", content: command, createdAt: new Date().toISOString() },
      ]);
      void handleSend(command);
      return;
    }

    const flow: ActiveFlow = { def, stepIndex: 0, collected: {} };
    setActiveFlow(flow);
    setMessages((c) => [
      ...c,
      { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "user", content: command, createdAt: new Date().toISOString() },
      { id: `msg-${Date.now()+1}-${Math.random().toString(36).slice(2, 7)}`, role: "assistant", content: def.intro, createdAt: new Date().toISOString() },
    ]);

    // Pre-load options for first step
    const firstStep = def.steps[0];
    if (firstStep && ["select-project","select-task","select-user"].includes(firstStep.type)) {
      setFlowOptionsLoading(true);
      const opts = await buildFlowOptions(firstStep.type);
      setFlowOptions(opts);
      setFlowOptionsLoading(false);
    } else {
      setFlowOptions([]);
    }
  };

  /** Called when the user picks/types an answer for the current step */
  const handleFlowAnswer = async (value: { id?: string; label: string }) => {
    if (!activeFlow) return;
    const { def, stepIndex, collected } = activeFlow;
    const currentStep = def.steps[stepIndex];
    if (!currentStep) return;

    const updated = { ...collected, [currentStep.key]: value };

    // Show user's answer as a message bubble
    setMessages((c) => [...c, { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "user", content: value.label, createdAt: new Date().toISOString() }]);

    const nextIndex = stepIndex + 1;
    if (nextIndex < def.steps.length) {
      // Move to next step
      const nextStep = def.steps[nextIndex];
      const nextFlow: ActiveFlow = { def, stepIndex: nextIndex, collected: updated };
      setActiveFlow(nextFlow);

      // Show next question as assistant message
      setMessages((c) => [...c, { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "assistant", content: nextStep.question, createdAt: new Date().toISOString() }]);

      // Load options for next step
      if (["select-project","select-task","select-user"].includes(nextStep.type)) {
        setFlowOptionsLoading(true);
        const opts = await buildFlowOptions(nextStep.type);
        setFlowOptions(opts);
        setFlowOptionsLoading(false);
      } else {
        setFlowOptions([]);
      }
    } else {
      // All steps done — show a confirmation bubble before executing
      setActiveFlow(null);
      setFlowOptions([]);
      requestGuidedFlowConfirmation(def, updated);
    }
  };

  /** Skip an optional step */
  const handleFlowSkip = async () => {
    if (!activeFlow) return;
    const { def, stepIndex, collected } = activeFlow;
    const nextIndex = stepIndex + 1;
    if (nextIndex < def.steps.length) {
      const nextStep = def.steps[nextIndex];
      const nextFlow: ActiveFlow = { def, stepIndex: nextIndex, collected };
      setActiveFlow(nextFlow);
      setMessages((c) => [...c, { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "assistant", content: nextStep.question, createdAt: new Date().toISOString() }]);
      if (["select-project","select-task","select-user"].includes(nextStep.type)) {
        setFlowOptionsLoading(true);
        const opts = await buildFlowOptions(nextStep.type);
        setFlowOptions(opts);
        setFlowOptionsLoading(false);
      } else {
        setFlowOptions([]);
      }
    } else {
      setActiveFlow(null);
      setFlowOptions([]);
      requestGuidedFlowConfirmation(def, collected);
    }
  };

  /** Build a human-readable summary and ask the user to confirm before executing */
  const requestGuidedFlowConfirmation = (
    def: ActiveFlow["def"],
    collected: ActiveFlow["collected"]
  ) => {
    const title    = collected["title"]?.label || collected["name"]?.label;
    const task     = collected["task"]?.label;
    const project  = collected["project"]?.label;
    const assignee = collected["assignee"]?.label;
    const status   = collected["status"]?.label;
    const comment  = collected["comment"]?.label;

    const actionLabel = def.id.replace(/_/g, " ");
    const parts: string[] = [];
    if (title)    parts.push(`"${title}"`);
    if (task)     parts.push(`task: "${task}"`);
    if (project)  parts.push(`in "${project}"`);
    if (assignee) parts.push(`→ ${assignee}`);
    if (status)   parts.push(`status: ${status}`);
    if (comment)  parts.push(`comment: "${comment}"`);
    const summary = `${actionLabel}${parts.length ? " " + parts.join(" ") : ""}`;

    postAssistantMessage(`Ready to **${summary}**. Confirm?`, "guided");
    setPendingGuidedExecution({ def, collected, summary });
  };

  /** Turn collected flow answers into a dispatch call directly — no LLM, no confirmation */
  const executeGuidedFlow = async (
    def: ActiveFlow["def"],
    collected: ActiveFlow["collected"]
  ) => {
    const title     = collected["title"]?.label   || collected["name"]?.label;
    const task      = collected["task"]?.label;
    const project   = collected["project"]?.label;
    const assignee  = collected["assignee"]?.label;
    const status    = collected["status"]?.id;
    const comment   = collected["comment"]?.label;

    // Build a human-readable summary for the chat message list
    const parts: string[] = [def.id.replace(/_/g, " ")];
    if (title)    parts.push(title);
    if (task)     parts.push(`task: ${task}`);
    if (project)  parts.push(`in ${project}`);
    if (assignee) parts.push(`to ${assignee}`);
    if (status)   parts.push(`status ${status}`);
    if (comment)  parts.push(`comment: ${comment}`);
    const sentence = parts.join(" ");

    // Show the user's action in chat history immediately
    setMessages((curr) => [...curr, { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: "user" as const, content: sentence, createdAt: new Date().toISOString() }]);

    setLoading(true);
    setIsThinking(true);
    setAiMode("thinking");
    pendingResponseRef.current = true;

    try {
      // For create_project the project name comes from collected["name"] → title.
      // For all other intents the project context comes from collected["project"].
      const resolvedProjectName =
        def.intent === "create_project" ? (title ?? null) : (project ?? null);

      // Dispatch directly — the flow already collected everything, skip LLM + confirmation
      const result = await dispatchZentrixaCommand({
        action:       def.intent as ZentrixaAction,
        text:         sentence,  // used by /dispatch to persist user message in chat history
        entities: {
          task_name:    title || task || null,
          project_name: resolvedProjectName,
          user_name:    assignee || null,
          status:       status   || null,
        },
        context: {
          ...context,
          ...activeProject,
          projectId:   collected["project"]?.id   || activeProject.projectId,
          taskId:      collected["task"]?.id,
          developerId: collected["assignee"]?.id,
          status,
          comment,
          title,
        },
        projectId:   collected["project"]?.id   || activeProject.projectId,
        taskId:      collected["task"]?.id,
      });

      const reply = result.message || (result.executed
        ? `Done! ${def.id.replace(/_/g, " ")} completed.`
        : `I could not complete that action. ${result.missing?.length ? `Missing: ${result.missing.join(", ")}.` : ""}`);

      playZentrixaReplyCue();
      showReplyModeBriefly();
      postAssistantMessage(reply, "guided");
      // Refresh sidebar so the new project/task appears immediately
      void refreshProjects();
      setPendingConfirmation(null);
      setPendingCommand(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      postAssistantMessage(msg, "guided");
      toast.error(msg);
    } finally {
      setIsThinking(false);
      setLoading(false);
      pendingResponseRef.current = false;
      scrollToBottom();
    }
  };

  const startVoice = () => {
    if (!supported) {
      toast.error("Voice input isn’t available in this browser.");
      return;
    }

    setManualVoiceExit(false);
    voiceSessionRef.current = true;
    stopSpeaking();
    setOpen(true);
    window.requestAnimationFrame(() => {
      try {
        startListening();
      } catch {
        voiceSessionRef.current = false;
        setAiMode(null);
        toast.error("Voice input could not start. Please try again.");
      }
    });
  };

  const stopVoice = () => {
    setManualVoiceExit(true);
    voiceSessionRef.current = false;
    pendingResponseRef.current = false;
    clearReplyModeTimer();
    stopSpeaking();
    stopListening();
    setAiMode(null);
    window.setTimeout(() => {
      scrollToBottomInstant();
    }, 10);
  };

  return (
    <div ref={shellRef} className="fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6">
      {mounted && (
        <Card
          data-state={open && panelVisible ? "open" : "closed"}
          className="zentrixa-panel absolute bottom-16 right-0 mb-3 flex h-[min(70vh,calc(100dvh-5.5rem))] w-[calc(100vw-1rem)] overflow-hidden rounded-[2rem] border border-white/20 bg-card/90 shadow-[0_20px_50px_rgba(0,0,0,0.3)] backdrop-blur-2xl transform-gpu will-change-transform sm:w-[480px]"
        >
          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4">
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 pb-3">
              <div className="flex min-w-0 items-center gap-3">
                <ZentrixaAiRing
                  mode={null}
                  size={64}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-lg sm:text-xl font-extrabold tracking-tight text-foreground">Zentrixa</h3>
                    <Sparkles className="h-4 w-4 text-primary" />
                  </div>
                  {(isThinking || loading) && (
                    <p className="text-[10px] font-medium text-muted-foreground/80">
                      {isThinking ? "Composing reply..." : "Processing..."}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("h-8 w-8 rounded-full transition-colors hover:bg-muted/50", isVoiceModeActive && "bg-primary/20 text-primary")}
                  title={isVoiceModeActive ? "Switch to Text Chat" : "Switch to Voice Mode"}
                  onClick={() => {
                    if (isVoiceModeActive) {
                      stopVoice();
                    } else {
                      startVoice();
                    }
                  }}
                >
                  <Mic className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full transition-colors hover:bg-muted/50"
                  onClick={() => {
                    stopVoice();
                    setOpen(false);
                  }}
                >
                  <X className="h-4 w-4 opacity-60" />
                </Button>
              </div>
            </div>

            <div className="mt-3 flex shrink-0 flex-wrap gap-2">
              {QUICK_COMMANDS.map((command) => (
                <Button
                  key={command}
                  type="button"
                  size="sm"
                  variant={activeFlow?.def.id === GUIDED_FLOWS[command]?.id ? "default" : "outline"}
                  className="h-7 rounded-full border-border/50 bg-background/50 px-3 text-[10px] font-medium transition-all hover:bg-background hover:shadow-sm"
                  onClick={() => startGuidedFlow(command)}
                  disabled={!!activeFlow}
                >
                  {command}
                </Button>
              ))}
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-hidden">
              {isVoiceModeActive ? (
                <div className="flex h-full flex-col justify-between rounded-3xl border border-border/60 bg-[radial-gradient(circle_at_center,rgba(200,162,122,0.15),transparent_65%),linear-gradient(180deg,rgba(255,255,255,0.08),rgba(0,0,0,0.03))] p-4 shadow-inner">

                  {/* Circle LEFT + Transcript RIGHT on desktop; stacked on mobile */}
                  <div className="my-auto flex flex-col sm:flex-row items-center gap-4 min-h-0 w-full overflow-y-auto">

                    {/* Animated Voice Circle (left on desktop, top on mobile) */}
                    <div className="flex shrink-0 flex-col items-center justify-center py-1">
                      <ZentrixaAiRing
                        mode={aiMode === "replying" ? "replying" : isListening ? "listening" : isProcessing || isThinking ? "thinking" : "listening"}
                        micScale={micScale}
                        size={100}
                      />
                    </div>

                    {/* Transcript + Reply panel (right on desktop, below on mobile) */}
                    {(voiceTranscript || voiceReply) ? (
                      <div className="flex-1 w-full space-y-2 rounded-2xl border border-border/50 bg-background/80 p-3 backdrop-blur-md shadow-sm overflow-y-auto max-h-48">
                        {voiceTranscript && (
                          <div className="text-xs text-foreground font-medium leading-relaxed">
                            {voiceTranscript}
                          </div>
                        )}
                        {voiceReply && (
                          <div className={cn("text-xs text-muted-foreground leading-relaxed", voiceTranscript && "border-t border-border/40 pt-2")}>
                            {voiceReply}
                          </div>
                        )}

                        {/* Searchable Voice Project Dropdown directly inside Voice UI */}
                        {voiceProjectOptions.length > 0 && (
                          <div className="mt-2.5 space-y-1.5 border-t border-border/40 pt-2.5">
                            <div className="flex items-center justify-between text-[11px] font-bold text-primary">
                              <span>Select Project:</span>
                              <span className="text-[9px] font-normal text-muted-foreground">or speak project name</span>
                            </div>
                            <Input
                              value={voiceProjectSearch}
                              onChange={(e) => setVoiceProjectSearch(e.target.value)}
                              placeholder="Search project name..."
                              className="h-7 rounded-xl text-xs bg-background/90"
                            />
                            <div className="max-h-28 overflow-auto space-y-1 rounded-xl border border-border/40 bg-background/95 p-1">
                              {voiceProjectOptions
                                .filter((p) => p.name.toLowerCase().includes(voiceProjectSearch.toLowerCase()))
                                .map((p) => (
                                  <button
                                    key={p.id || p.name}
                                    type="button"
                                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-primary/15 hover:text-primary font-medium"
                                    onClick={() => {
                                      setVoiceProjectSearch("");
                                      setVoiceProjectOptions([]);
                                      processTranscript(p.name);
                                    }}
                                  >
                                    <span>{p.name}</span>
                                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                  </button>
                                ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex-1 hidden sm:flex items-center justify-start">
                        <p className="text-[11px] text-muted-foreground italic">Listening for your command…</p>
                      </div>
                    )}
                  </div>

                  {/* Exit Voice Mode Button */}
                  <div className="mt-3 flex w-full justify-center shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-full border-border/60 px-4 text-xs font-semibold hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
                      onClick={() => {
                        voiceSessionRef.current = false;
                        stopVoice();
                        setAiMode(null);
                      }}
                    >
                      <X className="mr-1.5 h-3.5 w-3.5" />
                      Exit Voice Mode
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="relative h-full">
                <ScrollArea className="h-full pr-3" onScroll={handleScroll}>
                  <div className="space-y-3 pb-2">
                  {!historyLoaded ? (
                    /* Skeleton while loading DB history */
                    <div className="space-y-3 pt-2 animate-pulse">
                      {[70, 50, 80].map((w, i) => (
                        <div key={i} className={`flex items-end gap-2 ${i % 2 === 1 ? "flex-row-reverse" : ""}`}>
                          <div className="h-7 w-7 shrink-0 rounded-full bg-muted/60" />
                          <div
                            className="h-8 rounded-2xl bg-muted/50"
                            style={{ width: `${w}%` }}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                  <>
                  {loadingOlder && (
                    <div className="flex justify-center py-2">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={cn("flex flex-col gap-1", message.role === "user" ? "items-end" : "items-start")}
                    >
                      <div className={cn("flex items-end gap-2", message.role === "user" ? "flex-row-reverse" : "flex-row")}>
                      {message.role === "assistant" && (
                        <div className="relative shrink-0">
                          <Avatar className="h-7 w-7 border border-border/50">
                            <AvatarFallback className="bg-primary/10 text-primary flex items-center justify-center"><Bot className="h-4 w-4" /></AvatarFallback>
                          </Avatar>
                          {message.path && (
                            <span
                              title={
                                message.path === "llm"
                                  ? "Answered by external AI (OpenAI)"
                                  : "Answered by built-in AI (Zentrixa Engine)"
                              }
                              className={cn(
                                "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background transition-opacity",
                                message.path === "llm" ? "bg-green-500" : "bg-blue-500"
                              )}
                            />
                          )}
                        </div>
                      )}
                      <div
                        className={cn(
                          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm font-medium leading-relaxed shadow-sm",
                          message.role === "user" 
                            ? "bg-primary text-primary-foreground rounded-tr-none" 
                            : "bg-muted/50 text-foreground rounded-tl-none border border-border/50 backdrop-blur-sm"
                        )}
                      >
                        {message.content}
                      </div>
                      {message.role === "user" && (
                        <Avatar className="h-7 w-7 shrink-0 border border-border/50">
                          <AvatarFallback className="text-[10px] bg-muted">
                            {user?.firstName?.charAt(0) || "Y"}
                            {user?.lastName?.charAt(0) || "U"}
                          </AvatarFallback>
                        </Avatar>
                      )}
                    </div>

                  </div>
                  ))
                  }

                  {/* ── Welcome screen (first time, no history) ─────────── */}
                  {historyLoaded && messages.length === 0 && !activeFlow && (
                    <div className="flex flex-col items-center justify-center gap-4 py-6 text-center">
                      <div className="relative">
                        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 ring-2 ring-primary/20">
                          <Sparkles className="h-6 w-6 text-primary" />
                        </div>
                        <div className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-green-500 ring-2 ring-background" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">
                          Hi{user?.firstName ? `, ${user.firstName}` : ""}! I&apos;m Zentrixa
                        </p>
                        <p className="max-w-[220px] text-[11px] leading-relaxed text-muted-foreground">
                          Your AI assistant for tasks, projects, and team actions. Pick a quick action or just tell me what you need.
                        </p>
                      </div>
                      <div className="flex flex-wrap justify-center gap-1.5">
                        {["create task", "assign task", "show overdue tasks"].map((cmd) => (
                          <button
                            key={cmd}
                            onClick={() => startGuidedFlow(cmd)}
                            className="rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10"
                          >
                            {cmd}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Guided flow widget ─────────────────────────────── */}
                  {activeFlow && !isThinking && (() => {
                    const step = activeFlow.def.steps[activeFlow.stepIndex];
                    if (!step) return null;
                    const totalSteps = activeFlow.def.steps.length;
                    const currentStep = activeFlow.stepIndex + 1;
                    return (
                      <div className="flex flex-col gap-1 items-start w-full">
                        <div className="flex items-start gap-2 w-full">
                          <Avatar className="h-7 w-7 shrink-0 border border-border/50 mt-0.5">
                            <AvatarFallback className="text-[10px] bg-primary/10 text-primary">ZX</AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            {/* Widget header with step count + cancel */}
                            <div className="mb-1.5 flex items-center justify-between">
                              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                                Step {currentStep} of {totalSteps}
                              </span>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-5 w-5 rounded-full text-muted-foreground/60 hover:text-foreground hover:bg-muted/60"
                                onClick={() => {
                                  setActiveFlow(null);
                                  setFlowOptions([]);
                                  postAssistantMessage("No problem! Pick another action or just type what you need.", "guided");
                                }}
                                title="Cancel"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                            <GuidedFlowWidget
                              step={step}
                              options={flowOptions}
                              loading={flowOptionsLoading}
                              onAnswer={handleFlowAnswer}
                              onSkip={handleFlowSkip}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {isThinking && (
                    <div className="flex items-end gap-2">
                      <Avatar className="h-7 w-7 shrink-0 border border-border/50">
                        <AvatarFallback className="text-[10px] bg-primary/10 text-primary">ZX</AvatarFallback>
                      </Avatar>
                      <div className="max-w-[82%] rounded-2xl bg-muted/50 border border-border/50 text-foreground">
                        <ZentrixaTypingDots />
                      </div>
                    </div>
                  )}

                  {pendingConfirmation && (
                    <div className="w-full max-w-[310px] rounded-2xl border border-primary/25 bg-primary/5 p-3 text-xs shadow-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">
                          Confirm
                        </div>
                        {(["CREATE_TASK", "CREATE_PROJECT"].includes(String(pendingConfirmation.command || "").toUpperCase())) && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 rounded-full px-2 text-[10px]"
                            onClick={() => setConfirmationEditMode((value) => !value)}
                          >
                            <Pencil className="mr-1 h-3 w-3" />
                            Edit
                          </Button>
                        )}
                      </div>
                      {(["CREATE_TASK", "CREATE_PROJECT"].includes(String(pendingConfirmation.command || "").toUpperCase())) && confirmationEditMode ? (
                        <div className="mt-2 flex items-center gap-2">
                          <Input
                            value={confirmationDraftTitle}
                            onChange={(event) => setConfirmationDraftTitle(event.target.value)}
                            className="h-9 rounded-2xl text-xs"
                            placeholder={String(pendingConfirmation.command || "").toUpperCase() === "CREATE_PROJECT" ? "Project name" : "Task name"}
                          />
                          <Button
                            type="button"
                            size="sm"
                            className="h-9 rounded-full px-3 text-xs"
                            onClick={applyConfirmationDraft}
                          >
                            <Save className="mr-1 h-3 w-3" />
                            Save
                          </Button>
                        </div>
                      ) : null}
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{pendingConfirmation.message}</p>
                      {String(pendingConfirmation.command || "").toUpperCase() === "CREATE_TASK" && (
                        <div className="mt-2 space-y-2 rounded-xl border border-border/60 bg-background/70 p-2">
                          <div>
                            <div className="mb-1.5 flex items-center justify-between gap-2">
                              <div className="text-[10px] font-bold tracking-wide text-foreground">
                                Whom to assign?
                              </div>
                              {selectedDeveloperId && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-5 rounded-full px-1.5 text-[9px] text-muted-foreground hover:text-foreground"
                                  onClick={() => {
                                    setSelectedDeveloperId("");
                                    setDeveloperSearch("");
                                  }}
                                >
                                  Clear
                                </Button>
                              )}
                            </div>
                            <Input
                              value={developerSearch}
                              onChange={(event) => setDeveloperSearch(event.target.value)}
                              placeholder="Search developer name or email..."
                              className="h-8 rounded-xl text-xs"
                            />
                            <div className="mt-1.5 max-h-28 overflow-auto rounded-xl border border-border/40 bg-background">
                              <button
                                type="button"
                                className={cn(
                                  "flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-primary/10",
                                  !selectedDeveloperId && "bg-primary/10 font-medium text-primary"
                                )}
                                onClick={() => setSelectedDeveloperId("")}
                              >
                                <span>No assignee</span>
                                <span className="text-[10px] text-muted-foreground">Unassigned</span>
                              </button>
                              {loadingDevelopers ? (
                                <div className="px-2.5 py-2 text-xs text-muted-foreground">Loading developers...</div>
                              ) : filteredDevelopers.length > 0 ? (
                                filteredDevelopers.map((developer) => (
                                  <button
                                    key={developer.id}
                                    type="button"
                                    className={cn(
                                      "flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-primary/10",
                                      selectedDeveloperId === developer.id && "bg-primary/15 font-semibold text-primary"
                                    )}
                                    onClick={() => setSelectedDeveloperId(developer.id)}
                                  >
                                    <span className="truncate">{developer.name}</span>
                                    <span className="ml-2 truncate text-[10px] text-muted-foreground">{developer.email}</span>
                                  </button>
                                ))
                              ) : (
                                <div className="px-2.5 py-2 text-xs text-muted-foreground">No developers found.</div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 rounded-full px-3 text-[10px]"
                          onClick={() => {
                            const payload = buildCreateTaskPayload();
                            if (!payload) return;
                            void sendConfirmationDecision(true, "yes", payload);
                          }}
                        >
                          Confirm
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-7 rounded-full px-3 text-[10px]"
                          onClick={() => void sendConfirmationDecision(false, "cancel")}
                        >
                          Cancel
                        </Button>
                      </div>
                      {String(pendingConfirmation.command || "").toUpperCase() === "CREATE_TASK" && (
                        <div className="mt-2 rounded-xl bg-background/60 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
                          <div>Task: {confirmationDraftTitle || String(pendingConfirmation.payload.title || "")}</div>
                          <div>Project: {String(pendingConfirmation.payload.projectName || "")}</div>
                          <div>Description: {confirmationDraftDescription.trim() || "none"}</div>
                          <div>Assign to: {selectedDeveloperId ? (developers.find((developer) => developer.id === selectedDeveloperId)?.name || "selected") : String(pendingConfirmation.payload.userName || "not set")}</div>
                        </div>
                      )}
                    </div>
                  )}

                  {pendingGuidedExecution && !loading && (
                    <div className="rounded-2xl border border-primary/30 bg-primary/5 p-3 space-y-2">
                      <p className="text-xs font-semibold text-foreground">
                        Confirm action
                      </p>
                      <p className="text-[11px] text-muted-foreground capitalize">
                        {pendingGuidedExecution.summary}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 rounded-full px-4 text-[11px]"
                          onClick={() => {
                            const { def, collected } = pendingGuidedExecution;
                            setPendingGuidedExecution(null);
                            void executeGuidedFlow(def, collected);
                          }}
                        >
                          ✓ Confirm
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-7 rounded-full px-3 text-[11px]"
                          onClick={() => {
                            setPendingGuidedExecution(null);
                            postAssistantMessage("Cancelled. Let me know if you'd like to try again.", "guided");
                          }}
                        >
                          ✗ Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {pendingCommand && !pendingConfirmation && (
                    <div className="rounded-2xl border border-border/70 bg-muted/45 p-3 text-sm">
                      <div className="font-semibold text-foreground">Need one more detail</div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Zentrixa is waiting on the missing part of your last command. Just reply naturally and I’ll continue.
                      </p>
                    </div>
                  )}

                  <div ref={endRef} />
                  </>
                  )}
                  </div>
                </ScrollArea>
                {showNewMessagesPill && (
                  <button
                    type="button"
                    onClick={() => {
                      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
                      setShowNewMessagesPill(false);
                      isNearBottomRef.current = true;
                    }}
                    className="absolute bottom-3 right-5 z-20 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95"
                  >
                    <span>New messages</span>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                )}
                </div>
              )}
            </div>

            <div className="mt-3 shrink-0 space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex flex-1 items-center gap-1.5 rounded-2xl border border-border/40 bg-background/40 px-3 py-1 focus-within:border-primary/30 focus-within:bg-background/60 transition-all shadow-inner">
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask anything..."
                    className="h-8 border-0 bg-transparent p-0 text-sm focus-visible:ring-0"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleSend(input);
                      }
                    }}
                  />
                  <div className="flex items-center border-l border-border/30 pl-1.5 ml-1.5 italic text-[10px] text-muted-foreground/60 select-none">
                    Enter
                  </div>
                </div>
                <Button
                  type="button"
                  className="h-11 rounded-2xl px-4"
                  onClick={() => {
                    if (isListening) {
                      stopVoice();
                      return;
                    }
                    void handleSend(input);
                  }}
                  disabled={loading && !isListening}
                >
                  {isListening ? (
                    <Square className="h-4 w-4" />
                  ) : loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
                <div className="relative group">
                  <Button
                    type="button"
                    size="icon"
                    variant={isListening ? "default" : "secondary"}
                    className={cn(
                      "h-12 w-12 rounded-2xl transition-all duration-200",
                      isListening && !isMuted && "bg-primary text-primary-foreground shadow-lg shadow-primary/30 scale-105",
                      isListening && isMuted && "opacity-60"
                    )}
                    onClick={() => {
                      if (isListening || aiMode === "listening") {
                        toggleMute();
                      } else {
                        startVoice();
                      }
                    }}
                    aria-label={isListening ? (isMuted ? "Unmute Zentrixa Voice" : "Mute Zentrixa Voice") : "Zentrixa Voice"}
                  >
                    {isListening ? (
                      isMuted ? <MicOff className="h-5 w-5" /> : <Sparkles className="h-5 w-5 animate-pulse text-primary-foreground" />
                    ) : (
                      <Sparkles className="h-5 w-5 text-primary" />
                    )}
                  </Button>
                  {/* Label Badge */}
                  <div
                    className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-border/60 bg-popover/95 px-1.5 py-0.5 text-[8px] font-semibold text-foreground shadow-sm backdrop-blur-md tracking-tight"
                    style={{ animation: "zentrixa-tooltip-pop 0.3s cubic-bezier(0.34,1.56,0.64,1) both" }}
                  >
                    {isListening ? (isMuted ? "Unmute" : "Listening…") : "Zentrixa Voice"}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{supported ? "Voice ready" : "Voice not supported"}</span>
                <span>{pendingConfirmation ? "Waiting on confirmation" : pendingCommand ? "Waiting on follow-up" : "Ready"}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="relative inline-flex flex-col items-center">
        {/* "Zentrixa AI" label positioned absolutely above icon to prevent layout shift */}
        {!open && (
          <div
            className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-border/60 bg-popover/95 px-3 py-1 text-xs font-extrabold text-foreground shadow-md backdrop-blur-md"
            style={{ animation: "zentrixa-tooltip-pop 0.3s cubic-bezier(0.34,1.56,0.64,1) both" }}
          >
            Zentrixa AI
          </div>
        )}

        <Button
          type="button"
          size="icon"
          onClick={() => {
            if (open) {
              stopVoice();
              setOpen(false);
            } else {
              stopVoice();
              setOpen(true);
            }
          }}
          className={cn(
            "relative z-50 flex h-[4.25rem] w-[4.25rem] p-0 shrink-0 items-center justify-center rounded-full border border-white/30 bg-primary text-primary-foreground shadow-xl transition-all duration-200 ease-out hover:scale-110 hover:shadow-2xl active:scale-95",
            open && "bg-primary/90"
          )}
          aria-label="Toggle Zentrixa assistant"
        >
          {open ? (
            <X className="h-8 w-8 shrink-0" />
          ) : (
            <Bot className="h-8 w-8 shrink-0" />
          )}
        </Button>
      </div>
    </div>
  );
}
