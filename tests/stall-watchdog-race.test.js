import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { loadNetworkModule } from './_harness.js';

let RTCPeer;

beforeAll(() => {
    ({ RTCPeer } = loadNetworkModule());
});

afterEach(() => {
    vi.useRealTimers();
});

// A falsy peerId makes the RTCPeer constructor return immediately after basic
// field setup (no RTCPeerConnection is ever created), so this is safe to
// construct directly in Node.
function makeIdlePeer() {
    const peer = new RTCPeer(undefined, undefined, undefined);
    peer._awaitingComplete = true; // => _isTransferInProgress() reads true
    return peer;
}

describe('RTCPeer stall watchdog', () => {
    it('BUG-01: does not fail a transfer that resumed while getIceCandidateInfo() was pending', async () => {
        vi.useFakeTimers();
        const peer = makeIdlePeer();
        peer._transferFailed = vi.fn();

        // Simulates activity resuming (e.g. a chunk arrived) *during* the
        // getStats() await, by updating the timestamp as part of that same
        // promise's own resolution — deterministic without racing real time.
        peer.getIceCandidateInfo = () => Promise.resolve().then(() => {
            peer._lastTransferActivity = Date.now();
            return { local: {}, remote: {}, state: 'succeeded' };
        });

        const t0 = Date.now();
        peer._markTransferActivity(); // arms the watchdog, _lastTransferActivity = t0
        vi.setSystemTime(t0 + RTCPeer.TRANSFER_STALL_TIMEOUT + 1);

        await vi.advanceTimersByTimeAsync(2000);

        expect(peer._transferFailed).not.toHaveBeenCalled();
        peer._stopTransferWatchdog();
    });

    it('still fails a transfer that is genuinely still stalled after the await', async () => {
        vi.useFakeTimers();
        const peer = makeIdlePeer();
        peer._transferFailed = vi.fn();
        // No activity update this time — still stalled when the await resolves.
        peer.getIceCandidateInfo = () => Promise.resolve({ local: {}, remote: {}, state: 'succeeded' });

        const t0 = Date.now();
        peer._markTransferActivity();
        vi.setSystemTime(t0 + RTCPeer.TRANSFER_STALL_TIMEOUT + 1);

        await vi.advanceTimersByTimeAsync(2000);

        expect(peer._transferFailed).toHaveBeenCalledWith('stalled (no progress)');
        peer._stopTransferWatchdog();
    });
});
