const $ = query => document.getElementById(query);
const $$ = query => document.body.querySelector(query);
const isURL = text => /^((https?:\/\/|www)[^\s]+)/g.test(text.toLowerCase());
window.isDownloadSupported = (typeof document.createElement('a').download !== 'undefined');
window.isProductionEnvironment = !window.location.host.startsWith('localhost');
window.iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
// set display name
Events.on('display-name', e => {
    const me = e.detail.message;
    const $displayName = $('displayName')
    $displayName.textContent = me.displayName
    $displayName.title = me.deviceName;
    // Persist our name so a reconnect reuses the same identity. Otherwise the
    // server hands out a fresh (id-seeded) name and our previous, still-lingering
    // connection shows up as a separate "device" until the server cleans it up.
    if (me.displayName) localStorage.setItem('displayname', me.displayName);
});
let imageRetryCount = 0;
const maxImageRetries = 3;
$('img-preview').addEventListener('error',function() {
    imageRetryCount++;
    if (imageRetryCount <= maxImageRetries) {
        // Retry with same URL after a short delay
        setTimeout(() => {
            const currentSrc = $('img-preview').src;
            $('img-preview').src = ''; // Clear src first
            $('img-preview').src = currentSrc; // Then set it again to trigger reload
        }, 1000);
    } else {
        // Max retries reached, show placeholder instead of hiding completely
        const $imgPreview = $('img-preview');
        $imgPreview.style.display = 'none';
        
        // Show a text placeholder for failed images
        const $preview = $imgPreview.parentElement;
        const $placeholder = $preview.querySelector('.image-placeholder') || document.createElement('div');
        $placeholder.className = 'image-placeholder';
        $placeholder.textContent = 'Image preview not available';
        $placeholder.style.cssText = 'display: flex; align-items: center; justify-content: center; height: 200px; border: 1px dashed #ccc; color: #666; font-size: 14px;';
        
        if (!$preview.querySelector('.image-placeholder')) {
            $preview.appendChild($placeholder);
        }
        
        imageRetryCount = 0; // Reset for future images
    }
});
$('img-preview').addEventListener('load', function() {
    imageRetryCount = 0; // Reset counter on successful load
});
Events.on('room-display',e => {
    const room = e.detail
    if(room) {
        const $displayRoom = $('displayRoom')
        $displayRoom.textContent = jQuery.i18n.map['text_room']+room
        document.getElementById('exitRoomBt').style.display = 'block'
        $("body-text-area").innerText =  jQuery.i18n.prop('text_bottom_room')
    }else{
        document.getElementById('exitRoomBt').style.display = 'none'
        $("body-text-area").innerText = jQuery.i18n.prop('text_bottom_network')
    }
    
})
Events.on('edit-name-commit',e => {
    const name = e.detail.text
    const $displayName = $('displayName')
    $displayName.textContent = name
    Events.fire('peer-name',name)
})
//编辑显示的姓名
$('editNameBt').addEventListener('click',e => {
    Events.fire('edit-name')
})
//加入房间
$('room').addEventListener("click",e => {
    Events.fire('open-room-dialog')
})
//退出房间
$('exitRoomBt').addEventListener("click",e => {
    Events.fire('exit-room')
})
//语言切换
$('language').addEventListener("click",e => {
   let c_lang = localStorage.getItem('clanguage') === 'en' ? 'zh':'en'
   localStorage.setItem('clanguage',c_lang)
   location.reload()


})
class PeersUI {

    constructor() {
        Events.on('peer-joined', e => this._onPeerJoined(e.detail));
        Events.on('peer-left', e => this._onPeerLeft(e.detail));
        Events.on('peers', e => this._onPeers(e.detail));
        Events.on('file-progress', e => this._onFileProgress(e.detail));
        Events.on('paste', e => this._onPaste(e));
        Events.on('peer-modify-name', e => this._onPeerModifyName(e.detail));
        Events.on('close-progress',e => this._closeProgress(e.detail))
        Events.on('clear-cancel',e => this._clearCancel(e.detail))
        Events.on('clear-peers', e => this._clearPeers()) // wipe device list on disconnect
        this._currentPeerInfo = null; // Store current peer info for same-device detection
    }

