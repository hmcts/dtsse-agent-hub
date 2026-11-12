/** The home-screen icon iOS uses when the app is added to it: the crown, white on the Assistant's dark background. */
export const HOME_SCREEN_ICON = { url: "/pwa-icon/180.png", sizes: "180x180", type: "image/png" };

/**
 * The CFT Workspace's tab icon, `src/app/assistant/icon.svg`. Named here rather than left to the file convention,
 * because Next only applies a nested segment's `icon.svg` when no layout above it has set `metadata.icons`, and the
 * root layout sets them for {@link HOME_SCREEN_ICON}.
 */
export const TAB_ICON = { url: "/assistant/icon.svg", type: "image/svg+xml" };
