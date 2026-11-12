/** All dimensions are CSS pixels in the current app window, never panel pixels or model names. */
export const TABLET_BREAKPOINTS = { medium: 600, split: 760, expanded: 840, large: 1200 } as const;

export function clampPaneWidth(value: number, available: number, minimum = 220, maximum = 360, detailMinimum = 392): number {
    const safeAvailable = Number.isFinite(available) ? Math.max(0, available) : 0;
    const limit = Math.max(0, Math.min(maximum, safeAvailable - detailMinimum));
    const lower = Math.min(minimum, limit);
    return Math.round(Math.min(limit, Math.max(lower, Number.isFinite(value) ? value : lower)));
}

export function getTabletLayout(width: number) {
    const available = Number.isFinite(width) ? Math.max(0, width) : 0;
    return {
        size: available < 600 ? "compact" : available < 840 ? "medium" : available < 1200 ? "expanded" : "large",
        showNavigation: available >= TABLET_BREAKPOINTS.medium,
        expandedNavigation: available >= TABLET_BREAKPOINTS.expanded,
        splitChat: available >= TABLET_BREAKPOINTS.split,
        chatRail: available >= 1000,
        chatListWidth: clampPaneWidth(available * .32, available, 280, 440, 432),
        navigationWidth: clampPaneWidth(available * .24, available),
        shelfAlongsideReader: available >= TABLET_BREAKPOINTS.large,
    } as const;
}