    _onPeerJoined(peer) {
        // Never list ourselves. On reconnect the server may still briefly hold our
        // previous connection in the room; it carries our own identity, so filter
        // it out instead of showing a phantom "self" device.
        if (this._currentPeerInfo && JSON.stringify(peer.name) === JSON.stringify(this._currentPeerInfo)) {
            return;
        }
        if ($(peer.id)) return; // peer already exists
        // De-dupe by identity: the same device reconnecting gets a NEW id but keeps
        // its display name, while its previous (stale) connection may still linger
        // in the room. Drop any stale element for the same device before adding the
        // fresh one, so a device never appears twice.
        this._removeStaleByName(peer);
        const peerUI = new PeerUI(peer);
        $$('x-peers').appendChild(peerUI.$el);
        // Stop the background animation once a peer appears. Guard the call: it is
        // only defined after the window 'load' handler runs, which may be later
        // than this timeout fires.
        setTimeout(e => { if (typeof window.animateBackground === 'function') window.animateBackground(false); }, 1750);
    }

    // Remove any already-listed device that shares this peer's display name but has
    // a different id (a leftover connection from before a reconnect).
    _removeStaleByName(peer) {
        const name = peer.name && peer.name.displayName;
        if (!name) return;
        $$('x-peers').querySelectorAll('x-peer').forEach(el => {
            if (el.id === peer.id) return;
            const existing = el.ui && el.ui._peer && el.ui._peer.name && el.ui._peer.name.displayName;
            if (existing === name) el.remove();
        });
    }
    //peer modify name 
    _onPeerModifyName(peer) {
        let el = $(peer.id)      
        el.querySelector('.name').textContent = peer.name.displayName;
    }
    _onPeers(msg) {
        const currentPeerInfo = msg.currentPeerInfo
        this._currentPeerInfo = currentPeerInfo; // Store for individual peer joins
        const peers = msg.peers
        this._clearPeers();
        peers.forEach(peer => this._onPeerJoined(peer));
    }

    _onPeerLeft(peerId) {
        const $peer = $(peerId);
        if (!$peer) return;
        $peer.remove();
    }

    _onFileProgress(progress) {
        const peerId = progress.sender || progress.recipient;
        const $peer = $(peerId);
        if (!$peer) return;
        $peer.ui.setProgress(progress.progress);
    }

    _closeProgress(message){
        const peerId = message.sender || message.recipient;
        const $peer = $(peerId);
        if (!$peer) return;
       // Events.fire('notify-user', '文件传输被取消');
        $peer.ui.closeProgress();
    }
    _clearCancel(message) {
        const peerId = message.sender || message.recipient;
        const $peer = $(peerId);
        if (!$peer) return;
        $peer.ui.clearCancel();
    }
    _clearPeers() {
        const $peers = $$('x-peers').innerHTML = '';
    }

    _onPaste(e) {
        // 检查发送文字对话框是否打开，如果打开则不处理粘贴事件
        const sendTextDialog = document.getElementById('sendTextDialog');
        if (sendTextDialog && sendTextDialog.hasAttribute('show')) {
            return; // 让发送文字对话框自己处理粘贴
        }
        
        const files = e.clipboardData.files || e.clipboardData.items
            .filter(i => i.type.indexOf('image') > -1)
            .map(i => i.getAsFile());
        const peers = document.querySelectorAll('x-peer');
        // send the pasted image content to the only peer if there is one
        // otherwise, select the peer somehow by notifying the client that
        // "image data has been pasted, click the client to which to send it"
        // not implemented
        if (files.length > 0 && peers.length === 1) {
            Events.fire('files-selected', {
                files: files,
                to: $$('x-peer').id,
                sender: $('displayName').innerText
            });
        }
    }
}

class PeerUI {

    html() {
        return `
            <label class="column center" title="${jQuery.i18n.prop('text_instructions_pc')}">
                <input type="file" multiple>
                <x-icon shadow="1">
                    <svg class="icon"><use xlink:href="#"/></svg>
                </x-icon>
                <div class="progress">
                  <div class="circle"></div>
                  <div class="circle right"></div>
                </div>
                <div class="name font-subheading"></div>
                <div class="device-name font-body2"></div>
                <div class="status font-body2"></div>
                <button class="cancel-transfer" style="display:none">${jQuery.i18n.prop('cancel_send')}</button>
            </label>`
    }

