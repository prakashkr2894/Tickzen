import "./globals.css";
import "../bones/registry";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth-context";
import { DataProvider } from "@/lib/data-context";
import { RouteSkeleton } from "@/components/boneyard/route-skeleton";
import { ThemeProvider } from "@/components/theme-provider";

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "TickZen - AI Project Management & Task Automation Tool",
  description: "TickZen is an AI-powered project management platform that automates tasks, tracks progress, and boosts team productivity.",
  keywords: "AI project management, task automation, productivity tool, workflow automation, kanban AI",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/logo/light.png", media: "(prefers-color-scheme: light)" },
      { url: "/logo/dark.png", media: "(prefers-color-scheme: dark)" },
    ],
    shortcut: "/favicon.ico",
    apple: "/apple-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="scroll-smooth">
      <body className="font-sans antialiased">
        <AuthProvider>
          <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
            <DataProvider>
              <RouteSkeleton>{children}</RouteSkeleton>
              <Toaster position="top-right" richColors />
            </DataProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
