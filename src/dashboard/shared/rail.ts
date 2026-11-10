/**
 * How wide the inbox is, and whether it is showing its cards.
 *
 * The inbox takes room from the field only while it has something in it. With
 * nothing waiting on anyone it folds down to a strip at the right-hand edge —
 * a count and the Log button, still under the same hand — and the field has
 * the rest of the window. On a screen too narrow to share, the field keeps the
 * strip's width whatever happens, and the open inbox lies over it instead.
 */
export interface RailLayout {
  /** The width the field keeps clear on the right. */
  reserved: number;
  /** The width the inbox itself is drawn at. */
  panel: number;
  /** Whether the inbox is showing its cards. */
  open: boolean;
  /** Whether the open inbox lies over the field rather than beside it. */
  overlay: boolean;
}

/** The inbox folded away: wide enough for one finger-sized button. */
export const RAIL_STRIP = 68;
/** Below this the window is too narrow to give the inbox a column of its own. */
export const RAIL_OVERLAY_BELOW = 760;
const RAIL_MIN = 300;
const RAIL_MAX = 400;

export function railLayout(viewportWidth: number, hasContent: boolean, pinnedOpen: boolean): RailLayout {
  if (viewportWidth < RAIL_OVERLAY_BELOW) {
    return {
      reserved: RAIL_STRIP,
      panel: pinnedOpen ? Math.max(RAIL_STRIP, Math.min(360, viewportWidth - 44)) : RAIL_STRIP,
      open: pinnedOpen,
      overlay: true,
    };
  }
  const full = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(viewportWidth * 0.25)));
  const width = hasContent ? full : RAIL_STRIP;
  return { reserved: width, panel: width, open: hasContent, overlay: false };
}

/** The room the keep-awake lamp takes at the top right of the field. */
export function lampReserve(viewportWidth: number): number {
  return viewportWidth < 700 ? 52 : 132;
}
