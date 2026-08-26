import { describe, it, expect, vi, beforeAll } from 'vitest';
import { loadNetworkModule } from './_harness.js';

let RTCPeer;
let WSPeer;

beforeAll(() => {
    ({ RTCPeer, WSPeer } = loadNetworkModule());
});

describe('BUG-03: failures to notify the peer are logged, not swallowed', () => {
    it('_transferFailed warns when channel.send() throws', () => {
        const peer = new RTCPeer(undefined, undefined, undefined);
        peer._awaitingComplete = true; // _isTransferInProgress() => true
        peer._channel = {
            readyState: 'open',
            send: () => { throw new Error('channel is closing'); },
        };
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        peer._transferFailed('stalled (no progress)');

        expect(warnSpy).toHaveBeenCalledWith(
            'RTC: failed to notify peer of transfer failure:',
            expect.any(Error),
            peer._peerId
        );
        warnSpy.mockRestore();
    });

    it('_onFileReadError (WSPeer fallback) warns when sendJSON() throws', () => {
        const peer = new WSPeer(undefined, undefined, undefined);
        peer.sendJSON = () => { throw new Error('socket is closed'); };
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        peer._onFileReadError({ name: 'NotReadableError' });

        expect(warnSpy).toHaveBeenCalledWith(
            'RTC: failed to notify peer of transfer failure:',
            expect.any(Error),
            peer._peerId
        );
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });
});
