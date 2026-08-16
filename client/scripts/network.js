window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);

class ServerConnection {

    constructor() {
        this._hiddenSince = 0;
        this._lastReconnect = 0;
        this._connect();
        Events.on('beforeunload', e => this._disconnect());
        Events.on('pagehide', e => this._disconnect());
        Events.on('network-online', e => this._reconnect());
        document.addEventListener('visibilitychange', e => this._onVisibilityChange());
    }

    // Force a fresh signaling connection (used when the browser comes back
    // online). Re-opening the socket makes the server re-send the peer list, so
    // devices re-appear and RTC connections are renegotiated from scratch.
    _reconnect() {
        // Debounce: the browser's online/offline and visibilitychange events can
        // fire in bursts. Without this guard each burst tears the socket down and
        // reopens it, which thrashes the connection ("WebSocket is closed before
        // the connection is established") and triggers a storm of RTC renegotiation.
        const now = Date.now();
        if (this._lastReconnect && now - this._lastReconnect < 3000) return; // at most once / 3s
        this._lastReconnect = now;

        // Do NOT bail when a socket is stuck in CONNECTING: a connect initiated
        // while offline can hang in that state indefinitely and never transition,
        // which silently stops B from ever rejoining the server (A then never
        // shows B again). Since this only runs on an explicit 'online' event (or a
        // 10s+ tab refocus), tearing down the stale socket and rebuilding is safe.
        if (this._socket) {
            this._socket.onclose = null;
            try { this._socket.close(); } catch (e) {}
        }
        this._socket = null;
        clearTimeout(this._reconnectTimer);
        this._connect();
    }

    _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._isConnected() || this._isConnecting()) return;
        const lastDisplayName = localStorage.getItem('displayname')
        const roomid = localStorage.getItem('roomnumber')?localStorage.getItem('roomnumber'):''
        Events.fire('room-display',roomid)
        const ws = lastDisplayName ? new WebSocket(this._endpoint()+'?lastDisplayName='+lastDisplayName+'&room='+roomid) : new WebSocket(this._endpoint()+'?room='+roomid)
       //const ws = lastDisplayName ?new WebSocket('ws://localhost:3000/server/webrtc?lastDisplayName='+encodeURIComponent(lastDisplayName)+'&room='+encodeURIComponent(roomid)):new WebSocket('ws://localhost:3000/server/webrtc?room='+encodeURIComponent(roomid))
        ws.binaryType = 'arraybuffer';
        ws.onopen = e => {
            Events.fire('notify-user-hide');
        };
        ws.onmessage = e => this._onMessage(e.data);
        ws.onclose = e => this._onDisconnect();
        ws.onerror = e => {};
        this._socket = ws;
    }

    _onMessage(msg) {
        try {
            msg = JSON.parse(msg);
        } catch (e) {
            return;
        }
        
        switch (msg.type) {
            case 'peers':
              //  Events.fire('peers', msg.peers);
              Events.fire('peers', msg);
                break;
            case 'peer-joined':
                Events.fire('peer-joined', msg.peer);
                break;
            case 'peer-left':
                Events.fire('peer-left', msg.peerId);
                break;
            case 'signal':
                Events.fire('signal', msg);
                break;
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'display-name':
                Events.fire('display-name', msg);
                break;
            case 'peer-modify-name':
                Events.fire('peer-modify-name', msg.peer);
                break;
            default:
                break;
        }
    }

    send(message) {
        if (!this._isConnected()) return;
        this._socket.send(JSON.stringify(message));
    }

    _endpoint() {
        // hack to detect if deployment or development environment
        const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
        const webrtc = window.isRtcSupported ? '/webrtc' : '/fallback';
        const url = protocol + '://' + location.host + location.pathname + 'server' + webrtc;
        return url;
    }

    _disconnect() {
        this.send({ type: 'disconnect' });
        this._socket.onclose = null;
        this._socket.close();
    }

    _onDisconnect() {
        // Keep the "You are offline" banner visible until we reconnect, and clear
        // the discoverable-device list since those peers are no longer reachable.
        Events.fire('notify-user-persist', jQuery.i18n.prop('notify_offline'));
        Events.fire('clear-peers');
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(_ => this._connect(), 5000);
    }

    _onVisibilityChange() {
        if (document.hidden) {
            this._hiddenSince = Date.now();
            return;
        }
        const hiddenMs = this._hiddenSince ? Date.now() - this._hiddenSince : 0;
        this._hiddenSince = 0;
        // If the signaling socket died while hidden, reconnect.
        if (!this._isConnected()) { this._connect(); return; }
        // A tab backgrounded for a while may have been frozen by the browser, so
        // its peer connections can be silently dead even though the socket looks
        // open. Force a fresh signaling connection to rebuild everything.
        if (hiddenMs > 10000) this._reconnect();
    }

    _isConnected() {
        return this._socket && this._socket.readyState === this._socket.OPEN;
    }

    _isConnecting() {
        return this._socket && this._socket.readyState === this._socket.CONNECTING;
    }
}

class Peer {

    constructor(serverConnection, peerId, peerDisplayname) {
        this._server = serverConnection;
        this._peerId = peerId;
        this._peerDisplayname = peerDisplayname
        this._filesQueue = [];
        this._busy = false;
        this._cancel = false;
        this._ignoreNextComplete = false; // swallow a confirmation that races a cancel
        this._currentSender = null; // Track current sender for file transfers
    }

    sendJSON(message) {
        this._send(JSON.stringify(message));
    }

