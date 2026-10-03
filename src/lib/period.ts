/**
 * Calendar months, and the days inside them.
 *
 * The dashboard speaks in months because that is the unit its documents come in: Ozon's
 * realization report and the accrual statements are monthly, so a trailing window can never
 * be reconciled against them. There was a rolling mode here beside the month; it was removed
 * once the month view covered what it was for.
 */

/** `YYYY-MM` for a date, in local time. */
export function monthKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` for a date, in local time. */
export function dayKey(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

export function isValidMonthKey(value: string): boolean {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Russian month name with the year: «сентябрь 2026». */
export function monthLabel(key: string): string {
    if (!isValidMonthKey(key)) return key;

    const [year, month] = key.split('-').map(Number);
    const name = new Date(year, month - 1, 1).toLocaleDateString('ru-RU', { month: 'long' });

    return `${name} ${year}`;
}

/** Every calendar day of a month, oldest first. */
export function daysOfMonth(key: string): string[] {
    if (!isValidMonthKey(key)) return [];

    const [year, month] = key.split('-').map(Number);
    const days: string[] = [];
    const cursor = new Date(year, month - 1, 1);

    while (cursor.getMonth() === month - 1) {
        days.push(dayKey(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }

    return days;
}

/** Whether an order date falls inside the selected month. */
export function isInsidePeriod(createdAt: string | undefined, days: Set<string>): boolean {
    if (!createdAt) return false;
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return false;

    return days.has(dayKey(date));
}

/** The month before `key`. */
export function previousMonthKey(key: string): string {
    if (!isValidMonthKey(key)) return key;

    const [year, month] = key.split('-').map(Number);
    return monthKey(new Date(year, month - 2, 1));
}

/**
 * The last month that has closed.
 *
 * A seller asking for "a month" means a finished one: the current month is a few days of
 * data, has no realization report yet, and makes every figure look as if it had collapsed.
 * Opening on it reads as lost data rather than as a month in progress.
 */
export function lastCompleteMonth(now = new Date()): string {
    return monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}
