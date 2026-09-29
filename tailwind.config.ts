import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/components/**/*.{ts,tsx}", "./src/app/**/*.{ts,tsx}", "./src/web/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // An agent's status dot. Text beside a dot always says the status too, so colour is never the only signal.
        status: {
          busy: "#fbbf24",
          idle: "#4ade80",
          offline: "#64748b"
        },
        accent: "#818cf8"
      }
    }
  },
  plugins: []
};

export default config;
