window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);

class ServerConnection {

    constructor() {
        this._connect();
        Events.on('beforeunload', e => this._disconnect());
        Events.on('pagehide', e => this._disconnect());
        document.addEventListener('visibilitychange', e => this._onVisibilityChange());
    }

    _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._isConnected() || this._isConnecting()) return;
        const lastDisplayName = localStorage.getItem('displayname')
        const roomid = localStorage.getItem('roomnumber')?localStorage.getItem('roomnumber'):''
        Events.fire('room-display',roomid)
        const ws = lastDisplayName ? new WebSocket(this._endpoint()+'?lastDisplayName='+lastDisplayName+'&room='+roomid) : new WebSocket(this._endpoint()+'?room='+roomid)
       //const ws = lastDisplayName ?new WebSocket('ws://192.168.1.14:3000/server/webrtc?lastDisplayName='+encodeURIComponent(lastDisplayName)+'&room='+encodeURIComponent(roomid)):new WebSocket('ws://192.168.3.178:3000/server/webrtc?room='+encodeURIComponent(roomid))
        ws.binaryType = 'arraybuffer';
        ws.onopen = e => console.log('WS: server connected');
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
        Events.fire('notify-user', jQuery.i18n.prop('notify_connection_lost'));
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(_ => this._connect(), 5000);
    }

    _onVisibilityChange() {
        if (document.hidden) return;
        this._connect();
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
        this._lastProgress = 0;
        this._digester = new FileDigester({
            name: header.name,
            mime: header.mime,
            size: header.size
        }, file => this._onFileReceived(file,header.sender));
    }

    _onChunkReceived(chunk) {
        if(!chunk.byteLength) return;
        
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
        const unescaped = btoa(unescape(encodeURIComponent(text)));
        const unescapedSender = btoa(unescape(encodeURIComponent(sender)));
        this.sendJSON({ type: 'text', text: unescaped, sender: unescapedSender});
    }

    _onTextReceived(message,sender) {
        const escaped = decodeURIComponent(escape(atob(message.text)));
        const escapedSender = decodeURIComponent(escape(atob(sender)));
        Events.fire('text-received', { text: escaped, sender: escapedSender });
    }
}

class RTCPeer extends Peer {

    constructor(serverConnection, peerId, peerDisplayname) {
        super(serverConnection, peerId, peerDisplayname);
        this._sendQueue = [];
        this._isSendPaused = false;
        this._bufferedAmountLowThreshold = 1024 * 1024; // 1MB
        if (!peerId) return; // we will listen for a caller
        this._connect(peerId, true);
    }

    _connect(peerId, isCaller) {
        // Check if existing connection is closed and needs to be recreated
        if (this._conn && this._conn.signalingState === 'closed') {
            console.log('RTC: Connection is closed, creating new connection');
            this._conn = null;
        }
        
        if (!this._conn) this._openConnection(peerId, isCaller);

        if (isCaller) {
            this._openChannel();
        } else {
            this._conn.ondatachannel = e => this._onChannelOpened(e);
        }
    }

    _openConnection(peerId, isCaller) {
        this._isCaller = isCaller;
        this._peerId = peerId;
        this._conn = new RTCPeerConnection(RTCPeer.config);
        this._conn.onicecandidate = e => this._onIceCandidate(e);
        this._conn.onconnectionstatechange = e => this._onConnectionStateChange(e);
        this._conn.oniceconnectionstatechange = e => this._onIceConnectionStateChange(e);
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
        this._conn.createOffer().then(d => this._onDescription(d)).catch(e => this._onError(e));
    }

    _onDescription(description) {
        // description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
        this._conn.setLocalDescription(description)
            .then(_ => this._sendSignal({ sdp: description }))
            .catch(e => this._onError(e));
    }

    _onIceCandidate(event) {
        if (!event.candidate) return;
        this._sendSignal({ ice: event.candidate });
    }