    sendFiles(files,sender) {
        // Store current sender for subsequent files in queue
        this._currentSender = sender;
        for (let i = 0; i < files.length; i++) {
            this._filesQueue.push(files[i]);
        }
        // Always try to dequeue if not busy, even if files were already in queue
        if (!this._busy) {
            this._dequeueFile(sender);
        }
    }

    _dequeueFile(sender) {
        // Check if queue is empty
        if (!this._filesQueue.length) {
            this._busy = false;
            return;
        }
        this._busy = true;

        this._sendClearCancel()
        Events.fire('clear-cancel', {sender: this._peerId});
        this._cancel = false
        // A new transfer starts here, so a leftover suppression flag from an
        // earlier cancel must not swallow this one's confirmation.
        this._ignoreNextComplete = false
        const file = this._filesQueue.shift();
        // Use provided sender or maintain the current sender context
        const fileSender = sender || this._currentSender;
        this._sendFile(file, fileSender);
    }
    //通知关闭传输
    _sendCancelFile(sender) {
        this.sendJSON({
            type: 'cancel-send',
            sender: sender
        });
    }
    //通知取消关闭传输
    _sendClearCancel() {
        this.sendJSON({
            type: 'm-clear-cancel'       
        });
    }
    _sendFile(file,sender) {
        if(!file) return
        this._markTransferActivity(); // start the stall watchdog for this transfer
        const iceInfo = this.getIceCandidateInfo();
        this.sendJSON({
            type: 'header',
            name: file.name,
            mime: file.type,
            size: file.size,
            sender: sender
        });
        this._lastUploadProgress = 0;
        this._chunker = new FileChunker(file,
            chunk => {
                this._send(chunk)
                this._onUploadProgress()
            },
            offset => this._onPartitionEnd(offset));

        this._chunker.nextPartition();
        Events.fire('transfer-started', { sender: this._peerId });
    }

    // The sender's ring used to move only when the receiver reported back, so a
    // transfer going nowhere looked exactly like one that hadn't started yet.
    // Drive it from our own offset instead. Capped below 1: reaching 1 resets the
    // ring, and all these bytes are only queued — the real completion still comes
    // from the receiver via _onTransferCompleted.
    _onUploadProgress() {
        if (!this._chunker) return;
        const progress = Math.min(this._chunker.progress, 0.99);
        if (progress - this._lastUploadProgress < 0.01) return;
        this._lastUploadProgress = progress;
        Events.fire('file-progress', { sender: this._peerId, progress: progress });
    }
    //取消发送当前文件
    cancelSend() {
        this._cancel = true
        // Actually stop pushing bytes. Just setting the flag isn't enough: the
        // chunker's read/send loop is self-driving and only checks _cancel at a
        // 1MB partition boundary, so the rest of the file (often all of it) would
        // still reach the receiver.
        if (this._chunker) {
            this._chunker.abort();
            this._chunker = null;
        }
        // Drop everything that hasn't left this device yet.
        this._filesQueue = [];
        this._currentSender = null;
        this._dropPendingSends();
        // Reset send state so the next transfer isn't blocked by a stale _busy,
        // and stop the stall watchdog — otherwise it sees a transfer that stopped
        // making progress and reports it as a failure 30s later.
        this._busy = false;
        this._awaitingComplete = false;
        this._ignoreNextComplete = true;
        this._stopWatchdogIfIdle();
        Events.fire('close-progress', { sender: this._peerId });
        this._sendCancelFile(this._peerId)
    }

    // Overridden by RTCPeer, which buffers outgoing chunks in a send queue.
    _dropPendingSends() {}

    // WSPeer has no stall watchdog; on RTCPeer only stop it when nothing else
    // (e.g. an incoming file from the same peer) is still running.
    _stopWatchdogIfIdle() {
        if (typeof this._stopTransferWatchdog !== 'function') return;
        if (!this._isTransferInProgress()) this._stopTransferWatchdog();
    }

    _onPartitionEnd(offset) {
        if (this._chunker && this._chunker.isFileEnd()) {
            // All bytes are queued. Tell the receiver, but keep the transfer marked
            // in-progress (awaiting confirmation) so that if delivery of these last
            // buffered/in-flight bytes fails, the stall watchdog still catches it.
            this.sendJSON({ type: 'transfer-complete', sender: this._currentSender });
            this._chunker = null;
            this._busy = false;
            this._awaitingComplete = true;
            this._markTransferActivity(); // keep the watchdog alive until confirmed
            this._dequeueFile(); // Continue with next file in queue
        } else {
            // Send partition info and wait for acknowledgment
            this.sendJSON({ type: 'partition', offset: offset });
        }
    }

    _onReceivedPartitionEnd(offset) {
        this.sendJSON({ type: 'partition-received', offset: offset });
    }

    _sendNextPartition() {
        if (!this._chunker || this._chunker.isFileEnd() || this._cancel) return;
        this._markTransferActivity(); // ack received => transfer is progressing
        this._chunker.nextPartition();
    }

    _sendProgress(progress) {
        //接收方的进度
        this.sendJSON({ type: 'progress', progress: progress });
    }

