const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const Runner = require('../course-runner.js');
const course = require('../data.json').courses[0];
const code = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('discovery includes every tab in index order, including extra tabs without question data', () => {
    const step = Runner.buildSteps(course, [1]).find(s => s.type === 'discoverVideoTabs');
    const tabs = step.videos.map(video => video.tab);
    tabs.unshift({ index: 3, title: '1.4', blockId: 'extra' });
    const steps = Runner.stepsFromTabs(step, tabs);
    assert.deepEqual(steps.filter(s => s.type === 'openVideo').map(s => s.video.tab.index), [0, 1, 2, 3]);
    assert.deepEqual(steps.filter(s => s.type === 'skipVideoToEnd').map(s => s.video.tab.index), [2, 3]);
    assert.equal(steps.filter(s => s.type === 'answerQuestion').length, 2);
    assert.throws(() => Runner.stepsFromTabs(step, tabs.slice(0, 2)), /không khớp/);
});

test('skip tab without questions seeks one second before duration and waits for ended', async () => {
    const controller = new AbortController();
    const calls = [];
    let atEnd = false;
    let checks = 0;
    let playback = 0;
    const player = {
        play: async () => calls.push('play'),
        seek: async seconds => { calls.push(seconds); atEnd = true; },
        getState: async () => ({ ready: true, duration: 520, currentTime: playback++, paused: false, ended: atEnd && ++checks >= 3 })
    };
    const context = vm.createContext({ CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(), delay: async () => {}
    }, console });
    vm.runInContext(code('actions/play-video.js'), context);
    await context.CourseActions.skipVideoToEnd(player, controller.signal);
    assert.deepEqual(calls, ['play', 519]);
    assert.equal(checks, 3);
});

test('seek waits for five seconds of media progress and Stop cancels the wait', async () => {
    for (const stop of [false, true]) {
        const controller = new AbortController();
        const times = [10, 10, 12, 14, 15];
        let reads = 0;
        let sought = false;
        const player = {
            play: async () => {},
            getState: async () => ({ ready: true, duration: 100, currentTime: times[Math.min(reads++, 4)], paused: false, ended: sought }),
            seek: async () => { assert.ok(reads >= 5); sought = true; }
        };
        const context = vm.createContext({ CourseSite: {
            throwIfAborted: signal => signal.throwIfAborted(),
            delay: async () => { if (stop) controller.abort(); }
        }, console });
        vm.runInContext(code('actions/play-video.js'), context);
        const pending = context.CourseActions.skipVideoToEnd(player, controller.signal);
        if (stop) {
            await assert.rejects(pending, { name: 'AbortError' });
            assert.equal(sought, false);
        } else {
            await pending;
            assert.equal(sought, true);
        }
    }
});

test('a restored video position cannot bypass the real five-second delay', async () => {
    const controller = new AbortController();
    let finishDelay;
    let sought = false;
    let reads = 0;
    const player = {
        play: async () => {},
        getState: async () => ({ ready: true, duration: 600, currentTime: reads++ ? 400 : 0, paused: false, ended: sought }),
        seek: async () => { sought = true; }
    };
    const context = vm.createContext({ CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(),
        delay: ms => { assert.equal(ms, 5000); return new Promise(resolve => { finishDelay = resolve; }); }
    }, console });
    vm.runInContext(code('actions/play-video.js'), context);
    const pending = context.CourseActions.skipVideoToEnd(player, controller.signal);
    await tick();
    assert.equal(sought, false);
    assert.equal(typeof finishDelay, 'function');
    finishDelay();
    await pending;
    assert.equal(sought, true);
});

test('a video that resists seeking back to 00:00 does not fail the step: it keeps going from where it already is', async () => {
    const controller = new AbortController();
    const seeks = [];
    let currentTime = 580; // already watched almost to the end, past where reset should happen
    const player = {
        play: async () => {},
        getState: async () => ({ ready: true, duration: 700, currentTime, paused: false, ended: false }),
        seek: async seconds => {
            seeks.push(seconds);
            // Simulate the real timeout error a stuck YouTube replay
            // transition produces when asked to seek all the way back to 0.
            if (seconds === 0) throw new Error('Hết thời gian chờ tua video trong YouTube.');
            currentTime = seconds;
        }
    };
    const step = { question: { timeSeconds: 650, time: '10:50' }, seekSeconds: 645, resetToStart: true };
    const context = vm.createContext({ CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(),
        delay: async (ms, signal) => { signal?.throwIfAborted(); currentTime += 10; }
    }, console });
    vm.runInContext(code('actions/play-video.js'), context);
    const result = await context.CourseActions.playToQuestion(step, player, controller.signal, () => false);
    // The failed reset-to-0 attempt is tried once, then the step recovers and
    // still seeks to the normal pre-question mark instead of erroring out.
    assert.deepEqual(seeks, [0, 645]);
    assert.ok(result.currentTime >= 650 - 0.3);
});

