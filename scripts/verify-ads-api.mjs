#!/usr/bin/env node
/**
 * Checks whether the advertising contour (Ozon Performance API) is reachable and whether
 * its money ties back to the accruals the dashboard already reads.
 *
 * Why this exists before any UI work: advertising is a second, separate contour — its own
 * host, its own service account and a bearer token that lives 30 minutes. Nothing in the
 * seller contour proves it is available: the same call with a Seller Api-Key answers
 * `401 invalid_client`.
 *
 * Live answers this script was written to obtain, all four now confirmed on the account:
 *
 *   1. the token endpoint works with a Performance service account (Bearer, 1800 s);
 *   2. campaigns carry `PaymentType` (capital P) — `CPC` is «Оплата за клик», `CPO` is
 *      «Оплата за заказ», and `advObjectType` separates `SKU` from `SEARCH_PROMO`;
 *   3. `/statistics/campaign/product/json` and `/statistics/products/sku` answer
 *      synchronously and do not consume export limits, but the SKU method only accepts
 *      today or yesterday: `{"error":"date range must contain only today or yesterday"}`.
 *      Month-to-date per SKU therefore has to come from asynchronous campaign reports;
 *   4. money fields arrive as Russian-formatted strings (`"291,12"`) in the campaign
 *      report and as dot-decimal strings (`"88.06"`) in the SKU report, while `ctr` is a
 *      ratio in the first (`0,07`) and a percentage in the second (`4.74`) — parsing the
 *      two with one rule silently produces zeros.
 *
 * The last check joins the contours: the `unit_number` of an «Оплата за клик» accrual is
 * the **advertising campaign id**, so spend is attributable to a named campaign using the
 * Seller API alone, and its daily amount equals the cabinet's spend to the kopeck.
 *
 * Strictly read-only: a token, the campaign list, bid limits, three statistics reads and
 * accruals for one day. Nothing is created, activated or bid on.
 *
 * Credentials, environment first and `.env.local` (gitignored) as a fallback:
 *   OZON_PERFORMANCE_CLIENT_ID / OZON_PERFORMANCE_CLIENT_SECRET — Настройки → API-ключи →
 *   вкладка Performance API, сервисный аккаунт. Необязательные OZON_CLIENT_ID /
 *   OZON_API_KEY включают сверку с начислениями. Ни один секрет не печатается.
 *
 * Usage:
 *   node scripts/verify-ads-api.mjs [--date=YYYY-MM-DD] [--deep]
 *
 * Without `--date` yesterday is used: accruals for a day arrive the next day.
 */

import { readFileSync } from 'node:fs';

const PERF = 'https://api-performance.ozon.ru';
const SELLER = 'https://api-seller.ozon.ru';
/** Fee type 41 in /v1/finance/accrual/types: PayPerClick, «Оплата за клик». */
const PAY_PER_CLICK_TYPE = '41';

const arg = (name, fallback) =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

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
const clientId = env.OZON_PERFORMANCE_CLIENT_ID?.trim();
const clientSecret = env.OZON_PERFORMANCE_CLIENT_SECRET?.trim();
const sellerClientId = env.OZON_CLIENT_ID?.trim();
const sellerApiKey = env.OZON_API_KEY?.trim();

const dayMs = 24 * 60 * 60 * 1000;
const day = arg('date', new Date(Date.now() - dayMs).toISOString().slice(0, 10));
const olderDay = new Date(new Date(`${day}T00:00:00Z`).getTime() - 30 * dayMs)
    .toISOString()
    .slice(0, 10);
const deep = process.argv.includes('--deep');

if (!clientId || !clientSecret) {
    console.error(
        [
            'Не заданы ключи Performance API.',
            '',
            'Возьмите их в кабинете: Настройки → API-ключи → вкладка Performance API,',
            'создайте сервисный аккаунт и добавьте ключ, затем положите в .env.local:',
            '  OZON_PERFORMANCE_CLIENT_ID=xxxxx@advertising.performance.ozon.ru',
            '  OZON_PERFORMANCE_CLIENT_SECRET=xxxxx',
            '',
            'Ключ Seller API здесь не работает — это отдельный контур (проверено: 401 invalid_client).'
        ].join('\n')
    );
    process.exit(2);
}