    _onMessage(message) {
        // Any inbound traffic — a chunk, an ack, a pong — proves someone is still
        // on the other end. This is the only evidence _isAlive() trusts, because
        // the channel's readyState keeps reading 'open' for tens of seconds after
        // a peer vanishes.
        this._lastInbound = Date.now();
        if (typeof message !== 'string') {
            this._onChunkReceived(message);
            return;
        }
        let sender = ''
        
        message = JSON.parse(message);
        if(message.sender){
            sender = message.sender
        }
        switch (message.type) {
            case 'header':
                this._onFileHeader(message,sender);
                break;
            case 'partition':
                this._onReceivedPartitionEnd(message);
                break;
            case 'partition-received':
                this._sendNextPartition();
                break;
            case 'progress':
                // While we're actively sending, our own offset drives the ring
                // (_onUploadProgress). Letting the peer's report through too would
                // make it jump backwards between the two sources.
                // _awaitingComplete covers the tail: our bytes are all queued and
                // the ring sits at 0.99, so letting the peer's catch-up reports in
                // would drag it backwards. _onTransferCompleted finishes it at 1.
                if (!this._chunker && !this._awaitingComplete) this._onDownloadProgress(message.progress);
                break;
            case 'transfer-complete':
                this._onTransferCompleted(sender);
                break;
            case 'transfer-failed':
                // The other side reported the transfer failed; abort locally too
                // (don't echo the notification back — false to avoid a ping-pong).
                this._transferFailed('remote reported failure', false);
                break;
            case 'cancel-send':
                this._onCancelReceived();
                break;
            case 'm-clear-cancel':
                Events.fire('clear-cancel', {recipient: this._peerId});
                break;
            case 'ping':
                this.sendJSON({ type: 'pong' });
                break;
            case 'pong':
                // Nothing to do — receiving it already refreshed _lastInbound.
                break;
            case 'text':
                this._onTextReceived(message,sender);
                break;
        }
    }

    // Overridden by RTCPeer. WSPeer relays through the signaling server, which
    // runs its own keepalive, so it has nothing extra to prove here.
    _isAlive() {
        return true;
    }

    _onFileHeader(header, sender) {
        const iceInfo = this.getIceCandidateInfo();
        this._lastProgress = 0;
        // An incoming file is a different transfer than the one we cancelled; its
        // completion must still be announced.
        this._ignoreNextComplete = false;
        this._digester = new FileDigester({
            name: header.name,
            mime: header.mime,
            size: header.size
        }, file => this._onFileReceived(file,header.sender));
    }

    _onChunkReceived(chunk) {
        if(!chunk.byteLength || !this._digester) return;
        this._markTransferActivity(); // data arriving => receive transfer is progressing
        this._digester.unchunk(chunk);
        // unchunk() may have completed the file and cleared _digester via its
        // callback (_onFileReceived). If so, we're done — nothing left to report.
        if (!this._digester) return;
        const progress = this._digester.progress;
        this._onDownloadProgress(progress);

        // occasionally notify sender about our progress 
        if (progress - this._lastProgress < 0.01) return;
        this._lastProgress = progress;
        this._sendProgress(progress);
    }

    _onDownloadProgress(progress) {
        Events.fire('file-progress', { sender: this._peerId, progress: progress });
    }

    _onFileReceived(proxyFile,sender) {
        this._digester = null;
        this._stopTransferWatchdog();
        Events.fire('file-received', {file:proxyFile, sender:sender});
        Events.fire('clear-cancel', {recipient: this._peerId});
        this.sendJSON({ type: 'transfer-complete' ,sender: sender});
    }

    // The sender cancelled: throw away what we've collected so far instead of
    // quietly finishing the file, and tell the user why the transfer vanished.
    _onCancelReceived() {
        const wasReceiving = !!this._digester;
        this._digester = null;
        this._lastProgress = 0;
        this._stopWatchdogIfIdle();
        Events.fire('close-progress', { recipient: this._peerId });
        // If the file already landed, the cancel just lost the race against the
        // last chunks — don't contradict the "transfer completed" toast.
        if (wasReceiving) {
            Events.fire('notify-user', jQuery.i18n.prop('notify_transfer_cancelled'));
        }
    }

    _onTransferCompleted(sender) {
        // If the receiver finished the file just before our cancel reached it, it
        // still confirms the transfer. Swallow that one stale confirmation instead
        // of announcing a transfer the user just cancelled as completed.
        if (this._ignoreNextComplete) {
            this._ignoreNextComplete = false;
            return;
        }
        this._onDownloadProgress(1);
        this._reader = null;
        this._busy = false;
        // Confirmation arrived: the transfer really landed. Clear the awaiting flag
        // and stop the stall watchdog (unless another file is still going out).
        this._awaitingComplete = false;
        if (!this._isTransferInProgress()) this._stopTransferWatchdog();
        // Receiver doesn't need to dequeue files - that's sender's responsibility
        Events.fire('notify-user', jQuery.i18n.prop('transfer_completed_toast'));
    }

    sendText(text,sender) {
        const iceInfo = this.getIceCandidateInfo();
        const unescaped = btoa(unescape(encodeURIComponent(text)));
        const unescapedSender = btoa(unescape(encodeURIComponent(sender)));
        this.sendJSON({ type: 'text', text: unescaped, sender: unescapedSender});
    }

    // The peer has been removed from the peer list for good. Drop any transfer
    // state so nothing keeps running on an object nobody tracks any more.
    // RTCPeer extends this to tear down its connection and timers.
    destroy() {
        this._destroyed = true;
        this._filesQueue = [];
        this._chunker = null;
        this._digester = null;
        this._busy = false;
    }

    _onTextReceived(message,sender) {
        const escaped = decodeURIComponent(escape(atob(message.text)));
        const escapedSender = decodeURIComponent(escape(atob(sender)));
        const iceInfo = this.getIceCandidateInfo();
        Events.fire('text-received', { text: escaped, sender: escapedSender });
    }
}

class RTCPeer extends Peer {

