import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0f172a",
        panel: "#1e293b",
        border: "#334155",
        muted: "#94a3b8",
        text: "#e2e8f0",
        accent: "#3b82f6",
      },
    },
  },
  plugins: [],
} satisfies Config;