const results = [];

function record(name, status, lines) {
    results.push({ name, status });
    const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';
    console.log(`\n${icon} ${name}`);
    for (const line of lines) console.log(`    ${line}`);
}

const keysOf = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];

const cut = (value, limit = 300) => JSON.stringify(value)?.slice(0, limit) ?? String(value);

/** Money arrives as `"291,12"` here and `"88.06"` there — read both, never NaN. */
function parseMoney(value) {
    if (value === null || value === undefined || value === '') return 0;
    const parsed = Number(String(value).replace(/[\s\u00a0]/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
}

const money = (value) => parseMoney(value).toFixed(2);

/** Reports answer as a bare array or wrapped; find the rows without guessing a name. */
function rowsOf(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    for (const key of ['rows', 'items', 'list', 'result']) {
        if (Array.isArray(payload[key])) return payload[key];
    }
    const arrays = Object.values(payload).filter(Array.isArray);
    return arrays.length === 1 ? arrays[0] : [];
}

/** The campaign list wraps a single campaign as an object, not a one-element array. */
function listOf(payload) {
    if (Array.isArray(payload)) return payload;
    const rows = rowsOf(payload);
    if (rows.length) return rows;
    if (payload && typeof payload === 'object' && payload.id !== undefined) return [payload];
    return [];
}

async function call(base, path, { method = 'GET', body, token, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    const raw = await response.text();
    let parsed = {};
    try {
        parsed = raw ? JSON.parse(raw) : {};
    } catch {
        parsed = { _raw: raw.slice(0, 300) };
    }

    return { status: response.status, ok: response.ok, body: parsed };
}

const perf = (path, options) => call(PERF, path, options);

const seller = (path, body) =>
    call(SELLER, path, {
        method: 'POST',
        body,
        headers: { 'Client-Id': sellerClientId, 'Api-Key': sellerApiKey }
    });

console.log('Проверка контура Ozon Performance API (только чтение)');
console.log(`Кабинет: ${clientId.slice(0, 3)}***  ·  день: ${day}  ·  окно SKU: ${olderDay}…${day}`);
console.log(`Сверка с начислениями: ${sellerClientId && sellerApiKey ? 'включена' : 'выключена (нет ключей Seller API)'}`);

// --- 1. Token: the whole contour hinges on this one call --------------------------
let token = null;
{
    const { status, ok, body } = await perf('/api/client/token', {
        method: 'POST',
        body: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }
    });

    if (!ok || !body.access_token) {
        record('Токен: POST /api/client/token', 'fail', [
            `HTTP ${status}: ${cut(body.message ?? body.error_description ?? body, 200)}`,
            'Если 401 — это не тот ключ: нужен client_id/client_secret из вкладки Performance API.'
        ]);
    } else {
        token = body.access_token;
        record('Токен: POST /api/client/token', 'ok', [
            `HTTP ${status}, тип ${body.token_type}, срок ${body.expires_in} с`,
            `токен получен, длина ${String(token).length} символов (значение не выводится)`
        ]);
    }
}

if (!token) {
    console.log('\n' + '─'.repeat(60));
    console.log('Дальше идти некуда: без токена рекламные методы недоступны.');
    process.exit(1);
}

// --- 2. Campaigns: is there anything with оплата за клик at all? -----------------
let campaigns = [];
{
    const { status, ok, body } = await perf('/api/client/campaign?page=1&pageSize=100', { token });

    if (!ok) {
        record('Кампании: GET /api/client/campaign', 'fail', [
            `HTTP ${status}: ${cut(body.message ?? body, 200)}`
        ]);
    } else {
        campaigns = listOf(body);
        // `PaymentType` with a capital P is the real field name; the lowercase one is a trap.
        const paymentOf = (campaign) => String(campaign.PaymentType ?? campaign.paymentType ?? '—');
        const cpc = campaigns.filter((campaign) => paymentOf(campaign).includes('CPC'));

        const byType = {};
        for (const campaign of campaigns) {
            const key = `${paymentOf(campaign)}/${campaign.advObjectType ?? '—'}`;
            byType[key] = (byType[key] ?? 0) + 1;
        }

        const lines = [
            `HTTP ${status}, кампаний: ${campaigns.length}`,
            `по PaymentType/advObjectType: ${cut(byType, 240)}`,
            `«Оплата за клик» (CPC): ${cpc.length}, из них активных: ${cpc.filter((c) => String(c.state).includes('RUNNING')).length}`
        ];
        for (const campaign of cpc.slice(0, 12)) {
            lines.push(
                `  id=${campaign.id} | ${cut(campaign.title, 60)} | ${String(campaign.state).replace('CAMPAIGN_STATE_', '')}`
            );
        }

        record(
            'Кампании: GET /api/client/campaign',
            cpc.length ? 'ok' : 'warn',
            cpc.length
                ? lines
                : [...lines, 'Кампаний с оплатой за клик нет — расход pay_per_click в начислениях идёт из другой механики.']
        );
    }
}

const paymentOf = (campaign) => String(campaign.PaymentType ?? campaign.paymentType ?? '');
const cpcCampaigns = campaigns.filter((campaign) => paymentOf(campaign).includes('CPC'));
const cpcIds = cpcCampaigns.map((campaign) => String(campaign.id)).slice(0, 10);
const titleOf = (id) =>
    campaigns.find((campaign) => String(campaign.id) === String(id))?.title ?? '(нет в списке кампаний)';

// --- 3. Bid limits: what the contour calls a click bid ----------------------------
{
    const { status, ok, body } = await perf('/api/client/limits/list', { token });

    record(
        'Лимиты ставок: GET /api/client/limits/list',
        ok ? 'ok' : 'warn',
        ok
            ? [`HTTP ${status}`, `фрагмент: ${cut(body, 400)}`]
            : [`HTTP ${status}: ${cut(body.message ?? body, 200)}`, 'Не критично для проверки доступа.']
    );
}

// --- 4. Campaign statistics, synchronous and limit-free ---------------------------
/** Campaign id → spend for `day`, filled by the check below and reused by the join. */
const spendByCampaign = new Map();
{
    const query = new URLSearchParams({ dateFrom: day, dateTo: day });
    for (const id of cpcIds) query.append('campaignIds', id);

    const { status, ok, body } = await perf(`/api/client/statistics/campaign/product/json?${query}`, { token });

    if (!ok) {
        record('Статистика кампаний: GET /statistics/campaign/product/json', 'fail', [
            `HTTP ${status}: ${cut(body.message ?? body, 200)}`,
            'Метод не расходует лимиты выгрузок — это основной путь для регулярного обновления.'
        ]);
    } else {
        const rows = rowsOf(body);
        const lines = [`HTTP ${status}, строк: ${rows.length}`];
        let spend = 0;
        let clicks = 0;
        let views = 0;

        for (const row of rows) {
            const id = String(row.id ?? row.campaignId ?? '');
            const rowSpend = parseMoney(row.moneySpent ?? row.expense);
            spendByCampaign.set(id, rowSpend);
            spend += rowSpend;
            clicks += parseMoney(row.clicks);
            views += parseMoney(row.views);
        }

        lines.push(`расход за ${day}: ${money(spend)} ₽ · клики: ${clicks} · показы: ${views}`);
        if (rows[0]) {
            lines.push(`поля строки: ${keysOf(rows[0]).join(', ')}`);
            lines.push('внимание: здесь деньги приходят как «291,12», а ctr — долей («0,07»), не процентом');
            for (const row of rows.filter((r) => parseMoney(r.moneySpent ?? r.expense) > 0).slice(0, 8)) {
                lines.push(
                    `  id=${row.id} «${cut(row.title, 30)}»: расход ${money(row.moneySpent)} ₽, клики ${row.clicks ?? '—'}` +
                        `, CTR ${row.ctr ?? '—'}, цена клика ${row.clickPrice ?? '—'}, заказы ${row.orders ?? '—'}`
                );
            }
        }

        record(
            'Статистика кампаний: GET /statistics/campaign/product/json',
            rows.some((row) => parseMoney(row.moneySpent ?? row.expense) > 0) ? 'ok' : 'warn',
            rows.length
                ? lines
                : [`HTTP ${status}, строк нет`, `Проверьте другой день через --date=YYYY-MM-DD.`]
        );
    }
}

// --- 5. SKU statistics and the real width of its window ---------------------------
const skuRows = [];
{
    const { status, ok, body } = await perf('/api/client/statistics/products/sku', {
        method: 'POST',
        token,
        body: { campaignIds: cpcIds, dateFrom: day, dateTo: day }
    });

    if (!ok) {
        record('Статистика по товарам: POST /statistics/products/sku', 'fail', [
            `HTTP ${status}: ${cut(body.message ?? body, 200)}`
        ]);
    } else {
        skuRows.push(...rowsOf(body));
        const lines = [`HTTP ${status}, строк: ${skuRows.length}`];
        if (skuRows.length) {
            const spend = skuRows.reduce((total, row) => total + parseMoney(row.expense), 0);
            const clicks = skuRows.reduce((total, row) => total + parseMoney(row.clicks), 0);
            lines.push(`расход: ${money(spend)} ₽ · клики: ${clicks} · SKU: ${new Set(skuRows.map((r) => r.sku)).size}`);
            lines.push(`поля строки: ${keysOf(skuRows[0]).join(', ')}`);
            lines.push('здесь наоборот: деньги «88.06» через точку, ctr — процентом («4.74»)');
            lines.push(`пример: ${cut(skuRows[0], 320)}`);
        }
        record('Статистика по товарам: POST /statistics/products/sku', skuRows.length ? 'ok' : 'warn', lines);
    }
}

{
    const { status, ok, body } = await perf('/api/client/statistics/products/sku', {
        method: 'POST',
        token,
        body: { campaignIds: cpcIds, dateFrom: olderDay, dateTo: day }
    });

    const refused = !ok;
    const message = String(body.error ?? body.message ?? '');
    const asDocumented = refused && /today or yesterday/i.test(message);

    const lines = [
        `запрос за ${olderDay}…${day} → HTTP ${status}`,
        refused ? `ответ: ${cut(message, 200)}` : `строк: ${rowsOf(body).length}`
    ];

    if (asDocumented) {
        lines.push(
            'Правило подтверждено: поштучная статистика доступна только за сегодня и вчера.',
            'Месячный разрез по SKU — только асинхронными отчётами по кампаниям',
            '(POST /api/client/statistics с groupBy=DATE, до 62 дней).'
        );
    } else if (refused) {
        lines.push('Отказ по другой причине — стоит присмотреться.');
    } else {
        lines.push('Окно шире документации: история по SKU доступна, правило в спеке устарело.');
    }

    record('Окно истории по SKU', asDocumented || !refused ? 'ok' : 'warn', lines);
}

// --- 6. The join: does an accrual's unit_number name a campaign, and do the sums agree?
if (!sellerClientId || !sellerApiKey) {
    console.log('\nℹ️  Сверка с начислениями пропущена: нет OZON_CLIENT_ID / OZON_API_KEY.');
} else {
    const { status, ok, body } = await seller('/v1/finance/accrual/by-day', { date: day });

    if (!ok) {
        record('Сверка с начислениями: /v1/finance/accrual/by-day', 'warn', [
            `HTTP ${status}: ${cut(body.message ?? body, 200)}`,
            'Начисления за день приходят на следующий день — попробуйте другой --date.'
        ]);
    } else {
        const clickCharges = (body.accruals ?? []).filter(
            (accrual) => String(accrual.non_item_fee?.type_id ?? '') === PAY_PER_CLICK_TYPE
        );

        const lines = [
            `HTTP ${status}, начислений за ${day}: ${(body.accruals ?? []).length}`,
            `из них «Оплата за клик» (type_id ${PAY_PER_CLICK_TYPE}, NON_ITEM): ${clickCharges.length}`
        ];

        let matched = 0;
        for (const accrual of clickCharges) {
            const unit = String(accrual.unit_number ?? '');
            const accrued = parseMoney(accrual.non_item_fee?.accrued?.amount ?? accrual.total_amount);
            const spent = spendByCampaign.get(unit);
            const known = campaigns.some((campaign) => String(campaign.id) === unit);
            if (known) matched += 1;

            // The cabinet reports spend as a positive number and the accrual as a negative
            // one, so the comparison must be by magnitude, not by value.
            const verdict =
                spent === undefined
                    ? 'в статистике кабинета этой кампании за день нет'
                    : Math.abs(Math.abs(spent) - Math.abs(accrued)) < 0.01
                      ? 'совпало до копейки'
                      : `РАСХОЖДЕНИЕ: кабинет ${money(spent)} ₽, начисление ${money(accrued)} ₽`;

            lines.push(
                `  unit_number=${unit} → «${String(titleOf(unit)).replace(/"/g, '').slice(0, 40)}»${known ? '' : ' (не кампания!)'}: ` +
                    `начислено ${money(accrued)} ₽, расход кабинета ${spent === undefined ? '—' : money(spent) + ' ₽'} — ${verdict}`
            );
        }

        if (clickCharges.length && matched === clickCharges.length) {
            lines.push(
                'unit_number у начисления «Оплата за клик» — это идентификатор рекламной кампании:',
                'расход атрибутируется названию кампании силами Seller API, без рекламного ключа.'
            );
        }

        record(
            'Сверка с начислениями: unit_number = кампания?',
            clickCharges.length ? (matched === clickCharges.length ? 'ok' : 'warn') : 'warn',
            clickCharges.length
                ? lines
                : [...lines, 'За этот день начислений «Оплата за клик» нет — возьмите день с расходом.']
        );
    }
}

// --- 7. Optional: the two other synchronous reports, they may consume limits -----
if (deep) {
    for (const [path, label] of [
        [`/api/client/statistics/daily/json?dateFrom=${olderDay}&dateTo=${day}`, 'дневная статистика'],
        [`/api/client/statistics/expense/json?dateFrom=${olderDay}&dateTo=${day}`, 'расход кампаний']
    ]) {
        const { status, ok, body } = await perf(path, { token });
        const rows = ok ? rowsOf(body) : [];
        record(
            `Дополнительно: ${label} (${path.split('?')[0]})`,
            ok ? 'ok' : 'warn',
            ok
                ? [
                      `HTTP ${status}, строк: ${rows.length}`,
                      rows[0] ? `поля: ${keysOf(rows[0]).join(', ')}` : 'строк нет',
                      rows[0] ? `пример: ${cut(rows[0], 240)}` : ''
                  ].filter(Boolean)
                : [`HTTP ${status}: ${cut(body.message ?? body, 200)}`, 'Метод может расходовать лимиты выгрузок.']
        );
    }
} else {
    console.log('\nℹ️  Дневная статистика и расход кампаний не запрашивались: добавьте --deep.');
}

void skuRows;

const failures = results.filter((result) => result.status === 'fail');
const warnings = results.filter((result) => result.status === 'warn');

console.log('\n' + '─'.repeat(60));
console.log(
    `Итог: ${results.filter((r) => r.status === 'ok').length} ок, ` +
        `${warnings.length} с замечаниями, ${failures.length} провалено`
);
for (const failure of failures) console.log(`  ❌ ${failure.name}`);
for (const warning of warnings) console.log(`  ⚠️  ${warning.name}`);
console.log('─'.repeat(60));
console.log(
    'Что делать с результатом: расход «Оплата за клик» уже атрибутируется кампании из начислений;\n' +
        'клики, CTR, цена клика и разрез по SKU требуют этого контура, а история по SKU — только за сутки.'
);

process.exit(failures.length > 0 ? 1 : 0);