    constructor(serverConnection, peerId, peerDisplayname, isCaller = true) {
        super(serverConnection, peerId, peerDisplayname);
        this._sendQueue = [];
        this._flushWatchdog = null;
        this._reconnectTimer = null;
        this._disconnectTimer = null;
        this._reconnecting = false;
        this._transferWatchdog = null;     // detects a stalled/failed transfer
        this._lastTransferActivity = 0;
        this._awaitingComplete = false;    // sender finished pushing bytes, waiting for the receiver's confirmation
        // Keep this well BELOW the 1MB partition size so the send buffer never sits
        // right at the limit (which made the transfer depend on a single, sometimes-
        // missed 'bufferedamountlow' event and freeze mid-file).
        this._bufferedAmountLowThreshold = 256 * 1024; // 256KB
        if (!peerId) return;
        // Only the caller initiates the offer. A callee (peer created because an
        // incoming signal arrived) must wait for that offer instead of creating
        // its own, otherwise both sides createOffer() and setRemoteDescription()
        // fails with "Called in wrong state: stable" (WebRTC glare).
        if (isCaller) this._connect(peerId, true);
    }

    _connect(peerId, isCaller, isPolite) {
        if (this._destroyed) return;
        // Always (re)negotiate on a brand-new RTCPeerConnection — never re-offer on
        // a reused one. Re-offering on a connection that already carried a
        // negotiation throws "The order of m-lines in subsequent offer doesn't
        // match" and permanently wedges reconnection (only a page refresh recovers).
        this._reconnecting = true;
        this._disarmConnectTimers();
        this._openConnection(peerId, isCaller, isPolite);

        // Always capture incoming channels, even when we are the caller. When both
        // ends reconnect at the same time, perfect negotiation makes the polite
        // end yield and answer the other's offer — its own channel is then handed
        // to us via 'ondatachannel', not 'onopen'.
        this._conn.ondatachannel = e => this._onChannelOpened(e);

        if (isCaller) {
            this._openChannel();
        }
    }

    _openConnection(peerId, isCaller, isPolite) {
        // Tear down any previous connection first so we always start clean.
        if (this._conn) { try { this._conn.close(); } catch (e) {} }
        this._channel = null;
        this._isCaller = isCaller;
        // Perfect-negotiation roles. Exactly one side must stay "impolite" for
        // simultaneous reconnects to resolve cleanly: the impolite peer keeps its
        // own offer on a collision, the polite peer rolls back and yields.
        // The role is decided ONCE when the peer is first created and then kept
        // across reconnects, so both ends never agree on the wrong answer.
        this._isPolite = isPolite !== undefined ? isPolite : !isCaller;
        this._makingOffer = false;
        this._peerId = peerId;
        this._conn = new RTCPeerConnection(RTCPeer.config);
        this._conn.onicecandidate = e => this._onIceCandidate(e);
        this._conn.onconnectionstatechange = e => this._onConnectionStateChange(e);
        this._conn.oniceconnectionstatechange = e => this._onIceConnectionStateChange(e);
        
    }

    getIceCandidateInfo() {
        if (!this._conn) return null;
        try {
            const selectedPair = this._conn.getSenders()[0]?.transport?.iceTransport?.getSelectedCandidatePair();
            if (selectedPair) {
                return {
                    local: {
                        type: selectedPair.local?.type,
                        protocol: selectedPair.local?.protocol,
                        address: selectedPair.local?.address,
                        port: selectedPair.local?.port,
                    },
                    remote: {
                        type: selectedPair.remote?.type,
                        protocol: selectedPair.remote?.protocol,
                        address: selectedPair.remote?.address,
                        port: selectedPair.remote?.port,
                    },
                    state: selectedPair.state,
                };
            }
        } catch (e) {}
        return null;
    }

    _openChannel() {
        // Check if connection is still open before creating data channel
        if (!this._conn || this._conn.signalingState === 'closed') {
            return;
        }
        
        const channel = this._conn.createDataChannel('data-channel', { 
            ordered: true,
            reliable: true // Obsolete. See https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/reliable
        });
        channel.onopen = e => this._onChannelOpened(e);
        this._makingOffer = true;
        this._conn.createOffer()
            .then(d => this._onDescription(d))
            .catch(e => { this._makingOffer = false; this._onError(e); });
    }

    _onDescription(description) {
        // description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
        this._conn.setLocalDescription(description)
            .then(_ => { this._makingOffer = false; this._sendSignal({ sdp: description }); })
            .catch(e => { this._makingOffer = false; this._onError(e); });
    }

    onServerMessage(message) {
        // (Re)build a fresh connection as the callee when we have none, or when a
        // new offer arrives while our current connection is dead (a reconnect).
        // Answering on a stale connection causes the "m-lines order" error.
        const isOffer = message.sdp && message.sdp.type === 'offer';
        const dead = this._conn && (this._conn.connectionState === 'failed' || this._conn.connectionState === 'closed' || this._conn.signalingState === 'closed');
        if (!this._conn || (isOffer && dead)) {
            this._connect(message.sender, false);
        }

        if (message.sdp) {
            const desc = message.sdp;

            // --- Perfect negotiation: make renegotiation glare-safe ---
            // Without this, an offer/answer that arrives on an already-connected
            // ('stable') connection — reverse transfer, reconnect, or simultaneous
            // offers — throws "Called in wrong state: stable".
            if (desc.type === 'answer') {
                // Only apply an answer we are actually waiting for. A late or
                // duplicate answer while 'stable' would throw.
                if (this._conn.signalingState !== 'have-local-offer') {
                    return;
                }
                this._conn.setRemoteDescription(new RTCSessionDescription(desc))
                    .catch(e => this._onError(e));
                return;
            }

            // desc.type === 'offer'
            const collision = this._makingOffer || this._conn.signalingState !== 'stable';
            if (collision && !this._isPolite) {
                // Impolite peer keeps its own offer and ignores the colliding one.
                return;
            }
            const prepare = collision
                ? this._conn.setLocalDescription({ type: 'rollback' }).catch(() => {})
                : Promise.resolve();
            prepare
                .then(() => this._conn.setRemoteDescription(new RTCSessionDescription(desc)))
                .then(() => this._conn.createAnswer())
                .then(d => this._onDescription(d))
                .catch(e => this._onError(e));

        } else if (message.ice) {
            // Ignore ICE errors: candidates for an offer we dropped are expected.
            this._conn.addIceCandidate(new RTCIceCandidate(message.ice))
                .catch(e => {});
        }
    }

