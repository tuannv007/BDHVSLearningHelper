/* Player handle shared by the course actions; iframe access stays inside youtube-frame.js. */
(function (root) {
    'use strict';
    async function connect(container, signal) {
        const site = root.CourseSite;
        const frame = site.find('iframe[src*="youtube.com/embed/"]', container);
        if (!frame) throw new Error('Không tìm thấy iframe YouTube trong tab video đang chọn.');
        const url = new URL(frame.src);
        if (url.origin !== 'https://www.youtube.com' || !url.pathname.startsWith('/embed/')) {
            throw new Error('Iframe không phải player YouTube được hỗ trợ.');
        }
        try { frame.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
        const session = crypto.randomUUID();
        const pending = new Map();
        let released = false;
        function receive(event) {
            const message = event.data;
            if (event.source !== frame.contentWindow || event.origin !== url.origin ||
                message?.type !== 'BDHVS_PLAYER_RESPONSE' || message.session !== session) return;
            const entry = pending.get(message.requestId);
            if (!entry) return;
            entry.finish(message.ok ? null : new Error(message.error), message.result);
        }
        window.addEventListener('message', receive);
        function post(command, args = {}, commandSignal = signal, timeoutMs = 20000) {
            if (released || !frame.isConnected) return Promise.reject(new Error('Player đã bị thay thế hoặc đóng.'));
            if (commandSignal?.aborted) return Promise.reject(new DOMException('Đã dừng', 'AbortError'));
            return new Promise((resolve, reject) => {
                const requestId = crypto.randomUUID();
                let retryTimer = null;
                const finish = (error, value) => {
                    clearTimeout(timer);
                    if (retryTimer) clearTimeout(retryTimer);
                    commandSignal?.removeEventListener('abort', abort);
                    pending.delete(requestId);
                    if (error) reject(error); else resolve(value);
                };
                const abort = () => finish(new DOMException('Đã dừng', 'AbortError'));
                const timer = setTimeout(() => finish(new Error('Chưa kết nối được player YouTube. Reload extension và mở lại bài giảng.')), timeoutMs);
                pending.set(requestId, { finish });
                commandSignal?.addEventListener('abort', abort, { once: true });
                function send() {
                    if (released || !frame.isConnected) return finish(new Error('Player đã bị thay thế hoặc đóng.'));
                    if (commandSignal?.aborted) return finish(new DOMException('Đã dừng', 'AbortError'));
                    try {
                        frame.contentWindow.postMessage({ type: 'BDHVS_PLAYER_REQUEST', session, requestId, command, ...args }, '*');
                    } catch (error) {
                        const isOriginMismatch = error?.message?.includes('target origin provided') ||
                            error?.message?.includes('does not match') ||
                            error?.name === 'SyntaxError' ||
                            error?.name === 'SecurityError';
                        if (isOriginMismatch) {
                            retryTimer = setTimeout(send, 250);
                            return;
                        }
                        finish(error);
                    }
                }
                send();
            });
        }
        // Cancellation messages intentionally do not use the already-aborted run signal.
        function pause() { void post('pause', {}, null, 2000).catch(() => {}); }
        function release() {
            if (released) return;
            try {
                // Best-effort notification only — nothing awaits a reply. Using '*'
                // ensures the message is dispatched without browser-level target-origin
                // mismatch warnings even if the iframe is mid-reload or transitioning.
                frame.contentWindow?.postMessage({
                    type: 'BDHVS_PLAYER_REQUEST', session, requestId: crypto.randomUUID(), command: 'release'
                }, '*');
            } catch (error) { /* purely informational for the iframe side; safe to ignore */ }
            released = true;
            window.removeEventListener('message', receive);
            signal.removeEventListener('abort', pause);
            for (const entry of [...pending.values()]) entry.finish(new DOMException('Đã dừng', 'AbortError'));
        }
        signal.addEventListener('abort', pause, { once: true });
        const delayMs = ms => typeof site.delay === 'function' ? site.delay(ms, signal) : new Promise(r => setTimeout(r, ms));
        try {
            // An iframe may have just been inserted; its script can arrive later or need layout to activate.
            for (let attempt = 0; ; attempt++) {
                try {
                    if (attempt > 0 && attempt % 3 === 0) {
                        try { frame.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
                    }
                    await post('connect', {}, signal, 1500);
                    break;
                }
                catch (error) {
                    site.throwIfAborted(signal);
                    if (attempt >= 20) throw error;
                    await delayMs(400);
                }
            }
        } catch (error) { release(); throw error; }
        return {
            pause, release,
            getState: () => post('state'),
            // A big backward seek (e.g. resetting an already mostly-watched
            // video to 00:00) can need longer than a normal seek to settle
            // inside the iframe; give it more room than the default timeout.
            seek: seconds => post('seek', { seconds }, signal, 40000),
            async play() {
                site.throwIfAborted(signal);
                // Start through the course controls as well so its video UI receives the click.
                const play = site.find('button.video_control.play', container);
                if (play) site.click(play, signal);
                return post('play');
            }
        };
    }
    root.CourseMedia = { connect };
})(globalThis);
