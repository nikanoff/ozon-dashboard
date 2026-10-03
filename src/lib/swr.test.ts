import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { peekCache, useSWR } from './swr';

/** Lets queued promise continuations run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useSWR', () => {
    it('caches the fetched payload under its key', async () => {
        const swr = useSWR('swr:ok', async () => 42, { revalidateOnFocus: false });

        await swr.mutate({ force: true });

        expect(peekCache<number>('swr:ok')).toBe(42);
        expect(get(swr.data)).toBe(42);
        expect(get(swr.isLoading)).toBe(false);
    });

    it('reports a failed request and keeps loading off', async () => {
        const failure = new Error('boom');
        const swr = useSWR(
            'swr:fail',
            async () => {
                throw failure;
            },
            { revalidateOnFocus: false }
        );

        await swr.mutate({ force: true });

        expect(get(swr.error)).toBe(failure);
        expect(get(swr.isLoading)).toBe(false);
        expect(peekCache('swr:fail')).toBeUndefined();
    });

    it('reset forgets the payload and goes back to the first-load state', async () => {
        const swr = useSWR('swr:reset', async () => 'payload', { revalidateOnFocus: false });
        await swr.mutate({ force: true });

        swr.reset();

        expect(peekCache('swr:reset')).toBeUndefined();
        expect(get(swr.data)).toBeUndefined();
        expect(get(swr.error)).toBeNull();
        expect(get(swr.isLoading)).toBe(true);
        expect(get(swr.isValidating)).toBe(false);
    });

    it('discards a response that arrives after reset', async () => {
        // A request that only settles when the test says so, standing in for a
        // slow load of the previous account.
        let release!: (value: string) => void;
        const gate = new Promise<string>((resolve) => {
            release = resolve;
        });

        const swr = useSWR('swr:late', () => gate, { revalidateOnFocus: false });

        swr.reset();
        release('previous account');
        await flush();

        expect(peekCache('swr:late')).toBeUndefined();
        expect(get(swr.data)).toBeUndefined();
    });

    it('loads normally after a reset', async () => {
        let value = 'first';
        const swr = useSWR('swr:after-reset', async () => value, { revalidateOnFocus: false });
        await swr.mutate({ force: true });

        swr.reset();
        value = 'second';
        await swr.mutate({ force: true });

        expect(get(swr.data)).toBe('second');
        expect(get(swr.isLoading)).toBe(false);
        expect(peekCache('swr:after-reset')).toBe('second');
    });

    it('shares one request between callers that mount with the same key', async () => {
        let calls = 0;
        let release!: () => void;

        const fetcher = async () => {
            calls += 1;
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return calls;
        };

        // Both components mount with the same key, so the second joins the first
        // request instead of issuing its own.
        useSWR('swr:dedupe', fetcher, { revalidateOnFocus: false, dedupingInterval: 0 });
        useSWR('swr:dedupe', fetcher, { revalidateOnFocus: false, dedupingInterval: 0 });

        expect(calls).toBe(1);

        release();
        await flush();

        expect(peekCache<number>('swr:dedupe')).toBe(1);
    });
});
