/**
 * Loads client/scripts/network.js (a classic, non-module browser script) into
 * an isolated vm context so its classes/functions can be unit tested directly
 * from Node, without needing jsdom or a real browser.
 *
 * Only a minimal `window` stub is provided — enough for the two top-level
 * statements in network.js to run without throwing. Nothing in the tests that
 * use this harness exercises RTCPeerConnection/FileReader/WebSocket directly,
 * so those are intentionally left undefined rather than faked.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadNetworkModule() {
    const source = readFileSync(
        path.join(__dirname, '..', 'client', 'scripts', 'network.js'),
        'utf8'
    );

    const sandbox = {
        window: {
            URL: undefined,
            webkitURL: undefined,
            RTCPeerConnection: undefined,
            mozRTCPeerConnection: undefined,
            webkitRTCPeerConnection: undefined,
            // Events.fire()/on() target these — stubbed as no-ops so code
            // paths that emit events (e.g. close-progress, notify-user) don't
            // throw. Tests assert on peer/module state, not on these events.
            dispatchEvent: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
        },
        CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
        // Stubbed so any incidental call resolves instead of throwing;
        // individual tests assert on real values, not this stub's output.
        jQuery: { i18n: { prop: key => key } },
        console,
    };

    // Forward these dynamically (not a snapshot taken at load time) so
    // vi.useFakeTimers()/vi.setSystemTime(), installed per-test *after* this
    // module is loaded once in beforeAll, still control timing behavior
    // (setInterval, Date.now()) inside the sandboxed code.
    for (const name of ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']) {
        Object.defineProperty(sandbox, name, {
            get: () => globalThis[name],
            configurable: true,
            enumerable: true,
        });
    }

    vm.createContext(sandbox);

    // Function declarations attach to the sandbox global automatically, but
    // `class` declarations don't — capture everything we need explicitly.
    const footer = `
;globalThis.__exports = {
    Peer, RTCPeer, WSPeer, FileChunker, FileDigester, Events,
    classifyFileReadError, reasonCodeToReceiverMessageKey,
};
`;
    vm.runInContext(source + footer, sandbox, { filename: 'network.js' });
    return sandbox.__exports;
}

export function loadUiNotifyHelpers() {
    const source = readFileSync(
        path.join(__dirname, '..', 'client', 'scripts', 'ui.js'),
        'utf8'
    );
    // ui.js has heavy DOM side effects at the top level (document.createElement,
    // window.location, navigator.userAgent, ...) that don't matter for these
    // two pure functions. Extract just their source text by brace-matching
    // instead of executing the whole file, so no DOM stubbing is needed.
    const extract = name => {
        const start = source.indexOf(`function ${name}(`);
        if (start === -1) throw new Error(`${name} not found in ui.js`);
        let depth = 0;
        let bodyStarted = false;
        let end = start;
        for (let i = start; i < source.length; i++) {
            const ch = source[i];
            if (ch === '{') { depth++; bodyStarted = true; }
            else if (ch === '}') {
                depth--;
                if (bodyStarted && depth === 0) { end = i + 1; break; }
            }
        }
        return source.slice(start, end);
    };

    const snippet = `${extract('notifyMessageText')}\n${extract('notifyDuration')}\nreturn { notifyMessageText, notifyDuration };`;
    return new Function(snippet)(); // eslint-disable-line no-new-func
}
