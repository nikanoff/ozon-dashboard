import { describe, expect, it } from 'vitest';
import { BUBBLE_WIDTH, placeBubble, type Box } from './tooltip_placement';

/** A phone in standalone: 390×844 CSS pixels, with the system bars over the page. */
const PHONE = { width: 390, height: 844 };
/** A metric in the middle of a wide desktop window. */
const DESKTOP = { width: 1600, height: 900 };

function box(overrides: Partial<Box> = {}): Box {
    return { left: 100, right: 300, top: 300, bottom: 340, ...overrides };
}

const bubble = { width: 280, height: 200 };

describe('placeBubble', () => {
    it('leaves a bubble alone where it fits below the metric', () => {
        const placement = placeBubble({
            host: box(),
            bubble,
            viewport: DESKTOP,
            coarse: false
        });

        expect(placement).toEqual({ shift: 0, above: false });
    });

    it('slides a bubble back inside the left and right edges', () => {
        const leftEdge = placeBubble({
            host: box({ left: 4 }),
            bubble,
            viewport: DESKTOP,
            coarse: false
        });
        const rightEdge = placeBubble({
            host: box({ left: DESKTOP.width - 40 }),
            bubble,
            viewport: DESKTOP,
            coarse: false
        });

        // The bubble is 300 wide at most, so at the left edge it must move right by EDGE…
        expect(leftEdge.shift).toBeGreaterThan(0);
        expect(leftEdge.shift).toBeLessThan(BUBBLE_WIDTH);
        // …and at the right edge it must move left far enough to fit.
        expect(rightEdge.shift).toBeLessThan(0);
    });

    it('opens above a metric that has no room below it', () => {
        // The last row of a phone screen: below the metric there are 40 px, above there is room.
        const placement = placeBubble({
            host: box({ left: 40, right: 340, top: 700, bottom: 740 }),
            bubble,
            viewport: PHONE,
            coarse: true
        });

        expect(placement.above).toBe(true);
    });

    it('stays below when there is room neither below nor above', () => {
        // A bubble taller than the space on both sides: flipping would only move the problem.
        const placement = placeBubble({
            host: box({ left: 40, right: 340, top: 200, bottom: 240 }),
            bubble: { width: 280, height: 700 },
            viewport: PHONE,
            coarse: true
        });

        expect(placement.above).toBe(false);
    });

    it('counts the home indicator on a coarse pointer', () => {
        const host = box({ left: 40, right: 340, top: 500, bottom: 540 });
        // 270 px fits under the metric on a desktop, but not once the indicator is allowed for.
        const roomy = { width: 280, height: 270 };

        expect(
            placeBubble({ host, bubble: roomy, viewport: PHONE, coarse: false }).above
        ).toBe(false);
        expect(
            placeBubble({ host, bubble: roomy, viewport: PHONE, coarse: true }).above
        ).toBe(true);
    });

    it('will not open above into the status bar', () => {
        const host = box({ left: 40, right: 340, top: 250, bottom: 350 });
        // The bubble fits below neither way; above it would clear the screen edge but not the
        // status bar and notch, so a finger keeps it below rather than under the clock.
        const bubble200 = { width: 280, height: 200 };
        const landscape = { width: 780, height: 400 };

        expect(
            placeBubble({ host, bubble: bubble200, viewport: landscape, coarse: false }).above
        ).toBe(true);
        expect(
            placeBubble({ host, bubble: bubble200, viewport: landscape, coarse: true }).above
        ).toBe(false);
    });

    it('treats an unmeasured bubble as fitting, so nothing flips on a zero height', () => {
        const placement = placeBubble({
            host: box({ top: 800, bottom: 840 }),
            bubble: { width: 0, height: 0 },
            viewport: PHONE,
            coarse: true
        });

        expect(placement.above).toBe(false);
    });
});