    constructor(peer) {
        this._peer = peer;
        this._initDom();
        this._bindListeners(this.$el);
        this._hasCancel = false
    }

    _initDom() {
        const el = document.createElement('x-peer');
        el.id = this._peer.id;
        el.innerHTML = this.html();
        el.ui = this;
        el.querySelector('svg use').setAttribute('xlink:href', this._icon());
        el.querySelector('.name').textContent = this._displayName();
        el.querySelector('.device-name').textContent = this._deviceName();
        this.$el = el;
        this.$progress = el.querySelector('.progress');
    }

    _bindListeners(el) {
        el.querySelector('input').addEventListener('change', e => this._onFilesSelected(e));
        el.addEventListener('drop', e => this._onDrop(e));
        el.addEventListener('dragend', e => this._onDragEnd(e));
        el.addEventListener('dragleave', e => this._onDragEnd(e));
        el.addEventListener('dragover', e => this._onDragOver(e));
        el.addEventListener('contextmenu', e => this._onRightClick(e));
        el.addEventListener('touchstart', e => this._onTouchStart(e));
        el.addEventListener('touchend', e => this._onTouchEnd(e));
        //cancel transfer
        el.querySelector('.cancel-transfer').addEventListener('click',e => this._cancelTransfer(e))
        // prevent browser's default file drop behavior
        Events.on('dragover', e => e.preventDefault());
        Events.on('drop', e => e.preventDefault());
    }

    _displayName() {
        return this._peer.name.displayName;
    }

    _deviceName() {
        return this._peer.name.deviceName;
    }

    _icon() {
        const device = this._peer.name.device || this._peer.name;
        if (device.type === 'mobile') {
            return '#phone-iphone';
        }
        if (device.type === 'tablet') {
            return '#tablet-mac';
        }
        return '#desktop-mac';
    }

    _onFilesSelected(e) {
        const $input = e.target;
        const files = $input.files;
        // Reset cancel state for new transfer
        this._hasCancel = false;
        // Reset progress for new transfer
        this.setProgress(0);
        // Show cancel button
        this.$el.querySelector('.cancel-transfer').style.display = "block"
        Events.fire('files-selected', {
            files: files,
            to: this._peer.id,
            sender: $('displayName').innerText
        });
        $input.value = null; // reset input
    }

    setProgress(progress) {
        if(this._hasCancel) return
        if (progress > 0) {
            this.$el.setAttribute('transfer', '1');
        }
        if (progress > 0.5) {
            this.$progress.classList.add('over50');
        } else {
            this.$progress.classList.remove('over50');
        }
        const degrees = `rotate(${360 * progress}deg)`;
        this.$progress.style.setProperty('--progress', degrees);
        if (progress >= 1) {
            this._resetProgress();
        }
    }

    _resetProgress() {
        this.setProgress(0);
        this.$el.removeAttribute('transfer');
        this.$el.querySelector('.cancel-transfer').style.display = "none"
        this._hasCancel = true; // Match closeProgress behavior
    }
    clearCancel() {
        this._hasCancel = false
    }
    closeProgress() {
        this.setProgress(0);
        this.$el.removeAttribute('transfer');
        this.$el.querySelector('.cancel-transfer').style.display = "none"
        this._hasCancel = true
    }

    _onDrop(e) {
        e.preventDefault();
        const files = e.dataTransfer.files;
        // Reset cancel state for new transfer
        this._hasCancel = false;
        // Reset progress for new transfer
        this.setProgress(0);
        Events.fire('files-selected', {
            files: files,
            to: this._peer.id,
            sender: $('displayName').innerText
        });
        this._onDragEnd();
    }

    _onDragOver() {
        this.$el.setAttribute('drop', 1);
    }

    _onDragEnd() {
        this.$el.removeAttribute('drop');
    }

    _onRightClick(e) {
        e.preventDefault();
        Events.fire('text-recipient', this._peer.id);
    }

