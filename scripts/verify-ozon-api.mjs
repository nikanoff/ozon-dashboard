#!/usr/bin/env node
/**
 * Checks the four Ozon methods the dashboard depends on against a live account.
 *
 * Why this exists: the financial layer was written from documentation and field lists,
 * and the two published sources disagree about some of them. Unit tests can only prove
 * the parser handles the shapes it was told about. This asks the real API what it
 * actually returns, before anything is deployed.
 *
 * It is strictly read-only: one posting, one accrual day, the type catalogue, one page of
 * turnover. Nothing is written to the account.
 *
 * Usage (PowerShell):
 *   $env:OZON_CLIENT_ID="123456"; $env:OZON_API_KEY="xxxx"; node scripts/verify-ozon-api.mjs
 *
 * Usage (bash):
 *   OZON_CLIENT_ID=123456 OZON_API_KEY=xxxx node scripts/verify-ozon-api.mjs
 *
 * The key is never printed, and the client id is masked. Pass a day to check with
 * `--day=2026-09-15`, otherwise yesterday is used.
 */

const BASE = 'https://api-seller.ozon.ru';

const clientId = process.env.OZON_CLIENT_ID?.trim();
const apiKey = process.env.OZON_API_KEY?.trim();

const dayArg = process.argv.find((arg) => arg.startsWith('--day='));
const day =
    dayArg?.slice('--day='.length) ??
    (() => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return yesterday.toISOString().slice(0, 10);
    })();

const results = [];

function record(name, status, lines) {
    results.push({ name, status });
    const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';
    console.log(`\n${icon} ${name}`);
    for (const line of lines) console.log(`    ${line}`);
}

/** Keys of an object, so a shape can be inspected without dumping values. */
const keysOf = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];

async function call(path, body) {
    const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Client-Id': clientId,
            'Api-Key': apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const raw = await response.text();
    let parsed;
    try {
        parsed = raw ? JSON.parse(raw) : {};
    } catch {
        parsed = { _raw: raw.slice(0, 200) };
    }

    return { ok: response.ok, status: response.status, body: parsed };
}

/** Mirrors the app's recursive search for `{ type_id, accrued }` pairs. */
function findFees(node, out = [], depth = 0) {
    if (depth > 12 || node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const item of node) findFees(item, out, depth + 1);
        return out;
    }
    if (node.type_id !== undefined && node.accrued !== undefined) {
        out.push(String(node.type_id));
        return out;
    }
    for (const value of Object.values(node)) findFees(value, out, depth + 1);
    return out;
}

// --- 1. Orders and the money on the order card ------------------------------------
async function checkPostings() {
    const { ok, status, body } = await call('/v3/posting/fbo/list', {
        cursor: '',
        filter: {
            since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
            statuses: ['delivered', 'cancelled', 'delivering']
        },
        limit: 5,
        sort_dir: 'DESC',
        translit: true,
        with: { analytics_data: true, financial_data: true }
    });

    if (!ok) return record('Заказы: /v3/posting/fbo/list', 'fail', [`HTTP ${status}: ${body.message ?? ''}`]);

    const postings = body.postings ?? body.result ?? [];
    const lines = [`HTTP ${status}, заказов в ответе: ${Array.isArray(postings) ? postings.length : '—'}`];

    const withMoney = (Array.isArray(postings) ? postings : []).find(
        (posting) => posting.financial_data?.products?.length > 0
    );

    if (!withMoney) {
        lines.push('⚠️  ни в одном заказе нет financial_data.products — деньги из карточки недоступны');
        return record('Заказы: /v3/posting/fbo/list', 'warn', lines);
    }

    const money = withMoney.financial_data.products[0];
    lines.push(`поля financial_data.products[0]: ${keysOf(money).join(', ') || '(пусто)'}`);

    const present = ['payout', 'commission_amount', 'commission_percent'].filter(
        (field) => typeof money[field] === 'number'
    );
    const missing = ['payout', 'commission_amount', 'commission_percent'].filter(
        (field) => !present.includes(field)
    );

    lines.push(`есть: ${present.join(', ') || '—'}`);
    if (missing.length) lines.push(`НЕТ: ${missing.join(', ')}`);

    // The open question from the analysis: is `payout` already net of logistics?
    if (typeof money.payout === 'number' && typeof money.price === 'number') {
        const gross = money.price;
        const minusCommission =
            typeof money.commission_amount === 'number' ? gross - money.commission_amount : null;
        if (minusCommission !== null) {
            const isPlainCommission = Math.abs(money.payout - minusCommission) < 0.02;
            lines.push(
                `price ${gross}, commission ${money.commission_amount}, payout ${money.payout}` +
                    ` → payout ${isPlainCommission ? '= цена минус комиссия (логистика НЕ вычтена)' : 'меньше цены минус комиссия (что-то ещё вычтено)'}`
            );
        }
    }

    record('Заказы: /v3/posting/fbo/list', missing.length ? 'warn' : 'ok', lines);
}

