/**
 * Number formatting, shared by every screen.
 *
 * These used to live inside the dashboard page, which forced the page to strip the
 * currency symbol back out with `.replace("₽", "").trim()` in six places to place it
 * itself. `formatCurrencyParts` exists so that hack disappears: the symbol and the
 * digits are returned separately and each can be positioned or styled on its own.
 */

export const currencyFormatter = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0
});

export const numberFormatter = new Intl.NumberFormat('ru-RU');

export function formatCurrency(value: number): string {
    return currencyFormatter.format(value);
}

export function formatNumber(value: number): string {
    return numberFormatter.format(value);
}

/** Digits and symbol separately, so the symbol can be styled or moved. */
export function formatCurrencyParts(value: number): { amount: string; symbol: string } {
    const parts = currencyFormatter.formatToParts(value);

    const symbol = parts.find((part) => part.type === 'currency')?.value ?? '₽';
    const amount = parts
        .filter((part) => part.type !== 'currency' && part.type !== 'literal')
        .map((part) => part.value)
        .join('')
        .trim();

    return { amount, symbol };
}

/**
 * Percentage with a comma decimal separator, matching the ru-RU currency format.
 *
 * `toFixed` was producing `12.3%` next to `1 234 ₽`, so one screen showed a dot and a
 * comma side by side.
 */
export function formatPercent(value: number, fractionDigits = 1): string {
    return `${value.toFixed(fractionDigits).replace('.', ',')}%`;
}

/** Signed change for period-over-period comparisons. */
export function formatDelta(value: number | null): string {
    if (value === null) return '—';
    return `${value >= 0 ? '+' : ''}${value.toFixed(1).replace('.', ',')}%`;
}

/**
 * `2026-09-01` as `01.09.2026`, and `null` as an em dash.
 *
 * Dates elsewhere on the page are dotted, and a raw `YYYY-MM-DD` beside them read as a
 * machine value rather than a date — which is how it appeared in a notice meant for the
 * seller to act on.
 */
export function formatDay(value: string | null | undefined): string {
    if (!value) return '—';

    const [year, month, day] = value.split('-');
    if (!year || !month || !day) return value;

    return `${day}.${month}.${year}`;
}