    _onTouchStart(e) {
        this._touchStart = Date.now();
        this._touchTimer = setTimeout(_ => this._onTouchEnd(), 610);
    }

    _onTouchEnd(e) {
        if (Date.now() - this._touchStart < 500) {
            clearTimeout(this._touchTimer);
        } else { // this was a long tap
            if (e) e.preventDefault();
            Events.fire('text-recipient', this._peer.id);
        }
    }

    _cancelTransfer(e) {
        Events.fire('cancel-send', {
            to: this._peer.id
        });
    }
}


class Dialog {
    constructor(id) {
        this.$el = $(id);
        this.$el.querySelectorAll('[close]').forEach(el => el.addEventListener('click', e => this.hide()))
        this.$autoFocus = this.$el.querySelector('[autofocus]');
    }

    show() {
        this.$el.setAttribute('show', 1);
        if (this.$autoFocus) this.$autoFocus.focus();
    }

    hide() {
        this.$el.removeAttribute('show');
        document.activeElement.blur();
        window.blur();
    }
}

class ReceiveDialog extends Dialog {

    constructor() {
        super('receiveDialog');
        Events.on('file-received', e => {
            this._nextFile(e.detail.file, e.detail.sender);
            // Try to play sound, but handle autoplay restrictions gracefully
            try {
                window.blop.play().catch(error => {
                    console.log('Audio play failed due to browser autoplay policy:', error.message);
                });
            } catch (error) {
                console.log('Audio play error:', error.message);
            }
        });
        this._filesQueue = [];
        this._currentSender = null;
        this._currentObjectUrl = null; // Track current Object URL for cleanup
    }

    _nextFile(nextFile,sender) {
        //if (nextFile) this._filesQueue.push(nextFile);
        if(nextFile) {
            this._filesQueue.push(nextFile);
            if(sender) this._currentSender = sender
        }
        if (this._busy) return;
        this._busy = true;
        const file = this._filesQueue.shift();
        const fileSender = sender || this._currentSender;
        this._displayFile(file, fileSender);
    }

    _dequeueFile(file,sender) {
        if (!this._filesQueue.length) { // nothing to do
            this._busy = false;
            return;
        }
        // dequeue next file
        setTimeout(_ => {
            this._busy = false;
            this._nextFile(undefined,this._currentSender);
        }, 300);
    }
    _displayFile(file,sender) {
        // Revoke previous Object URL to prevent memory leaks
        if (this._currentObjectUrl) {
            URL.revokeObjectURL(this._currentObjectUrl);
        }
        
        const $a = this.$el.querySelector('#download');
        const url = URL.createObjectURL(file.blob);
        this._currentObjectUrl = url; // Store for cleanup
        $a.href = url;
        $a.download = file.name;

        if(this._autoDownload()){
            $a.click()
            return
        }
        if(file.mime.split('/')[0] === 'image'){
            // Reset image preview visibility and state for new image
            const $preview = this.$el.querySelector('.preview');
            const $imgPreview = this.$el.querySelector("#img-preview");
            
            // Remove any existing placeholder
            const $placeholder = $preview.querySelector('.image-placeholder');
            if ($placeholder) {
                $placeholder.remove();
            }
            
            // Reset image retry counter for new image
            imageRetryCount = 0;
            
            $preview.style.visibility = 'inherit';
            $imgPreview.style.display = 'block';
            $imgPreview.src = url;
        }

        this.$el.querySelector('#fileName').textContent = file.name;
        this.$el.querySelector('#fileSize').textContent = this._formatFileSize(file.size);
        if(sender !== null) $('fileSender').textContent = sender
        this.show();
        
      //  if (window.isDownloadSupported) return;
        // fallback for iOS
      /*  $a.target = '_blank';
        const reader = new FileReader();
        reader.onload = e => $a.href = reader.result;
        reader.readAsDataURL(file.blob);*/
    }
    _isSafari(){
        var ua = navigator.userAgent.toLowerCase();
        if (ua.indexOf('applewebkit') > -1 && ua.indexOf('mobile') > -1 && ua.indexOf('safari') > -1 &&
            ua.indexOf('linux') === -1 && ua.indexOf('android') === -1 && ua.indexOf('chrome') === -1 &&
            ua.indexOf('ios') === -1 && ua.indexOf('browser') === -1) {
            return true;
        }else{
            return false;
        }
    }
    _formatFileSize(bytes) {
        if (bytes >= 1e9) {
            return (Math.round(bytes / 1e8) / 10) + ' GB';
        } else if (bytes >= 1e6) {
            return (Math.round(bytes / 1e5) / 10) + ' MB';
        } else if (bytes > 1000) {
            return Math.round(bytes / 1000) + ' KB';
        } else {
            return bytes + ' Bytes';
        }
    }

