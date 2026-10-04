/**
 * Where a tooltip bubble goes, given the box it belongs to.
 *
 * Geometry only, no DOM: the maths is what decides whether a bubble ends up off-screen, and
 * that is worth a test rather than a squint at a phone. `MetricTip` measures the rectangles
 * and calls this.
 *
 * Three edges are respected, because the app is also installed as a PWA:
 *
 *   - horizontally the bubble is slid back inside the viewport, so the first card cannot push
 *     it off the left edge and the last one off the right;
 *   - vertically it opens below its metric, and flips above when there is no room — a metric
 *     near the bottom of a phone screen would otherwise open an explanation the reader cannot
 *     see;
 *   - a coarse pointer leaves room for what the system draws over the page in a standalone
 *     app: the home indicator below, the status bar and notch above.
 */

/** Widest the bubble gets, matching the component's `max-width`. */
export const BUBBLE_WIDTH = 300;
/** Keeps the bubble off the very edge of the screen. */
export const EDGE = 8;
/** Room the home indicator needs on a phone. */
export const SAFE_BOTTOM = 28;
/** Room the status bar and the notch need in a standalone app. */
export const SAFE_TOP = 34;

/** The gaps the bubble opens with, matching the component's CSS. */
export const GAP = 10;

export interface Box {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export interface Placement {
    /** How far to slide the bubble; negative moves it left. */
    shift: number;
    /** Open above the metric instead of below it. */
    above: boolean;
}

export function placeBubble(input: {
    host: Box;
    /** The bubble's own size, measured while it is still hidden but laid out. */
    bubble: { width: number; height: number };
    viewport: { width: number; height: number };
    /** Touch or not: a finger gets the safe-area margins, a mouse does not need them. */
    coarse: boolean;
}): Placement {
    const { host, bubble, viewport, coarse } = input;

    // Sideways: where it sits naturally, and where it has to sit to be fully visible.
    const width = Math.min(BUBBLE_WIDTH, viewport.width * 0.86);
    const natural = host.left - EDGE;
    let fitted = natural;
    if (fitted + width > viewport.width - EDGE) fitted = viewport.width - EDGE - width;
    if (fitted < EDGE) fitted = EDGE;

    // Vertically: below by default, above when the bubble would not fit under the metric — and
    // only when there is genuinely room above, or it would be worse off than staying put.
    const bottomLimit = viewport.height - EDGE - (coarse ? SAFE_BOTTOM : 0);
    const topLimit = EDGE + (coarse ? SAFE_TOP : 0);
    const fitsBelow = host.bottom + GAP + bubble.height <= bottomLimit;
    const fitsAbove = host.top - GAP - bubble.height >= topLimit;

    return {
        shift: fitted - natural,
        above: bubble.height > 0 && !fitsBelow && fitsAbove
    };
}