test('Stop during a stuck reset-to-00:00 still cancels the step instead of swallowing the abort', async () => {
    const controller = new AbortController();
    const player = {
        play: async () => {},
        getState: async () => ({ ready: true, duration: 700, currentTime: 580, paused: false, ended: false }),
        seek: async () => { controller.abort(); throw new DOMException('Đã dừng', 'AbortError'); }
    };
    const step = { question: { timeSeconds: 650, time: '10:50' }, seekSeconds: 645, resetToStart: true };
    const context = vm.createContext({ CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(),
        delay: async (ms, signal) => signal?.throwIfAborted()
    }, console });
    vm.runInContext(code('actions/play-video.js'), context);
    await assert.rejects(
        context.CourseActions.playToQuestion(step, player, controller.signal, () => false),
        { name: 'AbortError' }
    );
});

test('a timed-out seek to the question mark itself is retried once before giving up', async () => {
    // Seen on real runs (video 4.5 and 6.4): seeking close to the question
    // mark can time out the same way a stuck 00:00 reset does, together with
    // errors from the site's own in-video-quiz script — but here there is no
    // "just keep going from where it is" fallback, since the target position
    // matters. One fresh retry is tried instead before giving up for real.
    const controller = new AbortController();
    const seeks = [];
    let currentTime = 580;
    let attempts = 0;
    const player = {
        play: async () => {},
        getState: async () => ({ ready: true, duration: 700, currentTime, paused: false, ended: false }),
        seek: async seconds => {
            seeks.push(seconds);
            attempts++;
            if (attempts === 1) throw new Error('Hết thời gian chờ tua video trong YouTube.');
            currentTime = seconds;
        }
    };
    const step = { question: { timeSeconds: 650, time: '10:50' }, seekSeconds: 645, resetToStart: false };
    const warnings = [];
    const context = vm.createContext({ CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(),
        delay: async (ms, signal) => { signal?.throwIfAborted(); currentTime += 10; }
    }, console: { warn: (...args) => warnings.push(args.join(' ')), error() {} } });
    vm.runInContext(code('actions/play-video.js'), context);
    const result = await context.CourseActions.playToQuestion(step, player, controller.signal, () => false);
    assert.deepEqual(seeks, [645, 645]);
    assert.ok(result.currentTime >= 650 - 0.3);
    assert.ok(warnings.some(w => w.includes('thử lại')));
});

test('a seek to the question mark that keeps timing out on retry still fails the step', async () => {
    const controller = new AbortController();
    let currentTime = 580;
    const player = {
        play: async () => {},
        getState: async () => ({ ready: true, duration: 700, currentTime, paused: false, ended: false }),
        seek: async () => { throw new Error('Hết thời gian chờ tua video trong YouTube.'); }
    };
    const step = { question: { timeSeconds: 650, time: '10:50' }, seekSeconds: 645, resetToStart: false };
    const context = vm.createContext({ CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(),
        delay: async (ms, signal) => { signal?.throwIfAborted(); currentTime += 10; }
    }, console: { warn() {}, error() {} } });
    vm.runInContext(code('actions/play-video.js'), context);
    await assert.rejects(
        context.CourseActions.playToQuestion(step, player, controller.signal, () => false),
        /Hết thời gian chờ tua video trong YouTube/
    );
});

