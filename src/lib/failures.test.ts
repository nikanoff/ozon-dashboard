import { describe, expect, it } from 'vitest';
import { describeFailure, isProgrammingError } from './failures';

describe('describeFailure', () => {
    it('passes our own messages through', () => {
        expect(
            describeFailure(new Error('Укажите Client ID и API Key в настройках.'))
        ).toBe('Укажите Client ID и API Key в настройках.');
    });

    it('replaces a programming error with a sentence meant for the reader', () => {
        // The exact failure that reached the screen as raw text.
        const error = new ReferenceError(
            "can't access lexical declaration 'periodMonth' before initialization"
        );

        expect(describeFailure(error)).not.toContain('periodMonth');
        expect(describeFailure(error)).toContain('внутренн');
        expect(isProgrammingError(error)).toBe(true);
    });

    it('keeps a genuine upstream failure readable', () => {
        expect(describeFailure(new Error('Report was not found'))).toBe('Report was not found');
    });

    it('reports nothing when there is no error', () => {
        expect(describeFailure(null)).toBeNull();
        expect(describeFailure(undefined)).toBeNull();
        expect(describeFailure('')).toBeNull();
    });

    it('handles a thrown string', () => {
        expect(describeFailure('что-то пошло не так')).toBe('что-то пошло не так');
    });

    it('has something to say about an unrecognisable value', () => {
        expect(describeFailure({})).toContain('Повторите попытку');
        expect(describeFailure({ code: 16 })).toContain('Повторите попытку');
    });

    it('does not treat an ordinary error as a programming one', () => {
        expect(isProgrammingError(new Error('boom'))).toBe(false);
        expect(isProgrammingError(undefined)).toBe(false);
    });
});
