window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);

class ServerConnection {

    constructor() {
        this._hiddenSince = 0;
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
        console.log('WS: network back online, forcing fresh signaling connection');
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
            console.log('WS: server connected');
            Events.fire('notify-user-hide'); // dismiss the persistent "offline" banner on reconnect
        };
        ws.onmessage = e => this._onMessage(e.data);
        ws.onclose = e => this._onDisconnect();
        ws.onerror = e => console.error(e);
        this._socket = ws;
    }

    _onMessage(msg) {
        try {
            msg = JSON.parse(msg);
        } catch (e) {
            console.error('Failed to parse WebSocket message:', e, msg);
            return; // Skip malformed message
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
                console.error('WS: unkown message type', msg);
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
        console.log('WS: server disconnected');
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
        this._busy = true;
        if (!this._filesQueue.length && this._cancel) {
            Events.fire('close-progress',{sender: this._peerId});
            this._sendCancelFile(this._peerId)
            return
        }
        
        // Check if queue is empty
        if (!this._filesQueue.length) {
            this._busy = false;
            return;
        }
        
        this._sendClearCancel()
        Events.fire('clear-cancel', {sender: this._peerId});
        this._cancel = false
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
        this._chunker = new FileChunker(file,
            chunk => {
                this._send(chunk)
            },
            offset => this._onPartitionEnd(offset));
        
        this._chunker.nextPartition();
    }
    //取消发送当前文件
    cancelSend() {
        this._cancel = true
        this._busy = false;
        this._dequeueFile();
    }

    _onPartitionEnd(offset) {
        if (this._chunker && this._chunker.isFileEnd()) {
            // File is completely sent, notify completion
            this.sendJSON({ type: 'transfer-complete', sender: this._currentSender });
            this._chunker = null;
            // Reset sender state for next file
            this._busy = false;
            this._stopTransferWatchdog();
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
                this._onDownloadProgress(message.progress);
                break;
            case 'transfer-complete':
                this._onTransferCompleted(sender);
                break;
            case 'cancel-send':
                Events.fire('close-progress', {recipient: this._peerId});
                break;
            case 'm-clear-cancel':
                Events.fire('clear-cancel', {recipient: this._peerId});
                break;
            case 'text':
                this._onTextReceived(message,sender);
                break;
        }
    }

    _onFileHeader(header, sender) {
        const iceInfo = this.getIceCandidateInfo();
        this._lastProgress = 0;
        this._digester = new FileDigester({
            name: header.name,
            mime: header.mime,
            size: header.size
        }, file => this._onFileReceived(file,header.sender));
    }

    _onChunkReceived(chunk) {
        if(!chunk.byteLength) return;
        this._markTransferActivity(); // data arriving => receive transfer is progressing
        this._digester.unchunk(chunk);
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

    _onTransferCompleted(sender) {
        this._onDownloadProgress(1);
        this._reader = null;
        this._busy = false;
        // Receiver doesn't need to dequeue files - that's sender's responsibility
        Events.fire('notify-user', jQuery.i18n.prop('transfer_completed_toast'));
    }

    sendText(text,sender) {
        const iceInfo = this.getIceCandidateInfo();
        const unescaped = btoa(unescape(encodeURIComponent(text)));
        const unescapedSender = btoa(unescape(encodeURIComponent(sender)));
        this.sendJSON({ type: 'text', text: unescaped, sender: unescapedSender});
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
        this._transferWatchdog = null;     // detects a stalled/failed transfer
        this._lastTransferActivity = 0;
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

    _connect(peerId, isCaller) {
        // Always (re)negotiate on a brand-new RTCPeerConnection — never re-offer on
        // a reused one. Re-offering on a connection that already carried a
        // negotiation throws "The order of m-lines in subsequent offer doesn't
        // match" and permanently wedges reconnection (only a page refresh recovers).
        this._openConnection(peerId, isCaller);

        if (isCaller) {
            this._openChannel();
        } else {
            this._conn.ondatachannel = e => this._onChannelOpened(e);
        }
    }

    _openConnection(peerId, isCaller) {
        // Tear down any previous connection first so we always start clean.
        if (this._conn) { try { this._conn.close(); } catch (e) {} }
        this._channel = null;
        this._isCaller = isCaller;
        // Perfect-negotiation roles: exactly one side is the caller, so use it
        // as a stable tie-breaker. The callee is the "polite" peer that yields
        // on a collision; the caller is "impolite" and keeps its own offer.
        this._isPolite = !isCaller;
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
            console.warn('RTC: Cannot create data channel - connection is closed');
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
                    console.warn('RTC: ignoring unexpected answer in state', this._conn.signalingState);
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
                console.warn('RTC: ignoring colliding offer (impolite peer)');
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
                .catch(e => console.warn('RTC: addIceCandidate failed:', e.message));
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
        this._reconnectAttempts = 0; // healthy again
    }

    _onChannelClosed() {
        this._channel = null;
        // Stop the flush watchdog and drop any half-sent queue so a later transfer
        // doesn't inherit stale chunks.
        this._clearFlushWatchdog();
        this._sendQueue = [];
        // If a file was mid-transfer, the connection just died under it — the
        // reconnect starts fresh and can't resume, so report the failure now.
        if (this._isTransferInProgress()) {
            this._transferFailed('connection lost');
        }
        // Only the caller re-initiates. Don't stack reconnects if one is running.
        if (!this._isCaller) return;
        if (this._isConnecting()) return;

        this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
        if (this._reconnectAttempts > RTCPeer.MAX_RECONNECT_ATTEMPTS) {
            // Peer is unreachable after several tries (e.g. it stayed backgrounded
            // or really went away): drop it from the list instead of retrying forever.
            Events.fire('peer-left', this._peerId);
            return;
        }
        // Reconnect on a brand-new connection (see _connect / _openConnection).
        this._connect(this._peerId, true);
    }

    _onBufferedAmountLow() {
        this._flushSendQueue();
    }

    _onConnectionStateChange(e) {
        
        switch (this._conn.connectionState) {
            case 'disconnected':
                // May still recover on its own; don't tear it down yet. If it
                // doesn't recover it progresses to 'failed' below.
                break;
            case 'failed':
                // Try to re-establish (fresh connection) a few times; give up and
                // remove the peer only after repeated failures (_onChannelClosed).
                this._onChannelClosed();
                break;
        }
    }

    _onIceConnectionStateChange() {
        switch (this._conn.iceConnectionState) {
            case 'failed':
                console.error('ICE failed for peer:', this._peerId, 'state:', this._conn.iceConnectionState);
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
                console.error('RTC: send error', e);
                this._sendQueue.unshift(message);
                this.refresh();
                return;
            }
        }
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
        const sending = !!this._chunker;
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
    _transferFailed(reason) {
        if (!this._isTransferInProgress()) { this._stopTransferWatchdog(); return; }
        console.warn('RTC: transfer failed -', reason, this._peerId);
        this._stopTransferWatchdog();
        // reset sender state
        this._chunker = null;
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
        if (this._isConnected() || this._isConnecting()) return;
        this._connect(this._peerId, this._isCaller);
    }

    _isConnected() {
        return this._channel && this._channel.readyState === 'open';
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
            console.warn('Peer not found:', peerId);
            return;
        }
        peer.send(message);
    }

    _onFilesSelected(message) {
        const peer = this.peers[message.to];
        if (!peer) {
            console.warn('Target peer not found for file transfer:', message.to);
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
            console.warn('Target peer not found for text message:', message.to);
            return;
        }
        if (!this._ensurePeerReady(peer)) return;
        peer.sendText(message.text,message.from);
    }

    // Returns true if the peer's data channel is open. Otherwise notifies the user,
    // triggers a reconnect, and returns false so the caller aborts (no silent hang).
    _ensurePeerReady(peer) {
        // WSPeer (fallback) has no data channel — always allow it through.
        if (typeof peer._isConnected !== 'function') return true;
        if (peer._isConnected()) return true;
        Events.fire('notify-user', jQuery.i18n.prop('notify_peer_unreachable'));
        if (typeof peer.refresh === 'function') peer.refresh();
        return false;
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        delete this.peers[peerId];
        if (!peer || !peer._conn) return;
        peer._conn.close();
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
            console.warn('Target peer not found for cancel send:', message.to);
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

    _onChunkRead(chunk) {
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
