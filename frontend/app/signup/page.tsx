"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { apiRequest, setToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { toast } from "sonner";
import { CheckCircle2, CheckSquare, Clock, Code2, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { GlobalFooter } from "@/components/layout/global-footer";

const ADMIN_PLAN_AMOUNT = 99;

const ADMIN_FEATURES = [
  "Create and manage unlimited projects",
  "Full control over team roles & permissions",
  "AI-powered task creation and suggestions",
  "Smart deadline and priority management",
  "Real-time project tracking & dashboards",
  "Custom workflows for different projects",
  "Bulk task updates and management",
  "Secure data storage with backups",
];

const DEVELOPER_FEATURES = [
  "Join and collaborate on projects",
  "View assigned tasks & deadlines",
  "Track personal progress",
  "Real-time notifications",
];

type RoleOption = "developer" | "admin" | "trial-admin";

interface AdminOrderResponse {
  keyId: string;
  amount: number;
  currency: string;
  order: { id: string };
}

interface VerifyAdminPaymentResponse {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: "admin";
  };
}

declare global {
  interface Window {
    Razorpay?: new (options: {
      key: string;
      amount: number;
      currency: string;
      name: string;
      description: string;
      order_id: string;
      handler: (response: {
        razorpay_order_id: string;
        razorpay_payment_id: string;
        razorpay_signature: string;
      }) => void;
      modal?: { ondismiss?: () => void };
      prefill?: { name?: string; email?: string };
      theme?: { color?: string };
    }) => { open: () => void };
  }
}

const loadRazorpayScript = () =>
  new Promise<boolean>((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });

function SignupPageContent() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [role, setRole] = useState<RoleOption | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpEmail, setOtpEmail] = useState("");
  const [verifiedSignupToken, setVerifiedSignupToken] = useState("");
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [trialAlreadyUsed, setTrialAlreadyUsed] = useState(false);
  const { requestSignupOtp, verifySignupOtp, completeVerifiedSignup } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read URL params
  useEffect(() => {
    const prefetchedEmail = searchParams.get("email")?.trim() || "";
    const prefetchedName = searchParams.get("name")?.trim() || "";
    const prefetchedRole = searchParams.get("role")?.trim() as RoleOption | null;
    const prefetchedVerificationToken = searchParams.get("verificationToken")?.trim() || "";
    const trialUsedParam = searchParams.get("trialAlreadyUsed") === "true";

    if (prefetchedRole && (prefetchedRole === "admin" || prefetchedRole === "developer" || prefetchedRole === "trial-admin")) {
      setRole(prefetchedRole);
    }

    if (prefetchedEmail && (!email || !!prefetchedVerificationToken)) {
      setEmail(prefetchedEmail);
    }
    if (prefetchedName && !fullName) {
      setFullName(prefetchedName);
    }
    
    // Set trialAlreadyUsed unconditionally if param exists or wait until OTP verification sets it
    if (trialUsedParam && !trialAlreadyUsed) {
      setTrialAlreadyUsed(true);
    }
    if (
      prefetchedVerificationToken &&
      (prefetchedVerificationToken !== verifiedSignupToken || prefetchedEmail !== verifiedEmail)
    ) {
      setVerifiedSignupToken(prefetchedVerificationToken);
      setVerifiedEmail(prefetchedEmail);
      setOtpSent(false);
      setOtp("");
      setOtpEmail("");
    }
  }, [searchParams, verifiedEmail, verifiedSignupToken]);

  // Reset OTP state when role or email changes
  useEffect(() => {
    if (role === "admin" || !role) {
      setOtpSent(false);
      setOtp("");
      setOtpEmail("");
      return;
    }
    if (verifiedSignupToken && verifiedEmail && email !== verifiedEmail) {
      setVerifiedSignupToken("");
      setVerifiedEmail("");
    }
    if (otpSent && otpEmail && email !== otpEmail) {
      setOtpSent(false);
      setOtp("");
      setOtpEmail("");
    }
  }, [email, otpEmail, otpSent, role]);

  const splitName = (name: string) => {
    const parts = name.trim().split(/\s+/);
    return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
  };

  // Inline Razorpay payment for admin
  const handleAdminPayment = async () => {
    const { firstName, lastName } = splitName(fullName);
    setIsLoading(true);

    try {
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded || !window.Razorpay) {
        throw new Error("Razorpay checkout failed to load.");
      }

      const orderResponse = await apiRequest<AdminOrderResponse>("/auth/signup/admin/order", {
        method: "POST",
        body: JSON.stringify({
          name: fullName.trim(),
          email,
        }),
        auth: false,
      });

      const razorpay = new window.Razorpay({
        key: orderResponse.keyId,
        amount: orderResponse.order ? orderResponse.amount * 100 : ADMIN_PLAN_AMOUNT * 100,
        currency: orderResponse.currency,
        name: "Tickzen Admin",
        description: "Admin access activation — ₹" + ADMIN_PLAN_AMOUNT,
        order_id: orderResponse.order.id,
        prefill: { name: fullName.trim(), email },
        theme: { color: "#8b5e3c" },
        modal: {
          ondismiss: () => {
            setIsLoading(false);
          },
        },
        handler: async (response) => {
          try {
            const verifiedSignup = await apiRequest<VerifyAdminPaymentResponse>("/auth/signup/admin/verify-payment", {
              method: "POST",
              body: JSON.stringify({
                name: fullName.trim(),
                email,
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
                password: password || undefined,
              }),
              auth: false,
            });

            setToken(verifiedSignup.token);
            localStorage.setItem(
              "auth-session",
              JSON.stringify({
                token: verifiedSignup.token,
                user: {
                  id: verifiedSignup.user.id,
                  email: verifiedSignup.user.email,
                  firstName,
                  lastName,
                  role: verifiedSignup.user.role,
                },
              })
            );
            localStorage.setItem(
              "user",
              JSON.stringify({
                id: verifiedSignup.user.id,
                email: verifiedSignup.user.email,
                firstName,
                lastName,
                role: verifiedSignup.user.role,
              })
            );
            toast.success("Payment complete! Admin account is ready.");
            router.push("/dashboard");
          } catch (error) {
            const message = error instanceof Error ? error.message : "Payment verified, but admin creation failed.";
            toast.error(message);
          } finally {
            setIsLoading(false);
          }
        },
      });

      razorpay.open();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start payment";
      toast.error(message);
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!role) {
      toast.error("Please select an account type");
      return;
    }

    if (password !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    const { firstName, lastName } = splitName(fullName);

    if (!firstName) {
      toast.error("Please enter your full name");
      return;
    }

    if (password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }

    // Admin: launch Razorpay directly
    if (role === "admin") {
      await handleAdminPayment();
      return;
    }

    setIsLoading(true);

    try {
      if (role === "developer" || role === "trial-admin") {
        if (verifiedSignupToken) {
          await completeVerifiedSignup({
            email,
            password,
            firstName,
            lastName,
            verificationToken: verifiedSignupToken,
            role,
          });
          toast.success(role === "trial-admin" ? "Admin trial activated! You have 30 minutes." : "Developer account created!");
          router.push("/dashboard");
        } else if (!otpSent) {
          await requestSignupOtp(email);
          setOtpSent(true);
          setOtpEmail(email);
          toast.success("OTP sent to your email.");
        } else {
          if (otp.trim().length !== 6) {
            toast.error("Enter the 6-digit OTP sent to your email.");
            return;
          }
          await verifySignupOtp({ email, password, firstName, lastName, otp: otp.trim(), role });
          if (role === "trial-admin") setTrialAlreadyUsed(true);
          toast.success(role === "trial-admin" ? "Admin trial activated! You have 30 minutes." : "Developer account created!");
          router.push("/dashboard");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create account";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const isEmailVerified = !!verifiedSignupToken;

  const getButtonText = () => {
    if (!role) return "Select an account type";
    if (role === "admin") return `Pay ₹${ADMIN_PLAN_AMOUNT} & Create Admin`;
    if (isEmailVerified) return "Create Account";
    if (otpSent) return "Verify OTP & Create Account";
    return "Send OTP";
  };

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <div className="relative flex flex-1 flex-col items-center justify-center gap-8 p-4 sm:p-6 lg:p-8">
        {/* Theme toggle — icon only */}
        <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
          <ThemeToggle />
        </div>

        <div className="w-full max-w-5xl">
          {/* Header */}
          <div className="mb-6 text-center lg:mb-8">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary shadow-lg shadow-primary/20">
              <CheckSquare className="h-7 w-7 text-primary-foreground" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Choose Your Account</h1>
            <p className="mt-2 text-muted-foreground">
              {isEmailVerified ? (
                <>
                  <CheckCircle2 className="mr-1.5 inline h-4 w-4 text-emerald-500" />
                  <span className="font-medium text-foreground">{email}</span> verified — now pick your plan
                </>
              ) : (
                "Select a plan to get started with Tickzen"
              )}
            </p>
          </div>

          {/* Role Cards */}
          <div className="mb-6 grid gap-4 sm:grid-cols-3 lg:mb-8">
            {/* Developer */}
            <div
              role="button"
              tabIndex={0}
              className={`group relative flex cursor-pointer flex-col rounded-2xl border-2 p-5 transition-all duration-200 hover:shadow-md sm:p-6 ${
                role === "developer"
                  ? "border-blue-500 bg-blue-50/60 shadow-md shadow-blue-500/10 ring-1 ring-blue-500/30 dark:bg-blue-500/10"
                  : "border-border bg-card hover:border-blue-400/50"
              }`}
              onClick={() => setRole("developer")}
            >
              <div className="mb-3 flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${role === "developer" ? "bg-blue-500 text-white" : "bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400"}`}>
                  <Code2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">Developer</h3>
                  <p className="text-lg font-bold text-blue-600 dark:text-blue-400">Free</p>
                </div>
              </div>
              <ul className="mt-auto space-y-1.5 text-xs text-muted-foreground">
                {DEVELOPER_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-blue-500" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {role === "developer" && (
                <div className="absolute right-3 top-3">
                  <CheckCircle2 className="h-5 w-5 text-blue-500" />
                </div>
              )}
            </div>

            {/* Paid Admin */}
            <div
              role="button"
              tabIndex={0}
              className={`group relative flex cursor-pointer flex-col rounded-2xl border-2 p-5 transition-all duration-200 hover:shadow-md sm:p-6 ${
                role === "admin"
                  ? "border-amber-500 bg-amber-50/60 shadow-md shadow-amber-500/10 ring-1 ring-amber-500/30 dark:bg-amber-500/10"
                  : "border-border bg-card hover:border-amber-400/50"
              }`}
              onClick={() => setRole("admin")}
            >
              <div className="absolute -right-1 -top-1 rounded-bl-xl rounded-tr-2xl bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                Popular
              </div>
              <div className="mb-3 flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${role === "admin" ? "bg-amber-500 text-white" : "bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400"}`}>
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">Paid Admin</h3>
                  <p className="text-lg font-bold text-amber-600 dark:text-amber-400">₹{ADMIN_PLAN_AMOUNT} <span className="text-xs font-medium text-muted-foreground">/ 3 Months</span></p>
                  <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">One-time · non-recurring · 90 days access</p>
                </div>
              </div>
              <ul className="mt-auto space-y-1.5 text-xs text-muted-foreground">
                {ADMIN_FEATURES.slice(0, 4).map((f) => (
                  <li key={f} className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                    <span>{f}</span>
                  </li>
                ))}
                <li className="text-xs font-medium text-amber-600 dark:text-amber-400">+ {ADMIN_FEATURES.length - 4} more features</li>
              </ul>
              {role === "admin" && (
                <div className="absolute right-3 top-8">
                  <CheckCircle2 className="h-5 w-5 text-amber-500" />
                </div>
              )}
            </div>

            {/* Trial Admin */}
            <div
              role={trialAlreadyUsed ? "presentation" : "button"}
              tabIndex={trialAlreadyUsed ? -1 : 0}
              className={`group relative flex flex-col rounded-2xl border-2 p-5 transition-all duration-200 sm:p-6 ${
                trialAlreadyUsed 
                  ? "cursor-not-allowed border-border/50 bg-muted/40 opacity-50 grayscale select-none"
                  : `cursor-pointer hover:shadow-md ${
                      role === "trial-admin"
                        ? "border-teal-500 bg-teal-50/60 shadow-md shadow-teal-500/10 ring-1 ring-teal-500/30 dark:bg-teal-500/10"
                        : "border-border bg-card hover:border-teal-400/50"
                    }`
              }`}
              onClick={() => {
                if (trialAlreadyUsed) {
                  toast.error("You have already used your 30-minute admin trial.");
                  return;
                }
                setRole("trial-admin");
              }}
            >
              <div className="mb-3 flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${role === "trial-admin" && !trialAlreadyUsed ? "bg-teal-500 text-white" : "bg-teal-100 text-teal-600 dark:bg-teal-500/20 dark:text-teal-400"}`}>
                  <Clock className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">Trial Admin</h3>
                  <p className="text-lg font-bold text-teal-600 dark:text-teal-400">
                    {trialAlreadyUsed ? "Trial Used" : "30 min free"}
                  </p>
                </div>
              </div>
              <ul className="mt-auto space-y-1.5 text-xs text-muted-foreground">
                <li className="flex items-start gap-1.5">
                  <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-teal-500" />
                  <span>Full admin access for 30 minutes</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-teal-500" />
                  <span>No payment needed to try</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-teal-500" />
                  <span>Upgrade anytime to keep access</span>
                </li>
              </ul>
              {role === "trial-admin" && (
                <div className="absolute right-3 top-3">
                  <CheckCircle2 className="h-5 w-5 text-teal-500" />
                </div>
              )}
            </div>
          </div>
        </div>

        <Card className="mx-auto w-full max-w-lg">
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4 pt-6">
              {isEmailVerified && (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-sm text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>
                    Email <span className="font-semibold">{email}</span> verified. Choose your plan and set a password.
                  </span>
                </div>
              )}

              <Field>
                <FieldLabel htmlFor="fullName">Full Name</FieldLabel>
                <Input
                  id="fullName"
                  placeholder="John Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  placeholder="john@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isEmailVerified}
                  required
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    placeholder="Min 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="confirmPassword">Confirm</FieldLabel>
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="Re-enter password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={6}
                  />
                </Field>
              </div>

              {(role === "developer" || role === "trial-admin") && otpSent && (
                <Field>
                  <FieldLabel htmlFor="otp">Email OTP</FieldLabel>
                  <Input
                    id="otp"
                    inputMode="numeric"
                    placeholder="Enter 6-digit OTP"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    required
                  />
                </Field>
              )}
            </CardContent>
            <CardFooter className="flex flex-col gap-3 pb-6">
              <Button type="submit" className="w-full" disabled={isLoading || !role}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {getButtonText()}
              </Button>
              {(role === "developer" || role === "trial-admin") && otpSent && !isEmailVerified && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={isLoading}
                  onClick={async () => {
                    try {
                      setIsLoading(true);
                      await requestSignupOtp(email);
                      setOtpEmail(email);
                      toast.success("A new OTP has been sent.");
                    } catch (error) {
                      const message = error instanceof Error ? error.message : "Failed to resend OTP";
                      toast.error(message);
                    } finally {
                      setIsLoading(false);
                    }
                  }}
                >
                  Resend OTP
                </Button>
              )}
              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{" "}
                <Link href="/" className="text-primary hover:underline">
                  Sign in
                </Link>
              </p>
            </CardFooter>
          </form>
        </Card>

        {/* Policy links */}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          By creating an account you agree to our{" "}
          <Link href="/terms-and-conditions" className="text-primary hover:underline">Terms &amp; Conditions</Link>
          {" "}&amp;{" "}
          <Link href="/privacy-policy" className="text-primary hover:underline">Privacy Policy</Link>.
        </p>
      </div>

      <GlobalFooter />
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-muted/30" />}>
      <SignupPageContent />
    </Suspense>
  );
}