test('Stop during the seek to the question mark propagates immediately without retrying', async () => {
    const controller = new AbortController();
    let currentTime = 580;
    let seekCalls = 0;
    const player = {
        play: async () => {},
        getState: async () => ({ ready: true, duration: 700, currentTime, paused: false, ended: false }),
        seek: async () => { seekCalls++; controller.abort(); throw new DOMException('Đã dừng', 'AbortError'); }
    };
    const step = { question: { timeSeconds: 650, time: '10:50' }, seekSeconds: 645, resetToStart: false };
    const context = vm.createContext({ CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(),
        delay: async (ms, signal) => { signal?.throwIfAborted(); currentTime += 10; }
    }, console: { warn() {}, error() {} } });
    vm.runInContext(code('actions/play-video.js'), context);
    await assert.rejects(
        context.CourseActions.playToQuestion(step, player, controller.signal, () => false),
        { name: 'AbortError' }
    );
    assert.equal(seekCalls, 1);
});

function frameHarness() {
    const listeners = {};
    const replies = [];
    let overlayClicks = 0;
    let plays = 0;
    const video = {
        currentTime: 0, duration: 600, readyState: 1, paused: true, ended: false, seeking: false,
        getClientRects: () => [1],
        play: async () => { plays++; video.paused = false; },
        pause: () => { video.paused = true; }
    };
    const parent = { postMessage: data => replies.push(data) };
    const context = vm.createContext({
        AbortController, DOMException, setTimeout, clearTimeout, parent,
        document: {
            querySelectorAll: () => [video],
            querySelector: () => ({ getClientRects: () => [1], click: () => overlayClicks++ })
        },
        window: { addEventListener: (name, callback) => { listeners[name] = callback; } }
    });
    vm.runInContext(code('youtube-frame.js'), context);
    // youtube-frame.js's own internal poll cadence is 300ms (deliberately
    // slowed from 100ms to ease CPU use on weak machines), so a command that
    // needs even one poll cycle to settle can take just over that long for
    // real. waitMs defaults generously so a normal send() isn't racing the
    // very interval being tested; a couple of tests that deliberately
    // interrupt a command mid-retry pass a short waitMs instead, so they
    // still observe the in-between state rather than its eventual outcome.
    async function send(command, extra = {}, event = {}, waitMs = 1200) {
        const n = replies.length;
        listeners.message({ source: parent, origin: 'https://binhdanhocvuso.gov.vn',
            data: { type: 'BDHVS_PLAYER_REQUEST', session: 'session-1', requestId: String(n), command, ...extra }, ...event });
        for (let i = 0; i < 5; i++) await tick();
        const step = 20;
        for (let i = 0; i < Math.ceil(waitMs / step) && !replies[n]; i++) {
            await new Promise(resolve => setTimeout(resolve, step));
        }
        return replies[n];
    }
    return { send, replies, video, listeners, context, overlayClicks: () => overlayClicks, plays: () => plays };
}

test('YouTube frame clicks the supplied overlay, plays, seeks and pauses', async () => {
    const h = frameHarness();
    assert.equal((await h.send('connect')).ok, true);
    assert.equal((await h.send('play')).ok, true);
    assert.equal(h.overlayClicks(), 1);
    assert.equal(h.plays(), 1);
    assert.equal((await h.send('seek', { seconds: 391 })).result.currentTime, 391);
    await h.send('pause');
    assert.equal(h.video.paused, true);
});

