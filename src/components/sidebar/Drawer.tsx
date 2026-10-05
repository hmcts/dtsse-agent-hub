"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { CloseIcon, MenuIcon } from "@/components/sidebar/icons";

/**
 * Below the `md` breakpoint the sidebar is a drawer over the page, opened from the page header's menu button. From
 * `md` up it is always in the layout and none of this applies.
 */

export const SIDEBAR_ID = "sidebar";

interface DrawerContextValue {
  hasSidebar: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: React.RefObject<HTMLButtonElement>;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function SidebarDrawerProvider({ hasSidebar, children }: { hasSidebar: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page is what closes the drawer
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return <DrawerContext.Provider value={{ hasSidebar, open, setOpen, toggleRef }}>{children}</DrawerContext.Provider>;
}

/** The sidebar's frame: off screen until opened on a narrow screen, with a backdrop that closes it. */
export function SidebarDrawer({ children }: { children: React.ReactNode }) {
  const drawer = useContext(DrawerContext);
  const open = drawer?.open ?? false;
  return (
    <>
      {open ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => drawer?.setOpen(false)}
          className="fixed inset-0 z-30 cursor-default bg-black/60 md:hidden"
        />
      ) : null}
      {/* Hidden only once it has slid away, but shown at once on opening so the close button can take focus. */}
      <div
        id={SIDEBAR_ID}
        className={`fixed inset-y-0 left-0 z-40 flex transition-transform duration-200 md:static md:z-auto md:translate-x-0 md:transition-none ${open ? "translate-x-0" : "-translate-x-full max-md:invisible max-md:[transition:transform_200ms,visibility_0s_200ms]"}`}
      >
        {children}
      </div>
    </>
  );
}

/** The page header's menu button, shown only while the sidebar is a drawer. */
export function SidebarToggle() {
  const drawer = useContext(DrawerContext);
  if (drawer === null || !drawer.hasSidebar) {
    return null;
  }
  return (
    <button
      ref={drawer.toggleRef}
      type="button"
      aria-label="Open sidebar"
      aria-controls={SIDEBAR_ID}
      aria-expanded={drawer.open}
      onClick={() => drawer.setOpen(!drawer.open)}
      className="-ml-2 shrink-0 rounded-md p-2 text-hub-muted hover:bg-hub-hover hover:text-white md:hidden"
    >
      <MenuIcon />
    </button>
  );
}

/** Closes the drawer from inside it, and hands focus back to the menu button. */
export function SidebarClose() {
  const drawer = useContext(DrawerContext);
  const ref = useRef<HTMLButtonElement>(null);
  const open = drawer?.open ?? false;

  useEffect(() => {
    if (open) {
      ref.current?.focus();
    }
  }, [open]);

  if (drawer === null) {
    return null;
  }
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Close sidebar"
      aria-controls={SIDEBAR_ID}
      onClick={() => {
        drawer.setOpen(false);
        drawer.toggleRef.current?.focus();
      }}
      className="shrink-0 rounded-md p-1.5 text-hub-muted hover:bg-hub-hover hover:text-white md:hidden"
    >
      <CloseIcon />
    </button>
  );
}
