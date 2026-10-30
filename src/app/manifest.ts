import type { MetadataRoute } from "next";

/**
 * What lets the Assistant be installed to a phone's or a laptop's home screen and opened without the browser's own
 * chrome. It starts at the Assistant rather than the hub, which is what people install it for; the sign-in redirect
 * and the theme the person chose are the page's own, so the colours here are only what shows before it loads.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CFT Workspace",
    short_name: "CFT Workspace",
    description: "Ask for help with user stories, research, analysis and prototypes",
    start_url: "/assistant",
    scope: "/",
    display: "standalone",
    background_color: "#0b0c0c",
    theme_color: "#0b0c0c",
    icons: [{ src: "/assistant/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }]
  };
}
