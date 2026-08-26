import { describe, it, expect, beforeAll } from 'vitest';
import { loadNetworkModule } from './_harness.js';

let classifyFileReadError;
let reasonCodeToReceiverMessageKey;

beforeAll(() => {
    ({ classifyFileReadError, reasonCodeToReceiverMessageKey } = loadNetworkModule());
});

describe('classifyFileReadError', () => {
    it('BUG-02: maps NotReadableError to the file-changed messaging/reasonCode', () => {
        const error = { name: 'NotReadableError', message: 'boom' };
        expect(classifyFileReadError(error)).toEqual({
            messageKey: 'notify_file_changed',
            reasonCode: 'file-changed',
        });
    });

    it('BUG-02: does not mislabel other FileReader errors as file-changed', () => {
        for (const name of ['NotFoundError', 'SecurityError', 'AbortError', undefined]) {
            expect(classifyFileReadError({ name })).toEqual({
                messageKey: 'notify_transfer_failed',
                reasonCode: null,
            });
        }
    });

    it('handles a missing/null error object without throwing', () => {
        expect(classifyFileReadError(null)).toEqual({
            messageKey: 'notify_transfer_failed',
            reasonCode: null,
        });
    });
});

describe('reasonCodeToReceiverMessageKey', () => {
    it('maps file-changed to the receiver-phrased message', () => {
        expect(reasonCodeToReceiverMessageKey('file-changed')).toBe('notify_file_changed_remote');
    });

    it('falls back to the generic message for any other or missing reason', () => {
        expect(reasonCodeToReceiverMessageKey('something-else')).toBe('notify_transfer_failed');
        expect(reasonCodeToReceiverMessageKey(null)).toBe('notify_transfer_failed');
        expect(reasonCodeToReceiverMessageKey(undefined)).toBe('notify_transfer_failed');
    });
});