    _onChannelOpened(event) {
        const channel = event.channel || event.target;
        channel.binaryType = 'arraybuffer';
        channel.onmessage = e => this._onMessage(e.data);
        channel.onclose = e => this._onChannelClosed();
        channel.bufferedAmountLowThreshold = this._bufferedAmountLowThreshold;
        channel.onbufferedamountlow = e => this._onBufferedAmountLow();
        this._channel = channel;
        this._reconnecting = false;
        this._disarmConnectTimers();
        this._reconnectAttempts = 0; // healthy again
        this._startHeartbeat();
        // A sticky "reconnecting" notice (if shown) should disappear now that the
        // peer is reachable again.
        Events.fire('notify-user-hide');
    }

    // Keeps a trickle of traffic going while idle so _lastInbound stays meaningful.
    // During a transfer the acks and progress reports refresh it on their own, so
    // these pings only matter between transfers — which is exactly when the send
    // path needs to know whether the peer is still there.
    _startHeartbeat() {
        this._stopHeartbeat();
        // Nothing has had a chance to answer yet; assume alive until proven otherwise.
        this._lastInbound = Date.now();
        this._heartbeatTimer = setInterval(() => {
            if (!this._isConnected()) return;
            // Data in flight already proves liveness; don't add pings to a queue
            // that's busy carrying chunks.
            if (this._isTransferInProgress()) return;
            this.sendJSON({ type: 'ping' });
        }, RTCPeer.HEARTBEAT_INTERVAL);
    }

