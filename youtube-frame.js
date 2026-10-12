/* Runs only in YouTube embed frames. No playback until the course page requests it. */
(function () {
    'use strict';
    const REQUEST = 'BDHVS_PLAYER_REQUEST';
    const RESPONSE = 'BDHVS_PLAYER_RESPONSE';
    const COURSE_ORIGIN = 'https://binhdanhocvuso.gov.vn';
    let session = null;
    let controller = new AbortController();
    let playGeneration = 0;
    let controlledVideo = null;

    function videoElement() {
        const videos = [...document.querySelectorAll('video')].filter(video => video.getClientRects().length);
        if (videos.length > 1) throw new Error('Iframe có nhiều video, chưa xác định được player.');
        return videos[0] || null;
    }
    function check(signal) {
        if (signal.aborted) throw new DOMException('Đã dừng', 'AbortError');
    }
    function muteForPlayback(video) {
        if (!video) return;
        video.defaultMuted = true;
        video.muted = true;
        video.volume = 0;
        video.playsInline = true;
    }
    // This loop runs inside the YouTube iframe itself, right alongside the
    // player's own decode/render work -- the least convenient place to keep
    // busy-polling fast on a weak machine. 300ms (was 100ms) still confirms
    // play/seek within a fraction of a second, which nothing here needs to
    // be tighter than, while cutting these wake-ups to a third.
    async function waitFor(probe, signal, label, timeoutMs = 15000) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            check(signal);
            const value = probe();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        throw new Error('Hết thời gian chờ ' + label + ' trong YouTube.');
    }
    function pause() {
        controller.abort();
        controlledVideo?.pause();
        controller = new AbortController();
    }
    function state(video) {
        return {
            ready: !!video && video.readyState >= 1,
            currentTime: video?.currentTime || 0,
            duration: Number.isFinite(video?.duration) ? video.duration : 0,
            paused: video?.paused ?? true, ended: video?.ended || false,
            error: video?.error?.message || null
        };
    }
    async function command(message) {
        if (message.command === 'connect') {
            if (session !== message.session) { pause(); session = message.session; }
            return state(videoElement());
        }
        if (session !== message.session) throw new Error('Phiên điều khiển video đã thay đổi.');
        if (message.command === 'pause' || message.command === 'release') {
            pause();
            if (message.command === 'release') session = null;
            return { paused: true };
        }
        if (message.command === 'state') return state(videoElement());
        const signal = controller.signal;
        if (message.command === 'play') {
            check(signal);
            muteForPlayback(videoElement());
            // The play overlay lives INSIDE this iframe.
            const overlay = document.querySelector('button.ytp-large-play-button, button.ytmCuedOverlayPlayButton, .ytp-play-button');
            if (overlay?.getClientRects().length) { check(signal); overlay.click(); }
            const video = await waitFor(videoElement, signal, 'thẻ video');
            controlledVideo = video;
            check(signal);
            const generation = ++playGeneration;
            muteForPlayback(video);
            let failure = null;
            let pending = false;
            let attempts = 0;
            let retryAt = 0;
            let autoplayRetries = 0;
            await waitFor(() => {
                if (failure) {
                    if (failure.name === 'NotAllowedError') {
                        if (autoplayRetries++ >= 1 || attempts >= 3) {
                            throw new Error('Trình duyệt vẫn chặn phát video dù đã tắt tiếng. Hãy nhấn Play trực tiếp trong video YouTube rồi chạy lại.');
                        }
                    } else if (failure.name !== 'AbortError' || attempts >= 5) {
                        throw new Error('Không phát được video: ' + failure.message);
                    }
                    failure = null;
                    retryAt = Date.now() + 200;
                }
                // paused can become false before play() settles, then flip back when
                // YouTube's controls interrupt startup. Wait for the promise as well.
                if (!pending && !video.paused && video.readyState >= 1) return true;
                if (!pending && Date.now() >= retryAt && attempts < 3) {
                    pending = true;
                    attempts++;
                    Promise.resolve().then(() => {
                        check(signal);
                        muteForPlayback(video);
                        return video.play();
                    }).then(() => {
                        if (signal.aborted && generation === playGeneration) video.pause();
                    }).catch(error => { failure = error; }).finally(() => { pending = false; });
                }
                return false;
            }, signal, 'phát video');
            return state(video);
        }
        if (message.command === 'seek') {
            let video = await waitFor(() => {
                const element = videoElement();
                return element?.readyState >= 1 && element.duration > 0 ? element : null;
            }, signal, 'thời lượng video');
            controlledVideo = video;
            if (!Number.isFinite(message.seconds) || message.seconds < 0 || message.seconds > video.duration) {
                throw new Error('Mốc tua vượt thời lượng video hoặc không hợp lệ.');
            }
            check(signal);
            video.currentTime = message.seconds;
            // A big seek backwards (e.g. all the way to 00:00 on a video that
            // was already watched close to the end) can land while YouTube is
            // still running its own end-of-video/replay transition: it may
            // swap in a new <video> element, or silently ignore the first
            // currentTime assignment while it re-buffers. Keep re-targeting
            // whichever element is current and reasserting the seek instead
            // of giving up on a single attempt, and allow more time than a
            // normal small seek needs.
            await waitFor(() => {
                const current = videoElement();
                if (current && current !== video) {
                    video = current;
                    controlledVideo = video;
                    video.currentTime = message.seconds;
                    return false;
                }
                if (video.seeking) return false;
                if (Math.abs(video.currentTime - message.seconds) < 2) return true;
                video.currentTime = message.seconds;
                return false;
            }, signal, 'tua video', 30000);
            return state(video);
        }
        throw new Error('Lệnh player không hỗ trợ.');
    }
    window.addEventListener('message', event => {
        const message = event.data;
        if (event.source !== parent || event.origin !== COURSE_ORIGIN || message?.type !== REQUEST ||
            typeof message.session !== 'string' || typeof message.requestId !== 'string') return;
        command(message).then(
            result => {
                try {
                    parent.postMessage({ type: RESPONSE, session: message.session, requestId: message.requestId, ok: true, result }, COURSE_ORIGIN);
                } catch {}
            },
            error => {
                try {
                    parent.postMessage({ type: RESPONSE, session: message.session, requestId: message.requestId, ok: false, error: error.message }, COURSE_ORIGIN);
                } catch {}
            }
        );
    });
    window.addEventListener('pagehide', pause);
})();
