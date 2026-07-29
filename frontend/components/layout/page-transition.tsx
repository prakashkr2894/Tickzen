"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import type { ReactNode } from "react";

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement>(null);
  const tweenRef = useRef<gsap.core.Tween | null>(null);
  const firstRender = useRef(true);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Kill any in-flight animation
    tweenRef.current?.kill();

    if (firstRender.current) {
      firstRender.current = false;
      tweenRef.current = gsap.fromTo(
        el,
        { opacity: 0, y: 6 },
        {
          opacity: 1,
          y: 0,
          duration: 0.15,
          ease: "power2.out",
          clearProps: "opacity,transform",
        }
      );
      return;
    }

    gsap.set(el, { opacity: 0.8, y: 4 });
    tweenRef.current = gsap.to(el, {
      opacity: 1,
      y: 0,
      duration: 0.12,
      ease: "power2.out",
      clearProps: "opacity,transform",
    });

    return () => {
      tweenRef.current?.kill();
    };
  }, [pathname]);

  return (
    <div ref={containerRef}>
      {children}
    </div>
  );
}