    _stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    _onChannelClosed() {
        if (this._destroyed) return;
        this._channel = null;
        this._stopHeartbeat();
        // Stop the flush watchdog and drop any half-sent queue so a later transfer
        // doesn't inherit stale chunks.
        this._clearFlushWatchdog();
        this._sendQueue = [];
        // If a file was mid-transfer, the connection just died under it — the
        // reconnect starts fresh and can't resume, so report the failure now.
        if (this._isTransferInProgress()) {
            this._transferFailed('connection lost');
        }
        // Reconnect regardless of our caller/callee role, otherwise a dead callee
        // would sit forever waiting for an offer that never comes. The perfect-
        // negotiation role saved in _isPolite resolves any simultaneous offers.
        // Don't stack reconnects if one is already running.
        if (this._reconnecting) return;
        if (this._isConnected()) return;

        this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
        if (this._reconnectAttempts > RTCPeer.MAX_RECONNECT_ATTEMPTS) {
            // Peer is unreachable after several tries (e.g. it stayed backgrounded
            // or really went away): drop it from the list instead of retrying forever.
            Events.fire('peer-left', this._peerId);
            // A persistent "reconnecting" notice can no longer be fulfilled by
            // automation (the peer is gone for good), so stop showing it and tell
            // the user to refresh instead of leaving a stale hint up forever.
            Events.fire('notify-user-hide');
            Events.fire('notify-user-persist', jQuery.i18n.prop('notify_peer_lost'));
            return;
        }
        // The caller reconnects immediately; the callee waits a moment so the
        // caller's offer usually arrives first and we avoid needless glare. If no
        // offer comes, the callee drives the reconnection itself.
        const delay = this._isCaller ? 0 : RTCPeer.CALLEE_RECONNECT_DELAY;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            // The caller's offer may have arrived during our wait and already
            // rebuilt the connection (via onServerMessage). Don't stack a second
            // connection on top of it.
            if (this._reconnecting || this._isConnected()) return;
            // Reconnect on a brand-new connection (see _connect / _openConnection),
            // opening our own channel and keeping our settled perfect-negotiation role.
            this._connect(this._peerId, true, this._isPolite);
        }, delay);
    }

    _armDisconnectTimer() {
        // 'disconnected' often never recovers on its own (NAT timeout, VPN switch,
        // backgrounded tab). Give it a short grace period, then force the same
        // reconnect path instead of hanging on "Reconnecting…" indefinitely.
        if (this._disconnectTimer) return;
        this._disconnectTimer = setTimeout(() => {
            this._disconnectTimer = null;
            if (!this._isConnected() && !this._isConnecting()) {
                this._reconnecting = false;
                this._onChannelClosed();
            }
        }, RTCPeer.DISCONNECTED_GRACE_PERIOD);
    }

    _disarmConnectTimers() {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = null;
    }

    _onBufferedAmountLow() {
        this._flushSendQueue();
    }

    _onConnectionStateChange(e) {
        
        switch (this._conn.connectionState) {
            case 'disconnected':
                // May still recover on its own; arm a watchdog that gives up on it.
                this._armDisconnectTimer();
                break;
            case 'connected':
                this._disarmConnectTimers();
                this._reconnectAttempts = 0;
                break;
            case 'failed':
                // The reconnection attempt itself failed: clear the in-flight flag
                // (it was set by _connect) so _onChannelClosed is allowed to
                // schedule the next retry instead of dead-locking on the guard.
                this._reconnecting = false;
                this._disarmConnectTimers();
                // Try to re-establish (fresh connection) a few times; give up and
                // remove the peer only after repeated failures (_onChannelClosed).
                this._onChannelClosed();
                break;
        }
    }

    _onIceConnectionStateChange() {
        switch (this._conn.iceConnectionState) {
            case 'failed':
                break;
            case 'connected':
                break;
            case 'checking':
                break;
            case 'completed':
                break;
            default:
        }
    }

    _onIceCandidate(event) {
        if (!event.candidate) {
            return;
        }
        const c = event.candidate;
        this._sendSignal({ ice: event.candidate });
    }

    _onError(error) {
        console.error(error);
    }

    _send(message) {
        if (!this._channel) return this.refresh();
        // Single ordered path: always enqueue, then drain as the buffer allows.
        // Keeps data chunks and control messages (header/partition/complete) in order.
        this._sendQueue.push(message);
        this._flushSendQueue();
    }

    // Drains the send queue while the buffer has room. Driven by _send(), by the
    // 'bufferedamountlow' event, and by a watchdog — so a single missed event can
    // no longer wedge the transfer.
    _flushSendQueue() {
        if (!this._channel || this._channel.readyState !== 'open') return;
        while (this._sendQueue.length > 0) {
            if (this._channel.bufferedAmount > this._bufferedAmountLowThreshold) {
                // Buffer is full: wait for it to drain. Arm a watchdog in case the
                // 'bufferedamountlow' event never fires (a known Chromium flake).
                this._armFlushWatchdog();
                return;
            }
            const message = this._sendQueue.shift();
            try {
                this._channel.send(message);
            } catch (e) {
                this._sendQueue.unshift(message);
                this.refresh();
                return;
            }
        }
        this._clearFlushWatchdog();
    }

    // Chunks that are still queued here never reached the data channel, so a
    // cancel can drop them outright.
    _dropPendingSends() {
        this._sendQueue = [];
        this._clearFlushWatchdog();
    }

    _armFlushWatchdog() {
        if (this._flushWatchdog) return;
        this._flushWatchdog = setInterval(() => {
            if (!this._channel || this._channel.readyState !== 'open') {
                this._clearFlushWatchdog();
                return;
            }
            if (this._channel.bufferedAmount <= this._bufferedAmountLowThreshold) {
                this._flushSendQueue();
            }
        }, 200);
    }

    _clearFlushWatchdog() {
        if (this._flushWatchdog) {
            clearInterval(this._flushWatchdog);
            this._flushWatchdog = null;
        }
    }

    // ---- Transfer stall/failure detection ----
    _isTransferInProgress() {
        // "sending" stays true after the last byte is queued until the receiver
        // confirms it got everything — bytes may still be buffered/in-flight, so a
        // failure in that window must still be caught.
        const sending = !!this._chunker || this._awaitingComplete;
        const receiving = !!(this._digester && this._digester._bytesReceived < this._digester._size);
        return sending || receiving;
    }

    // Called whenever a transfer makes progress (file start, partition ack, chunk
    // received). Refreshes the deadline and (re)arms the stall watchdog.
    _markTransferActivity() {
        this._lastTransferActivity = Date.now();
        if (this._transferWatchdog) return;
        this._transferWatchdog = setInterval(() => {
            if (!this._isTransferInProgress()) { this._stopTransferWatchdog(); return; }
            if (Date.now() - this._lastTransferActivity > RTCPeer.TRANSFER_STALL_TIMEOUT) {
                this._transferFailed('stalled (no progress)');
            }
        }, 2000);
    }

    _stopTransferWatchdog() {
        if (this._transferWatchdog) {
            clearInterval(this._transferWatchdog);
            this._transferWatchdog = null;
        }
    }

    // Abort the current transfer, reset send/receive state, clear the progress UI
    // and tell the user it failed.
    _transferFailed(reason, notifyPeer = true) {
        if (!this._isTransferInProgress()) { this._stopTransferWatchdog(); return; }
        console.warn('RTC: transfer failed -', reason, this._peerId);
        this._stopTransferWatchdog();
        // Best-effort: tell the other side so it also aborts and shows the failure,
        // instead of waiting out its own 30s stall timeout. If the channel is dead
        // this simply no-ops and each side falls back to its own watchdog.
        if (notifyPeer && this._channel && this._channel.readyState === 'open') {
            try { this._channel.send(JSON.stringify({ type: 'transfer-failed' })); } catch (e) {}
        }
        // reset sender state
        this._chunker = null;
        this._awaitingComplete = false;
        this._busy = false;
        this._filesQueue = [];
        // reset receiver state
        this._digester = null;
        this._lastProgress = 0;
        // reset the progress ring and notify the user
        Events.fire('close-progress', { sender: this._peerId, recipient: this._peerId });
        Events.fire('notify-user', jQuery.i18n.prop('notify_transfer_failed'));
    }

    _sendSignal(signal) {
        signal.type = 'signal';
        signal.to = this._peerId;
        if (signal.ice) {
        } else if (signal.sdp) {
        }
        this._server.send(signal);
    }

    refresh() {
        if (this._destroyed) return;
        if (this._isConnected()) return;
        // A data channel stuck in 'connecting' has the same dead-end symptom as a
        // closed one (nothing will ever transition it). Force a fresh connection
        // instead of returning early — that early-return is what left users stuck
        // on "Reconnecting…" forever.
        if (this._reconnecting) return; // a reconnect is already underway
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        this._reconnecting = true;
        this._connect(this._peerId, true, this._isPolite);
    }

    // Closing _conn also closes its data channel, which fires channel.onclose ->
    // _onChannelClosed -> another scheduled _connect. Detach the handler and stop
    // every timer first, otherwise a peer that was just removed from the list
    // lives on as an orphan: rebuilding connections, re-offering to a peer id the
    // server no longer knows, and eventually posting a bogus "connection lost,
    // refresh the page" notice while everything else works fine.
    destroy() {
        super.destroy();
        this._disarmConnectTimers();
        this._clearFlushWatchdog();
        this._stopTransferWatchdog();
        this._stopHeartbeat();
        this._sendQueue = [];
        if (this._channel) {
            this._channel.onclose = null;
            try { this._channel.close(); } catch (e) {}
        }
        this._channel = null;
        if (this._conn) { try { this._conn.close(); } catch (e) {} }
        this._conn = null;
    }

    _isConnected() {
        return this._channel && this._channel.readyState === 'open';
    }

    // Deliberately NOT folded into _isConnected(). That one gates the whole
    // reconnect machinery, and making it depend on traffic freshness would have it
    // tear down and rebuild connections on every hiccup. Only the send path asks
    // this stricter question.
    _isAlive() {
        if (!this._isConnected()) return false;
        // A transfer already in flight has its own stall watchdog; don't second-
        // guess it here. Pings queue behind file data, so on a slow link
        // _lastInbound can go stale while everything is in fact still working —
        // rejecting a second file in that window would be a false alarm.
        if (this._isTransferInProgress()) return true;
        if (!this._lastInbound) return true; // channel just opened, no round trip yet
        return Date.now() - this._lastInbound < RTCPeer.PEER_SILENCE_TIMEOUT;
    }

    _isConnecting() {
        return this._channel && this._channel.readyState === 'connecting';
    }
}