    hide() {
        this.$el.querySelector('.preview').style.visibility = 'hidden';
        this.$el.querySelector("#img-preview").src = "";
        super.hide();
        this._dequeueFile();
    }


    _autoDownload(){
        return !this.$el.querySelector('#autoDownload').checked
    }
}

class EditNameDialog extends Dialog {
    constructor() {
        super('editNameDialog');
        this.$nameText = this.$el.querySelector('#nameTextInput')
        Events.on('edit-name', e => this._onOpenEditName(e.detail))
        const button = this.$el.querySelector('form')
        button.addEventListener('submit', e => {
            this._sure(e)
        });

    }
    _onOpenEditName(){
        this.$nameText.innerHTML = ""
        this.show()
    }
    _sure(e) {
        e.preventDefault();
        if(this.$nameText.innerText == '') {
            return
        }
        localStorage.setItem('displayname',this.$nameText.innerText)
        Events.fire('edit-name-commit', {
            text: this.$nameText.innerText
        });
    }
}
class JoinRoomDialog extends Dialog {
    constructor() {
        super('roomDialog')
        this.$number = document.getElementById("roomNumberInput")
        Events.on('open-room-dialog', e => this._onOpenRoomDialog())
        Events.on('exit-room', e => this._exitRoom())
        const button = this.$el.querySelector('form')
        button.addEventListener('submit', e => {
            this._sure(e)
        });
    }
    _onOpenRoomDialog() {
        this.show()
        this.$number.innerHTML = ""
    }
    _sure(e) {
        e.preventDefault();
        let number = this.$number.value.replace(/\D/g,'')
        if(number.length < 6) {
            let roomNumber = this._getRandomSixDigit()
            localStorage.setItem('roomnumber',roomNumber)
            location.reload()
        }else{
            //join
            number = number.substring(0,6)
            localStorage.setItem('roomnumber',number)
            location.reload()
        }
    }
    _exitRoom() {
        localStorage.setItem('roomnumber','')
        location.reload()
    }
    _getRandomSixDigit() {
        // Note: This generates 6-digit codes with potential collision risk
        // Only 1 million possible combinations (000000-999999)
        // For production use, consider server-side generation with collision detection
        let code = ''
        for(var i=0;i<6;i++){
            code += parseInt(Math.random()*10)
        }

        return code
    }
}
class SendTextDialog extends Dialog {
    constructor() {
        super('sendTextDialog');
        Events.on('text-recipient', e => this._onRecipient(e.detail))
        this.$text = this.$el.querySelector('#textInput');
        this._pendingImageFiles = null; // 初始化待发送图片属性
        this._imageUrls = []; // 存储图片 URL 用于清理
        const button = this.$el.querySelector('form');
        button.addEventListener('submit', e => this._send(e));
        //绑定paste事件
        this.$text.addEventListener('paste', e => this._onInputPaste(e))
    }
    _onInputPaste(e) {
        const files = e.clipboardData.files || e.clipboardData.items
        .filter(i => i.type.indexOf('image') > -1)
        .map(i => i.getAsFile());
        
        if(!files.length) {
            return
        }
        
        // 阻止默认粘贴行为
        e.preventDefault();
        
        // 存储图片文件，等待发送时使用
        this._pendingImageFiles = files;
        
        // 在输入框中显示图片预览
        this._displayImagePreviews(files);
    }

