"use client";

import { useEffect, useRef } from "react";

/** Focuses the element the ref is on as it mounts, so the person is taken to the question or field they opened. */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
