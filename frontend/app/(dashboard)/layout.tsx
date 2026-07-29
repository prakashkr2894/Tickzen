"use client";

import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppHeader } from "@/components/layout/app-header";
import { RouteScrollRestorer } from "@/components/layout/route-scroll-restorer";
import { PageTransition } from "@/components/layout/page-transition";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { ZentrixaAssistant } from "@/components/zentrixa/ZentrixaAssistant";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) {
      router.push("/");
    }
  }, [user, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0 transition-[width,padding] duration-200 ease-out">
        <AppHeader />
        <RouteScrollRestorer />
        <main className="relative min-w-0 flex-1 p-4 transition-[padding] duration-200 ease-out sm:p-6 lg:p-8">
            <PageTransition>
              {children}
            </PageTransition>
          </main>
        <ZentrixaAssistant />
      </SidebarInset>
    </SidebarProvider>
  );
}
