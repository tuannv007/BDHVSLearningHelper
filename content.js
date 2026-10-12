/* One cancellable runner per top-level document. */
(function () {
    'use strict';
    let controller = null;
    let activeRunId = null;
    let activeVideo = null;
    let booting = false;
    let bootEpoch = 0;
    let leaving = false;
    const site = CourseSite;
    let currentLessonName = '';
    let logHistory = [];
    let closedRunId = null;

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function appendLog(text, type = 'info', lessonTitle = currentLessonName) {
        const now = new Date();
        const timeStr = [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map(n => String(n).padStart(2, '0')).join(':');
        const entry = {
            id: Date.now() + Math.random(),
            time: timeStr,
            lesson: lessonTitle || '',
            text: text,
            type: type
        };
        logHistory.push(entry);
        if (logHistory.length > 250) logHistory.shift();
        if (typeof chrome !== 'undefined' && typeof chrome.storage?.local?.set === 'function') {
            chrome.storage.local.set({ courseLogHistory: logHistory }).catch(() => {});
        }
        try { renderLogHistoryUI(); } catch {}
    }

    const log = (...args) => {
        if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(...args);
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        const cleanMsg = msg.replace(/^\[Bình dân học vụ số\]\s*/, '');
        const isSuccess = cleanMsg.includes('✔️') || cleanMsg.includes('✅') || cleanMsg.includes('thành công') || cleanMsg.includes('HOÀN THÀNH');
        appendLog(cleanMsg, isSuccess ? 'success' : 'info');
    };
    const warn = (...args) => {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(...args);
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        const cleanMsg = msg.replace(/^\[Bình dân học vụ số\]\s*/, '');
        appendLog(cleanMsg, 'warning');
    };

    function cancel() {
        bootEpoch++;
        controller?.abort();
        activeVideo?.pause();
        activeVideo = null;
    }

    // Chrome can tear down the background service worker whenever it wants
    // the memory back -- far more often on a low-RAM machine -- and a
    // request that lands right as that happens gets no response at all
    // ("message port closed before a response was received" / "Could not
    // establish connection"), even though nothing about the run itself is
    // wrong. Chrome wakes the worker again on its own for the very next
    // message, so a couple of short retries ride out that race instead of
    // ending the whole run over bad timing. Anything else (a real error
    // from the worker, or the extension context itself being gone) is not
    // this kind of hiccup and is never retried.
    const TRANSIENT_CHANNEL_ERROR = /Could not establish connection|message port closed before a response/i;
    const CONTEXT_INVALIDATED_ERROR = /Extension context invalidated/i;
    async function send(message) {
        for (let attempt = 0; ; attempt++) {
            let response;
            try {
                response = await chrome.runtime.sendMessage(message);
            } catch (error) {
                if (CONTEXT_INVALIDATED_ERROR.test(error?.message || '')) {
                    cancel();
                    throw error;
                }
                if (attempt >= 2 || !TRANSIENT_CHANNEL_ERROR.test(error?.message || '')) throw error;
                await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
                continue;
            }
            if (!response?.ok) throw new Error(response?.error || 'Không kết nối được background.');
            return response.task;
        }
    }

    // Shared with the run loop in start() below: any "Hết thời gian chờ..."
    // message is a plain deadline-exceeded timeout, never a real bug and
    // never Stop (that always throws AbortError instead, checked first).
    function isTimeout(error) {
        return error.name !== 'AbortError' && typeof error.message === 'string' &&
            error.message.startsWith('Hết thời gian chờ');
    }
    // A single in-video question, a single no-question video, or switching to
    // a single video tab can each time out on their own -- most often the
    // same site-side widget glitch documented in README's "Câu hỏi trong
    // video bị kẹt do lỗi ở chính trang" (YouTube swaps its player instance,
    // the page's own quiz script loses its reference, nothing about our side
    // is actually wrong). Giving up on just THAT one item and moving on to
    // the next is safe for these three step types specifically: whatever
    // runs next re-locates its own DOM target from scratch, so one skipped
    // item cannot corrupt anything later in the run. This is deliberately
    // NOT extended to whole-lesson/navigation steps (opening a lesson,
    // discovering tabs, the module/final test, returning to the outline) --
    // there, a timeout usually means the page never reached the state the
    // run expects, and ploughing ahead risks silently skipping large parts
    // of the course instead of just one glitchy widget.
    const SKIPPABLE_STEP_TYPES = new Set(['answerQuestion', 'skipVideoToEnd', 'openVideo']);

    // The wait budgets nested inside these three step types (site.waitFor's
    // own 30s default, play-video.js's 90s default for reaching the question
    // mark, media-player.js's 20-40s postMessage timeouts, and so on) were
    // never designed with "give up and skip" in mind -- they were tuned for
    // "keep trying, this matters". Now that a timeout here just means moving
    // on to the next question/video, there is no reason to let any of that
    // run its full original course first: 15s is plenty to tell a genuine
    // site glitch apart from a slow page, and capping it here (instead of
    // lowering every nested timeoutMs individually) keeps this one number as
    // the single place that controls it, whatever is waiting underneath.
    // This intentionally supersedes answerQuestion's own `.neverSkip` timing
    // (which needed its full ~30s budget to tell "confirmed unanswered"
    // apart from "just slow") -- at 15s that inner distinction can no longer
    // finish before this cap fires, so it no longer has a chance to apply.
    const STEP_TIMEOUT_MS = 35000;

    // Races a step's own signal against an activity/stall watchdog: aborting
    // the returned signal cancels whatever is in flight (video waits, postMessage
    // commands, DOM polling) exactly the way Stop already does.
    // Unlike a blind wall-clock deadline that cuts off active playback,
    // this watchdog extends its timer whenever genuine progress is made
    // (video playback advancing, DOM elements interacting, question phases completing).
    // It only aborts when the step is truly stalled (zero progress for ms).
    function withStepTimeout(signal, ms) {
        const stepController = new AbortController();
        const forwardAbort = () => stepController.abort();
        if (signal.aborted) stepController.abort();
        else signal.addEventListener('abort', forwardAbort, { once: true });
        let timedOut = false;
        let timer = null;
        function resetTimer() {
            if (timedOut || stepController.signal.aborted) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timedOut = true; stepController.abort(); }, ms);
        }
        resetTimer();
        stepController.signal.heartbeat = resetTimer;
        return {
            signal: stepController.signal,
            heartbeat: resetTimer,
            timedOut: () => timedOut,
            cleanup() {
                if (timer) clearTimeout(timer);
                signal.removeEventListener('abort', forwardAbort);
            }
        };
    }

    async function withPlayer(step, signal, action) {
        const container = await site.waitFor(() => CourseActions.videoContainer(step), signal, 'player của tab đang chọn');
        const player = await CourseMedia.connect(container, signal);
        activeVideo = player;
        try {
            return await action(player);
        } finally {
            player.pause();
            player.release();
            if (activeVideo === player) activeVideo = null;
        }
    }

    async function answerQuestion(step, signal) {
        // Missing question HTML must not prevent the implemented Play/seek action.
        let css;
        let configError;
        try { css = site.questionSelectors(step); }
        catch (error) {
            if (error.code !== 'CONFIG_REQUIRED') throw error;
            configError = error;
        }
        signal?.heartbeat?.();
        // A timeout here can mean the widget on the page itself got stuck
        // (observed on real videos: the site's own in-video-quiz script starts
        // throwing errors, most likely after YouTube swaps its player instance
        // near the end of a video, and then never shows/hides the panel again)
        // even though the answer was already submitted and recorded. Try a
        // short 5s wait first; if that's not enough AND data-attempts-used
        // already confirms the answer was saved, don't keep waiting — log a
        // warning and move on instead of stopping the whole run. Only when
        // the answer is NOT yet confirmed saved does it fall back to the
        // rest of the original ~30s budget (the site may just still be
        // processing), and only a genuine timeout is ever downgraded like
        // this — Stop (AbortError) and any other error still fail the step.
        const TOLERANCE_GRACE_MS = 5000;
        const TOLERANCE_TOTAL_MS = 30000;
        async function waitTolerant(probe, description) {
            signal?.heartbeat?.();
            try {
                return await site.waitFor(probe, signal, description, TOLERANCE_GRACE_MS);
            } catch (error) {
                if (!isTimeout(error)) throw error;
                if (!site.find(css.answered)) {
                    try {
                        return await site.waitFor(probe, signal, description, TOLERANCE_TOTAL_MS - TOLERANCE_GRACE_MS);
                    } catch (finalError) {
                        // Unlike every other timeout in this file (including the
                        // "tolerated" case just below, and the run loop's own
                        // skip-and-continue in start()), this one is never let
                        // through quietly: the answer was still not confirmed
                        // saved even after the full budget, so the question may
                        // genuinely be unanswered on the real site. That must
                        // still stop the run and get reported, not count as done.
                        if (isTimeout(finalError)) finalError.neverSkip = true;
                        throw finalError;
                    }
                }
                return { tolerated: true };
            }
        }
        async function continueQuestion() {
            signal?.heartbeat?.();
            const found = await waitTolerant(() => {
                const currentPanel = site.find(css.panel);
                if (!currentPanel) return null;
                const wrapper = currentPanel.closest?.('.in-video-problem-wrapper') || currentPanel;
                return site.find(css.continue, wrapper);
            }, 'nút Continue sau câu hỏi');
            if (found?.tolerated) {
                console.warn('[Bình dân học vụ số] Quá thời gian chờ, không thấy nút Continue sau câu hỏi (đáp án đã được ghi nhận, có thể do lỗi ở widget câu hỏi của trang) — coi như đã xong câu hỏi, tiếp tục.');
                return;
            }
            site.click(found, signal);
            signal?.heartbeat?.();
            const closed = await waitTolerant(() => !site.find(css.panel), 'đóng câu hỏi');
            if (closed?.tolerated) {
                console.warn('[Bình dân học vụ số] Quá thời gian chờ, bảng câu hỏi không tự đóng (đáp án đã được ghi nhận, có thể do lỗi ở widget câu hỏi của trang) — vẫn tiếp tục.');
            }
        }
        if (css && site.find(css.answered)) {
            log('[Bình dân học vụ số] ℹ️ ' + (step.lesson?.title || '') + ' / ' + (step.video?.title || '') + ' · Câu hỏi mốc ' + step.question.time + ' đã được lưu đáp án trước đó.');
            if (css.continue) await continueQuestion();
            return;
        }
        await withPlayer(step, signal, async player => {
            if (!css || !site.find(css.panel)) {
                log('[Bình dân học vụ số] ⏳ Đang phát video đến mốc ' + (step.question?.time || step.question?.timeSeconds + 's') + '...');
                await CourseActions.playToQuestion(step, player, signal, () => css && !!site.find(css.panel));
            }
            if (configError) throw configError;
            signal?.heartbeat?.();

            log('[Bình dân học vụ số] 📋 Đã thấy bảng câu hỏi tại ' + step.question.time);
            const panel = await site.waitFor(() => site.find(css.panel), signal, 'câu hỏi tại ' + step.question.time);
            signal?.heartbeat?.();
            const opt = await site.waitFor(() => site.find(css.option, panel), signal, 'đáp án ' + step.question.answer);
            site.click(opt, signal);
            signal?.heartbeat?.();

            // Cơ chế tự sửa lỗi nếu thẻ radio chưa nhận checked
            if (opt && typeof opt === 'object') {
                if (opt.checked === false) {
                    log('[Bình dân học vụ số] 🔄 Đáp án chưa nhận trạng thái checked, tự động kích hoạt lại sự kiện...');
                    try {
                        const label = (typeof opt.closest === 'function' ? opt.closest('label') : null) ||
                            (opt.id && typeof site.find === 'function' ? site.find('label[for="' + opt.id + '"]') : null);
                        if (label && label !== opt) {
                            try { site.click(label, signal); } catch {}
                        }
                        opt.checked = true;
                        if (typeof opt.dispatchEvent === 'function') {
                            opt.dispatchEvent(new Event('change', { bubbles: true }));
                            opt.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    } catch {}
                }
            }
            log('[Bình dân học vụ số] 👉 Đã chọn đáp án: ' + step.question.answer);
            signal?.heartbeat?.();

            // Nộp đáp án
            if (css.submit) {
                const submitBtn = await site.waitFor(() => {
                    const currentPanel = site.find(css.panel);
                    return currentPanel && site.find(css.submit, currentPanel);
                }, signal, 'nút xác nhận đáp án');
                site.click(submitBtn, signal);
                log('[Bình dân học vụ số] 📤 Đã bấm Gửi xác nhận đáp án ' + step.question.answer);
                signal?.heartbeat?.();
            }

            if (css.continue) {
                log('[Bình dân học vụ số] ⏳ Chờ nút Continue...');
                // The in-video widget owns Continue; its attempt counter may stay
                // unchanged after submission. Let the widget handle this action.
                await continueQuestion();
                log('[Bình dân học vụ số] ⏭️ Đã bấm Continue, đóng bảng câu hỏi.');
            } else {
                await site.waitFor(() => site.find(css.answered), signal, 'xác nhận đã lưu đáp án');
                log('[Bình dân học vụ số] ✅ Xác nhận đáp án đã được lưu thành công.');
            }
            signal?.heartbeat?.();
        });
    }

    async function execute(task, signal) {
        const step = task.step;
        site.throwIfAborted(signal);
        if (step.type === 'wait') return site.delay(step.ms, signal);
        if (step.type === 'openLessonVideo') {
            return CourseActions.openLessonVideo(step, signal, {
                path: task.path, navigation: task.navigation,
                prepareNavigation: async (phase, url) => {
                    const next = await send({
                        type: 'COURSE_PREPARE_NAVIGATION', runId: task.runId,
                        stepIndex: task.stepIndex, phase, url
                    });
                    if (!next?.step) throw new DOMException('Đã dừng', 'AbortError');
                }
            });
        }
        if (step.type === 'discoverVideoTabs') {
            const tabs = await CourseActions.discoverVideoTabs(signal);
            const next = await send({ type: 'COURSE_SYNC_TABS', runId: task.runId, stepIndex: task.stepIndex, tabs });
            if (!next?.step) throw new DOMException('Đã dừng', 'AbortError');
            return;
        }
        if (step.type === 'openVideo') return CourseActions.openVideoTab(step, signal);
        if (step.type === 'skipVideoToEnd') {
            return withPlayer(step, signal, player => CourseActions.skipVideoToEnd(player, signal));
        }
        if (step.type === 'answerQuestion') return answerQuestion(step, signal);
        if (step.type === 'answerLessonTest') return CourseActions.answerLessonTest(step, signal, task.path);
        if (step.type === 'openFinalReview') {
            return CourseActions.openFinalReview(step, signal, {
                path: task.path, navigation: task.navigation,
                prepareNavigation: async (phase, url) => {
                    const next = await send({
                        type: 'COURSE_PREPARE_NAVIGATION', runId: task.runId,
                        stepIndex: task.stepIndex, phase, url
                    });
                    if (!next?.step) throw new DOMException('Đã dừng', 'AbortError');
                }
            });
        }
        if (step.type === 'returnToOutline') return CourseActions.returnToOutline(signal, task.path);
        throw new Error('Bước không hỗ trợ: ' + step.type);
    }

    async function start() {
        if (booting || controller || leaving) return;
        booting = true;
        const epoch = bootEpoch;
        let task;
        try {
            task = await send({ type: 'COURSE_READY' });
            if (!task?.step || epoch !== bootEpoch || leaving) return;
            // Covers Stop racing the initial READY response.
            const saved = (await chrome.storage.local.get('courseRun')).courseRun;
            if (saved?.status !== 'running' || saved.id !== task.runId || epoch !== bootEpoch || leaving) return;
            controller = new AbortController();
            const signal = controller.signal;
            activeRunId = task.runId;
            if (task.runId !== closedRunId) closedRunId = null;
            while (task?.step) {
                site.throwIfAborted(signal);
                if (!CourseRunner.isCoursePage(location.href, task.path)) {
                    throw new Error('Trang hiện tại không thuộc khóa học đã chọn.');
                }
                if (task.step.lesson?.title) currentLessonName = task.step.lesson.title;
                else if (task.step.manualPage && task.step.pageTitle) currentLessonName = task.step.pageTitle;
                else if (task.step.review) currentLessonName = 'Kiểm tra cuối khóa';
                let desc = task.step.type;
                try { desc = CourseRunner.describeStep(task.step); } catch {}
                const stepNum = task.stepIndex + 1;
                const lessonTag = currentLessonName ? '[' + currentLessonName + '] ' : '';
                log('[Bình dân học vụ số] ▶️ ' + lessonTag + 'BƯỚC ' + stepNum + ': ' + desc);
                const skippable = SKIPPABLE_STEP_TYPES.has(task.step.type);
                const stepTimeout = skippable ? withStepTimeout(signal, STEP_TIMEOUT_MS) : null;
                let isSkipped = false;
                let skipDetail = null;
                try {
                    await execute(task, stepTimeout ? stepTimeout.signal : signal);
                    log('[Bình dân học vụ số] ✔️ ' + lessonTag + 'HOÀN THÀNH BƯỚC ' + stepNum + ': ' + desc);
                } catch (error) {
                    // Either this step's own timeout naturally fired somewhere
                    // inside it (isTimeout), or nothing had resolved by the 15s
                    // cap and withStepTimeout gave up on its behalf (its signal
                    // aborting looks identical to Stop, so only timedOut() can
                    // tell the difference) -- either way is a plain "gave up",
                    // never a real Stop or a genuine bug.
                    const capped = Boolean(stepTimeout?.timedOut()) && error.name === 'AbortError';
                    if (!skippable || error.neverSkip || !(isTimeout(error) || capped)) throw error;
                    isSkipped = true;
                    skipDetail = capped ? 'Bỏ qua do quá ' + (STEP_TIMEOUT_MS / 1000) + ' giây' : error.message;
                    // Quietly move on instead of reporting COURSE_STEP_ERROR: the
                    // popup keeps showing "Đang chạy" and progress keeps advancing
                    // rather than stopping the whole run over one glitchy item.
                    // Still logged locally (console only, no extra messaging) so a
                    // real pattern is still visible in DevTools if ever needed. A
                    // capped abort loses the specific wait's own message, so name
                    // the question/video from the step data instead.
                    const detail = task.step.question?.time ? 'câu hỏi ' + task.step.question.time :
                        task.step.video?.tab?.title ? 'video ' + task.step.video.tab.title : '';
                    warn('[Bình dân học vụ số] ⚠️ CẢNH BÁO - BỎ QUA BƯỚC BỊ TREO (' + task.step.type +
                        (detail ? ', ' + detail : '') + '): ' +
                        (capped ? 'quá ' + (STEP_TIMEOUT_MS / 1000) + ' giây' : error.message) +
                        ' — BƯỚC NÀY CÓ THỂ CHƯA ĐƯỢC LƯU TRÊN TRANG, tiếp tục bước tiếp theo.');
                } finally {
                    stepTimeout?.cleanup();
                }
                site.throwIfAborted(signal);
                task = await send({
                    type: 'COURSE_STEP_DONE',
                    runId: task.runId,
                    stepIndex: task.stepIndex,
                    skipped: isSkipped,
                    detail: skipDetail
                });
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                if (/Extension context invalidated/i.test(error?.message || '')) {
                    warn('[Bình dân học vụ số] 🔄 Extension vừa được cập nhật hoặc reload. Vui lòng nhấn phím F5 để tải lại trang học.');
                    return;
                }
                console.error('[Bình dân học vụ số]', error);
                const lessonTag = task?.step?.lesson?.title || currentLessonName || 'Khóa học';
                const stepNum = (task?.stepIndex != null) ? (task.stepIndex + 1) : '';
                const errorMsg = String(error?.message || 'Lỗi không xác định');
                const errorDetail = `[LỖI Ở ${lessonTag.toUpperCase()}${stepNum ? ', BƯỚC ' + stepNum : ''}]: ${errorMsg}`;
                appendLog(errorDetail, 'error', lessonTag);
                if (task?.step && !leaving) {
                    await send({
                        type: 'COURSE_STEP_ERROR', runId: task.runId,
                        stepIndex: task.stepIndex, code: error.code, error: error.message
                    }).catch(console.error);
                }
            }
        } finally {
            activeVideo?.pause();
            activeVideo = null;
            controller = null;
            activeRunId = null;
            booting = false;
        }
    }

    function renderLogHistoryUI(run) {
        if (typeof document === 'undefined' || !document.body) return;

        // Xóa panel cũ (nếu có từ phiên bản trước)
        const oldPanel = document.getElementById('bdhvs-floating-panel');
        if (oldPanel) oldPanel.remove();

        const currentRunId = activeRunId || run?.id || 'active';
        // Nếu người dùng đã bấm tắt x ở phiên chạy này thì giữ panel đóng
        if (closedRunId && (closedRunId === currentRunId || closedRunId === 'active')) {
            const existing = document.getElementById('bdhvs-history-panel');
            if (existing) existing.remove();
            return;
        }

        // Nếu đã dừng và không còn nhật ký nào thì ẩn panel
        if (run?.status === 'stopped' && (!logHistory || logHistory.length === 0)) {
            const existing = document.getElementById('bdhvs-history-panel');
            if (existing) existing.remove();
            return;
        }

        let panel = document.getElementById('bdhvs-history-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'bdhvs-history-panel';
            panel.setAttribute('data-minimized', 'false');
            panel.innerHTML = `
                <style>
                    #bdhvs-history-panel {
                        position: fixed;
                        bottom: 16px;
                        right: 16px;
                        width: 50vw;
                        height: 50vh;
                        background: #0f172a;
                        color: #f1f5f9;
                        border: 1px solid #334155;
                        border-radius: 10px;
                        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
                        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                        font-size: 12px;
                        z-index: 2147483647;
                        display: flex;
                        flex-direction: column;
                        overflow: hidden;
                        box-sizing: border-box;
                        transition: height 0.2s ease, width 0.2s ease;
                        overscroll-behavior: contain;
                    }
                    #bdhvs-history-panel[data-minimized="true"] {
                        height: 38px !important;
                        width: 280px !important;
                    }
                    #bdhvs-history-panel * { box-sizing: border-box; }
                    .bdhvs-header {
                        padding: 8px 12px;
                        background: #1e293b;
                        border-bottom: 1px solid #334155;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        user-select: none;
                        cursor: pointer;
                        height: 38px;
                        flex-shrink: 0;
                    }
                    .bdhvs-title-wrap {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        font-weight: 600;
                        font-size: 12px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                    }
                    .bdhvs-status-badge {
                        display: inline-block;
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        background: #60a5fa;
                        box-shadow: 0 0 8px #60a5fa;
                        flex-shrink: 0;
                    }
                    .bdhvs-status-badge.completed { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
                    .bdhvs-status-badge.error { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
                    .bdhvs-status-badge.stopped { background: #94a3b8; box-shadow: none; }
                    .bdhvs-controls { display: flex; align-items: center; gap: 4px; }
                    .bdhvs-btn-icon {
                        background: transparent;
                        border: none;
                        color: #94a3b8;
                        cursor: pointer;
                        padding: 3px 7px;
                        border-radius: 4px;
                        font-size: 13px;
                        line-height: 1;
                    }
                    .bdhvs-btn-icon:hover { background: #334155; color: #f8fafc; }
                    .bdhvs-btn-close {
                        font-size: 13px;
                        font-weight: bold;
                    }
                    .bdhvs-btn-close:hover {
                        background: #ef4444 !important;
                        color: #ffffff !important;
                    }
                    .bdhvs-body {
                        padding: 10px 14px;
                        overflow-y: auto;
                        flex: 1;
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                        background: #0f172a;
                        overscroll-behavior: contain;
                    }
                    #bdhvs-history-panel[data-minimized="true"] .bdhvs-body {
                        display: none;
                    }
                    .bdhvs-log-row {
                        display: flex;
                        gap: 6px;
                        line-height: 1.45;
                        font-size: 12px;
                        word-break: break-word;
                    }
                    .bdhvs-log-time {
                        color: #64748b;
                        font-family: inherit;
                        flex-shrink: 0;
                    }
                    .bdhvs-log-lesson {
                        color: #38bdf8;
                        font-weight: 600;
                        flex-shrink: 0;
                    }
                    .bdhvs-log-text {
                        flex: 1;
                    }
                    .bdhvs-log-row.success {
                        color: #4ade80;
                    }
                    .bdhvs-log-row.info {
                        color: #93c5fd;
                    }
                    .bdhvs-log-row.warning {
                        color: #fbbf24;
                    }
                    .bdhvs-log-row.error {
                        color: #f87171;
                        background: rgba(239, 68, 68, 0.15);
                        border: 1px solid rgba(239, 68, 68, 0.35);
                        padding: 3px 6px;
                        border-radius: 4px;
                        font-weight: 600;
                    }
                    .bdhvs-empty-logs {
                        color: #64748b;
                        text-align: center;
                        padding: 24px;
                        font-style: italic;
                    }
                    .bdhvs-body::-webkit-scrollbar {
                        width: 6px;
                    }
                    .bdhvs-body::-webkit-scrollbar-track {
                        background: #0f172a;
                    }
                    .bdhvs-body::-webkit-scrollbar-thumb {
                        background: #334155;
                        border-radius: 3px;
                    }
                    .bdhvs-body::-webkit-scrollbar-thumb:hover {
                        background: #475569;
                    }
                </style>
                <div class="bdhvs-header">
                    <div class="bdhvs-title-wrap">
                        <span class="bdhvs-status-badge"></span>
                        <span class="bdhvs-title-text">Nhật ký tiến trình</span>
                        <span class="bdhvs-log-count" style="color: #64748b; font-size: 11px;">(0 dòng)</span>
                    </div>
                    <div class="bdhvs-controls">
                        <button class="bdhvs-btn-icon bdhvs-toggle-btn" title="Thu nhỏ / Phóng to (1/2 màn hình)">—</button>
                        <button class="bdhvs-btn-icon bdhvs-btn-close" title="Đóng bảng nhật ký">✕</button>
                    </div>
                </div>
                <div class="bdhvs-body"></div>
            `;
            document.body.appendChild(panel);

            const toggleBtn = panel.querySelector('.bdhvs-toggle-btn');
            const header = panel.querySelector('.bdhvs-header');
            const closeBtn = panel.querySelector('.bdhvs-btn-close');

            function toggleMinimize(e) {
                if (e) e.stopPropagation();
                const isMin = panel.getAttribute('data-minimized') === 'true';
                if (isMin) {
                    panel.setAttribute('data-minimized', 'false');
                    toggleBtn.textContent = '—';
                } else {
                    panel.setAttribute('data-minimized', 'true');
                    toggleBtn.textContent = '▢';
                }
            }

            toggleBtn.addEventListener('click', toggleMinimize);
            header.addEventListener('click', e => {
                if (panel.getAttribute('data-minimized') === 'true') {
                    toggleMinimize(e);
                }
            });
            closeBtn.addEventListener('click', e => {
                e.stopPropagation();
                closedRunId = activeRunId || run?.id || 'active';
                panel.remove();
            });
            panel.addEventListener('wheel', e => {
                e.stopPropagation();
                const body = panel.querySelector('.bdhvs-body');
                if (body && panel.getAttribute('data-minimized') !== 'true') {
                    body.scrollTop += e.deltaY;
                    if (e.deltaX) body.scrollLeft += e.deltaX;
                }
                e.preventDefault();
            }, { passive: false });
        }

        const status = run?.status || 'running';
        const badge = panel.querySelector('.bdhvs-status-badge');
        if (badge) badge.className = 'bdhvs-status-badge ' + status;

        const countText = panel.querySelector('.bdhvs-log-count');
        if (countText) countText.textContent = '(' + logHistory.length + ' dòng)';

        const body = panel.querySelector('.bdhvs-body');
        if (body) {
            if (logHistory.length === 0) {
                body.innerHTML = '<div class="bdhvs-empty-logs">Chưa có nhật ký nào. Đang đợi các bước...</div>';
            } else {
                let html = '';
                for (const item of logHistory) {
                    const typeClass = item.type || 'info';
                    const lessonPart = item.lesson ? `<span class="bdhvs-log-lesson">[${escapeHtml(item.lesson)}]</span> ` : '';
                    html += `
                        <div class="bdhvs-log-row ${typeClass}">
                            <span class="bdhvs-log-time">[${item.time || ''}]</span>
                            ${lessonPart}
                            <span class="bdhvs-log-text">${escapeHtml(item.text || '')}</span>
                        </div>
                    `;
                }
                body.innerHTML = html;
                body.scrollTop = body.scrollHeight;
            }
        }
    }

    function renderWelcomeBadgeUI() {
        const container = document.getElementById('bdhvs-welcome-container');
        if (container) container.remove();
    }

    function updateFloatingUI(run) {
        try { renderLogHistoryUI(run); } catch {}
        try { renderWelcomeBadgeUI(); } catch {}
    }

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message.type === 'COURSE_RUN_START') {
            closedRunId = null;
            void start();
            respond({ ok: true });
        }
        if (message.type === 'COURSE_CANCEL' && (!activeRunId || message.runId === activeRunId)) {
            cancel();
            respond({ ok: true });
        }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.courseLogHistory && Array.isArray(changes.courseLogHistory.newValue)) {
            logHistory = changes.courseLogHistory.newValue;
        }
        if (changes.courseRun) {
            const run = changes.courseRun.newValue;
            if (run?.id && run.id !== closedRunId) closedRunId = null;
            if (!run || run.status !== 'running' || (activeRunId && run.id !== activeRunId)) cancel();
            try { updateFloatingUI(run); } catch {}
        } else if (changes.courseLogHistory) {
            try { updateFloatingUI(); } catch {}
        }
    });
    window.addEventListener('pagehide', () => { leaving = true; cancel(); });
    window.addEventListener('pageshow', event => {
        if (event.persisted) { leaving = false; void start(); }
    });
    if (typeof chrome !== 'undefined' && typeof chrome.storage?.local?.get === 'function') {
        chrome.storage.local.get(['courseRun', 'courseLogHistory']).then(saved => {
            if (Array.isArray(saved?.courseLogHistory)) {
                logHistory = saved.courseLogHistory;
            }
            try { updateFloatingUI(saved?.courseRun); } catch {}
        }).catch(() => {});
    }
    void start();
})();
