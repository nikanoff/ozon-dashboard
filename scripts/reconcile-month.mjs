#!/usr/bin/env node
/**
 * Reconciles a month of Ozon accruals with the realization report.
 *
 * Fetches `/v1/finance/accrual/by-day` for every day of a month, folds the accruals by
 * category and by fee type (using the names from `/v1/finance/accrual/types`), and writes
 * the result as JSON so it can be compared with the seller's own report.
 *
 * Read-only. Credentials come from `OZON_CLIENT_ID` / `OZON_API_KEY`.
 *
 * Usage:
 *   node scripts/reconcile-month.mjs --month=2026-09 --out=.reconcile.json
 */

import { writeFileSync } from 'node:fs';

const BASE = 'https://api-seller.ozon.ru';
const clientId = process.env.OZON_CLIENT_ID?.trim();
const apiKey = process.env.OZON_API_KEY?.trim();

const arg = (name, fallback) =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const month = arg('month', new Date().toISOString().slice(0, 7));
const outPath = arg('out', 'reports/accruals.json');

if (!clientId || !apiKey) {
    console.error('Set OZON_CLIENT_ID and OZON_API_KEY first.');
    process.exit(2);
}

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

/** Every accrual day of the month, one request each. */
function monthDays(month) {
    const [year, monthNumber] = month.split('-').map(Number);
    const days = [];
    const cursor = new Date(year, monthNumber - 1, 1);

    while (cursor.getMonth() === monthNumber - 1) {
        const day = String(cursor.getDate()).padStart(2, '0');
        days.push(`${year}-${String(monthNumber).padStart(2, '0')}-${day}`);
        cursor.setDate(cursor.getDate() + 1);
    }

    return days;
}

/** Collects every `{ type_id, accrued }` pair anywhere in an accrual. */
function fees(node, out = [], depth = 0) {
    if (depth > 12 || node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const item of node) fees(item, out, depth + 1);
        return out;
    }
    if (node.type_id !== undefined && node.accrued !== undefined) {
        out.push({ typeId: String(node.type_id), amount: Number(node.accrued?.amount ?? 0) });
        return out;
    }
    for (const value of Object.values(node)) fees(value, out, depth + 1);
    return out;
}

const amount = (value) => {
    const parsed = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
};

// --- Catalogue --------------------------------------------------------------------
const catalogueRaw = await call('/v1/finance/accrual/types', {});
const catalogueList = catalogueRaw.accrual_types ?? catalogueRaw.types ?? [];
const typeNames = {};
for (const entry of catalogueList) {
    if (entry?.id === undefined) continue;
    // `description` is the Russian wording; `name` is the English enum-ish label.
    typeNames[String(entry.id)] = entry.description || entry.name || String(entry.id);
}

// --- Days -------------------------------------------------------------------------
const days = monthDays(month);
const byCategory = {};
const byType = {};
const perPosting = {};
const dailyNet = {};
/** Per SKU: the sale side and the fee side, so it can be compared with the report. */
const perSku = {};

let accrualCount = 0;
let sumTotalAmount = 0;
let daysEmpty = 0;
let daysFailed = 0;

for (const day of days) {
    let payload;
    try {
        payload = await call('/v1/finance/accrual/by-day', { date: day });
    } catch (error) {
        daysFailed += 1;
        console.error(`  ${day}: ${error.message}`);
        continue;
    }

    const rows = payload.accruals ?? [];
    if (rows.length === 0) {
        daysEmpty += 1;
        dailyNet[day] = 0;
        continue;
    }

    let dayNet = 0;

    for (const row of rows) {
        accrualCount += 1;
        const category = String(row.accrued_category ?? 'UNKNOWN');
        const total = amount(row.total_amount?.amount);
        const unit = row.unit_number ? String(row.unit_number) : null;

        sumTotalAmount += total;
        dayNet += total;

        const bucket = (byCategory[category] ??= { net: 0, count: 0 });
        bucket.net += total;
        bucket.count += 1;

        const rowFees = fees(row);
        for (const fee of rowFees) {
            const entry = (byType[fee.typeId] ??= { net: 0, count: 0, categories: {} });
            entry.net += fee.amount;
            entry.count += 1;
            entry.categories[category] = (entry.categories[category] ?? 0) + fee.amount;
        }

        // Only POSTING and ITEM belong to an order; NON_ITEM is a cabinet-level document.
        if (unit && category !== 'NON_ITEM') {
            perPosting[unit] = (perPosting[unit] ?? 0) + total;
        }

        if (category === 'POSTING') {
            // A posting accrual is the net for that accrual and also attributes its
            // deductions as fee lines, so both are recorded per SKU: the sale side is
            // `net + |fees|`, and the fee side stands on its own.
            for (const product of row.posting?.products ?? []) {
                const sku = String(product.sku ?? '');
                if (!sku) continue;
                const entry = (perSku[sku] ??= { net: 0, fees: 0, units: 0 });
                entry.net += total;
                entry.fees += rowFees.reduce((sum, fee) => sum + fee.amount, 0);
                entry.units += Number(product.quantity ?? 0) || 0;
            }
        }
    }

    dailyNet[day] = dayNet;
    await new Promise((resolve) => setTimeout(resolve, 250));
}

const typeLines = Object.entries(byType)
    .map(([typeId, entry]) => ({
        typeId,
        name: typeNames[typeId] ?? `Тип ${typeId}`,
        net: entry.net,
        count: entry.count,
        categories: entry.categories
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

const result = {
    month,
    fetched: { days: days.length, daysEmpty, daysFailed, accruals: accrualCount },
    sumTotalAmount,
    byCategory,
    /**
     * Deductions attributed inside POSTING accruals. The sale commission is *not* among
     * them — it is netted into `total_amount` — which is why the implied commission is
     * derived by comparing with the realization report rather than read from a line here.
     */
    postingFeesAttributed: typeLines.reduce(
        (sum, line) => sum + (line.categories.POSTING ?? 0),
        0
    ),
    postingUnits: Object.keys(perPosting).length,
    perPostingNet: Object.values(perPosting).reduce((sum, value) => sum + value, 0),
    perSku,
    dailyNet,
    typeLines,
    typeNames,
    catalogueSize: catalogueList.length
};

writeFileSync(outPath, JSON.stringify(result, null, 1), 'utf8');
console.log(
    `месяц ${month}: дней ${days.length}, начислений ${accrualCount}, ` +
        `пустых дней ${daysEmpty}, ошибок ${daysFailed}`
);
console.log(`сумма total_amount: ${sumTotalAmount.toFixed(2)}`);
console.log(`типов начислений встретилось: ${typeLines.length} из справочника ${catalogueList.length}`);
console.log(`успешных отправлений: ${Object.keys(perPosting).length}`);
console.log(`\nпо категориям:`);
for (const [category, entry] of Object.entries(byCategory)) {
    console.log(`  ${category.padEnd(9)} ${entry.net.toFixed(2).padStart(12)}  (${entry.count} шт)`);
}
console.log(
    `услуги внутри POSTING: ${result.postingFeesAttributed.toFixed(2)}` +
        ` → продажная часть ${(byCategory.POSTING.net - result.postingFeesAttributed).toFixed(2)}`
);
console.log(`SKU с начислениями: ${Object.keys(perSku).length}`);
console.log(`\nтоп типов по сумме:`);
for (const line of typeLines.slice(0, 12)) {
    console.log(`  ${line.typeId.padStart(4)} ${line.name.slice(0, 42).padEnd(44)} ${line.net.toFixed(2).padStart(11)}`);
}
console.log(`\nwrote ${outPath}`);
