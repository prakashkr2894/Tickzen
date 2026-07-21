"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Skeleton } from "boneyard-js/react";
import { useAuth } from "@/lib/auth-context";
import { useData } from "@/lib/data-context";
import { PaywallPage } from "@/components/boneyard/paywall-page";

const protectedRoutes = ["/admin", "/projects/new", "/chat"];

const isRouteProtected = (pathname: string) =>
  protectedRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));

export function RouteSkeleton({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, isLoading: isAuthLoading } = useAuth();
  const { isLoading: isDataLoading } = useData();
  const isProtected = useMemo(() => isRouteProtected(pathname), [pathname]);
  const [isAccessChecking, setIsAccessChecking] = useState(false);

  useEffect(() => {
    if (!isProtected || isAuthLoading || !user) {
      setIsAccessChecking(false);
      return;
    }

    setIsAccessChecking(true);
    const timer = window.setTimeout(() => setIsAccessChecking(false), 180);
    return () => window.clearTimeout(timer);
  }, [isProtected, isAuthLoading, user?.id, pathname]);

  const hasAccess = !isProtected || user?.role === "admin";
  const isPaymentChecking = isAccessChecking;
  const isLoading = isAuthLoading || isPaymentChecking || isDataLoading;
  const skeletonName = pathname.replace(/\//g, "-") || "home";

  if (!isLoading && isProtected && !hasAccess) {
    return <PaywallPage />;
  }

  return (
    <Skeleton
      name={skeletonName}
      loading={isLoading}
      animate="shimmer"
      transition={320}
      fixture={children}
      fallback={<div className="min-h-[40vh] w-full rounded-2xl bg-muted/40" />}
    >
      {children}
    </Skeleton>
  );
}
