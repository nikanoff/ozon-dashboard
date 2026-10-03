/**
 * What a failed load should say to the seller.
 *
 * Our own failures are written to be read — a missing key, an upstream status with its
 * meaning, a month whose report has not been published. A programming error is not: a
 * temporal-dead-zone mistake once reached the screen as `can't access lexical declaration
 * 'periodMonth' before initialization`, which tells a seller nothing, and reads as though the
 * dashboard had fallen over rather than as though one request failed.
 *
 * So programming errors are reported in plain language and kept out of the interface. The
 * original is still logged where it is useful — see the catch in `swr.ts`.
 */

/** The error names that mean the code went wrong, not the request. */
const PROGRAMMING_ERRORS = new Set([
    'ReferenceError',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'InternalError'
]);

const GENERIC =
    'Не удалось загрузить данные из-за внутренней ошибки. Обновите страницу — если повторяется, пришлите текст из консоли браузера.';

const UNKNOWN = 'Не удалось загрузить данные. Повторите попытку.';

/** A sentence for the reader, or `null` when there is nothing to report. */
export function describeFailure(error: unknown): string | null {
    if (error === null || error === undefined || error === false || error === '') return null;

    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && PROGRAMMING_ERRORS.has(name)) return GENERIC;

    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;

    // Thrown without a message: a string, or something unrecognisable.
    if (typeof error === 'string' && error.trim().length > 0) return error;

    return UNKNOWN;
}

/** Whether the technical text is worth logging rather than showing. */
export function isProgrammingError(error: unknown): boolean {
    const name = (error as { name?: unknown })?.name;

    return typeof name === 'string' && PROGRAMMING_ERRORS.has(name);
}