test('a seek can still land after YouTube swaps in a new <video> element mid-transition, without timing out', async () => {
    const h = frameHarness();
    await h.send('connect');
    await h.send('play');
    // Simulate seeking far back on an already mostly-watched video: YouTube's
    // own end-of-video/replay transition replaces the <video> element, and
    // the assignment on the old (now detached) element has no visible effect.
    let usingReplacement = false;
    let reads = 0;
    const replacement = { currentTime: 580, duration: 600, readyState: 1, paused: false, ended: false, seeking: false, getClientRects: () => [1] };
    const stale = h.video;
    let staleAssignCount = 0;
    Object.defineProperty(stale, 'currentTime', {
        get() { return 580; },
        set() { staleAssignCount++; },
        configurable: true
    });
    h.context.document.querySelectorAll = () => {
        reads++;
        if (reads > 2) usingReplacement = true;
        return [usingReplacement ? replacement : stale];
    };
    await h.send('seek', { seconds: 0 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const reply = h.replies.at(-1);
    assert.equal(reply.ok, true);
    assert.equal(reply.result.currentTime, 0);
    assert.equal(replacement.currentTime, 0);
    assert.ok(staleAssignCount >= 1);
});

test('YouTube frame rejects foreign origins, stale sessions and invalid seek times', async () => {
    const h = frameHarness();
    assert.equal(await h.send('connect', {}, { origin: 'https://example.com' }), undefined);
    await h.send('connect');
    assert.equal((await h.send('seek', { seconds: 1000 })).ok, false);
    assert.equal((await h.send('play', { session: 'stale' })).ok, false);
    assert.equal(h.plays(), 0);
});

test('Stop aborts a pending play and a late play promise cannot resume the video', async () => {
    const h = frameHarness();
    let resolvePlay;
    h.video.play = () => new Promise(resolve => { resolvePlay = resolve; });
    await h.send('connect');
    await h.send('play');
    await h.send('pause');
    h.video.paused = false;
    resolvePlay();
    await tick();
    assert.equal(h.video.paused, true);
});

test('YouTube retries an interrupted play after startup settles', async () => {
    const h = frameHarness();
    let attempts = 0;
    h.video.play = async () => {
        if (++attempts === 1) throw new DOMException('Interrupted by pause()', 'AbortError');
        h.video.paused = false;
    };
    await h.send('connect');
    await h.send('play');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(h.replies.at(-1).ok, true);
    assert.equal(attempts, 2);
});

test('YouTube retries browser autoplay denial only once before requesting interaction', async () => {
    const h = frameHarness();
    let attempts = 0;
    h.video.play = async () => {
        attempts++;
        throw new DOMException('Autoplay denied', 'NotAllowedError');
    };
    await h.send('connect');
    await h.send('play');
    await new Promise(resolve => setTimeout(resolve, 500));
    const reply = h.replies.at(-1);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /Hãy nhấn Play/);
    assert.equal(attempts, 2);
});

test('YouTube mutes before overlay click and restores muted playback after autoplay denial', async () => {
    const h = frameHarness();
    let attempts = 0;
    h.context.document.querySelector = () => ({
        getClientRects: () => [1],
        click: () => {
            assert.equal(h.video.muted, true);
            assert.equal(h.video.volume, 0);
            h.video.muted = false;
            h.video.volume = 1;
        }
    });
    h.video.play = async () => {
        assert.equal(h.video.muted, true);
        assert.equal(h.video.defaultMuted, true);
        assert.equal(h.video.volume, 0);
        assert.equal(h.video.playsInline, true);
        if (++attempts === 1) {
            h.video.muted = false;
            h.video.volume = 1;
            throw new DOMException('Interaction required', 'NotAllowedError');
        }
        h.video.paused = false;
    };
    await h.send('connect');
    await h.send('play');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(h.replies.at(-1).ok, true);
    assert.equal(attempts, 2);
});

test('Stop during interrupted-play retry prevents another play call', async () => {
    const h = frameHarness();
    let attempts = 0;
    h.video.play = async () => {
        attempts++;
        throw new DOMException('Interrupted', 'AbortError');
    };
    await h.send('connect');
    // A short budget here on purpose: just enough real time for the first
    // (microtask-scheduled) play attempt to fail, but well under the 300ms
    // poll cadence that would let a second attempt get scheduled -- this
    // test is about catching Stop in between the two.
    await h.send('play', {}, {}, 100);
    await h.send('pause');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(attempts, 1);
    assert.equal(h.video.paused, true);
});

test('parent player bridge connects to the correct iframe and sends Play/seek/Stop end to end', async () => {
    const frame = frameHarness();
    const listeners = new Set();
    let hostPlayClicks = 0;
    const parent = frame.context.parent;
    const iframeWindow = {
        postMessage: message => queueMicrotask(() => frame.listeners.message({
            source: parent, origin: 'https://binhdanhocvuso.gov.vn', data: message
        }))
    };
    parent.postMessage = message => queueMicrotask(() => {
        for (const listener of listeners) listener({ source: iframeWindow, origin: 'https://www.youtube.com', data: message });
    });
    const iframe = { src: 'https://www.youtube.com/embed/ZX18adOn4h4?enablejsapi=1', contentWindow: iframeWindow, isConnected: true };
    const hostPlay = {};
    const controller = new AbortController();
    const context = vm.createContext({
        URL, crypto: webcrypto, DOMException, setTimeout, clearTimeout,
        window: { addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) },
        CourseSite: {
            find: selector => selector.startsWith('iframe') ? iframe : hostPlay,
            click: () => hostPlayClicks++, throwIfAborted: signal => signal.throwIfAborted()
        }
    });
    vm.runInContext(code('media-player.js'), context);
    const player = await context.CourseMedia.connect({}, controller.signal);
    await player.play();
    await player.seek(391);
    assert.equal((await player.getState()).currentTime, 391);
    assert.equal(frame.overlayClicks(), 1);
    assert.equal(hostPlayClicks, 1);
    controller.abort();
    await tick();
    assert.equal(frame.video.paused, true);
    player.release();
    await tick();
    assert.equal(listeners.size, 0);
});

