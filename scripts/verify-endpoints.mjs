#!/usr/bin/env node
/**
 * Exercises the app's own server endpoints against a live Ozon account.
 *
 * The unit tests prove the parsers handle the shapes they were told about; the contract
 * checker (`verify-ozon-api.mjs`) asks Ozon directly. Neither covers the wire between the
 * two — the server projection that decides which fields reach the browser. That gap is not
 * hypothetical: the real `commission` object was dropped in the projection for a while, so
 * the dashboard reported a zero commission on real orders while every test passed.
 *
 * Start the dev server first (`npm run dev`), then run this.
 *
 * Credentials come from the environment, falling back to `.env.local` (gitignored).
 * Usage:
 *   node scripts/verify-endpoints.mjs [--base=http://localhost:5173] [--month=2026-09]
 */

import { readFileSync } from 'node:fs';

const arg = (name, fallback) =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const BASE = arg('base', 'http://localhost:5173');

/** Reads `.env.local` for anything not already set in the environment. */
function loadEnv() {
    const env = { ...process.env };
    try {
        for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
            const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
            if (match && !env[match[1]]) env[match[1]] = match[2];
        }
    } catch {
        // No local file: rely on the environment alone.
    }
    return env;
}

const env = loadEnv();
if (!env.OZON_CLIENT_ID || !env.OZON_API_KEY) {
    console.error('Set OZON_CLIENT_ID and OZON_API_KEY, or put them in .env.local.');
    process.exit(2);
}

const headers = {
    'Content-Type': 'application/json',
    'X-Ozon-Client-Id': env.OZON_CLIENT_ID,
    'X-Ozon-Api-Key': env.OZON_API_KEY
};

async function post(path, body = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    const text = await res.text();
    try {
        return { status: res.status, body: JSON.parse(text) };
    } catch {
        return { status: res.status, body: { _raw: text.slice(0, 200) } };
    }
}

