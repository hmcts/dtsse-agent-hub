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
        }
      },
      fontFamily: {
        sans: ["Lato", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
