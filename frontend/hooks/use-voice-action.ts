"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VoiceActionStatus =
  | "idle"
  | "matching"
  | "executing"
  | "done"
  | "fallback"
  | "repeat"
  | "error";

export interface VoiceActionResult {
  action: string | null;
  executed: boolean;
  message: string;
  data?: unknown;
  isFallback: boolean;
  /** "local" = Hybrid Intent Engine; "llm" = OpenAI; "repeat" = low-confidence; "pending_confirm" = awaiting yes/no; "pending_project" = awaiting project choice */
  path?: "local" | "llm" | "repeat" | "pending_confirm" | "pending_project";
  entities?: Record<string, unknown>;
  confidence?: number;
  projects?: Array<{ id: string; name: string }>;
}

export interface UseVoiceActionOptions {
  onActionExecuted?: (result: VoiceActionResult) => void;
  onFallback?: (result: VoiceActionResult) => void;
  onRepeat?: (message: string) => void;
  onConfirmNeeded?: (result: VoiceActionResult) => void;
  onError?: (message: string) => void;
  context?: Record<string, unknown>;
  debounceMs?: number;
}

interface VoiceProcessResult {
  transcript: string;
  reply: string;
  intent: string | null;
  confidence: number;
  executed: boolean;
  path: "local" | "llm" | "repeat" | "pending_confirm" | "pending_project";
  entities?: Record<string, unknown>;
  projects?: Array<{ id: string; name: string }>;
  data?: unknown;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useVoiceAction
 * ==============
 * Receives a raw transcript string from useVoiceRecognition and forwards
 * it to the centralised backend Hybrid Intent Engine.
 *
 * All intent classification is handled server-side by the Python engine.
 * This hook no longer contains any intent-matching rules.
 */
export function useVoiceAction(options: UseVoiceActionOptions = {}) {
  const {
    onActionExecuted,
    onFallback,
    onRepeat,
    onConfirmNeeded,
    onError,
    context = {},
    debounceMs = 300,
  } = options;

  const [status, setStatus]       = useState<VoiceActionStatus>("idle");
  const [lastResult, setLastResult] = useState<VoiceActionResult | null>(null);

  const debounceTimerRef  = useRef<number | null>(null);
  const lastTranscriptRef = useRef<string>("");
  const isProcessingRef   = useRef(false);

  // Stable refs for callbacks and context (avoids stale closures)
  const onActionExecutedRef = useRef(onActionExecuted);
  const onFallbackRef       = useRef(onFallback);
  const onRepeatRef           = useRef(onRepeat);
  const onConfirmNeededRef    = useRef(onConfirmNeeded);
  const onErrorRef            = useRef(onError);
  const contextRef          = useRef(context);

  useEffect(() => { onActionExecutedRef.current = onActionExecuted; }, [onActionExecuted]);
  useEffect(() => { onFallbackRef.current       = onFallback;       }, [onFallback]);
  useEffect(() => { onRepeatRef.current           = onRepeat;           }, [onRepeat]);
  useEffect(() => { onConfirmNeededRef.current    = onConfirmNeeded;    }, [onConfirmNeeded]);
  useEffect(() => { onErrorRef.current          = onError;          }, [onError]);
  useEffect(() => { contextRef.current          = context;          }, [context]);

  // ── Main entry point ─────────────────────────────────────────────────────────

  const processTranscript = useCallback((rawTranscript: string) => {
    if (!rawTranscript.trim() || isProcessingRef.current) return;

    // Debounce — cancel any pending call and restart the timer
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = window.setTimeout(async () => {
      debounceTimerRef.current = null;

      const transcript = rawTranscript.trim();
      if (!transcript) return;

      // Dedup — skip if identical to the last processed transcript
      if (transcript === lastTranscriptRef.current) return;
      lastTranscriptRef.current = transcript;

      setStatus("matching");
      isProcessingRef.current = true;

      try {
        // ── Single call to the centralised backend pipeline ────────────────
        const res = await apiRequest<VoiceProcessResult>("/zentrixa/voice/process", {
          method: "POST",
          body: JSON.stringify({
            text:    transcript,
            context: contextRef.current,
          }),
        });

        const result: VoiceActionResult = {
          action:     res.intent,
          executed:   Boolean(res.executed),
          message:    res.reply || transcript,
          data:       res.data,
          isFallback: res.path === "llm",
          path:       res.path,
          confidence: res.confidence,
          entities:   res.entities,
          projects:   res.projects,
        };

        setLastResult(result);

        if (res.path === "pending_confirm" || res.path === "pending_project") {
          setStatus("matching");
          onConfirmNeededRef.current?.(result);
        } else if (res.path === "repeat") {
          setStatus("repeat");
          onRepeatRef.current?.(res.reply || result.message);
        } else if (res.path === "local" && res.executed) {
          setStatus("done");
          onActionExecutedRef.current?.(result);
        } else {
          setStatus("done");
          onFallbackRef.current?.(result);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Voice processing failed.";
        onErrorRef.current?.(msg);
        setStatus("error");
      } finally {
        isProcessingRef.current = false;
      }
    }, debounceMs);
  }, [debounceMs]);

  // ── Reset ─────────────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    isProcessingRef.current  = false;
    lastTranscriptRef.current = "";
    setStatus("idle");
    setLastResult(null);
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────────

  useEffect(() => () => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
  }, []);

  return {
    status,
    lastResult,
    processTranscript,
    reset,
  };
}
