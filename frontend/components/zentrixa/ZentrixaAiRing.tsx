"use client";

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

type ZentrixaAiMode = "thinking" | "listening" | "replying" | null;

export interface ZentrixaAiRingProps {
  mode: ZentrixaAiMode;
  micScale?: number;
  size?: number;
  className?: string;
}

export function ZentrixaAiRing({
  mode,
  micScale = 1,
  size = 128,
  className,
}: ZentrixaAiRingProps) {
  return (
    <div
      className={cn("zentrixa-ai-container", className)}
      data-mode={mode || "idle"}
      style={
        {
          "--zentrixa-ai-size": `${size}px`,
          "--zentrixa-ai-center-size": `${Math.round(size * 0.5)}px`,
          "--zentrixa-ai-scale": micScale,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <div className="zentrixa-ai-center" />

      <div
        className={cn("zentrixa-ai-ring zentrixa-ai-thinking", mode !== "thinking" && "hidden")}
      />

      <div
        className={cn("zentrixa-ai-ring zentrixa-ai-listening", mode !== "listening" && "hidden")}
      />

      <div
        className={cn("zentrixa-ai-ring zentrixa-ai-replying", mode !== "replying" && "hidden")}
      />
    </div>
  );
}