    onServerMessage(message) {
        if (!this._conn) this._connect(message.sender, false);

        if (message.sdp) {
            this._conn.setRemoteDescription(new RTCSessionDescription(message.sdp))
                .then( _ => {
                    if (message.sdp.type === 'offer') {
                        return this._conn.createAnswer()
                            .then(d => this._onDescription(d));
                    }
                })
                .catch(e => this._onError(e));
        } else if (message.ice) {
            this._conn.addIceCandidate(new RTCIceCandidate(message.ice));
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
    }

    _onChannelClosed() {
        console.log('RTC: channel closed', this._peerId);
        if (!this._isCaller) return;
        
        // Only attempt to reconnect if the connection is not already closed
        if (this._conn && this._conn.signalingState !== 'closed') {
            console.log('RTC: Attempting to reconnect channel for', this._peerId);
            this._connect(this._peerId, true);
        } else {
            console.log('RTC: Connection is closed, cannot reconnect channel for', this._peerId);
        }
    }

    _onBufferedAmountLow() {
        console.log('RTC: buffered amount low, resuming sends');
        this._isSendPaused = false;
        
        // Send queued messages
        while (this._sendQueue.length > 0 && !this._isSendPaused) {
            const message = this._sendQueue.shift();
            if (this._channel.bufferedAmount > this._bufferedAmountLowThreshold) {
                this._sendQueue.unshift(message); // Put it back
                this._isSendPaused = true;
                break;
            }
            
            try {
                this._channel.send(message);
            } catch (e) {
                console.error('RTC: send error while flushing queue', e);
                this.refresh();
                break;
            }
        }
    }

    _onConnectionStateChange(e) {
        console.log('RTC: state changed:', this._conn.connectionState);
        switch (this._conn.connectionState) {
            case 'disconnected':
                this._onChannelClosed();
                break;
            case 'failed':
                this._conn = null;
                this._onChannelClosed();
                break;
        }
    }

    _onIceConnectionStateChange() {
        switch (this._conn.iceConnectionState) {
            case 'failed':
                console.error('ICE Gathering failed');
                break;
            default:
                console.log('ICE Gathering', this._conn.iceConnectionState);
        }
    }

    _onError(error) {
        console.error(error);
    }

    _send(message) {
        if (!this._channel) return this.refresh();
        
        // Check if we need to pause sending
        if (this._channel.bufferedAmount > this._bufferedAmountLowThreshold) {
            this._sendQueue.push(message);
            this._isSendPaused = true;
            return;
        }
        
        try {
            this._channel.send(message);
        } catch (e) {
            console.error('RTC: send error', e);
            this.refresh();
        }
    }

    _sendSignal(signal) {
        signal.type = 'signal';
        signal.to = this._peerId;
        this._server.send(signal);
    }

    refresh() {
        // check if channel is open. otherwise create one
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
    }

    _onMessage(message) {
        if (!this.peers[message.sender]) {
            this.peers[message.sender] = new RTCPeer(this._server);
        }
        this.peers[message.sender].onServerMessage(message);
    }

    _onPeers(msg) {
        const peers = msg.peers;
        peers.forEach(peer => {
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
        peer.sendFiles(message.files,message.sender);
    }

    _onSendText(message) {
        const peer = this.peers[message.to];
        if (!peer) {
            console.warn('Target peer not found for text message:', message.to);
            return;
        }
        peer.sendText(message.text,message.from);
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
        message.to = this._peerId;
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


RTCPeer.config = {
    'sdpSemantics': 'unified-plan',
    'iceServers': [
        {
            urls: 'stun:stun.l.google.com:19302',
        },
        {
            // Note: These are public TURN server credentials from openrelayproject
            // They are intentionally hardcoded for client-side WebRTC connectivity
            // While public, they should be monitored for potential abuse
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject",
        },
        {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject",
        },
        {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject",
        },
    ],
}
