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
        // The HMCTS Assistant's own theme, from its prototype: cool greys with one teal accent. Text on `asst-bg` is at
        // least 4.5:1 down to `asst-faint`; `asst-ink` is the text on the accent.
        asst: {
          rail: "oklch(0.17 0.006 240)",
          bg: "oklch(0.205 0.006 240)",
          panel: "oklch(0.185 0.006 240)",
          raised: "oklch(0.225 0.007 240)",
          hover: "oklch(0.235 0.007 240)",
          field: "oklch(0.25 0.007 240)",
          active: "oklch(0.27 0.008 240)",
          bubble: "oklch(0.28 0.008 240)",
          line: "oklch(0.3 0.008 240)",
          strong: "oklch(0.36 0.008 240)",
          text: "oklch(0.96 0.004 240)",
          body: "oklch(0.93 0.005 240)",
          muted: "oklch(0.76 0.01 240)",
          faint: "oklch(0.7 0.01 240)",
          accent: "oklch(0.78 0.12 185)",
          "accent-hover": "oklch(0.84 0.11 185)",
          "accent-soft": "oklch(0.84 0.1 185)",
          "accent-line": "oklch(0.5 0.08 185)",
          ink: "oklch(0.18 0.02 185)",
          ok: "oklch(0.82 0.12 160)",
          warn: "oklch(0.82 0.12 70)",
          error: "oklch(0.78 0.13 25)"
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
