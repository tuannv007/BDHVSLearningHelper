importScripts('course-runner.js');

// Only this worker writes courseRun. A late ACK must never undo Stop.
let operations = Promise.resolve();
function serialize(operation) {
    const result = operations.then(operation);
    operations = result.catch(() => {});
    return result;
}

async function readRun() {
    return (await chrome.storage.local.get('courseRun')).courseRun;
}
async function saveRun(run) {
    run.updatedAt = Date.now();
    await chrome.storage.local.set({ courseRun: run });
}
function payload(run) {
    return {
        runId: run.id, stepIndex: run.stepIndex, path: run.path, navigation: run.navigation || null,
        step: run.status === 'running' ? run.steps[run.stepIndex] : null
    };
}

async function startRun(selectedIds = [], courseId, moduleTestOnly = null) {
    const previous = await readRun();
    if (previous?.status === 'running') throw new Error('Khóa học đang chạy. Hãy Stop trước.');
    const response = await fetch(chrome.runtime.getURL('data.json'));
    if (!response.ok) throw new Error('Không đọc được data.json.');
    const course = CourseRunner.getCourse(await response.json(), courseId);
    const steps = moduleTestOnly != null
        ? CourseRunner.moduleTestOnlySteps(course, moduleTestOnly)
        : CourseRunner.buildSteps(course, selectedIds);
    // A dedicated tab avoids replacing the user's current page. A manual-page
    // run (standalone final review, or just one lesson's module test) instead
    // reuses whichever tab the user already has the right page open in.
    const reviewOnly = moduleTestOnly == null && selectedIds.length === 1 && selectedIds[0] === -1;
    const manualPage = steps[0]?.manualPage === true;
    let tab;
    if (manualPage) {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !CourseRunner.isCoursePage(tab.url, course.path)) {
            throw new Error(moduleTestOnly != null
                ? 'Hãy mở đúng trang "' + steps[0].pageTitle + '" của bài đã chọn trước khi Start.'
                : 'Hãy mở trang kiểm tra cuối khoá của đúng khóa học trước khi Start.');
        }
    } else tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    const selectedLessonIds = moduleTestOnly != null ? [] : reviewOnly ? [-1] : [
        ...course.lessons.filter(l => selectedIds.includes(l.id)).map(l => l.id),
        ...(selectedIds.includes(-1) ? [-1] : [])
    ];
    const run = {
        id: crypto.randomUUID(), status: 'running', tabId: tab.id, documentId: null,
        path: course.path, courseId: course.id, courseTitle: course.title, navigation: null,
        selectedLessonIds, moduleTestOnly, steps, stepIndex: 0, completedQuestions: 0,
        totalQuestions: steps.filter(step => step.type === 'answerQuestion').length +
            steps.filter(step => step.manualPage).reduce((sum, step) => sum + step.questions.length, 0),
        message: moduleTestOnly != null ? 'Đang làm ' + steps[0].pageTitle + '…' : 'Đang mở ' + course.title + '…',
        errorCode: null,
        logs: []
    };
    await saveRun(run);
    try {
        if (manualPage) await chrome.tabs.sendMessage(tab.id, { type: 'COURSE_RUN_START' }, { frameId: 0 });
        else await chrome.tabs.update(tab.id, { url: course.path });
    } catch (error) {
        run.status = 'error';
        run.message = 'Không mở được khóa học: ' + error.message;
        await saveRun(run);
        throw error;
    }
    return { ok: true };
}

async function stopRun(message = 'Đã dừng. Start sẽ chạy lại các bài đã chọn từ đầu.') {
    const run = await readRun();
    if (run?.status !== 'running') return { ok: true };
    run.status = 'stopped';
    run.message = message;
    await saveRun(run);
    await chrome.tabs.sendMessage(run.tabId, { type: 'COURSE_CANCEL', runId: run.id }, { frameId: 0 }).catch(() => {});
    return { ok: true };
}

function isOwner(run, message, sender) {
    return run?.status === 'running' && run.id === message.runId &&
        run.tabId === sender.tab?.id && sender.frameId === 0 &&
        run.documentId === sender.documentId && run.stepIndex === message.stepIndex;
}

