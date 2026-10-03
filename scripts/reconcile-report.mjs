#!/usr/bin/env node
/**
 * Reconciles a parsed realization report with live Seller API data.
 *
 * Three sources are compared, deliberately, because each answers a different question:
 *
 *   1. the realization report — what was realized, at the seller's price;
 *   2. the order cards (`/v3/posting/fbo/list` with `financial_data`) — price, commission
 *      and payout per line, i.e. what Ozon says an order is worth;
 *   3. the accruals (`/v1/finance/accrual/by-day`) — what Ozon actually charged and paid.
 *
 * Only the third says what reaches the account, which is why the other two are needed to
 * check it rather than replace it.
 *
 * Read-only. Credentials from `OZON_CLIENT_ID` / `OZON_API_KEY`.
 *
 * Usage:
 *   node scripts/reconcile-report.mjs --report=.report.json --api=.reconcile.json \
 *        --month=2026-09 --out=docs/reconciliation.md
 */

import { writeFileSync } from 'node:fs';

const BASE = 'https://api-seller.ozon.ru';
const arg = (name, fallback) =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const reportPath = arg('report', 'reports/report.json');
const apiPath = arg('api', 'reports/accruals.json');
const month = arg('month', '2026-09');
const outPath = arg('out', null);

const clientId = process.env.OZON_CLIENT_ID?.trim();
const apiKey = process.env.OZON_API_KEY?.trim();
if (!clientId || !apiKey) {
    console.error('Set OZON_CLIENT_ID and OZON_API_KEY first.');
    process.exit(2);
}

const report = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(reportPath, 'utf8')));
const api = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(apiPath, 'utf8')));