    _displayImagePreviews(files) {
        // 清理之前的图片 URL
        this._cleanupImageUrls();
        
        let previewHtml = '<div style="margin: 10px 0;">';
        
        // 将 FileList 转换为数组
        const fileArray = Array.from(files);
        
        fileArray.forEach((file, index) => {
            const url = URL.createObjectURL(file);
            this._imageUrls.push(url); // 存储 URL 用于后续清理
            
            previewHtml += `
                <div style="margin-bottom: 10px;">
                    <img src="${url}" style="max-width: 200px; max-height: 150px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); display: block; margin-bottom: 5px;">
                    <div style="font-size: 12px; color: #666;">${file.name} (${this._formatFileSize(file.size)})</div>
                </div>
            `;
        });
        
        previewHtml += '</div>';
        
        this.$text.innerHTML = previewHtml;
    }

    _cleanupImageUrls() {
        this._imageUrls.forEach(url => URL.revokeObjectURL(url));
        this._imageUrls = [];
    }

    _formatFileSize(bytes) {
        if (bytes >= 1e9) {
            return (Math.round(bytes / 1e8) / 10) + ' GB';
        } else if (bytes >= 1e6) {
            return (Math.round(bytes / 1e5) / 10) + ' MB';
        } else if (bytes > 1000) {
            return Math.round(bytes / 1000) + ' KB';
        } else {
            return bytes + ' Bytes';
        }
    }
    _onRecipient(recipient) {
        this._recipient = recipient;
        this._handleShareTargetText();
        this.$text.innerHTML = ''
        this._pendingImageFiles = null; // 清空待发送的图片
        this._cleanupImageUrls(); // 清理图片 URL
        this.show();

        const range = document.createRange();
        const sel = window.getSelection();

        range.selectNodeContents(this.$text);
        sel.removeAllRanges();
        sel.addRange(range);

    }

    _handleShareTargetText() {
        if (!window.shareTargetText) return;
        this.$text.textContent = window.shareTargetText;
        window.shareTargetText = '';
    }

    _send(e) {
        e.preventDefault();
        let displayName = $('displayName').innerText
        
        // 优先检查是否有待发送的图片
        if (this._pendingImageFiles && this._pendingImageFiles.length > 0) {
            // 发送图片
            Events.fire('files-selected', {
                files: this._pendingImageFiles,
                to: this._recipient,
                sender: displayName
            });
            // 清空待发送的图片和预览
            this._pendingImageFiles = null;
            this._cleanupImageUrls();
            this.$text.innerHTML = '';
        } else {
            // 发送文字
            Events.fire('send-text', {
                to: this._recipient,
                text: this.$text.innerText,
                from: displayName
            });
        }
    }
}

class ReceiveTextDialog extends Dialog {
    constructor() {
        super('receiveTextDialog');
        Events.on('text-received', e => this._onText(e.detail))
        this.$text = this.$el.querySelector('#text');
        const $copy = this.$el.querySelector('#copy');
        $copy.addEventListener('click', _ => this._onCopy());
    }

    _onText(e) {
        $('sender').textContent = e.sender
        this.$text.innerHTML = '';
        const text = e.text;
        if (isURL(text)) {
            const $a = document.createElement('a');
            $a.href = text;
            $a.target = '_blank';
            $a.textContent = text;
            this.$text.appendChild($a);
        } else {
            this.$text.textContent = text;
        }
        this.show();
        // Try to play sound, but handle autoplay restrictions gracefully
        try {
            window.blop.play().catch(error => {
                console.log('Audio play failed due to browser autoplay policy:', error.message);
            });
        } catch (error) {
            console.log('Audio play error:', error.message);
        }
    }

    async _onCopy() {
        await navigator.clipboard.writeText(this.$text.textContent);
        Events.fire('notify-user', jQuery.i18n.prop('text_copy'));
    }
}

class Toast extends Dialog {
    constructor() {
        super('toast');
        this._persistMessage = null; // sticky message kept visible until cleared
        Events.on('notify-user', e => this._onNotfiy(e.detail));
        Events.on('notify-user-persist', e => this._onPersist(e.detail));
        Events.on('notify-user-hide', e => this._onHidePersist());
    }

