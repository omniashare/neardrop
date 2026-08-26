import { describe, it, expect, beforeAll } from 'vitest';
import { loadUiNotifyHelpers } from './_harness.js';

let notifyMessageText;
let notifyDuration;

beforeAll(() => {
    ({ notifyMessageText, notifyDuration } = loadUiNotifyHelpers());
});

describe('notify-user toast duration', () => {
    it('shows plain-string toasts for the routine 3s', () => {
        expect(notifyMessageText('Copied to clipboard')).toBe('Copied to clipboard');
        expect(notifyDuration('Copied to clipboard')).toBe(3000);
    });

    it('shows {message, isError: true} toasts for 7s', () => {
        const detail = { message: 'The file changed on disk...', isError: true };
        expect(notifyMessageText(detail)).toBe('The file changed on disk...');
        expect(notifyDuration(detail)).toBe(7000);
    });

    it('treats {message} without isError as a routine 3s toast', () => {
        const detail = { message: 'hello' };
        expect(notifyDuration(detail)).toBe(3000);
    });
});