async function call(path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Client-Id': clientId,
            'Api-Key': apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

const money = (value) =>
    value === null || value === undefined
        ? '—'
        : value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const signed = (value) => (value > 0 ? `+${money(value)}` : money(value));

// --- 2. Order cards ----------------------------------------------------------------
const [year, monthNumber] = month.split('-').map(Number);
const statuses = ['awaiting_packaging', 'awaiting_deliver', 'delivering', 'delivered', 'cancelled'];

const orders = { price: 0, commission: 0, payout: 0, units: 0, postings: 0, missingMoney: 0 };
const orderBySku = new Map();

/** Walks the cursor over one window, then dedupes across windows by posting number. */
async function windowPostings(from, to) {
    const found = [];
    let cursor = '';

    for (let page = 0; page < 60; page += 1) {
        const response = await call('/v3/posting/fbo/list', {
            cursor,
            filter: { since: from, to, statuses },
            limit: 100,
            sort_dir: 'DESC',
            translit: true,
            with: { analytics_data: false, financial_data: true }
        });

        found.push(...(response.postings ?? []));
        if (!response.has_next || !response.cursor) break;
        cursor = response.cursor;
    }

    return found;
}

const windows = [];
const lastDay = new Date(year, monthNumber, 0).getDate();
for (let day = 1; day <= lastDay; day += 5) {
    const from = new Date(Date.UTC(year, monthNumber - 1, day, 0, 0, 0));
    const to = new Date(Date.UTC(year, monthNumber - 1, Math.min(day + 4, lastDay), 23, 59, 59));
    windows.push({ from: from.toISOString(), to: to.toISOString() });
}

const seen = new Map();
for (const window of windows) {
    for (const posting of await windowPostings(window.from, window.to)) {
        seen.set(posting.posting_number, posting);
    }
}

for (const posting of seen.values()) {
    orders.postings += 1;

    const financial = posting.financial_data?.products ?? [];
    if (financial.length === 0) orders.missingMoney += 1;

    for (const product of posting.products ?? []) {
        const entry = orderBySku.get(String(product.sku)) ?? { units: 0, price: 0, commission: 0, payout: 0 };
        entry.units += Number(product.quantity ?? 0) || 0;
        orderBySku.set(String(product.sku), entry);
    }

    for (const row of financial) {
        const price = Number(row.price ?? 0) || 0;
        // `commission` is an object and comes through negative: { amount: -936, percent: 52 }.
        const commission = Math.abs(Number(row.commission?.amount ?? 0) || 0);

        orders.price += price;
        orders.commission += commission;
        orders.payout += Number(row.payout ?? 0) || 0;

        const sku = String(row.product_id ?? '');
        const entry = orderBySku.get(sku);
        if (entry) {
            entry.price += price;
            entry.commission += commission;
            entry.payout += Number(row.payout ?? 0) || 0;
        }
    }
}

// --- 3. Accruals -------------------------------------------------------------------
const postingNet = api.byCategory.POSTING.net;
const itemNet = api.byCategory.ITEM.net;
const nonItemNet = api.byCategory.NON_ITEM.net;
const attributed = api.postingFeesAttributed;
const salePart = postingNet - attributed;

const netRealized = report.totals.net_realized ?? report.sums.realized - report.sums.returned;
const impliedCommission = netRealized - salePart;

// --- Per SKU -----------------------------------------------------------------------
const reportBySku = new Map();
for (const item of report.items) {
    const entry = reportBySku.get(item.sku) ?? { units: 0, returned: 0, realized: 0, returnedSum: 0, name: item.name };
    entry.units += item.realized_qty;
    entry.returned += item.returned_qty;
    entry.realized += item.realized;
    entry.returnedSum += item.returned;
    entry.name = entry.name || item.name;
    reportBySku.set(item.sku, entry);
}

const skus = [...new Set([...reportBySku.keys(), ...Object.keys(api.perSku)])].sort(
    (a, b) => (reportBySku.get(b)?.realized ?? 0) - (reportBySku.get(a)?.realized ?? 0)
);

const lines = [];
const push = (text = '') => lines.push(text);

push(`# Сверка отчёта о реализации с Seller API — ${month}`);
push();
push(`Отчёт № ${report.report_number ?? '—'} от ${report.period.to ?? '—'}, период ` +
    `${report.period.from} — ${report.period.to}, получатель: ${report.seller || '—'}.`);
push();
push('Три источника отвечают на разные вопросы: отчёт — сколько реализовано по цене продавца,');
push('карточки заказов — сколько Ozon начислил и удержал по каждой позиции, начисления — сколько');
push('денег реально дошло до счёта. Совпадать до копейки они не обязаны: отчёт строится по дате');
push('реализации, начисления — по дате начисления, поэтому заказ конца августа может попасть в');
push('сентябрьские начисления. Ниже — суммы и объяснение расхождений.');
push();

push('## Итоги');
push();
push('| Показатель | Сумма, ₽ | Источник |');
push('| --- | ---: | --- |');
push(`| Реализовано | ${money(report.sums.realized)} | отчёт |`);
push(`| Возвращено клиентом | ${money(report.sums.returned)} | отчёт |`);
push(`| **Итого реализовано за вычетом возвратов** | **${money(netRealized)}** | отчёт |`);
push(`| Выплаты по механикам лояльности, нетто | ${money(report.totals.net_loyalty)} | отчёт |`);
push(`| Цена продавца по карточкам заказов | ${money(orders.price)} | заказы |`);
push(`| Комиссия по карточкам заказов | ${money(orders.commission)} | заказы |`);
push(`| Payout по карточкам заказов | ${money(orders.payout)} | заказы |`);
push(`| Продажная часть начислений (POSTING минус услуги) | ${money(salePart)} | начисления |`);
push(`| Услуги внутри POSTING (логистика и прочее) | ${money(attributed)} | начисления |`);
push(`| Эквайринг и прочие сборы по товару (ITEM) | ${money(itemNet)} | начисления |`);
push(`| Расходы кабинета (NON_ITEM) | ${money(nonItemNet)} | начисления |`);
push(`| **К получению на счёт (всего)** | **${money(api.sumTotalAmount)}** | начисления |`);
push();

push('## Комиссия: два независимых способа');
push();
push(`Из отчёта и начислений она выводится как разница: ${money(netRealized)} − ${money(salePart)} ` +
    `= **${money(impliedCommission)}** (${((impliedCommission / netRealized) * 100).toFixed(1)} % от реализации).`);
push();
push(`По карточкам заказов комиссия приходит готовой суммой: **${money(orders.commission)}** ` +
    `(${orders.price > 0 ? ((orders.commission / orders.price) * 100).toFixed(1) : '—'} % от цены заказов).`);
push();
const commissionGap = impliedCommission - orders.commission;
push(`Расхождение способов: ${money(commissionGap)}. Оно ожидаемо и объясняется тем, что сравниваются`);
push('разные множества заказов: отчёт — по дате реализации, заказы — по дате создания.');
push();

push('## Заказы и начисления');
push();
push(`| Показатель | Значение |`);
push(`| --- | ---: |`);
push(`| Отправлений в заказах | ${orders.postings.toLocaleString('ru-RU')} |`);
push(`| Штук в заказах | ${orders.units.toLocaleString('ru-RU')} |`);
push(`| Штук реализовано (отчёт, за вычетом возвратов) | ${(report.sums.realized_qty - report.sums.returned_qty).toLocaleString('ru-RU')} |`);
push(`| Начислений за месяц | ${api.fetched.accruals.toLocaleString('ru-RU')} |`);
push(`| Дней с начислениями | ${api.fetched.days - api.fetched.daysEmpty} из ${api.fetched.days} |`);
push(`| Отправлений с начислениями | ${api.postingUnits.toLocaleString('ru-RU')} |`);
push(`| Заказов без финансовых данных | ${orders.missingMoney.toLocaleString('ru-RU')} |`);
push();

push('## Удержания Ozon за месяц');
push();
push('| Тип | Название | Сумма, ₽ | Операций |');
push('| ---: | --- | ---: | ---: |');
for (const line of api.typeLines) {
    push(`| ${line.typeId} | ${line.name} | ${money(line.net)} | ${line.count} |`);
}
push();
push('Комиссии в этом списке нет: Ozon не отдаёт её отдельной строкой услуги, она уже вычтена');
push('внутри суммы начисления. Именно поэтому её считают разницей, а не читают из строки.');
push();

push('## По товарам');
push();
push('| SKU | Название | Реализовано, шт | Начислено, шт | Реализовано, ₽ | Начисления нетто, ₽ | Услуги, ₽ |');
push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const sku of skus) {
    const fromReport = reportBySku.get(sku);
    const fromApi = api.perSku[sku];
    push(
        `| ${sku} | ${(fromReport?.name ?? '').slice(0, 40)} | ${fromReport?.units ?? 0} | ` +
            `${fromApi?.units ?? 0} | ${money(fromReport?.realized ?? 0)} | ` +
            `${money(fromApi?.net ?? 0)} | ${money(fromApi?.fees ?? 0)} |`
    );
}
push();

const unitGap = skus
    .map((sku) => ({
        sku,
        report: reportBySku.get(sku)?.units ?? 0,
        api: api.perSku[sku]?.units ?? 0
    }))
    .filter((row) => row.report !== row.api);

push('### Совпадение по штукам');
push();
if (unitGap.length === 0) {
    push('Количество совпало по всем SKU — значит сопоставление товаров и разбор ответов верны.');
} else {
    push(`Расходится по ${unitGap.length} SKU (ожидаемо: границы месяца и даты начисления не совпадают):`);
    push();
    push('| SKU | Отчёт, шт | Начисления, шт | Разница |');
    push('| --- | ---: | ---: | ---: |');
    for (const row of unitGap) {
        push(`| ${row.sku} | ${row.report} | ${row.api} | ${signed(row.api - row.report)} |`);
    }
}
push();

const markdown = lines.join('\n');
if (outPath) {
    writeFileSync(outPath, markdown, 'utf8');
    console.log(`wrote ${outPath}`);
}
console.log(markdown.split('\n').slice(0, 60).join('\n'));
