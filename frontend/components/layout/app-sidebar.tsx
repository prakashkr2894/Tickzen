"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { useData } from "@/lib/data-context";
import { BrandLogo } from "@/components/brand-logo";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LayoutDashboard,
  FolderKanban,
  ListTodo,
  Bell,
  Settings,
  LogOut,
  ChevronUp,
  Users,
  Plus,
  CreditCard,
  Sparkles,
  Clock,
} from "lucide-react";

const mainNavItems = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "My Tasks", href: "/tasks", icon: ListTodo },
  { title: "Notifications", href: "/notifications", icon: Bell },
  { title: "Invitations", href: "/invitations", icon: Bell },
];

const adminNavItems = [
  { title: "Manage Users", href: "/admin/users", icon: Users },
  { title: "All Projects", href: "/admin/projects", icon: FolderKanban },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const { user, logout } = useAuth();
  const { projects, notifications } = useData();

  const isTrialUser = Boolean(
    user?.isTrialAdmin ||
    user?.trialExpiresAt ||
    (user?.role === "admin" && !user?.isPaidAdmin)
  );
  const [trialTimeLeft, setTrialTimeLeft] = useState<string>("");

  useEffect(() => {
    if (!isTrialUser) return;

    const updateTimer = () => {
      let targetTime: number;
      if (user?.trialExpiresAt) {
        targetTime = new Date(user.trialExpiresAt).getTime();
      } else if (user?.createdAt) {
        targetTime = new Date(user.createdAt).getTime() + 30 * 60 * 1000;
      } else {
        targetTime = Date.now() + 30 * 60 * 1000;
      }

      const diff = targetTime - Date.now();
      if (diff <= 0) {
        setTrialTimeLeft("Trial Expired");
        toast.error("Your 30-minute admin trial has expired. Please upgrade to continue.");
        logout();
        router.push("/?trialExpired=true");
      } else {
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        setTrialTimeLeft(`${mins}m ${secs < 10 ? "0" : ""}${secs}s`);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [isTrialUser, user?.trialExpiresAt, user?.createdAt]);

  const unreadNotifications = notifications.filter((notification) => !notification.read).length;
  const visibleMainNavItems = user?.role === "admin"
    ? mainNavItems.filter((item) => item.title !== "Invitations")
    : mainNavItems;

  const getInitials = (firstName: string, lastName: string) => {
    return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
  };

  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  const handleSidebarLinkClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return (
    <Sidebar className="text-[110%]">
      <SidebarHeader className="border-b p-4">
        <Link href="/dashboard" className="flex items-center gap-2">
          <BrandLogo className="h-[4.8rem] w-[21rem] sm:h-[7rem] sm:w-[23.4rem]" priority sizes="384px" />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {/* Navigation */}
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleMainNavItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={pathname === item.href}>
                    <Link
                      href={item.href}
                      onClick={handleSidebarLinkClick}
                    >
                      <item.icon className="h-4 w-4 max-[767px]:h-5 max-[767px]:w-5" />
                      <span className="flex-1 max-[767px]:text-[1rem]">{item.title}</span>
                      {item.title === "Notifications" && unreadNotifications > 0 && (
                        <Badge variant="secondary" className="ml-auto">
                          {unreadNotifications}
                        </Badge>
                      )}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Projects */}
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between">
            <span>Projects</span>
            {user?.role === "admin" && (
              <Link href="/projects/new">
                <Button variant="ghost" size="icon" className="h-5 w-5">
                  <Plus className="h-3 w-3 max-[767px]:h-4 max-[767px]:w-4" />
                </Button>
              </Link>
            )}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === `/projects/${project.id}`}
                  >
                    <Link
                      href={`/projects/${project.id}`}
                      className="group/link flex w-full items-center gap-2"
                      onClick={handleSidebarLinkClick}
                    >
                      <FolderKanban className="h-4 w-4 text-muted-foreground transition-colors group-hover/link:text-primary max-[767px]:h-5 max-[767px]:w-5" />
                      <span className="truncate font-medium text-foreground/80 transition-colors group-hover/link:text-foreground max-[767px]:text-[1rem]">
                        {project.name}
                      </span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {projects.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  No projects yet
                </p>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Plan & Billing for 30-Min Trial Users */}
        {isTrialUser && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-primary font-bold">Plan & Billing</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    className="bg-primary/10 text-primary font-bold hover:bg-primary/20 transition-colors"
                  >
                    <Link
                      href={`/signup?role=admin${user?.email ? `&email=${encodeURIComponent(user.email)}` : ""}${user?.firstName ? `&name=${encodeURIComponent(`${user.firstName} ${user.lastName}`.trim())}` : ""}`}
                      onClick={handleSidebarLinkClick}
                    >
                      <CreditCard className="h-4 w-4 text-primary animate-pulse" />
                      <span className="flex-1">Upgrade & Pay (₹99)</span>
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Admin Navigation */}
        {user?.role === "admin" && (
          <SidebarGroup>
            <SidebarGroupLabel>Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adminNavItems.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={pathname === item.href}>
                      <Link
                        href={item.href}
                        onClick={handleSidebarLinkClick}
                      >
                        <item.icon className="h-4 w-4 max-[767px]:h-5 max-[767px]:w-5" />
                        <span className="max-[767px]:text-[1rem]">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t p-2">
        {/* Trial User Floating Upgrade Banner Card */}
        {isTrialUser && (
          <div className="mb-2 rounded-2xl border border-primary/40 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-3 shadow-md backdrop-blur-md">
            <div className="flex items-center justify-between gap-1 mb-1.5">
              <div className="flex items-center gap-1.5 text-xs font-extrabold text-primary">
                <Clock className="h-3.5 w-3.5 animate-pulse" />
                <span>30-Min Trial</span>
              </div>
              {trialTimeLeft && (
                <Badge variant="outline" className="text-[10px] font-mono border-primary/40 text-primary px-1.5 py-0 bg-primary/10">
                  {trialTimeLeft}
                </Badge>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground leading-snug mb-2">
              Unlock 3 Months Full Admin Access for ₹99.
            </p>
            <Button
              asChild
              size="sm"
              className="w-full h-8 text-xs font-bold rounded-xl bg-primary text-primary-foreground shadow-sm hover:scale-[1.02] active:scale-95 transition-all"
            >
              <Link
                href={`/signup?role=admin${user?.email ? `&email=${encodeURIComponent(user.email)}` : ""}${user?.firstName ? `&name=${encodeURIComponent(`${user.firstName} ${user.lastName}`.trim())}` : ""}`}
                onClick={handleSidebarLinkClick}
              >
                <CreditCard className="mr-1.5 h-3.5 w-3.5" />
                Pay ₹99 Now
              </Link>
            </Button>
          </div>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="w-full justify-start gap-2 max-[767px]:px-2 max-[767px]:py-2">
              <Avatar className="h-6 w-6">
                <AvatarFallback className="text-xs">
                  {user ? getInitials(user.firstName, user.lastName) : "U"}
                </AvatarFallback>
              </Avatar>
              <span className="flex-1 truncate text-left text-sm max-[767px]:text-[1rem]">
                {user?.firstName} {user?.lastName}
              </span>
              <ChevronUp className="h-4 w-4 max-[767px]:h-5 max-[767px]:w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem asChild>
              <Link
                href="/profile"
                onClick={handleSidebarLinkClick}
              >
                <Settings className="mr-2 h-4 w-4 max-[767px]:h-5 max-[767px]:w-5" />
                Profile Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="text-destructive">
              <LogOut className="mr-2 h-4 w-4 max-[767px]:h-5 max-[767px]:w-5" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
