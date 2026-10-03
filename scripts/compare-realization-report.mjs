#!/usr/bin/env node
/**
 * Compares the seller's realization report file with the same report fetched from the API.
 *
 * The xlsx is the official monthly document; `/v2/finance/realization` returns the same
 * report as data. Comparing them row by row proves the file and the API agree, and that the
 * dashboard reads the same reality the seller signs off on.
 *
 * `/v1/finance/realization/posting` is also fetched, because unlike the monthly report it
 * carries the posting number — the only key that ties a line to an order and therefore to
 * the accruals.
 *
 * Read-only. Usage:
 *   node scripts/compare-realization-report.mjs --report=.report.json --month=2026-09
 */

import { readFileSync, writeFileSync } from 'node:fs';

const BASE = 'https://api-seller.ozon.ru';
const arg = (name, fallback) =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const report = JSON.parse(readFileSync(arg('report', 'reports/report.json'), 'utf8'));
const [year, month] = arg('month', '2026-09').split('-').map(Number);
const outPath = arg('out', null);

async function call(path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Client-Id': process.env.OZON_CLIENT_ID,
            'Api-Key': process.env.OZON_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

const money = (value) =>
    Number(value).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round = (value) => Math.round(value * 100) / 100;

const monthly = await call('/v2/finance/realization', { month, year });
const monthlyRows = monthly.result?.rows ?? monthly.rows ?? [];

const perOrder = await call('/v1/finance/realization/posting', { month, year });
const perOrderRows = perOrder.rows ?? perOrder.result?.rows ?? [];

// --- Monthly report: file vs API ---------------------------------------------------
const apiTotals = monthlyRows.reduce(
    (acc, row) => {
        const delivery = Number(row.delivery_commission?.amount ?? 0);
        const returned = Number(row.return_commission?.amount ?? 0);
        const commission = Number(row.delivery_commission?.commission ?? 0);
        const bonus = Number(row.delivery_commission?.bonus ?? 0);
        acc.realized += delivery;
        acc.returned += returned;
        acc.commission += commission;
        acc.bonus += bonus;
        acc.units += Number(row.delivery_commission?.quantity ?? 1) || 1;
        return acc;
    },
    { realized: 0, returned: 0, commission: 0, bonus: 0, units: 0 }
);

const lines = [];
const push = (text = '') => lines.push(text);

push(`# Сверка файла отчёта с API — ${year}-${String(month).padStart(2, '0')}`);
push();
push(`Файл: ${report.source}`);
push(`Отчёт № ${report.report_number ?? '—'}, период ${report.period.from} — ${report.period.to}.`);
push();

push('## Строки и суммы');
push();
push('| Показатель | Файл | API | Расхождение |');
push('| --- | ---: | ---: | ---: |');
push(`| Строк в отчёте | ${report.items.length} | ${monthlyRows.length} | ${report.items.length - monthlyRows.length} |`);
push(`| Реализовано, ₽ | ${money(report.sums.realized)} | ${money(apiTotals.realized)} | ${money(round(report.sums.realized - apiTotals.realized))} |`);
push(`| Возвращено, ₽ | ${money(report.sums.returned)} | ${money(apiTotals.returned)} | ${money(round(report.sums.returned - apiTotals.returned))} |`);
push(`| Единиц реализовано | ${report.sums.realized_qty} | ${apiTotals.units} | ${report.sums.realized_qty - apiTotals.units} |`);
push(`| Итого за вычетом возвратов, ₽ | ${money(report.totals.net_realized)} | ${money(round(apiTotals.realized - apiTotals.returned))} | ${money(round(report.totals.net_realized - (apiTotals.realized - apiTotals.returned)))} |`);
push();

push('## Что ещё есть в API, но не в файле');
push();
push('Отчёт о реализации показывает только реализацию и возвраты по цене продавца. Комиссии,');
push('логистики и эквайринга в нём нет — их надо брать отдельно:');
push();
push('| Показатель | Сумма, ₽ | Где |');
push('| --- | ---: | --- |');
push(`| Комиссия в отчёте реализации (поле commission) | ${money(apiTotals.commission)} | /v2/finance/realization |`);
push(`| Бонусы и выплаты по механикам (поле bonus) | ${money(apiTotals.bonus)} | /v2/finance/realization |`);
push(`| Комиссия по каждому отправлению (commission_ratio) | — | /v1/finance/realization/posting |`);
push();

// --- Per-order report: the bridge to accruals --------------------------------------
const ratios = perOrderRows
    .map((row) => Number(row.commission_ratio))
    .filter((value) => Number.isFinite(value) && value > 0);
const avgRatio = ratios.length
    ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length
    : null;

push('## Построчный отчёт: мост к начислениям');
push();
push(`/v1/finance/realization/posting отдал ${perOrderRows.length} строк и, в отличие от месячного`);
push('отчёта, содержит `order.posting_number`. Это единственный ключ, которым строка отчёта');
push('связывается с заказом и с начислениями, поэтому именно на нём строится сверка «сколько');
push('начислено против сколько реализовано».');
push();
if (avgRatio !== null) {
    push(`Средний \`commission_ratio\` по строкам: ${(avgRatio * 100).toFixed(1)} %.`);
}
const sample = perOrderRows.find((row) => row?.item?.sku);
if (sample) {
    push();
    push('Пример строки:');
    push();
    push('```json');
    push(JSON.stringify(sample, null, 1));
    push('```');
}
push();

const markdown = lines.join('\n');
if (outPath) {
    writeFileSync(outPath, markdown, 'utf8');
    console.log(`wrote ${outPath}`);
}
console.log(markdown);