    _onNotfiy(message) {
        clearTimeout(this._hideTimer);
        this.$el.textContent = message;
        this.show();
        this._hideTimer = setTimeout(_ => {
            // A sticky message (e.g. "You are offline") must reassert itself
            // after a transient toast, instead of hiding the toast entirely.
            if (this._persistMessage) {
                this.$el.textContent = this._persistMessage;
            } else {
                this.hide();
            }
        }, 3000);
    }

    // Show a message that stays until _onHidePersist() is called.
    _onPersist(message) {
        clearTimeout(this._hideTimer);
        this._persistMessage = message;
        this.$el.textContent = message;
        this.show();
    }

    _onHidePersist() {
        clearTimeout(this._hideTimer);
        this._persistMessage = null;
        this.hide();
    }
}


class Notifications {

    constructor() {
        // Check if the browser supports notifications
        if (!('Notification' in window)) return;

        // Check whether notification permissions have already been granted
        if (Notification.permission !== 'granted') {
            this.$button = $('notification');
            this.$button.removeAttribute('hidden');
            this.$button.addEventListener('click', e => this._requestPermission());
        }
        Events.on('text-received', e => this._messageNotification(e.detail.text));
        Events.on('file-received', e => this._downloadNotification(e.detail.file.name));
    }

    _requestPermission() {
        Notification.requestPermission(permission => {
            if (permission !== 'granted') {
                Events.fire('notify-user', Notifications.PERMISSION_ERROR || 'Error');
                return;
            }
            this._notify(jQuery.i18n.prop('notify_sharing'));
            this.$button.setAttribute('hidden', 1);
        });
    }

    _notify(message, body) {
        const config = {
            body: body,
            icon: '/images/logo_transparent_128x128.png',
        }
        let notification;
        try {
            notification = new Notification(message, config);
        } catch (e) {
            // Android doesn't support "new Notification" if service worker is installed
            if (!serviceWorker || !serviceWorker.showNotification) return;
            notification = serviceWorker.showNotification(message, config);
        }

        // Notification is persistent on Android. We have to close it manually
        const visibilitychangeHandler = () => {                             
            if (document.visibilityState === 'visible') {    
                notification.close();
                Events.off('visibilitychange', visibilitychangeHandler);
            }                                                       
        };                                                                                
        Events.on('visibilitychange', visibilitychangeHandler);

        return notification;
    }

    _messageNotification(message) {
        if (document.visibilityState !== 'visible') {
            if (isURL(message)) {
                const notification = this._notify(message, jQuery.i18n.prop('notify_copy_link'));
                this._bind(notification, e => window.open(message, '_blank', null, true));
            } else {
                const notification = this._notify(message, jQuery.i18n.prop('notify_copy_text'));
                this._bind(notification, e => this._copyText(message, notification));
            }
        }
    }

    _downloadNotification(message) {
        if (document.visibilityState !== 'visible') {
            const notification = this._notify(message, jQuery.i18n.prop('notify_download'));
            if (!window.isDownloadSupported) return;
            this._bind(notification, e => this._download(notification));
        }
    }

    _download(notification) {
        document.querySelector('x-dialog [download]').click();
        notification.close();
    }

    _copyText(message, notification) {
        notification.close();
        if (!navigator.clipboard.writeText(message)) return;
        this._notify(jQuery.i18n.prop('notify_clipboard'));
    }

    _bind(notification, handler) {
        if (notification.then) {
            notification.then(e => serviceWorker.getNotifications().then(notifications => {
                serviceWorker.addEventListener('notificationclick', handler);
            }));
        } else {
            notification.onclick = handler;
        }
    }
}


class NetworkStatusUI {

    constructor() {
        window.addEventListener('offline', e => this._showOfflineMessage(), false);
        window.addEventListener('online', e => this._showOnlineMessage(), false);
        if (!navigator.onLine) this._showOfflineMessage();
    }

    _showOfflineMessage() {
        // Clear the (now-stale) device list first so it happens even if the i18n
        // lookup below were to fail, then keep the banner up until we're back online.
        Events.fire('clear-peers');
        Events.fire('notify-user-persist', jQuery.i18n.prop('notify_offline'));
    }