function appendOrUpdateLog(run, entry) {
    if (!run) return;
    if (!Array.isArray(run.logs)) run.logs = [];
    const existingIndex = run.logs.findIndex(item => item.stepIndex === entry.stepIndex);
    if (existingIndex >= 0) {
        run.logs[existingIndex] = { ...run.logs[existingIndex], ...entry };
    } else {
        run.logs.push(entry);
    }
}

async function handleMessage(message, sender) {
    const fromPopup = !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
    if (message.type === 'COURSE_START') {
        if (!fromPopup) throw new Error('Chỉ có thể Start từ popup.');
        return startRun(message.selectedLessonIds, message.courseId, message.moduleTestOnly ?? null);
    }
    if (message.type === 'COURSE_STOP') {
        if (!fromPopup) throw new Error('Chỉ có thể Stop từ popup.');
        return stopRun();
    }
    if (message.type === 'OPEN_POPUP') {
        if (typeof chrome !== 'undefined' && chrome.action?.openPopup) {
            return chrome.action.openPopup().catch(() => {});
        }
        return { ok: true };
    }

    const run = await readRun();
    if (message.type === 'COURSE_READY') {
        if (run?.status !== 'running' || run.tabId !== sender.tab?.id || sender.frameId !== 0) {
            return { ok: true, task: null };
        }
        if (!CourseRunner.isCoursePage(sender.url, run.path)) {
            run.status = 'error';
            run.message = 'Chưa vào được khóa học. Hãy đăng nhập, rồi nhấn Start lại.';
            await saveRun(run);
            return { ok: true, task: null };
        }
        run.documentId = sender.documentId;
        run.message = CourseRunner.describeStep(run.steps[run.stepIndex]);
        const curStep = run.steps[run.stepIndex];
        if (curStep) {
            appendOrUpdateLog(run, {
                stepIndex: run.stepIndex,
                lessonId: curStep.lesson?.id ?? null,
                lessonTitle: curStep.lesson?.title ?? 'Khóa học',
                desc: CourseRunner.describeStep(curStep),
                status: 'running',
                timestamp: Date.now()
            });
        }
        await saveRun(run);
        return { ok: true, task: payload(run) };
    }
    if (!isOwner(run, message, sender)) return { ok: true, task: null };
    if (message.type === 'COURSE_SYNC_TABS') {
        const step = run.steps[run.stepIndex];
        if (step.type !== 'discoverVideoTabs') throw new Error('Không phải bước đọc tab.');
        const replacement = CourseRunner.stepsFromTabs(step, message.tabs);
        // A "wait" always precedes whatever comes after this lesson's own
        // steps — the next lesson's openLessonVideo, or the final review's
        // openFinalReview — so any of the three marks where this lesson's
        // block ends. Recognising only openLessonVideo missed the case where
        // the discovered lesson is the LAST one selected and a final review
        // is queued right after it: nothing but a "wait" follows there, so
        // the old check never found a boundary and spliced away the review
        // (and everything else) along with this lesson's own steps.
        const BOUNDARY_TYPES = new Set(['openLessonVideo', 'wait', 'openFinalReview']);
        const nextBoundary = run.steps.findIndex((item, index) => index > run.stepIndex && BOUNDARY_TYPES.has(item.type));
        const end = nextBoundary < 0 ? run.steps.length : nextBoundary;
        run.steps.splice(run.stepIndex + 1, end - run.stepIndex - 1, ...replacement);
        run.totalQuestions = run.steps.filter(item => item.type === 'answerQuestion').length +
            run.steps.filter(item => item.manualPage).reduce((sum, item) => sum + item.questions.length, 0);
        await saveRun(run);
        return { ok: true, task: payload(run) };
    }
    if (message.type === 'COURSE_PREPARE_NAVIGATION') {
        const step = run.steps[run.stepIndex];
        const target = message.phase === 'outline' ? run.path :
            message.phase === 'lecture' ? step.lesson.navigation.lecturePath :
            message.phase === 'review' ? step.navigation.path : null;
        const validPhase = (step.type === 'openLessonVideo' && (message.phase === 'outline' || message.phase === 'lecture')) ||
            (step.type === 'openFinalReview' && message.phase === 'review');
        if (!validPhase || !target || message.url !== target) {
            throw new Error('Đích chuyển trang không khớp action hiện tại.');
        }
        run.navigation = { phase: message.phase, url: target };
        await saveRun(run);
        return { ok: true, task: payload(run) };
    }
    if (message.type === 'COURSE_STEP_DONE') {
        const doneStep = run.steps[run.stepIndex];
        if (doneStep) {
            appendOrUpdateLog(run, {
                stepIndex: run.stepIndex,
                lessonId: doneStep.lesson?.id ?? null,
                lessonTitle: doneStep.lesson?.title ?? 'Khóa học',
                desc: CourseRunner.describeStep(doneStep),
                status: message.skipped ? 'skipped' : 'success',
                detail: message.detail || (message.skipped ? 'Bỏ qua do quá thời gian chờ' : 'Hoàn thành thành công'),
                timestamp: Date.now()
            });
        }
        if (run.steps[run.stepIndex].manualPage) run.completedQuestions += run.steps[run.stepIndex].questions.length;
        if (run.steps[run.stepIndex].type === 'answerQuestion') run.completedQuestions++;
        run.stepIndex++;
        run.navigation = null;
        if (run.stepIndex === run.steps.length) run.status = 'completed';
        run.message = CourseRunner.describeStep(run.steps[run.stepIndex]);
        if (run.status === 'running' && run.stepIndex < run.steps.length) {
            const nextStep = run.steps[run.stepIndex];
            if (nextStep) {
                appendOrUpdateLog(run, {
                    stepIndex: run.stepIndex,
                    lessonId: nextStep.lesson?.id ?? null,
                    lessonTitle: nextStep.lesson?.title ?? 'Khóa học',
                    desc: CourseRunner.describeStep(nextStep),
                    status: 'running',
                    timestamp: Date.now()
                });
            }
        }
        await saveRun(run);
        return { ok: true, task: payload(run) };
    }
    if (message.type === 'COURSE_STEP_ERROR') {
        const errStep = run.steps[run.stepIndex];
        const lessonTitle = errStep?.lesson?.title || 'Khóa học';
        const stepNum = run.stepIndex + 1;
        const errorMsg = String(message.error || 'Không xử lý được bước hiện tại.');
        const detailedError = `[LỖI Ở ${lessonTitle.toUpperCase()}, BƯỚC ${stepNum}]: ${errorMsg}`;
        if (errStep) {
            appendOrUpdateLog(run, {
                stepIndex: run.stepIndex,
                lessonId: errStep.lesson?.id ?? null,
                lessonTitle: lessonTitle,
                desc: CourseRunner.describeStep(errStep),
                status: 'error',
                detail: detailedError,
                timestamp: Date.now()
            });
        }
        run.status = message.code === 'CONFIG_REQUIRED' ? 'needsConfig' : 'error';
        run.errorCode = message.code || 'RUN_ERROR';
        run.message = detailedError;
        await saveRun(run);
        return { ok: true, task: null };
    }
    if (message.type === 'OPEN_POPUP') {
        if (typeof chrome.action?.openPopup === 'function') {
            try {
                await chrome.action.openPopup();
            } catch {}
        }
        return { ok: true };
    }
    return { ok: false, error: 'Thông điệp không hợp lệ.' };
}

const messageTypes = new Set(['COURSE_START', 'COURSE_STOP', 'COURSE_READY', 'COURSE_PREPARE_NAVIGATION', 'COURSE_SYNC_TABS', 'COURSE_STEP_DONE', 'COURSE_STEP_ERROR', 'OPEN_POPUP']);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!messageTypes.has(message?.type)) return;
    serialize(() => handleMessage(message, sender))
        .then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
    return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
    serialize(async () => {
        const run = await readRun();
        if (run?.tabId === tabId) await stopRun('Đã dừng vì tab khóa học đã đóng.');
    }).catch(console.error);
});
// Full navigations reconnect via COURSE_READY; the step remains until acknowledged.
chrome.runtime.onStartup.addListener(() => {
    serialize(() => stopRun('Đã dừng sau khi mở lại trình duyệt. Nhấn Start để chạy lại.')).catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => {
    serialize(() => stopRun('Extension đã cập nhật. Nhấn Start để chạy lại.')).catch(console.error);
});
