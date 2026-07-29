"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";

export interface UseVoiceRecognitionOptions {
  /** BCP-47 language tag. Hardcoded to en-US; non-English transcripts are rejected. */
  lang?: string;
  onFinalResult?: (text: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
  silenceTimeoutMs?: number;
  maxSessionMs?: number;
}

// Only accept transcripts that look like English.
// Rejects strings where the majority of chars are non-Latin.
function isEnglish(text: string): boolean {
  if (!text) return false;
  const latinChars = (text.match(/[A-Za-z0-9 .,!?'"-]/g) || []).length;
  return latinChars / text.length > 0.7;
}

export function useVoiceRecognition(options: UseVoiceRecognitionOptions = {}) {
  const {
    onFinalResult,
    onStart,
    onEnd,
    onError,
    silenceTimeoutMs = 2500,
    maxSessionMs = 15000,
  } = options;

  const [supported, setSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false); // true while uploading + transcribing
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [micScale, setMicScale] = useState(1);

  const mediaRecorderRef    = useRef<MediaRecorder | null>(null);
  const chunksRef           = useRef<BlobPart[]>([]);
  const audioContextRef     = useRef<AudioContext | null>(null);
  const analyserRef         = useRef<AnalyserNode | null>(null);
  const micStreamRef        = useRef<MediaStream | null>(null);
  const volumeRafRef        = useRef<number | null>(null);
  const silenceTimerRef     = useRef<number | null>(null);
  const maxSessionTimerRef  = useRef<number | null>(null);
  const isProcessingRef     = useRef(false);
  const lastActiveTimeRef   = useRef<number>(0);

  // Stable callback refs
  const onFinalResultRef = useRef(onFinalResult);
  const onStartRef       = useRef(onStart);
  const onEndRef         = useRef(onEnd);
  const onErrorRef       = useRef(onError);

  useEffect(() => { onFinalResultRef.current = onFinalResult; }, [onFinalResult]);
  useEffect(() => { onStartRef.current       = onStart;       }, [onStart]);
  useEffect(() => { onEndRef.current         = onEnd;         }, [onEnd]);
  useEffect(() => { onErrorRef.current       = onError;       }, [onError]);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
      !!navigator?.mediaDevices?.getUserMedia &&
      !!window.MediaRecorder
    );
  }, []);

  // ── Cleanup helpers ──────────────────────────────────────────────────────────

  const clearTimers = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      window.clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (maxSessionTimerRef.current !== null) {
      window.clearTimeout(maxSessionTimerRef.current);
      maxSessionTimerRef.current = null;
    }
  }, []);

  const stopAudioTracks = useCallback(() => {
    if (volumeRafRef.current !== null) {
      cancelAnimationFrame(volumeRafRef.current);
      volumeRafRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setMicScale(1);
  }, []);

  // ── Stop listening (reusable, safe to call multiple times) ──────────────────

  const stopListening = useCallback(() => {
    clearTimers();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop(); // triggers onstop → processAudio
    }
    stopAudioTracks();
    setIsListening(false);
    if (!isProcessingRef.current) setIsProcessing(false);
  }, [clearTimers, stopAudioTracks]);

  // ── TranscribeAudio → Faster-Whisper (via backend proxy) ──────────────────────

  const processAudio = useCallback(async (audioBlob: Blob) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setIsProcessing(true);
    onEndRef.current?.(); // signal: listening stopped

    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, "recording.webm");

      const response = await apiRequest<{ text: string }>("/zentrixa/transcribe", {
        method: "POST",
        body: formData,
      });

      const text = (response?.text || "").trim();
      setTranscript(text);

      if (!text) {
        onErrorRef.current?.("No speech detected.");
        return;
      }

      // Enforce English-only
      if (!isEnglish(text)) {
        onErrorRef.current?.("Only English voice commands are supported.");
        return;
      }

      onFinalResultRef.current?.(text);
    } catch (err) {
      let msg = err instanceof Error ? err.message : "Failed to transcribe audio.";
      try {
        const parsed = JSON.parse(msg);
        msg = parsed.detail || parsed.message || msg;
      } catch {
        // ignore non-json error strings
      }
      setError(msg);
      if (!/audio file is empty|no speech detected/i.test(msg)) {
        onErrorRef.current?.(msg);
      }
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  }, []);

  // ── Start listening ──────────────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    if (isListening || isProcessingRef.current) return;

    try {
      setError(null);
      setTranscript("");
      chunksRef.current = [];

      // Enhanced WebRTC microphone constraints for clean SNR audio input
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000,
      });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        chunksRef.current = [];
        void processAudio(blob);
      };

      // ── Volume analyser (drives the animated circle scale) ────────────────────
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      lastActiveTimeRef.current = Date.now();

      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        setMicScale(1 + Math.min(avg / 255, 1) * 0.5);
        if (avg > 15) lastActiveTimeRef.current = Date.now();
        volumeRafRef.current = requestAnimationFrame(tick);
      };
      volumeRafRef.current = requestAnimationFrame(tick);

      mediaRecorder.start(250);
      setIsListening(true);
      onStartRef.current?.();

      // ── Silence detector ──────────────────────────────────────────────────────
      clearTimers();
      silenceTimerRef.current = window.setInterval(() => {
        if (Date.now() - lastActiveTimeRef.current > silenceTimeoutMs) {
          stopListening();
        }
      }, 500);

      maxSessionTimerRef.current = window.setTimeout(() => {
        stopListening();
      }, maxSessionMs);
    } catch {
      setError("Microphone access denied or not available.");
      onErrorRef.current?.("Microphone access denied or not available.");
    }
  }, [isListening, processAudio, clearTimers, maxSessionMs, silenceTimeoutMs, stopListening]);

  // ── Mute toggle (stream‑level, doesn't stop recording) ──────────────────────

  const toggleMute = useCallback(() => {
    if (!micStreamRef.current) return;
    const next = !isMuted;
    micStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !next; });
    setIsMuted(next);
  }, [isMuted]);

  const resetTranscript = useCallback(() => setTranscript(""), []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────────

  useEffect(() => () => {
    clearTimers();
    stopAudioTracks();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }, [clearTimers, stopAudioTracks]);

  return {
    supported,
    /** True while the microphone is recording (show animated circle) */
    isListening,
    /** True while Faster-Whisper is transcribing after recording stopped */
    isProcessing,
    isMuted,
    transcript,
    error,
    /** Normalised 1–1.5 scale value driven by mic volume */
    micScale,
    startListening,
    stopListening,
    toggleMute,
    resetTranscript,
  };
}