class PeersManager {

    constructor(serverConnection) {
        this.peers = {};
        this._server = serverConnection;
        Events.on('signal', e => this._onMessage(e.detail));
        Events.on('peers', e => this._onPeers(e.detail));
        Events.on('files-selected', e => this._onFilesSelected(e.detail));
        Events.on('send-text', e => this._onSendText(e.detail));
        Events.on('peer-left', e => this._onPeerLeft(e.detail));
        Events.on('peer-name',e => this._onModifyName(e.detail))
        Events.on('cancel-send',e => this._onCancelSend(e.detail))
        Events.on('clear-peers', e => this._clearAllPeers())
    }

    // Drop every peer connection (e.g. when the server link goes down). The
    // fresh 'peers' list on reconnect will rebuild them.
    _clearAllPeers() {
        Object.keys(this.peers).forEach(id => this._onPeerLeft(id));
        this.peers = {};
    }

    _onMessage(message) {
        if (!this.peers[message.sender]) {
            if (window.isRtcSupported) {
                // Created in response to an incoming signal => we are the callee.
                // Pass isCaller=false so onServerMessage() sets up the connection
                // as the answerer instead of firing a competing offer.
                this.peers[message.sender] = new RTCPeer(this._server, message.sender, '', false);
            } else {
                this.peers[message.sender] = new WSPeer(this._server, message.sender, '');
            }
        }
        // WSPeer没有onServerMessage方法，跳过信号消息
        if (typeof this.peers[message.sender].onServerMessage === 'function') {
            this.peers[message.sender].onServerMessage(message);
        }
    }

    _onPeers(msg) {
        const peers = msg.peers;
        const self = msg.currentPeerInfo;
        peers.forEach(peer => {
            // Skip ourselves — a stale self-connection the server may still list
            // right after a reconnect. Don't open an RTC connection to self.
            if (self && JSON.stringify(peer.name) === JSON.stringify(self)) return;
            if (this.peers[peer.id]) {
                // this.peers[peer.id].refresh();
                // return;

                // Delete conn, will re-create the conn later...
                this._onPeerLeft(peer.id)
            }
            if (window.isRtcSupported && peer.rtcSupported) {
                this.peers[peer.id] = new RTCPeer(this._server, peer.id, peer.name.displayName);
            } else {
                this.peers[peer.id] = new WSPeer(this._server, peer.id, peer.name.displayName);
            }
        })
    }

    sendTo(peerId, message) {
        const peer = this.peers[peerId];
        if (!peer) {
            return;
        }
        peer.send(message);
    }

    _onFilesSelected(message) {
        const peer = this.peers[message.to];
        if (!peer) {
            return;
        }
        // Don't feed a file into a dead data channel (it would silently hang).
        // Tell the user and kick off a reconnect instead.
        if (!this._ensurePeerReady(peer)) return;
        peer.sendFiles(message.files,message.sender);
    }

    _onSendText(message) {
        const peer = this.peers[message.to];
        if (!peer) {
            return;
        }
        if (!this._ensurePeerReady(peer)) return;
        peer.sendText(message.text,message.from);
    }

