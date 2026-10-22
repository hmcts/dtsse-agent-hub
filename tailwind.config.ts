import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/components/**/*.{ts,tsx}", "./src/app/**/*.{ts,tsx}", "./src/web/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // An agent's status dot. Text beside a dot always says the status too, so colour is never the only signal.
        status: {
          busy: "#fbbf24",
          idle: "#2bac76",
          offline: "#8b8d91"
        },
        accent: "#1d9bd1",
        // Slack's dark theme: a darker rail for the sidebar, the message pane a shade lighter.
        hub: {
          rail: "#19171d",
          pane: "#1a1d21",
          raised: "#222529",
          line: "#35373b",
          hover: "#27242c",
          active: "#1164a3",
          text: "#d1d2d3",
          muted: "#ababad",
          link: "#1d9bd1"
        },
        // The HMCTS Assistant's own theme, from its prototype: cool greys with one teal accent, dark or light. Each colour is
        // a CSS variable set by `.asst-theme` in globals.css. Text on `asst-bg` is at least 4.5:1 down to `asst-faint`
        // in both themes; `asst-ink` is the text on the accent.
        asst: {
          rail: "oklch(var(--asst-rail) / <alpha-value>)",
          bg: "oklch(var(--asst-bg) / <alpha-value>)",
          panel: "oklch(var(--asst-panel) / <alpha-value>)",
          raised: "oklch(var(--asst-raised) / <alpha-value>)",
          hover: "oklch(var(--asst-hover) / <alpha-value>)",
          field: "oklch(var(--asst-field) / <alpha-value>)",
          active: "oklch(var(--asst-active) / <alpha-value>)",
          bubble: "oklch(var(--asst-bubble) / <alpha-value>)",
          line: "oklch(var(--asst-line) / <alpha-value>)",
          strong: "oklch(var(--asst-strong) / <alpha-value>)",
          text: "oklch(var(--asst-text) / <alpha-value>)",
          body: "oklch(var(--asst-body) / <alpha-value>)",
          muted: "oklch(var(--asst-muted) / <alpha-value>)",
          faint: "oklch(var(--asst-faint) / <alpha-value>)",
          accent: "oklch(var(--asst-accent) / <alpha-value>)",
          "accent-hover": "oklch(var(--asst-accent-hover) / <alpha-value>)",
          "accent-soft": "oklch(var(--asst-accent-soft) / <alpha-value>)",
          "accent-line": "oklch(var(--asst-accent-line) / <alpha-value>)",
          ink: "oklch(var(--asst-ink) / <alpha-value>)",
          ok: "oklch(var(--asst-ok) / <alpha-value>)",
          warn: "oklch(var(--asst-warn) / <alpha-value>)",
          error: "oklch(var(--asst-error) / <alpha-value>)"
        }
      },
      fontFamily: {
        sans: ["Lato", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        // Used where installed; the Assistant falls back to the system font rather than load a web font.
        plex: ["IBM Plex Sans", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        "plex-mono": ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      keyframes: {
        "asst-dot": { "0%, 80%, 100%": { opacity: "0.25", transform: "translateY(0)" }, "40%": { opacity: "1", transform: "translateY(-3px)" } }
      },
      animation: { "asst-dot": "asst-dot 1.2s infinite ease-in-out" }
    }
  },
  plugins: []
};

export default config;
