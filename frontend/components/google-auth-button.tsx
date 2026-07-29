"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

type GoogleButtonText = "signin_with" | "signup_with" | "continue_with";

type GoogleAuthButtonProps = {
  onCredential: (credential: string) => Promise<void>;
  text?: GoogleButtonText;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            auto_select?: boolean;
            itp_support?: boolean;
            callback: (response: { credential?: string }) => void;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              theme: "outline" | "filled_blue";
              size: "large" | "medium";
              type: "standard";
              shape: "pill" | "rectangular";
              text: GoogleButtonText;
              logo_alignment: "left" | "center";
              width?: number;
            }
          ) => void;
        };
      };
    };
  }
}

export function GoogleAuthButton({
  onCredential,
  text = "continue_with",
}: GoogleAuthButtonProps) {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [clientId, setClientId] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && window.google) {
      setScriptLoaded(true);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadConfig = async () => {
      try {
        const response = await fetch("/api/auth/google/config");
        const data = (await response.json()) as { clientId?: string; message?: string };

        if (!response.ok || !data.clientId) {
          throw new Error(data.message || "Google OAuth config is unavailable.");
        }

        if (mounted) {
          setClientId(data.clientId);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to load Google sign-in";
        if (mounted) {
          toast.error(message);
        }
      }
    };

    loadConfig();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const isGoogleReady = scriptLoaded || Boolean(typeof window !== "undefined" && window.google);
    if (!isGoogleReady || !clientId || !buttonRef.current || !window.google) {
      return;
    }

    buttonRef.current.innerHTML = "";

    window.google.accounts.id.initialize({
      client_id: clientId,
      auto_select: false,
      itp_support: true,
      callback: async (response) => {
        if (!response.credential) {
          toast.error("Google did not return a valid credential.");
          return;
        }

        try {
          setIsLoading(true);
          await onCredential(response.credential);
        } finally {
          setIsLoading(false);
        }
      },
    });

    window.google.accounts.id.renderButton(buttonRef.current, {
      theme: "outline",
      size: "large",
      type: "standard",
      shape: "pill",
      text,
      logo_alignment: "left",
      width: 260,
    });
  }, [clientId, onCredential, scriptLoaded, text]);

  return (
    <div className="flex flex-col items-center gap-3">
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onLoad={() => setScriptLoaded(true)}
      />
      <div ref={buttonRef} className="min-h-[44px]" />
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-[#666]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Signing in with Google...
        </div>
      )}
    </div>
  );
}