    _showOnlineMessage() {
        Events.fire('notify-user-hide');
        // Refresh the signaling connection so discoverable devices come back.
        Events.fire('network-online');
        Events.fire('notify-user', jQuery.i18n.prop('notify_online'));
    }
}

class WebShareTargetUI {
    constructor() {
        const parsedUrl = new URL(window.location);
        const title = parsedUrl.searchParams.get('title');
        const text = parsedUrl.searchParams.get('text');
        const url = parsedUrl.searchParams.get('url');

        let shareTargetText = title ? title : '';
        shareTargetText += text ? shareTargetText ? ' ' + text : text : '';

        if(url) shareTargetText = url; // We share only the Link - no text. Because link-only text becomes clickable.

        if (!shareTargetText) return;
        window.shareTargetText = shareTargetText;
        history.pushState({}, 'URL Rewrite', '/');
    }
}


class Snapdrop {
    constructor() {
        const server = new ServerConnection();
        const peers = new PeersManager(server);
        const peersUI = new PeersUI();
        Events.on('load', e => {
            const receiveDialog = new ReceiveDialog();
            const sendTextDialog = new SendTextDialog();
            const editNameDialog = new EditNameDialog();
            const receiveTextDialog = new ReceiveTextDialog();
            const roomDialog = new JoinRoomDialog()
            const toast = new Toast();
            const notifications = new Notifications();
            const networkStatusUI = new NetworkStatusUI();
            const webShareTargetUI = new WebShareTargetUI();
        });
    }
}

const snapdrop = new Snapdrop();



if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
        .then(serviceWorker => {
            console.log('Service Worker registered');
            window.serviceWorker = serviceWorker
        });
}

window.addEventListener('beforeinstallprompt', e => {
    if (window.matchMedia('(display-mode: standalone)').matches) {
        // don't display install banner when installed
        return e.preventDefault();
    } else {
        return
        const btn = document.querySelector('#install')
        btn.hidden = false;
        btn.onclick = _ => e.prompt();
        return e.preventDefault();
    }
});

// Background Animation
Events.on('load', () => {
    let c = document.createElement('canvas');
    document.body.appendChild(c);
    let style = c.style;
    style.width = '100%';
    style.position = 'absolute';
    style.zIndex = -1;
    style.top = 0;
    style.left = 0;
    let ctx = c.getContext('2d');
    let x0, y0, w, h, dw;

    function init() {
        w = window.innerWidth;
        h = window.innerHeight;
        c.width = w;
        c.height = h;
        let offset = h > 380 ? 100 : 65;
        offset = h > 800 ? 116 : offset;
        x0 = w / 2;
        y0 = h - offset;
        dw = Math.max(w, h, 1000) / 13;
        drawCircles();
    }
    window.onresize = init;

    function drawCircle(radius) {
        ctx.beginPath();
        let color = Math.round(255 * (1 - radius / Math.max(w, h)));
        ctx.strokeStyle = 'rgba(' + color + ',' + color + ',' + color + ',0.1)';
        ctx.arc(x0, y0, radius, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.lineWidth = 2;
    }

    let step = 0;

    function drawCircles() {
        ctx.clearRect(0, 0, w, h);
        for (let i = 0; i < 8; i++) {
            drawCircle(dw * i + step % dw);
        }
        step += 1;
    }

    let loading = true;

    function animate() {
        if (loading || step % dw < dw - 5) {
            requestAnimationFrame(function() {
                drawCircles();
                animate();
            });
        }
    }
    window.animateBackground = function(l) {
        loading = l;
        animate();
    };
    init();
    animate();
});

Notifications.PERMISSION_ERROR = `
Notifications permission has been blocked
as the user has dismissed the permission prompt several times.
This can be reset in Page Info
which can be accessed by clicking the lock icon next to the URL.`;

document.body.onclick = e => { // safari hack to fix audio
    document.body.onclick = null;
    if (!(/.*Version.*Safari.*/.test(navigator.userAgent))) return;
    try {
        blop.play().catch(error => {
            console.log('Safari audio hack failed:', error.message);
        });
    } catch (error) {
        console.log('Safari audio hack error:', error.message);
    }
}
