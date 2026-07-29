"use client";

import Link from "next/link";
import { GlobalFooter } from "@/components/layout/global-footer";
import Image from "next/image";
import { GoogleAuthButton } from "@/components/google-auth-button";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import React, {
  FormEvent,
  useCallback,
  useEffect,
  useState,
  useRef,
} from "react";
import {
  ArrowRight,
  Loader2,
  Sparkles,
  Star,
  Layout,
  Search,
  CheckCircle2,
  XCircle,
  Bot,
  Sun,
  Moon
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme } from "next-themes";

const heroFeatures = [
  "Manage unlimited projects without confusion",
  "Assign tasks instantly with AI assistance",
  "Track progress in real time",
  "Automate workflows with intelligent logic",
  "Secure data with cloud backups",
  "Boost team productivity effortlessly",
];

function ScrollReveal({ children, delay = 0, className = "" }: { children: React.ReactNode, delay?: number, className?: string }) {
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setInView(true);
      } else {
        setInView(false); // Reverse on scroll up
      }
    }, { threshold: 0.1 });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-all duration-1000 ease-[cubic-bezier(0.25,0.1,0.25,1.0)] ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-24"} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

function RobotSplitCard() {
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry.isIntersecting);
    }, { threshold: 0.5 });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="relative w-full max-w-sm rounded-2xl overflow-hidden shadow-sm h-24 flex items-center justify-center">
      {/* Outer wrapper provides the visual container color */}
      <div className="absolute inset-0 bg-primary/10 border border-primary/20 rounded-2xl" />

      {/* Left and Right curtains */}
      <div className={`absolute top-0 bottom-0 left-0 w-1/2 bg-card rounded-l-2xl border-y border-l border-border z-10 transition-transform duration-[1200ms] ease-[cubic-bezier(0.85,0,0.15,1)] ${inView ? "-translate-x-full" : "translate-x-0"}`} />
      <div className={`absolute top-0 bottom-0 right-0 w-1/2 bg-card rounded-r-2xl border-y border-r border-border z-10 transition-transform duration-[1200ms] ease-[cubic-bezier(0.85,0,0.15,1)] ${inView ? "translate-x-full" : "translate-x-0"}`} />

      {/* Center seam */}
      <div className={`absolute inset-y-0 left-1/2 w-px bg-border z-20 transition-opacity duration-300 ${inView ? "opacity-0" : "opacity-100"}`} />

      {/* Content */}
      <div className={`relative z-0 px-6 transition-all duration-1000 ease-out ${inView ? "opacity-100 scale-100 delay-[400ms]" : "opacity-0 scale-90 delay-0"}`}>
        <p className="text-sm font-medium text-foreground text-center leading-relaxed">
          "I'll handle task assignment and scheduling while you focus on the vision."
        </p>
      </div>
    </div>
  )
}