    // Returns true if the peer's data channel is open. Otherwise resets the UI,
    // shows a sticky "reconnecting" notice, triggers a reconnect, and returns
    // false so the caller aborts (no silent hang, no phantom cancel button).
    _ensurePeerReady(peer) {
        // WSPeer (fallback) has no data channel — always allow it through.
        if (typeof peer._isConnected !== 'function') return true;
        // _isAlive(), not _isConnected(): a channel still reading 'open' whose peer
        // went silent would otherwise swallow the file and show nothing for 30s,
        // until the stall watchdog finally reported a failure.
        if (peer._isAlive()) return true;
        // The UI already shows the cancel button / progress ring for this transfer
        // (it renders on file selection). Since nothing will be sent, undo that
        // state so the peer card goes back to idle instead of "stuck at 0%".
        Events.fire('close-progress', { sender: peer._peerId });
        // A sticky notice that stays until the channel reopens, not a 3s toast
        // the user easily misses. Hidden again in _onChannelOpened.
        Events.fire('notify-user-persist', jQuery.i18n.prop('notify_peer_unreachable'));
        if (typeof peer.refresh === 'function') peer.refresh();
        return false;
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        delete this.peers[peerId];
        if (!peer) return;
        // Full teardown, not just _conn.close(): closing the connection alone
        // leaves this object's timers running and re-triggers its own reconnect.
        peer.destroy();
    }

    //修改peer的名字
    _onModifyName(name) {
        const message = {displayName: name}
        this._server.send(message)
    }

    //取消发送
    _onCancelSend(message) {
        const peer = this.peers[message.to];
        if (!peer) {
            return;
        }
        peer.cancelSend()
    }

}

class WSPeer extends Peer {
    
    constructor(serverConnection, peerId, peerDisplayname) {
        super(serverConnection, peerId, peerDisplayname);
    }

    _send(message) {
        if (typeof message === 'string') {
            const msgObj = JSON.parse(message);
            msgObj.to = this._peerId;
            message = JSON.stringify(msgObj);
        } else {
            message.to = this._peerId;
        }
        this._server.send(message);
    }
}

class FileChunker {

    constructor(file, onChunk, onPartitionEnd) {
        this._chunkSize = 64000; // 64 KB
        this._maxPartitionSize = 1e6; // 1 MB
        this._offset = 0;
        this._partitionSize = 0;
        this._file = file;
        this._onChunk = onChunk;
        this._onPartitionEnd = onPartitionEnd;
        this._aborted = false;
        this._reader = new FileReader();
        this._reader.addEventListener('load', e => this._onChunkRead(e.target.result));
    }

    nextPartition() {
        this._partitionSize = 0;
        this._readChunk();
    }

    _readChunk() {
        const chunk = this._file.slice(this._offset, this._offset + this._chunkSize);
        this._reader.readAsArrayBuffer(chunk);
    }

    // Stop the read/send loop. The guard in _onChunkRead matters as much as
    // reader.abort(): a read that already finished has its 'load' event queued
    // and would otherwise push one more chunk (and possibly signal file-end).
    abort() {
        this._aborted = true;
        try { this._reader.abort(); } catch (e) {}
    }

    _onChunkRead(chunk) {
        if (this._aborted) return;
        this._offset += chunk.byteLength;
        this._partitionSize += chunk.byteLength;
        this._onChunk(chunk);
        if (this.isFileEnd()) {
            // Notify that file is completely sent
            this._onPartitionEnd(this._offset);
            return;
        }
        if (this._isPartitionEnd()) {
            this._onPartitionEnd(this._offset);
            return;
        }
        this._readChunk();
    }

    repeatPartition() {
        this._offset -= this._partitionSize;
        this._nextPartition();
    }

    _isPartitionEnd() {
        return this._partitionSize >= this._maxPartitionSize;
    }

    isFileEnd() {
        return this._offset >= this._file.size;
    }

    get progress() {
        return this._offset / this._file.size;
    }
}

class FileDigester {

    constructor(meta, callback) {
        this._buffer = [];
        this._bytesReceived = 0;
        this._size = meta.size;
        this._mime = meta.mime || 'application/octet-stream';
        this._name = meta.name;
        this._callback = callback;
    }

    unchunk(chunk) {
        this._buffer.push(chunk);
        this._bytesReceived += chunk.byteLength || chunk.size;
        const totalChunks = this._buffer.length;
        this.progress = this._bytesReceived / this._size;
        if (isNaN(this.progress)) this.progress = 1

        if (this._bytesReceived < this._size) return;
        // we are done
        let blob = new Blob(this._buffer, { type: this._mime });
        this._callback({
            name: this._name,
            mime: this._mime,
            size: this._size,
            blob: blob
        });
    }

}

class Events {
    static fire(type, detail) {
        window.dispatchEvent(new CustomEvent(type, { detail: detail }));
    }

    static on(type, callback) {
        return window.addEventListener(type, callback, false);
    }

    static off(type, callback) {
        return window.removeEventListener(type, callback, false);
    }
}

RTCPeer.MAX_RECONNECT_ATTEMPTS = 5;
RTCPeer.HEARTBEAT_INTERVAL = 5000;      // ms between idle pings on the data channel
RTCPeer.PEER_SILENCE_TIMEOUT = 15000;   // ms without any inbound traffic => treat the peer as gone
RTCPeer.CALLEE_RECONNECT_DELAY = 1500; // ms the callee waits before driving a reconnect itself
RTCPeer.DISCONNECTED_GRACE_PERIOD = 5000; // ms a 'disconnected' state is given to recover before forcing a reconnect
RTCPeer.TRANSFER_STALL_TIMEOUT = 30000; // ms with no progress => transfer failed
RTCPeer.config = {
    'sdpSemantics': 'unified-plan',
    'iceServers': [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: "turn:free.expressturn.com:3478",
            username: "000000002091239258",
            credential: "N+KIX4PNnYDxKKJfrAuzRpAoWwQ=",
        },
    ],
}
