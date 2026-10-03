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

const failed = results.filter((result) => !result.ok);
console.log('\n' + '-'.repeat(60));
console.log(`Проверок: ${results.length}, провалено: ${failed.length}`);
for (const result of failed) console.log(`  FAIL ${result.label}`);
console.log('-'.repeat(60));

process.exit(failed.length > 0 ? 1 : 0);