// --- 2. Financial accruals --------------------------------------------------------
async function checkAccruals() {
    const { ok, status, body } = await call('/v1/finance/accrual/by-day', { date: day });

    if (!ok) {
        return record(`Начисления: /v1/finance/accrual/by-day (${day})`, 'fail', [
            `HTTP ${status}: ${body.message ?? ''}`,
            'Если здесь 400 «obsolete» — проверяется не тот метод; если 403 — у ключа нет прав.'
        ]);
    }

    const accruals = body.accruals ?? [];
    const lines = [
        `HTTP ${status}, начислений за ${day}: ${Array.isArray(accruals) ? accruals.length : '—'}`,
        `ключ пагинации last_id: ${body.last_id === undefined ? 'ОТСУТСТВУЕТ' : JSON.stringify(body.last_id)}`
    ];

    if (!Array.isArray(accruals) || accruals.length === 0) {
        lines.push('Начислений за этот день нет — попробуйте другой день через --day=YYYY-MM-DD');
        return record(`Начисления: /v1/finance/accrual/by-day (${day})`, 'warn', lines);
    }

    const first = accruals.find((row) => row && typeof row === 'object') ?? {};
    lines.push(`поля начисления: ${keysOf(first).join(', ')}`);

    const mapped = {
        accrual_id: first.accrual_id ?? first.operation_id,
        total_amount: first.total_amount,
        accrued_category: first.accrued_category,
        unit_number: first.unit_number ?? first.posting_number
    };
    for (const [field, value] of Object.entries(mapped)) {
        lines.push(`${field}: ${value === undefined ? 'ОТСУТСТВУЕТ' : 'есть'}`);
    }

    const byCategory = {};
    let withoutUnit = 0;
    for (const row of accruals) {
        const category = String(row?.accrued_category ?? 'UNKNOWN');
        byCategory[category] = (byCategory[category] ?? 0) + 1;
        if (!(row?.unit_number ?? row?.posting_number)) withoutUnit += 1;
    }
    lines.push(`категории: ${JSON.stringify(byCategory)}`);
    lines.push(`без номера отправления (расходы кабинета): ${withoutUnit}`);

    const feeSample = findFees(first);
    lines.push(`вложенных пар {type_id, accrued} в первом начислении: ${feeSample.length}${feeSample.length ? ` → ${feeSample.slice(0, 6).join(', ')}` : ''}`);
    if (feeSample.length === 0) {
        lines.push('Рекурсивный поиск комиссий ничего не нашёл — разбор удержаний по видам будет пустым.');
    }

    const critical = ['accrual_id', 'total_amount'].filter(
        (field) => mapped[field] === undefined || mapped[field] === null
    );

    record(
        `Начисления: /v1/finance/accrual/by-day (${day})`,
        critical.length ? 'fail' : 'ok',
        lines
    );
}