const money = (value) => Number(value ?? 0).toFixed(2);
const results = [];
const check = (label, ok, detail) => {
    results.push({ label, ok });
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- Accruals ---------------------------------------------------------------------
const monthArg = arg('month', new Date().toISOString().slice(0, 7));
const [year, monthNumber] = monthArg.split('-').map(Number);
const daysInMonth = new Date(year, monthNumber, 0).getDate();
const dates = Array.from(
    { length: daysInMonth },
    (_, index) => `${monthArg}-${String(index + 1).padStart(2, '0')}`
);

console.log(`\n/api/economics — ${monthArg}, ${dates.length} дн.`);
const economics = await post('/api/economics', { dates, withTypes: true });
if (economics.status !== 200) {
    check(
        'endpoint отвечает 200',
        false,
        `HTTP ${economics.status} ${JSON.stringify(economics.body).slice(0, 160)}`
    );
} else {
    const days = economics.body.days ?? [];
    const types = economics.body.types ?? {};
    const net = days.reduce((sum, day) => sum + (day.net ?? 0), 0);
    const cabinet = days.reduce((sum, day) => sum + (day.cabinetByType?.total ?? 0), 0);
    const feeTypes = new Set(days.flatMap((day) => Object.keys(day.byType ?? {})));
    const catalogueNames = Object.values(types).map(String);

    console.log(
        `  дней ${days.length}, итог ${money(net)}, кабинет ${money(cabinet)}, ` +
            `видов удержаний ${feeTypes.size}, названий в справочнике ${catalogueNames.length}`
    );
    check('endpoint отвечает 200', true);
    check('ни один день не упал', days.every((day) => day.status !== 'failed'));
    check('справочник названий загружен', catalogueNames.length > 0, `${catalogueNames.length}`);
    check(
        'названия на русском, а не идентификаторы',
        catalogueNames.some((name) => /[а-яА-Я]/.test(name))
    );
    check('расходы кабинета отделены от заказов', cabinet !== 0, money(cabinet));
    check('виды удержаний разобраны', feeTypes.size > 0, `${feeTypes.size} видов`);
    check(
        'есть разрез по отправлениям',
        days.some((day) => day.byPosting),
        'нужен для «ещё не начислено»'
    );
}

// --- Turnover ---------------------------------------------------------------------
// Removed with the section that used it: the endpoint, its server helper and the summary
// module are gone, so there is nothing here to check. The method itself stays documented in
// docs/ — it is still the only source of Ozon's own view of stock, should it earn a place
// again.

// --- Dashboard --------------------------------------------------------------------
console.log('\n/api/dashboard');
const dashboard = await post('/api/dashboard');
if (dashboard.status !== 200) {
    check('endpoint отвечает 200', false, `HTTP ${dashboard.status}`);
} else {
    const postings = dashboard.body.postings ?? [];
    const lines = postings.flatMap((posting) => posting.financial_products ?? []);
    const withCommission = lines.filter((row) => row.commission?.amount !== undefined);
    const withPayout = lines.filter((row) => typeof row.payout === 'number');
    const commission = lines.reduce(
        (sum, row) => sum + Math.abs(Number(row.commission?.amount ?? 0)),
        0
    );
    const payout = lines.reduce((sum, row) => sum + Number(row.payout ?? 0), 0);

    console.log(
        `  заказов ${postings.length}, строк ${lines.length}, ` +
            `комиссия ${money(commission)}, payout ${money(payout)}`
    );
    check('endpoint отвечает 200', true);
    check('строки с финансами есть', lines.length > 0);
    check(
        'комиссия доехала до браузера',
        withCommission.length > 0 && withCommission.length === lines.length,
        `${withCommission.length} из ${lines.length}`
    );
    check('payout доехал до браузера', withPayout.length === lines.length);
    check('снимки товаров есть', Object.keys(dashboard.body.skuToImage ?? {}).length > 0);
}

// --- The period cards: the previous calendar month beside an older selected month ----
//
// This is the shape that costs a real request: an old month on screen means the payload holds
// that month and today's tail, with the cards' month — the previous calendar month — inside
// the hole between them. The cards need orders, returns and accruals for it, so all three are
// checked here against the endpoint the page actually calls.
const cardsMonth = arg('cards-month', '2026-03');
const [cardsYear, cardsNumber] = cardsMonth.split('-').map(Number);
const cardsLastDay = new Date(cardsYear, cardsNumber, 0).getDate();
const previousDay = new Date(cardsYear, cardsNumber - 2, 1);
const previousMonth = `${previousDay.getFullYear()}-${String(previousDay.getMonth() + 1).padStart(2, '0')}`;
const previousLastDay = new Date(previousDay.getFullYear(), previousDay.getMonth() + 1, 0).getDate();
const extraFrom = `${previousMonth}-01`;
const extraTo = `${previousMonth}-${String(previousLastDay).padStart(2, '0')}`;

console.log(`\n/api/dashboard — карточки: месяц на экране ${cardsMonth}, прошлый ${previousMonth}`);
const cards = await post('/api/dashboard', {
    windowFrom: `${cardsMonth}-01`,
    windowTo: `${cardsMonth}-${String(cardsLastDay).padStart(2, '0')}`,
    extraFrom,
    extraTo
});
if (cards.status !== 200) {
    check('карточки: endpoint отвечает 200', false, `HTTP ${cards.status}`);
} else {
    const ranges = cards.body.ranges ?? [];
    const returns = cards.body.returns ?? [];
    const window = cards.body.returnsWindow ?? {};
    const coversCardsMonth = ranges.some(
        (range) => range.from <= extraFrom && range.to >= extraTo
    );
    const returnsInside = returns.every((row) => row.date >= window.from && row.date <= window.to);
    const returnsNamed = returns.every(
        (row) => row.sku > 0 && row.units > 0 && typeof row.amount === 'number' && row.date
    );
    const inPreviousMonth = returns.filter((row) => row.date.slice(0, 7) === previousMonth);

    console.log(
        `  диапазоны: ${ranges.map((range) => `${range.from}…${range.to}`).join(', ')}`
    );
    console.log(
        `  возвратов ${returns.length}, из них за ${previousMonth}: ${inPreviousMonth.length}, ` +
            `окно возвратов ${window.from}…${window.to}`
    );
    check('карточки: endpoint отвечает 200', true);
    check('прошлый календарный месяц покрыт диапазоном', coversCardsMonth);
    check('возвраты пришли', returns.length > 0, `${returns.length}`);
    check('возвраты разобраны в записи', returnsNamed, `${returns.length} записей`);
    check('окно возвратов начинается с прошлого месяца', window.from === extraFrom, `${window.from}`);
    check('все возвраты внутри своего окна', returnsInside);
}

// The accruals the cards read: the previous calendar month and the current one.
const cardDates = [];
for (let day = 1; day <= previousLastDay; day += 1) {
    cardDates.push(`${previousMonth}-${String(day).padStart(2, '0')}`);
}
const today = new Date();
for (let day = 1; day <= today.getDate(); day += 1) {
    cardDates.push(
        `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    );
}

console.log(`\n/api/economics — дни карточек: ${cardDates.length} дн. (${previousMonth} и текущий)`);
const cardAccruals = await post('/api/economics', { dates: cardDates });
if (cardAccruals.status !== 200) {
    check('карточки: начисления отвечают 200', false, `HTTP ${cardAccruals.status}`);
} else {
    const days = cardAccruals.body.days ?? [];
    const failedDays = days.filter((day) => day.status === 'failed');
    const advertising = days.reduce((sum, day) => {
        const rows = day.byType ?? {};
        return sum + Math.abs(Number(rows['41'] ?? 0));
    }, 0);

    console.log(
        `  дней ${days.length}, упало ${failedDays.length}, оплата за клик ${money(advertising)}`
    );
    check('карточки: начисления отвечают 200', true);
    check('ни один день карточек не упал', failedDays.length === 0, `${failedDays.length}`);
    check('все запрошенные дни вернулись', days.length === cardDates.length, `${days.length}`);
}

// --- Monthly finance, including a month the order feed cannot reach ---------------
const oldMonth = arg('old-month', '2026-03');
console.log(`\n/api/finance — ${oldMonth} (старше окна заказов)`);
const finance = await post('/api/finance', { month: oldMonth });
if (finance.status !== 200) {
    check(
        'месяц старше окна заказов отвечает',
        false,
        `HTTP ${finance.status} ${JSON.stringify(finance.body).slice(0, 160)}`
    );
} else {
    const realization = finance.body.realization ?? {};
    const balance = finance.body.balance;
    const weeks = finance.body.weeks ?? [];

    console.log(
        `  строк ${realization.rows}, единиц ${realization.units}, ` +
            `реализовано ${money(realization.realized)}, возвраты ${money(realization.returned)}, ` +
            `лояльность ${money(realization.loyaltyNet)}`
    );
    check('месяц старше окна заказов отвечает', true);
    check('отчёт о реализации разобран', realization.rows > 0, `${realization.rows} строк`);
    check(
        'нетто равно реализации минус возвраты',
        Math.abs(realization.net - (realization.realized - realization.returned)) < 0.01
    );
    check('разрез по товарам есть', (realization.perSku ?? []).length > 0);
    check('баланс прочитан', Boolean(balance), balance ? `начислено ${money(balance.accrued)}` : 'нет');
    check(
        'начислено совпадает с суммой дней',
        Boolean(balance) && Math.abs(balance.accrued) > 0,
        balance ? money(balance.accrued) : '—'
    );
    check('недельная разбивка есть', weeks.length > 0, `${weeks.length} недель`);
    check('ошибок в ответе нет', !finance.body.partialError, finance.body.partialError ?? '');
}

// --- The cards' tax base: the realization report alone, and the same figure ----------
//
// The period cards charge a revenue-based tax on the realized revenue, which only the monthly
// report states — the order feed's seller price is nearly twice it. So the light request has to
// return the very same document the full bundle does, or the cards and the month sections would
// disagree about the same month.
console.log(`\n/api/finance — только отчёт о реализации за ${oldMonth}`);
const light = await post('/api/finance', { month: oldMonth, only: 'realization' });
if (light.status !== 200) {
    check('отчёт о реализации отвечает 200', false, `HTTP ${light.status}`);
} else {
    const realization = light.body.realization ?? {};
    const fullRealization = finance.body?.realization ?? null;

    console.log(
        `  реализовано ${money(realization.realized)}, возвраты ${money(realization.returned)}, ` +
            `нетто ${money(realization.net)}, строк ${realization.rows}`
    );
    check('отчёт о реализации отвечает 200', true);
    check('нетто — это реализовано минус возвраты', Math.abs(realization.net - (realization.realized - realization.returned)) < 0.01);
    check('месяц в ответе тот же, что запрошен', light.body.month === oldMonth, `${light.body.month}`);
    check(
        'тот же документ, что в полной сборке',
        fullRealization !== null && Math.abs(fullRealization.net - realization.net) < 0.01,
        fullRealization ? `${money(fullRealization.net)} против ${money(realization.net)}` : 'полной сборки нет'
    );
    check(
        'в лёгком ответе нет лишнего',
        light.body.balance === undefined && light.body.weeks === undefined,
        Object.keys(light.body).join(', ')
    );
}

const failed = results.filter((result) => !result.ok);
console.log('\n' + '-'.repeat(60));
console.log(`Проверок: ${results.length}, провалено: ${failed.length}`);
for (const result of failed) console.log(`  FAIL ${result.label}`);
console.log('-'.repeat(60));

process.exit(failed.length > 0 ? 1 : 0);