test('release() swallows a postMessage origin mismatch instead of throwing, and still finishes cleanup', async () => {
    const listeners = new Set();
    let releaseAttempted = false;
    const iframeWindow = {
        postMessage: message => {
            if (message.command === 'release') {
                releaseAttempted = true;
                // Mirrors a real failure seen on live runs: the iframe can
                // momentarily show a different document (e.g. mid a
                // self-reload the site triggers right after its own
                // in-video-quiz widget breaks) so postMessage's target-origin
                // check fails, even though nothing is functionally wrong
                // with the run itself.
                throw new DOMException(
                    "Failed to execute 'postMessage' on 'DOMWindow': The target origin provided " +
                    "('https://www.youtube.com') does not match the recipient window's origin " +
                    "('https://binhdanhocvuso.gov.vn').", 'SyntaxError');
            }
            queueMicrotask(() => {
                for (const listener of listeners) {
                    listener({
                        source: iframeWindow, origin: 'https://www.youtube.com', data: {
                            type: 'BDHVS_PLAYER_RESPONSE', session: message.session, requestId: message.requestId,
                            ok: true, result: { ready: true, duration: 600, currentTime: 0, paused: true, ended: false }
                        }
                    });
                }
            });
        }
    };
    const iframe = { src: 'https://www.youtube.com/embed/ZX18adOn4h4?enablejsapi=1', contentWindow: iframeWindow, isConnected: true };
    const controller = new AbortController();
    const context = vm.createContext({
        URL, crypto: webcrypto, DOMException, setTimeout, clearTimeout,
        window: { addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) },
        CourseSite: { find: () => iframe, throwIfAborted: signal => signal.throwIfAborted() }
    });
    vm.runInContext(code('media-player.js'), context);
    const player = await context.CourseMedia.connect({}, controller.signal);
    assert.doesNotThrow(() => player.release());
    await tick();
    assert.equal(releaseAttempted, true);
    assert.equal(listeners.size, 0);
});

test('post() retries on transient postMessage target origin mismatch and succeeds once resolved', async () => {
    const listeners = new Set();
    let attempts = 0;
    const iframeWindow = {
        postMessage: message => {
            if (message.command === 'state' && ++attempts < 3) {
                throw new DOMException(
                    "Failed to execute 'postMessage' on 'DOMWindow': The target origin provided " +
                    "('https://www.youtube.com') does not match the recipient window's origin " +
                    "('https://binhdanhocvuso.gov.vn').", 'SyntaxError');
            }
            queueMicrotask(() => {
                for (const listener of listeners) {
                    listener({
                        source: iframeWindow, origin: 'https://www.youtube.com', data: {
                            type: 'BDHVS_PLAYER_RESPONSE', session: message.session, requestId: message.requestId,
                            ok: true, result: { ready: true, duration: 600, currentTime: 50, paused: false, ended: false }
                        }
                    });
                }
            });
        }
    };
    const iframe = { src: 'https://www.youtube.com/embed/ZX18adOn4h4?enablejsapi=1', contentWindow: iframeWindow, isConnected: true };
    const controller = new AbortController();
    const context = vm.createContext({
        URL, crypto: webcrypto, DOMException, setTimeout, clearTimeout,
        window: { addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) },
        CourseSite: { find: () => iframe, throwIfAborted: signal => signal.throwIfAborted() }
    });
    vm.runInContext(code('media-player.js'), context);
    const player = await context.CourseMedia.connect({}, controller.signal);
    const state = await player.getState();
    assert.equal(state.currentTime, 50);
    assert.equal(attempts, 3);
    player.release();
});