// --- 3. Fee type catalogue --------------------------------------------------------
async function checkTypes() {
    const { ok, status, body } = await call('/v1/finance/accrual/types', {});

    if (!ok) {
        return record('Справочник: /v1/finance/accrual/types', 'warn', [
            `HTTP ${status}: ${body.message ?? ''}`,
            'Не критично: без справочника удержания покажутся идентификаторами типов.'
        ]);
    }

    const flat = Array.isArray(body.types) ? body.types : null;
    const nested = Array.isArray(body.result?.types) ? body.result.types : null;
    const list = flat ?? nested ?? [];

    const lines = [
        `HTTP ${status}, оболочка: ${flat ? 'types' : nested ? 'result.types' : 'НЕ РАСПОЗНАНА'}`,
        `записей: ${list.length}`
    ];

    const sample = list.find((entry) => entry && (entry.name || entry.title));
    if (sample) {
        lines.push(`пример: id=${sample.id ?? '—'} name=${JSON.stringify(sample.name ?? sample.title)}`);
        lines.push(`поля записи: ${keysOf(sample).join(', ')}`);
    } else {
        lines.push('Записи не найдены — названия удержаний будут идентификаторами.');
    }

    record('Справочник: /v1/finance/accrual/types', list.length ? 'ok' : 'warn', lines);
}

// --- 4. Turnover ------------------------------------------------------------------
async function checkTurnover() {
    const { ok, status, body } = await call('/v1/analytics/turnover/stocks', {
        limit: 100,
        offset: 0
    });

    if (!ok) {
        return record('Оборачиваемость: /v1/analytics/turnover/stocks', 'warn', [
            `HTTP ${status}: ${body.message ?? ''}`,
            'Не критично: раздел скроется, дни запаса считаются и без него.',
            'Внимание: метод ограничен одним запросом в минуту — не нажимайте «Повторить» подряд.'
        ]);
    }

    const items = body.items ?? body.result?.items ?? [];
    const lines = [
        `HTTP ${status}, строк: ${Array.isArray(items) ? items.length : '—'}`,
        `всего по ответу (total): ${body.total ?? body.total_items ?? '—'}`
    ];

    const first = (Array.isArray(items) ? items : []).find((row) => row && typeof row === 'object');
    if (first) {
        lines.push(`поля строки: ${keysOf(first).join(', ')}`);
        const gradeField = ['turnover_grade', 'idc_grade', 'grade'].find(
            (field) => first[field] !== undefined
        );
        lines.push(
            gradeField
                ? `поле оценки: ${gradeField} = ${JSON.stringify(first[gradeField])}`
                : 'ПОЛЕ ОЦЕНКИ НЕ НАЙДЕНО (ни turnover_grade, ни idc_grade)'
        );
        for (const field of ['current_stock', 'stock', 'ads', 'idc']) {
            if (first[field] !== undefined) lines.push(`${field} = ${JSON.stringify(first[field])}`);
        }
    } else {
        lines.push('Строк нет — вероятно, у кабинета нет товаров с остатками.');
    }

    record('Оборачиваемость: /v1/analytics/turnover/stocks', first ? 'ok' : 'warn', lines);
}

// --- Run --------------------------------------------------------------------------
if (!clientId || !apiKey) {
    console.error(
        [
            'Не заданы ключи.',
            '',
            'PowerShell:',
            '  $env:OZON_CLIENT_ID="ваш-client-id"',
            '  $env:OZON_API_KEY="ваш-api-ключ"',
            '  node scripts/verify-ozon-api.mjs',
            '',
            'Ключи берутся только из переменных окружения, чтобы не попасть в историю команд.',
            'Скрипт делает только чтение: один заказ, один день начислений, справочник и одна страница оборачиваемости.'
        ].join('\n')
    );
    process.exit(2);
}

console.log('Проверка контрактов Ozon Seller API (только чтение)');
console.log(`Кабинет: ${clientId.slice(0, 3)}***  ·  день начислений: ${day}`);
console.log(`Ключ: не выводится, длина ${apiKey.length} символов`);

try {
    await checkPostings();
    await checkAccruals();
    await checkTypes();
    await checkTurnover();
} catch (error) {
    console.error(`\n❌ Проверка прервалась: ${error.message}`);
    process.exit(1);
}

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

process.exit(failures.length > 0 ? 1 : 0);
