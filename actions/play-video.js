(function (root) {
    'use strict';
    // Each poll here is a round trip into the YouTube iframe (post a command,
    // wait for its reply), not just a local DOM check -- heavier than a plain
    // wait loop, so it benefits the most from a slower cadence. Nothing here
    // is watched interactively; 400ms keeps runs feeling prompt while cutting
    // the number of cross-frame round trips roughly in half versus the
    // previous 200ms, which matters on a machine that is already struggling
    // to keep up with normal page work.
    const STATE_POLL_MS = 400;
    async function waitForState(player, signal, predicate, label, timeoutMs = 90000) {
        const deadline = Date.now() + timeoutMs;
        let lastTime = -1;
        while (Date.now() < deadline) {
            root.CourseSite.throwIfAborted(signal);
            try {
                const state = await player.getState();
                if (state.error) throw new Error(state.error);
                if (state.currentTime !== lastTime || !state.paused) {
                    lastTime = state.currentTime;
                    signal?.heartbeat?.();
                }
                if (predicate(state)) return state;
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                const isTransient = error.message?.includes('Chưa kết nối được') ||
                    error.message?.includes('target origin provided') ||
                    error.message?.includes('does not match') ||
                    error.name === 'SyntaxError' ||
                    error.name === 'SecurityError';
                if (!isTransient) throw error;
            }
            await root.CourseSite.delay(STATE_POLL_MS, signal);
        }
        throw new Error('Hết thời gian chờ ' + label + '. Video có thể đang dừng hoặc chưa tải được.');
    }
    async function seekWithRetry(player, signal, seconds) {
        try {
            return await player.seek(seconds);
        } catch (error) {
            // A glitched YouTube player can make a single seek command time
            // out (observed on real runs together with repeated errors from
            // the site's own in-video-quiz script, most likely a player
            // instance the page briefly lost its reference to) even though
            // the page recovers a little later. Wait briefly, then try once
            // more against whatever <video> element exists by then; if that
            // also fails, give up for real rather than guessing at a
            // position that was never confirmed.
            if (error.name === 'AbortError') throw error;
            root.CourseSite.throwIfAborted(signal);
            console.warn('[Bình dân học vụ số] Tua video hết thời gian chờ, đang thử lại một lần...');
            await root.CourseSite.delay(1500, signal);
            return player.seek(seconds);
        }
    }
    const log = (...args) => { if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(...args); };
    async function playToQuestion(step, player, signal, questionVisible = () => false) {
        if (questionVisible()) {
            log('[Bình dân học vụ số] 🎯 Bảng câu hỏi đã hiển thị sẵn trên trang.');
            return player.getState();
        }
        player.muted = true;
        await player.play();
        let ready = await waitForState(player, signal, state => state.ready && state.duration > 0, 'thời lượng video', 30000);
        const videoLabel = [step.lesson?.title, step.video?.title].filter(Boolean).join(' / ') || 'Video';
        log('[Bình dân học vụ số] 🎬 ' + videoLabel + ': thời lượng ' + Math.round(ready.duration) + 's');
        if (step.question.timeSeconds > ready.duration) throw new Error('Mốc câu hỏi vượt thời lượng video.');
        if (step.resetToStart && !questionVisible()) {
            log('[Bình dân học vụ số] ⏪ Tua về 00:00 trước khi phát');
            // Never trust wherever the player happened to restore its position
            // to — a fresh video always starts being timed from 00:00.
            root.CourseSite.throwIfAborted(signal);
            try {
                await player.seek(0);
                ready = await player.getState();
                if (ready.paused && !questionVisible()) {
                    await player.play();
                    ready = await player.getState();
                }
            } catch (error) {
                // A video already watched past this question can still be
                // finishing YouTube's own end-of-video/replay transition,
                // which can make seeking all the way back to 00:00 time out.
                // Do not fail the whole step over this one-time reset —
                // fall back to wherever the video already is and continue.
                if (error.name === 'AbortError') throw error;
                root.CourseSite.throwIfAborted(signal);
                ready = await player.getState();
            }
        }
        const started = await waitBeforeSeek(player, signal, ready, questionVisible);
        if (questionVisible() || started.currentTime >= step.question.timeSeconds - 0.3) {
            log('[Bình dân học vụ số] 🎯 Đã thấy câu hỏi hoặc video đã ở mốc ' + (step.question.time || step.question.timeSeconds + 's'));
            return started;
        }
        root.CourseSite.throwIfAborted(signal);
        log('[Bình dân học vụ số] ⏩ Đang tua video đến ' + step.seekSeconds + 's (mốc câu hỏi ' + (step.question.time || step.question.timeSeconds + 's') + ')...');
        await seekWithRetry(player, signal, step.seekSeconds);
        const afterSeek = await player.getState();
        if (afterSeek.paused && !questionVisible()) await player.play();
        const reached = await waitForState(player, signal,
            state => questionVisible() || state.currentTime >= step.question.timeSeconds - 0.3,
            'mốc câu hỏi ' + (step.question.time || step.question.timeSeconds + 's'));
        log('[Bình dân học vụ số] 🎯 Video đã chạy tới mốc câu hỏi: vị trí ' + Math.round(reached.currentTime) + 's');
        return reached;
    }
    async function skipVideoToEnd(player, signal) {
        await player.play();
        const ready = await waitForState(player, signal, state => state.ready && state.duration > 0, 'thời lượng video', 30000);
        log('[Bình dân học vụ số] 🎬 Video không câu hỏi: tua tới cuối video...');
        const started = await waitBeforeSeek(player, signal, ready);
        if (started.ended) return started;
        root.CourseSite.throwIfAborted(signal);
        // Leave the last second to play naturally, so ended/completion events can fire.
        await seekWithRetry(player, signal, Math.max(0, ready.duration - 1));
        if ((await player.getState()).paused) await player.play();
        const endedState = await waitForState(player, signal, state => state.ended, 'video phát hết', 30000);
        log('[Bình dân học vụ số] ✔️ Video đã phát hết (ended)');
        return endedState;
    }
    async function waitBeforeSeek(player, signal, ready, questionVisible = () => false) {
        // currentTime can jump when YouTube restores a saved position. Require
        // five wall-clock seconds as well, not just a five-second media delta.
        await root.CourseSite.delay(5000, signal);
        const startTime = ready.currentTime;
        return waitForState(player, signal, state => questionVisible() || state.ended ||
            (!state.paused && state.currentTime - startTime >= 5), 'video chạy 5 giây trước khi tua');
    }
    root.CourseActions = { ...root.CourseActions, playToQuestion, skipVideoToEnd };
})(globalThis);