export default function HomePage() {
  const {
    user,
    isLoading,
    authenticateWithGoogle,
    requestLoginOtp,
    verifyLoginOtp,
    requestSignupOtp,
    verifySignupEmailOtp,
  } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authMode, setAuthMode] = useState<"signup" | "login">("signup");
  const [authStep, setAuthStep] = useState<"form" | "otp">("form");
  const [introStage, setIntroStage] = useState<"loading" | "strike" | "ready">("loading");

  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [navReady, setNavReady] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get("trialExpired") === "true") {
        toast.error("Your 30-minute admin trial has expired. Please sign in or create an account.");
      }
    }
  }, []);

  useEffect(() => {
    if (!isLoading && user) {
      router.push("/dashboard");
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (isLoading || user) return;
    const loadingTimer = window.setTimeout(() => setIntroStage("strike"), 950);
    const revealTimer = window.setTimeout(() => {
      setIntroStage("ready");
      setNavReady(true);
    }, 1500); // Trigger earlier for nav animations
    return () => {
      window.clearTimeout(loadingTimer);
      window.clearTimeout(revealTimer);
    };
  }, [isLoading, user]);

  useEffect(() => {
    if (authStep === "otp" && !email.trim()) {
      setAuthStep("form");
      setOtp("");
    }
  }, [authStep, email]);

  const toggleTheme = (e: React.MouseEvent) => {
    const isDark = theme === "dark";
    const nextTheme = isDark ? "light" : "dark";

    if (!document.startViewTransition) {
      setTheme(nextTheme);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const maxRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    const transition = document.startViewTransition(() => {
      setTheme(nextTheme);
    });

    transition.ready.then(() => {
      const clipPath = [
        `circle(0px at ${x}px ${y}px)`,
        `circle(${maxRadius}px at ${x}px ${y}px)`,
      ];
      document.documentElement.animate(
        { clipPath },
        {
          duration: 800,
          easing: "cubic-bezier(0.4, 0, 0.2, 1)",
          pseudoElement: "::view-transition-new(root)",
        }
      );
    });
  };

  const handlePrimarySubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (authStep === "otp" && !otp.trim()) {
      toast.error("Please enter the OTP");
      return;
    }

    setIsSubmitting(true);
    try {
      if (authMode === "login") {
        if (authStep === "form") {
          await requestLoginOtp(email.trim());
          setAuthStep("otp");
          toast.success("Login OTP sent to your email.");
        } else {
          await verifyLoginOtp(email.trim(), otp.trim());
          toast.success("Successfully logged in.");
          router.push("/dashboard");
        }
        return;
      }

      if (authStep === "form") {
        if (!name.trim()) {
          toast.error("Please enter your name");
          return;
        }
        await requestSignupOtp(email.trim());
        setAuthStep("otp");
        toast.success("Verification OTP sent to your email.");
        return;
      }

      const data = await verifySignupEmailOtp(email.trim(), otp.trim());
      const firstName = name.trim().split(" ")[0];
      toast.success("Email verified! Now choose your account type.");
      router.push(
        `/signup?email=${encodeURIComponent(email.trim())}&name=${encodeURIComponent(firstName)}&verificationToken=${encodeURIComponent(data.verificationToken)}&trialAlreadyUsed=${data.trialAlreadyUsed}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to continue";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleAuth = useCallback(
    async (credential: string) => {
      try {
        await authenticateWithGoogle(credential);
        toast.success("Signed in with Google.");
        router.push("/dashboard");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Google sign-in failed");
      }
    },
    [authenticateWithGoogle, router]
  );

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (user) return null;

  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground font-sans antialiased">

      {/* Dynamic View-Transition Global Styles */}
      <style dangerouslySetInnerHTML={{
        __html: `
        ::view-transition-old(root),
        ::view-transition-new(root) {
          animation: none;
          mix-blend-mode: normal;
          display: block;
        }
      `}} />

      {/* Intro Animation Layer */}
      {introStage !== "ready" && (
        <div className="pointer-events-none fixed inset-0 z-[100] overflow-hidden bg-background">
          <div
            className={`absolute inset-0 bg-background transition-opacity duration-500 ${introStage === "loading" ? "opacity-100" : "opacity-0"}`}
          />
          {introStage === "loading" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 text-foreground">
              <div className="flex h-20 w-20 items-center justify-center rounded-full border border-border bg-card">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold uppercase tracking-[0.35em] text-muted-foreground">
                  Loading Tickzen
                </p>
                <p className="mt-2 text-base text-muted-foreground">
                  Preparing your AI workspace experience
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Content Wrapper */}
      <div className={`transition-all duration-700 relative ${introStage === "ready" ? "opacity-100 blur-0" : "opacity-0 blur-sm saturate-50 translate-y-4"}`}>

        {/* Ambient Gradient Background */}
        <div className="absolute inset-0 z-0 bg-[radial-gradient(circle_at_top,theme(colors.primary.DEFAULT/0.05)_0%,transparent_100%)] pointer-events-none" />

        {/* HEADER & HERO SECTION */}
        <header className="relative z-10 w-full px-4 pt-4 sm:px-6 lg:px-8 xl:pt-8 bg-gradient-to-b from-background via-background/80 to-transparent">
          <div className="mx-auto max-w-[1400px]">
            <nav className="flex flex-row items-start sm:items-center justify-between mb-8 md:mb-12 gap-2">

              {/* Logo Switcher */}
              <div className="relative h-8 w-24 sm:h-10 sm:w-28 md:h-16 md:w-40 lg:h-20 lg:w-48 shrink-0 overflow-hidden mt-1 sm:mt-0" style={{ zoom: 0.909 }}>
                {!mounted ? null : (
                  <>
                    <Image
                      src="/logo/light.png"
                      alt="TickZen Logo Light"
                      fill
                      sizes="(max-width: 768px) 160px, 192px"
                      className={`object-contain transition-opacity duration-[800ms] ${theme !== 'dark' ? 'opacity-100' : 'opacity-0'}`}
                    />
                    <Image
                      src="/logo/dark.png"
                      alt="TickZen Logo Dark"
                      fill
                      sizes="(max-width: 768px) 160px, 192px"
                      className={`object-contain transition-opacity duration-[800ms] ${theme === 'dark' ? 'opacity-100' : 'opacity-0'}`}
                    />
                  </>
                )}
              </div>

              {/* Desktop Nav Actions */}
              <div className="hidden md:flex flex-wrap w-full items-center justify-end gap-2 lg:w-auto lg:gap-3">
                {["Dashboards", "Features", "Pricing", "Admin Workspace"].map((item, idx) => {
                  const targetId = item.toLowerCase().replace(" ", "-");
                  return (
                    <a 
                      key={item} 
                      href={`#${targetId}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth" });
                      }}
                      className="group h-10 flex flex-col justify-center shrink-0"
                    >
                      <div
                        className={`transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] ${navReady ? "translate-y-0 opacity-100 scale-100" : "-translate-y-16 opacity-0 scale-50"}`}
                        style={{ transitionDelay: `${idx * 100}ms` }}
                      >
                        <div
                          className="flex overflow-hidden relative rounded-full bg-secondary text-sm font-medium text-secondary-foreground hover:bg-secondary/80 transition-all duration-[600ms] ease-out hover:scale-105"
                          style={{ width: navReady ? (item.length * 8 + 48) + 'px' : '40px', height: '40px', transitionDelay: navReady ? `${idx * 150 + 200}ms` : '0ms' }}
                        >
                          <span className="absolute inset-0 flex items-center justify-center whitespace-nowrap transition-opacity duration-[400ms]" style={{ opacity: navReady ? 1 : 0, transitionDelay: navReady ? `${idx * 150 + 500}ms` : '0ms' }}>
                            {item}
                          </span>
                        </div>
                      </div>
                    </a>
                  );
                })}

                {mounted && (
                  <button
                    onClick={toggleTheme}
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-secondary-foreground transition-all hover:bg-secondary/80 ml-2 hover:scale-110 active:scale-95"
                    aria-label="Toggle dark mode"
                  >
                    {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                  </button>
                )}
              </div>

              {/* Mobile explicitly compact nav */}
              <div className="md:hidden flex flex-wrap justify-end gap-1.5 sm:gap-2 items-center w-full max-w-[85%]">
                {["Dashboards", "Features", "Admin"].map((item) => {
                  const targetId = item.toLowerCase().replace(" ", "-");
                  return (
                    <a 
                      key={item} 
                      href={`#${targetId}`}
                      onClick={(e) => {
                        e.preventDefault();
                        // For 'admin', target might be 'admin-workspace' if it matches the desktop section, but here they just typed Admin.
                        const trueTargetId = targetId === "admin" ? "admin-workspace" : targetId;
                        document.getElementById(trueTargetId)?.scrollIntoView({ behavior: "smooth" });
                      }}
                      className="rounded-full bg-secondary px-3 sm:px-4.5 py-[6px] text-[13px] sm:text-[15px] font-semibold text-secondary-foreground whitespace-nowrap"
                    >
                      {item}
                    </a>
                  );
                })}
                {mounted && (
                  <button
                    onClick={toggleTheme}
                    className="flex h-8 w-8 sm:h-11 sm:w-11 items-center justify-center rounded-full bg-secondary text-secondary-foreground shrink-0"
                    aria-label="Toggle dark mode"
                  >
                    {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
                  </button>
                )}
              </div>
            </nav>

            <div className="grid gap-12 lg:grid-cols-[1.2fr_0.8fr] lg:items-center pb-12 md:pb-20">

              {/* Hero Text */}
              <div className="max-w-3xl">
                <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary">
                  <Sparkles className="h-4 w-4" /> TickZen = AI that runs your projects, not just tracks them
                </div>
                <h1 className="text-[clamp(2.5rem,5vw,4.5rem)] font-black leading-[1.05] tracking-tight text-foreground">
                  AI-Powered Project Management That Thinks With You
                </h1>
                <p className="mt-6 text-[clamp(1.1rem,1.5vw,1.25rem)] text-muted-foreground leading-relaxed max-w-2xl">
                  Plan, assign, track, and optimize your workflow using intelligent automation — not manual effort. Switch to the next generation of productivity.
                </p>
                <div className="mt-10 flex flex-wrap items-center gap-4">
                  <Button asChild className="h-14 rounded-full px-8 text-lg font-medium shadow-lg hover:-translate-y-1 hover:shadow-xl transition-all active:scale-95">
                    <a 
                      href="#pricing"
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >Start Free</a>
                  </Button>
                  <Button asChild variant="outline" className="h-14 rounded-full border-2 border-primary text-primary px-8 text-lg font-medium hover:bg-primary/5 transition-colors bg-transparent active:scale-95">
                    <a 
                      href="#features"
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >Explore Features</a>
                  </Button>
                </div>
                <p className="mt-6 text-sm font-medium text-muted-foreground block">
                  No credit card required • Try Admin Free for 30 Minutes
                </p>
              </div>

              {/* Login / Signup Card with Curtain Drop Bounce Animation */}
              <div className={`w-full lg:max-w-md mx-auto lg:ml-auto relative transition-all duration-[1200ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] ${navReady ? "translate-y-0 opacity-100" : "-translate-y-32 opacity-0"}`}>
                <div className="absolute inset-0 bg-gradient-to-r from-primary/10 to-primary/5 rounded-[2.5rem] blur-xl" />
                <div className="relative rounded-[2.5rem] bg-card p-6 md:p-8 shadow-2xl border border-border group hover:shadow-primary/20 transition-all duration-500 hover:-translate-y-1 w-full overflow-hidden">

                  <div className="relative mb-8 flex w-full rounded-full bg-secondary p-1.5">
                    <div
                      className="absolute bottom-1.5 left-1.5 top-1.5 w-[calc(50%-6px)] rounded-full bg-background shadow-sm transition-transform duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
                      style={{ transform: authMode === "signup" ? "translateX(100%)" : "translateX(0)" }}
                    />
                    <button
                      type="button"
                      onClick={() => { setAuthMode("login"); setAuthStep("form"); setOtp(""); }}
                      className={`relative z-10 w-1/2 rounded-full py-2.5 text-sm transition-colors duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${authMode === "login" ? "font-bold text-foreground" : "font-semibold text-muted-foreground hover:text-foreground/80"}`}
                    >
                      Sign In
                    </button>
                    <button
                      type="button"
                      onClick={() => { setAuthMode("signup"); setAuthStep("form"); setOtp(""); }}
                      className={`relative z-10 w-1/2 rounded-full py-2.5 text-sm transition-colors duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${authMode === "signup" ? "font-bold text-foreground" : "font-semibold text-muted-foreground hover:text-foreground/80"}`}
                    >
                      Sign Up
                    </button>
                  </div>

                  <form onSubmit={handlePrimarySubmit} className="flex flex-col">
                    <div className={`grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${authStep === "form" && authMode === "signup" ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none"}`}>
                      <div className="overflow-hidden">
                        <div className="pb-5">
                          <Input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Enter your name"
                            className="h-14 w-full rounded-full border-0 bg-secondary px-6 text-base placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
                            required={authMode === "signup" && authStep === "form"}
                            tabIndex={authMode === "signup" && authStep === "form" ? 0 : -1}
                          />
                        </div>
                      </div>
                    </div>

                    <div className={`grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${authStep === "form" ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none"}`}>
                      <div className="overflow-hidden">
                        <div className="pb-5">
                          <Input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="Enter your email"
                            className="h-14 w-full rounded-full border-0 bg-secondary px-6 text-base placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
                            required={authStep === "form"}
                            tabIndex={authStep === "form" ? 0 : -1}
                          />
                        </div>
                      </div>
                    </div>

                    <div className={`grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${authStep === "otp" ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none"}`}>
                      <div className="overflow-hidden">
                        <div className="space-y-4 pb-5">
                          <p className="text-center text-sm text-muted-foreground">
                            Enter the OTP sent to <span className="font-semibold text-foreground">{email}</span>
                          </p>
                          <Input
                            type="text"
                            inputMode="numeric"
                            value={otp}
                            onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                            placeholder="Enter OTP"
                            className="h-14 w-full rounded-full border-0 bg-secondary px-6 text-center text-xl tracking-widest placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
                            required={authStep === "otp"}
                            tabIndex={authStep === "otp" ? 0 : -1}
                          />
                          <div className="flex justify-center flex-col items-center">
                            <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => { setAuthStep("form"); setOtp(""); }} tabIndex={authStep === "otp" ? 0 : -1}>
                              Change email
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-center pb-5">
                      <Button type="submit" disabled={isSubmitting} className="h-14 w-full rounded-full text-base font-semibold shadow hover:-translate-y-0.5 transition-transform active:scale-95">
                        {isSubmitting ? (authStep === "form" ? "Sending..." : "Verifying...") : authMode === "login" ? (authStep === "form" ? "Continue" : "Login") : (authStep === "form" ? "Continue" : "Create Account")}
                      </Button>
                    </div>

                    <div className="flex items-center gap-4 pb-5 px-2">
                      <div className="h-px flex-1 bg-border" />
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">or</span>
                      <div className="h-px flex-1 bg-border" />
                    </div>

                    <div className="pb-2">
                      <GoogleAuthButton onCredential={handleGoogleAuth} text={authMode === "login" ? "signin_with" : "signup_with"} />
                    </div>
                  </form>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* ZENTRIXA AI SECTION */}
        <section className="relative z-10 py-12 md:py-20 px-4 sm:px-6 lg:px-8 md:mt-10 border-t border-border bg-card/30 backdrop-blur-sm overflow-hidden">
          <div className="mx-auto max-w-[1400px] grid md:grid-cols-2 gap-10 md:gap-16 items-center">
            <ScrollReveal delay={100} className="order-2 md:order-1 relative aspect-square w-full max-w-md mx-auto group">
              <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full group-hover:bg-primary/30 transition-colors duration-700" />
              <div className="relative h-full w-full rounded-[3rem] bg-card border border-border shadow-2xl p-6 md:p-10 flex flex-col items-center justify-center gap-6 overflow-hidden hover:-translate-y-2 transition-transform duration-700 ease-[cubic-bezier(0.25,0.1,0.25,1)]">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/10 via-transparent to-transparent opacity-60" />
                <Bot className="w-24 h-24 text-primary animate-pulse transition-transform duration-700 group-hover:scale-110" />

                {/* Advanced Robot Curtain Animation Component */}
                <RobotSplitCard />
              </div>
            </ScrollReveal>

            <ScrollReveal delay={200} className="order-1 md:order-2">
              <div className="mb-4 inline-flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-primary">
                <Sparkles className="h-4 w-4" /> AI Companion
              </div>
              <h2 className="text-4xl md:text-5xl font-black text-foreground tracking-tight leading-tight mb-6">
                Meet Zentrixa —<br />Your AI Teammate
              </h2>
              <p className="text-lg text-muted-foreground mb-8 leading-relaxed">
                Zentrixa understands your commands, creates tasks automatically, tracks deadlines, and alerts you before things go wrong. Stop manually doing what AI can do for you.
              </p>
              <ul className="space-y-4">
                {["Turn voice or text into tasks instantly", "Smart deadline tracking", "Real-time alerts and suggestions", "Interactive AI Chatbox for meeting & tasks", "Automated handler and team interactions"].map((pt, i) => (
                  <li key={i} className="flex items-start gap-4">
                    <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
                      <CheckCircle2 className="h-4 w-4" />
                    </div>
                    <span className="text-foreground font-medium text-lg">{pt}</span>
                  </li>
                ))}
              </ul>
            </ScrollReveal>
          </div>
        </section>

        {/* WHY TICKZEN (COMPARISON) SECTION */}
        <section id="features" className="relative z-10 py-16 md:py-24 px-4 sm:px-6 lg:px-8 overflow-hidden">
          <ScrollReveal delay={0} className="mx-auto max-w-[1200px] text-center mb-12 md:mb-16">
            <h2 className="text-4xl md:text-5xl font-black text-foreground tracking-tight mb-6">Why TickZen is Different</h2>
            <p className="text-xl text-muted-foreground">Don't manage projects the hard way. See the AI difference.</p>
          </ScrollReveal>

          <div className="mx-auto max-w-[1000px] grid md:grid-cols-2 gap-8">
            <ScrollReveal delay={200} className="rounded-[3rem] bg-card border border-border p-8 md:p-10 shadow-lg hover:-translate-y-2 hover:shadow-xl transition-all duration-500 group">
              <div className="mb-8 flex items-center justify-center h-16 w-16 rounded-full bg-red-500/10 text-red-500 mx-auto transition-transform duration-500 group-hover:scale-110">
                <XCircle className="h-8 w-8" />
              </div>
              <h3 className="text-2xl font-bold text-center text-foreground mb-8">Traditional Tools</h3>
              <ul className="space-y-5">
                {[
                  "Manual task creation & tagging",
                  "Static, unintelligent boards",
                  "Reactive to missed deadlines",
                  "You maintain the system"
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-lg text-muted-foreground">
                    <XCircle className="h-5 w-5 text-red-500 shrink-0" /> {item}
                  </li>
                ))}
              </ul>
            </ScrollReveal>

            <ScrollReveal delay={400} className="rounded-[3rem] bg-primary p-8 md:p-10 shadow-xl text-primary-foreground transition-transform duration-700 ease-out transform md:scale-105 relative z-10 group hover:-translate-y-2 hover:shadow-2xl">
              <div className="absolute top-0 right-0 -m-4">
                <div className="bg-yellow-400 text-yellow-900 text-xs font-bold px-4 py-2 rounded-full shadow-lg transform rotate-12 rotate-[-12deg]">THE WINNER</div>
              </div>
              <div className="mb-8 flex items-center justify-center h-16 w-16 rounded-full bg-primary-foreground/20 text-primary-foreground mx-auto backdrop-blur-sm transition-transform duration-500 group-hover:scale-110">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <h3 className="text-2xl font-bold text-center text-primary-foreground mb-8">TickZen AI</h3>
              <ul className="space-y-5">
                {[
                  "AI-driven conversational creation",
                  "Predicts delays dynamically",
                  "Automates handler decisions",
                  "Works like a real teammate"
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-lg text-primary-foreground font-medium">
                    <CheckCircle2 className="h-5 w-5 text-primary-foreground shrink-0" /> {item}
                  </li>
                ))}
              </ul>
            </ScrollReveal>
          </div>
        </section>

        {/* DEMO / INTERACTION SECTION */}
        <section className="py-16 md:py-20 px-4 sm:px-6 lg:px-8 bg-secondary text-secondary-foreground md:my-10 relative overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,theme(colors.primary.DEFAULT/0.05)_0%,transparent_70%)]" />
          <div className="mx-auto max-w-[1200px] flex flex-col md:flex-row items-center gap-10 md:gap-16 relative z-10">
            <ScrollReveal delay={100} className="w-full md:w-1/2">
              <div className="mb-4 inline-flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted-foreground">
                <Bot className="h-4 w-4" /> See It In Action
              </div>
              <h2 className="text-4xl md:text-5xl font-black tracking-tight mb-8 text-foreground">
                Tell the AI. <br /><span className="text-primary">Consider it done.</span>
              </h2>
              <div className="bg-card rounded-3xl p-6 border border-border shadow-md relative hover:shadow-lg transition-shadow duration-500">
                <div className="flex gap-4 items-start mb-6">
                  <div className="w-10 h-10 rounded-full bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0">U</div>
                  <div className="bg-muted rounded-2xl rounded-tl-none p-4 text-foreground">
                    "Create a high-priority task to redesign the homepage by tomorrow"
                  </div>
                </div>
                <div className="flex gap-4 items-start">
                  <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0"><Bot className="w-5 h-5" /></div>
                  <div className="bg-primary/5 rounded-2xl rounded-tr-none p-4 text-foreground border border-primary/20">
                    Task created: <strong>Homepage Redesign</strong><br />
                    <span className="text-xs text-primary inline-block mt-2 bg-primary/10 px-2 py-1 rounded border border-primary/20">Priority: High</span>
                    <span className="text-xs text-orange-500 inline-block mt-2 bg-orange-500/10 px-2 py-1 rounded border border-orange-500/20 ml-2">Due: Tomorrow 5 PM</span>
                  </div>
                </div>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={300} className="w-full md:w-1/2">
              <div className="grid gap-4">
                {[
                  "Creates highly detailed tasks from plain English",
                  "Automatically assigns to the correct developer based on keywords",
                  "Dynamically parses deadlines and dates",
                  "Follows up in real-time on your dashboard"
                ].map((txt, idx) => (
                  <div key={idx} className="bg-card/80 backdrop-blur-md border border-border rounded-2xl p-5 flex items-start gap-4 shadow-sm hover:translate-x-2 transition-transform duration-500 group hover:shadow-md">
                    <div className="bg-primary/10 text-primary p-2 rounded-lg group-hover:scale-110 transition-transform"><Sparkles className="w-5 h-5" /></div>
                    <p className="text-foreground mt-0.5">{txt}</p>
                  </div>
                ))}
              </div>
            </ScrollReveal>
          </div>
        </section>

        {/* EXPLORE WORKSPACE (EXISTING 3 CARDS RESTYLED/KEPT) */}
        <section id="dashboards" className="relative z-10 py-16 md:py-20 px-4 sm:px-6 lg:px-8 max-w-[1400px] mx-auto overflow-hidden">
          <ScrollReveal delay={100} className="rounded-[3rem] md:rounded-[3.5rem] bg-card p-6 md:p-12 shadow-xl border border-border backdrop-blur-md">
            <div className="mb-12 flex flex-col items-center text-center gap-4">
              <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.25em] text-muted-foreground">
                <Layout className="h-4 w-4" /> Interface Showcase
              </div>
              <h2 className="text-4xl md:text-5xl leading-[1.1] font-black tracking-tight text-foreground">
                Explore TickZen Workspace
              </h2>
            </div>
            <div className="grid gap-6 md:grid-cols-3">
              {[
                { titleLine1: "Global Tracking", tag: "Analytics", desc: "Track every step of your project lifecycle with real-time holistic updates globally.", img: "/11.jpg", delay: 200 },
                { titleLine1: "Project View", tag: "Kanban", desc: "Visualize and drag-and-drop tasks directly. The AI manages the backend automatically.", img: "/22.jpg", delay: 400 },
                { titleLine1: "Admin Portal", tag: "Control", desc: "Govern your workspace with powerful role permissions, billing, and team monitoring.", img: "/33.jpg", delay: 600 }
              ].map((item, idx) => (
                <ScrollReveal key={idx} className="h-full" delay={item.delay}>
                  <div className="group h-full relative flex flex-col rounded-[2.5rem] bg-card p-6 md:p-8 shadow-sm transition-all duration-500 hover:-translate-y-3 hover:shadow-2xl border border-border">
                    <div className="mb-6 flex h-10 w-full items-center justify-between rounded-full bg-secondary px-4 opacity-70 group-hover:opacity-100 transition-opacity">
                      <span className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">{item.tag}</span>
                    </div>
                    <h3 className="mb-4 text-2xl md:text-3xl font-bold tracking-tight text-foreground uppercase">{item.titleLine1}</h3>
                    <p className="mb-8 text-muted-foreground leading-relaxed">{item.desc}</p>

                    <div className="relative mt-auto aspect-[4/3] w-full overflow-hidden rounded-2xl bg-muted border border-border shadow-inner">
                      <Image
                        src={item.img}
                        alt={item.titleLine1}
                        fill
                        className="object-cover object-top hover:scale-105 transition-transform duration-1000 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
                      />
                    </div>
                  </div>
                </ScrollReveal>
              ))}
            </div>
          </ScrollReveal>
        </section>

        {/* PREMIUM ACCESS SECTION */}
        <section id="pricing" className="relative z-10 py-16 md:py-24 px-4 sm:px-6 lg:px-8 overflow-hidden">
          <ScrollReveal delay={100} className="mx-auto max-w-[1000px] rounded-[3rem] md:rounded-[4rem] bg-card border border-border p-8 md:p-16 text-center shadow-xl relative overflow-hidden group hover:shadow-2xl transition-shadow duration-700">
            <div className="absolute top-0 right-0 p-8 opacity-20 blur-2xl group-hover:opacity-30 group-hover:scale-110 transition-all duration-1000">
              <Star className="w-64 h-64 text-yellow-500" />
            </div>
            <div className="relative z-10">
              <div className="mb-6 inline-flex rounded-full bg-primary/10 px-6 py-2 text-sm font-bold text-primary tracking-widest uppercase border border-primary/20 hover:bg-primary/20 transition-colors cursor-default">
                Admin Privileges
              </div>
              <h2 className="text-4xl md:text-6xl font-black text-foreground tracking-tight mb-8">
                Unlock Full Power of TickZen
              </h2>
              <div className="flex flex-wrap justify-center gap-3 md:gap-4 text-base md:text-lg text-muted-foreground mb-12 max-w-2xl mx-auto">
                {["Advanced AI automation", "Admin controls", "Analytics & insights", "Team productivity boost"].map(ft => (
                  <span key={ft} className="bg-muted px-4 py-2 rounded-full border border-border hover:border-primary/30 transition-colors cursor-default">{ft}</span>
                ))}
              </div>

              <div className="flex flex-col items-center gap-4">
                {/* Razorpay-required pricing clarity */}
                <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-5 py-2 text-base font-bold text-primary mb-2">
                  Paid Admin Plan: ₹99 for 3 Months
                </div>
                <p className="text-sm text-muted-foreground -mt-2 mb-2">
                  One-time payment, non-recurring · Full admin dashboard access for 90 days
                </p>
                <Button asChild className="h-14 md:h-16 rounded-full bg-primary px-8 md:px-10 text-lg md:text-xl font-bold text-primary-foreground hover:opacity-90 hover:scale-105 transition-transform active:scale-95 shadow-md hover:shadow-xl">
                  <Link href="/signup">
                    Unlock Premium Access <ArrowRight className="ml-2 h-5 w-5" />
                  </Link>
                </Button>
                <p className="mt-4 text-sm md:text-base font-medium text-muted-foreground">
                  Try Admin Free for 30 Minutes • Upgrade later directly
                </p>
              </div>
            </div>
          </ScrollReveal>
        </section>

        {/* BOTTOM CTA FOOTER */}
        <section id="admin-workspace" className="relative z-10 py-20 px-4 text-center border-t border-border md:mt-10 overflow-hidden">
          <ScrollReveal delay={100} className="max-w-4xl mx-auto flex flex-col items-center">
            <h2 className="text-4xl md:text-6xl font-black text-foreground tracking-tight mb-8">
              Ready to Stop Managing and <span className="text-primary">Start Finishing?</span>
            </h2>
            <Button asChild className="h-14 md:h-16 rounded-full px-10 md:px-12 text-lg md:text-xl font-bold shadow-xl hover:-translate-y-1 transition-transform active:scale-95 hover:shadow-2xl">
              <a href="#">Start Free Today <ArrowRight className="ml-2 h-5 w-5" /></a>
            </Button>
          </ScrollReveal>
        </section>

        {/* GLOBAL FOOTER — visible on every page */}
        <GlobalFooter />
      </div>
    </main>
  );
}
