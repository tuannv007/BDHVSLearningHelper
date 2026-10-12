const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const Runner = require('../course-runner.js');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const catalog = JSON.parse(source('data.json'));
const course = Runner.getCourses(catalog)[0];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function event() {
    const listeners = [];
    return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)), listeners };
}

function worker(storage = {}, data = catalog, activeTab = { id: 1, url: course.path }) {
    const onMessage = event();
    const removed = event();
    const startup = event();
    const installed = event();
    const visits = [];
    const cancellations = [];
    let nextTab = 10;
    const chrome = {
        runtime: { getURL: name => 'chrome-extension://test/' + name, onMessage, onStartup: startup, onInstalled: installed },
        storage: { local: {
            get: async key => ({ [key]: clone(storage[key]) }),
            set: async value => Object.assign(storage, clone(value))
        } },
        tabs: {
            create: async options => { visits.push(options.url); return { id: nextTab++ }; },
            update: async (id, options) => { visits.push(options.url); },
            sendMessage: async (id, message) => { cancellations.push({ id, message }); },
            query: async () => (activeTab ? [activeTab] : []),
            onRemoved: removed
        }
    };
    const context = vm.createContext({ chrome, CourseRunner: Runner, importScripts() {}, crypto: webcrypto,
        fetch: async () => ({ ok: true, json: async () => clone(data) }), console });
    vm.runInContext(source('background.js'), context);
    const popup = { url: chrome.runtime.getURL('popup.html') };
    const sender = (documentId = 'doc-1', tabId = storage.courseRun?.tabId) => ({ tab: { id: tabId }, frameId: 0, documentId, url: course.path });
    const message = (data, from = popup) => new Promise(resolve => onMessage.listeners[0](data, from, resolve));
    return { storage, visits, cancellations, message, sender, removed, startup };
}

test('selected lessons only, deduplicated and in course order; source is unchanged', () => {
    const before = JSON.stringify(course);
    const steps = Runner.buildSteps(course, [6, 1, 6]);
    assert.deepEqual(steps.filter(s => s.type === 'openLessonVideo').map(s => s.lesson.id), [1, 6]);
    assert.equal(steps.filter(s => s.type === 'answerQuestion').length, 7);
    assert.equal(JSON.stringify(course), before);
});

test('27 known tabs / 30 timestamp questions plus tab 1.3 to skip to end', () => {
    const steps = Runner.buildSteps(course, course.lessons.map(l => l.id));
    assert.equal(steps.filter(s => s.type === 'openVideo').length, 27);
    assert.equal(steps.filter(s => s.type === 'answerQuestion').length, 30);
    assert.equal(steps.filter(s => s.type === 'skipVideoToEnd').length, 1);
    // A 3s wait step is inserted between each of the 7 lessons (6 gaps).
    assert.equal(steps.filter(s => s.type === 'wait').length, 6);
    assert.equal(steps.length, 92);
});

test('selecting all lessons plus the final review runs lessons in course order, then the review, with a 3s wait between every step', () => {
    const ids = [...course.lessons.map(l => l.id), -1];
    const steps = Runner.buildSteps(course, ids);
    const lessonOpens = steps.filter(s => s.type === 'openLessonVideo').map(s => s.lesson.id);
    assert.deepEqual(lessonOpens, [1, 2, 3, 4, 5, 6, 7]);
    // 6 gaps between the 7 lessons, plus 1 gap before the review.
    const waits = steps.filter(s => s.type === 'wait');
    assert.equal(waits.length, 7);
    assert.ok(waits.every(s => s.ms === 3000));
    assert.equal(steps.at(-3).type, 'wait');
    assert.equal(steps.at(-3).lesson.id, -1);
    assert.equal(steps.at(-2).type, 'openFinalReview');
    assert.equal(steps.at(-1).type, 'answerLessonTest');
    assert.equal(steps.at(-1).manualPage, true);
    assert.deepEqual(steps.at(-1).questions, course.review.questions);
});

test('the final review still runs alone without navigation, and combining it with lessons requires review.navigation', () => {
    const withoutNav = JSON.parse(JSON.stringify(course));
    delete withoutNav.review.navigation;
    assert.equal(Runner.buildSteps(withoutNav, [-1]).length, 1);
    assert.throws(() => Runner.buildSteps(withoutNav, [1, -1]), /review\.navigation/);
});

test('a single lesson\'s module test can run on its own, from a tab the user already opened to it', () => {
    const lesson = course.lessons[0];
    const steps = Runner.moduleTestOnlySteps(course, lesson.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'answerLessonTest');
    assert.equal(steps[0].manualPage, true);
    assert.equal(steps[0].lesson.id, lesson.id);
    assert.equal(steps[0].pageTitle, lesson.test.pageTitle || 'Ôn tập Module ' + lesson.id);
    assert.deepEqual(steps[0].questions, [...lesson.test.questions].sort((a, b) => a.id - b.id));
    assert.throws(() => Runner.moduleTestOnlySteps(course, 99), /không tồn tại/);
});

test('unsorted Bài 5 timestamps retain their own answers and seek six seconds early', () => {
    const steps = Runner.buildSteps(course, [5]).filter(s => s.type === 'answerQuestion' && s.video.id === 1);
    assert.deepEqual(steps.map(s => [s.question.time, s.question.answer, s.seekSeconds]), [
        ['20:01', 'C', 1195], ['22:08', 'D', 1322], ['24:33', 'D', 1467]
    ]);
    // Only the first question of the video resets it to 00:00 first.
    assert.deepEqual(steps.map(s => s.resetToStart), [true, false, false]);
    const small = clone(course);
    small.lessons[0].videos[0].questions[0].time = '00:05';
    assert.equal(Runner.buildSteps(small, [1]).find(s => s.type === 'answerQuestion').seekSeconds, 0);
});

test('question.seekEarlySeconds overrides the default 6s for a single flaky question', () => {
    const withOverride = clone(course);
    const question = withOverride.lessons[0].videos[0].questions[0];
    question.seekEarlySeconds = 15;
    const overridden = Runner.buildSteps(withOverride, [1]).find(s => s.type === 'answerQuestion' && s.question.id === question.id);
    assert.equal(overridden.seekSeconds, question.timeSeconds - 15);
    // A negative or non-finite override is ignored, falling back to 6s, same as omitting it.
    for (const bad of [-1, NaN, 'x']) {
        const invalid = clone(course);
        invalid.lessons[0].videos[0].questions[0].seekEarlySeconds = bad;
        const step = Runner.buildSteps(invalid, [1]).find(s => s.type === 'answerQuestion' && s.question.id === question.id);
        assert.equal(step.seekSeconds, question.timeSeconds - 6);
    }
});

test('reject malformed selections, URLs, answers and times', () => {
    assert.throws(() => Runner.buildSteps(course, []));
    assert.throws(() => Runner.buildSteps(course, [99]));
    assert.throws(() => Runner.validateCourse({ ...course, path: 'https://example.com/course/' }));
    assert.throws(() => Runner.questionSeconds({ time: '06:99' }));
    assert.equal(Runner.questionSeconds({ timeSeconds: 401 }), 401);
    const bad = clone(course);
    bad.lessons[0].videos[0].questions[0].answer = 'Z';
    assert.throws(() => Runner.buildSteps(bad, [1]));
    assert.equal(Runner.isCoursePage(course.path + 'lesson-1', course.path), true);
    assert.equal(Runner.isCoursePage(course.path.replace('BacNinh', 'Other'), course.path), false);
});

test('Start navigates to path, rejects duplicate Start, and only the assigned tab can run', async () => {
    const w = worker();
    assert.equal((await w.message({ type: 'COURSE_START', selectedLessonIds: [1] })).ok, true);
    assert.deepEqual(w.visits, ['about:blank', course.path]);
    assert.equal((await w.message({ type: 'COURSE_START', selectedLessonIds: [1] })).ok, false);
    assert.equal((await w.message({ type: 'COURSE_READY' }, w.sender('other', 999))).task, null);
    const response = await w.message({ type: 'COURSE_READY' }, w.sender());
    assert.equal(response.task.step.type, 'openLessonVideo');
});

test('Stop cannot be undone by an in-flight completion', async () => {
    const w = worker();
    await w.message({ type: 'COURSE_START', selectedLessonIds: [1] });
    const { task } = await w.message({ type: 'COURSE_READY' }, w.sender());
    const stop = w.message({ type: 'COURSE_STOP' });
    const late = w.message({ type: 'COURSE_STEP_DONE', ...task }, w.sender());
    await Promise.all([stop, late]);
    assert.equal(w.storage.courseRun.status, 'stopped');
    assert.equal(w.storage.courseRun.stepIndex, 0);
    assert.equal(w.cancellations.length, 1);
});

test('worker restart and document navigation resume the same step; old/duplicate ACK ignored', async () => {
    let w = worker();
    await w.message({ type: 'COURSE_START', selectedLessonIds: [1] });
    const { task } = await w.message({ type: 'COURSE_READY' }, w.sender());
    w = worker(w.storage); // New JS globals, same persisted state.
    const ready = await w.message({ type: 'COURSE_READY' }, w.sender('doc-2'));
    assert.equal(ready.task.stepIndex, task.stepIndex);
    assert.equal((await w.message({ type: 'COURSE_STEP_DONE', ...task }, w.sender('doc-1'))).task, null);
    await w.message({ type: 'COURSE_STEP_DONE', ...ready.task }, w.sender('doc-2'));
    await w.message({ type: 'COURSE_STEP_DONE', ...ready.task }, w.sender('doc-2'));
    assert.equal(w.storage.courseRun.stepIndex, 1);
});

test('complete all selected tasks and count only acknowledged video questions', async () => {
    const w = worker();
    await w.message({ type: 'COURSE_START', selectedLessonIds: [1] });
    let { task } = await w.message({ type: 'COURSE_READY' }, w.sender());
    while (task?.step) {
        ({ task } = await w.message({ type: 'COURSE_STEP_DONE', ...task }, w.sender()));
    }
    assert.equal(w.storage.courseRun.status, 'completed');
    assert.equal(w.storage.courseRun.completedQuestions, 2);
});

test('navigation checkpoint survives document replacement and clears only after arrival ACK', async () => {
    let w = worker();
    await w.message({ type: 'COURSE_START', courseId: course.id, selectedLessonIds: [1] });
    const { task } = await w.message({ type: 'COURSE_READY' }, w.sender());
    const nav = task.step.lesson.navigation;
    const invalid = await w.message({ ...task, type: 'COURSE_PREPARE_NAVIGATION', phase: 'lecture', url: course.path }, w.sender());
    assert.equal(invalid.ok, false);
    await w.message({ ...task, type: 'COURSE_PREPARE_NAVIGATION', phase: 'lecture', url: nav.lecturePath }, w.sender());
    w = worker(w.storage);
    const sender = { ...w.sender('lecture-document'), url: nav.lecturePath };
    const ready = await w.message({ type: 'COURSE_READY' }, sender);
    assert.equal(ready.task.navigation.url, nav.lecturePath);
    assert.equal(ready.task.stepIndex, 0);
    await w.message({ ...ready.task, type: 'COURSE_STEP_DONE' }, sender);
    assert.equal(w.storage.courseRun.navigation, null);
    assert.equal(w.storage.courseRun.steps[w.storage.courseRun.stepIndex].type, 'discoverVideoTabs');
});

test('the final review has the same navigation checkpoint as a lesson: wrong phase or URL is rejected, and it survives document replacement', async () => {
    let w = worker();
    await w.message({ type: 'COURSE_START', selectedLessonIds: [-1] });
    const { task } = await w.message({ type: 'COURSE_READY' }, w.sender());
    assert.equal(task.step.type, 'openFinalReview');
    const nav = task.step.navigation;
    const wrongUrl = await w.message({ ...task, type: 'COURSE_PREPARE_NAVIGATION', phase: 'review', url: course.path }, w.sender());
    assert.equal(wrongUrl.ok, false);
    const wrongPhase = await w.message({ ...task, type: 'COURSE_PREPARE_NAVIGATION', phase: 'lecture', url: nav.path }, w.sender());
    assert.equal(wrongPhase.ok, false);
    await w.message({ ...task, type: 'COURSE_PREPARE_NAVIGATION', phase: 'review', url: nav.path }, w.sender());
    w = worker(w.storage);
    const sender = { ...w.sender('review-document'), url: nav.path };
    const ready = await w.message({ type: 'COURSE_READY' }, sender);
    assert.equal(ready.task.navigation.url, nav.path);
    assert.equal(ready.task.stepIndex, 0);
});

test('background opens the selected course from a multi-course catalog', async () => {
    const second = JSON.parse(JSON.stringify(course).replaceAll('BacNinh', 'TestProvince'));
    second.id = 'test-province';
    const w = worker({}, { courses: [course, second] });
    const result = await w.message({ type: 'COURSE_START', courseId: second.id, selectedLessonIds: [3] });
    assert.equal(result.ok, true);
    assert.equal(w.visits.at(-1), second.path);
    assert.equal(w.storage.courseRun.courseId, second.id);
    assert.deepEqual(w.storage.courseRun.selectedLessonIds, [3]);
});

test('Start combining a lesson with the final review opens a fresh tab, keeps -1 in the stored selection and sums totalQuestions across both', async () => {
    const w = worker();
    const result = await w.message({ type: 'COURSE_START', selectedLessonIds: [1, -1] });
    assert.equal(result.ok, true);
    assert.deepEqual(w.visits, ['about:blank', course.path]);
    assert.deepEqual(w.storage.courseRun.selectedLessonIds, [1, -1]);
    const videoQuestions = Runner.buildSteps(course, [1]).filter(s => s.type === 'answerQuestion').length;
    assert.equal(w.storage.courseRun.totalQuestions, videoQuestions + course.review.questions.length);
});

test('"Chỉ ôn tập" (moduleTestOnly) reuses the tab already open on the course, skips video, and clears when it finishes', async () => {
    const lesson = course.lessons[1];
    const w = worker({}, catalog, { id: 7, url: course.path });
    const result = await w.message({ type: 'COURSE_START', courseId: course.id, selectedLessonIds: [], moduleTestOnly: lesson.id });
    assert.equal(result.ok, true);
    // No new tab: it runs in whatever tab was already active, like the
    // standalone final review does when there is no automatic navigation.
    assert.deepEqual(w.visits, []);
    assert.equal(w.storage.courseRun.tabId, 7);
    assert.equal(w.storage.courseRun.selectedLessonIds.length, 0);
    assert.equal(w.storage.courseRun.moduleTestOnly, lesson.id);
    assert.equal(w.storage.courseRun.steps.length, 1);
    assert.equal(w.storage.courseRun.steps[0].type, 'answerLessonTest');
    assert.equal(w.storage.courseRun.totalQuestions, lesson.test.questions.length);
    assert.equal(w.cancellations.length, 1);
    assert.equal(w.cancellations[0].id, 7);
    assert.equal(w.cancellations[0].message.type, 'COURSE_RUN_START');
    // Finishing the single step completes the run without ever touching the
    // lesson's own video/openLessonVideo/discoverVideoTabs steps.
    const { task } = await w.message({ type: 'COURSE_READY' }, w.sender(undefined, 7));
    assert.equal(task.step.type, 'answerLessonTest');
    const done = await w.message({ ...task, type: 'COURSE_STEP_DONE' }, w.sender(undefined, 7));
    assert.equal(done.task.step, null);
    assert.equal(w.storage.courseRun.status, 'completed');
});

test('"Chỉ ôn tập" refuses to start when the active tab is not already on the right course', async () => {
    const lesson = course.lessons[0];
    const w = worker({}, catalog, { id: 7, url: 'https://binhdanhocvuso.gov.vn/courses/other/course/' });
    const result = await w.message({ type: 'COURSE_START', courseId: course.id, selectedLessonIds: [], moduleTestOnly: lesson.id });
    assert.equal(result.ok, false);
    assert.match(result.error, /Hãy mở đúng trang/);
    assert.equal(w.storage.courseRun, undefined);
});

test('missing HTML config becomes actionable status; closing the tab stops the run', async () => {
    const w = worker();
    await w.message({ type: 'COURSE_START', selectedLessonIds: [1] });
    const { task } = await w.message({ type: 'COURSE_READY' }, w.sender());
    await w.message({ type: 'COURSE_STEP_ERROR', ...task, code: 'CONFIG_REQUIRED', error: 'TODO lessonReady' }, w.sender());
    assert.equal(w.storage.courseRun.status, 'needsConfig');
    await w.message({ type: 'COURSE_START', selectedLessonIds: [2] });
    w.removed.emit(w.storage.courseRun.tabId);
    await tick();
    assert.equal(w.storage.courseRun.status, 'stopped');
});

function adapterContext(extra = {}) {
    const context = vm.createContext({ console, setTimeout, clearTimeout, DOMException, AbortController,
        getComputedStyle: () => ({ visibility: 'visible' }), ...extra });
    vm.runInContext(source('site-adapter.js'), context);
    return context;
}

test('unconfigured adapter never guesses a click; waits cancel immediately', async () => {
    const context = adapterContext();
    const controller = new AbortController();
    assert.throws(() => context.CourseSite.questionSelectors({}), { code: 'CONFIG_REQUIRED' });
    const pending = context.CourseSite.waitFor(() => false, controller.signal, 'video');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});

test('ambiguous visible selectors are errors instead of clicking the first match', () => {
    const element = { isConnected: true, getClientRects: () => [1], closest: () => null };
    const context = adapterContext({ document: { querySelectorAll: () => [element, element] } });
    assert.throws(() => context.CourseSite.find('.ambiguous'), /nhiều phần tử/);
});

async function contentHarness({ waitAt = null, timeoutAt = null, missingQuestionHtml = false, questionOpen = false, continueButton = false, staleCounter = false, siblingContinue = false, transientSendFailures = 0, nonTransientSendFailure = false } = {}) {
    const step = Runner.buildSteps(course, [1]).find(s => s.type === 'answerQuestion');
    const task = { runId: 'run-test', stepIndex: 2, path: course.path, step };
    let run = { id: task.runId, status: 'running' };
    const messages = [];
    const changes = event();
    const received = event();
    let answered = false;
    let selected = false;
    let continued = false;
    let playCount = 0;
    const seeks = [];
    let reached = null;
    let sendAttempts = 0;
    class FakeVideo {
        constructor() { this.readyState = 1; this.duration = 1000; this.paused = true; this.seeking = false; this.isConnected = true; this.currentTime = 0; }
        pause() { this.paused = true; }
        async play() { playCount++; this.paused = false; }
        async seek(seconds) { seeks.push(seconds); this.currentTime = seconds; }
        async getState() {
            if (!this.paused) this.currentTime += 10;
            return { ready: true, duration: this.duration, currentTime: this.currentTime, paused: this.paused };
        }
        release() {}
    }
    const video = new FakeVideo();
    const elements = { ready: {}, player: video, panel: {}, option: { kind: 'option' }, submit: { kind: 'submit' } };
    const questionWrapper = {};
    const warnings = [];
    if (siblingContinue) elements.panel.closest = () => questionWrapper;
    const context = adapterContext({
        console: { error() {}, warn: (...args) => warnings.push(args.join(' ')) },
        CourseRunner: Runner, HTMLVideoElement: FakeVideo, location: { href: course.path },
        CourseMedia: { connect: async () => video }, CourseActions: { videoContainer: () => ({}) },
        window: { addEventListener() {} },
        chrome: {
            runtime: {
                onMessage: received,
                sendMessage: async message => {
                    const attempt = sendAttempts++;
                    // A single non-transient failure that never recurs: if content.js's
                    // send() wrongly retried this, the call below would succeed and get
                    // logged, so leaving `messages` empty is proof it was not retried.
                    if (nonTransientSendFailure && attempt === 0) {
                        throw new Error('Extension context invalidated.');
                    }
                    if (attempt < transientSendFailures) {
                        throw new Error('The message port closed before a response was received.');
                    }
                    messages.push(message);
                    return { ok: true, task: message.type === 'COURSE_READY' ? task : null };
                }
            },
            storage: { local: { get: async () => ({ courseRun: clone(run) }) }, onChanged: changes }
        }
    });
    const site = context.CourseSite;
    const actualDelay = site.delay;
    site.delay = (ms, signal) => ms === 5000 ? (signal.throwIfAborted(), Promise.resolve()) : actualDelay(ms, signal);
    if (!missingQuestionHtml) site.questionSelectors = () => ({ panel: 'panel', option: 'option', submit: 'submit', answered: 'answered', continue: continueButton ? 'continue' : null });
    else site.selectors.questionPanel = null;
    site.find = (css, scope) => css === 'answered' ? (answered && !staleCounter ? {} : null) :
        css === 'continue' ? (answered && (!siblingContinue || scope === questionWrapper) ? { kind: 'continue' } : null) :
        css === 'panel' ? (!continued && (questionOpen || video.currentTime >= 401) ? elements.panel : null) : elements[css];
    const actualWait = site.waitFor;
    site.waitFor = async (probe, signal, description) => {
        if (description === timeoutAt) throw new Error('Hết thời gian chờ: ' + description);
        if (description === waitAt) {
            reached = description;
            return actualWait(() => false, signal, description);
        }
        return actualWait(probe, signal, description);
    };
    site.click = (element, signal) => {
        site.throwIfAborted(signal);
        if (element.kind === 'option') selected = true;
        if (element.kind === 'submit') { assert.equal(selected, true); answered = true; }
        if (element.kind === 'continue') { assert.equal(answered, true); continued = true; }
    };
    vm.runInContext(source('actions/play-video.js'), context);
    vm.runInContext(source('content.js'), context);
    for (let i = 0; i < 20; i++) await tick();
    return {
        video, messages, seeks, selected: () => selected, continued: () => continued, playCount: () => playCount, reached: () => reached,
        warnings: () => warnings.slice(),
        stop() { run.status = 'stopped'; changes.emit({ courseRun: { newValue: run } }, 'local'); }
    };
}

test('content resets a fresh video to 00:00, then seeks 06:41 to 395s, plays, selects and submits before ACK', async () => {
    const h = await contentHarness();
    // First question of the video: reset to 0 before seeking near the question.
    assert.deepEqual(h.seeks, [0, 395]);
    assert.equal(h.playCount(), 1);
    assert.equal(h.selected(), true);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
    assert.equal(h.video.paused, true);
});

test('an already open video question is answered without autoplay or seeking', async () => {
    const h = await contentHarness({ questionOpen: true });
    assert.equal(h.playCount(), 0);
    assert.deepEqual(h.seeks, []);
    assert.equal(h.selected(), true);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
});

test('Continue closes the submitted question before reporting completion', async () => {
    const h = await contentHarness({ questionOpen: true, continueButton: true });
    assert.equal(h.continued(), true);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
});

test('Continue is clicked even when submission does not update the attempt counter', async () => {
    const h = await contentHarness({ questionOpen: true, continueButton: true, staleCounter: true });
    assert.equal(h.selected(), true);
    assert.equal(h.continued(), true);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
});
test('Continue beside the problem panel is found inside the question wrapper', async () => {
    const h = await contentHarness({ questionOpen: true, continueButton: true, siblingContinue: true });
    assert.equal(h.continued(), true);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
});

test('a question panel stuck open (site widget glitch) after a recorded answer does not fail the step', async () => {
    const h = await contentHarness({ questionOpen: true, continueButton: true, timeoutAt: 'đóng câu hỏi' });
    // Continue was still clicked; only the wait for the panel to disappear
    // timed out, and the answer was already confirmed recorded, so it proceeds.
    assert.equal(h.continued(), true);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
    assert.ok(h.warnings().some(w => w.includes('không tự đóng')));
});

test('a missing Continue button after a recorded answer does not fail the step', async () => {
    const h = await contentHarness({ questionOpen: true, continueButton: true, timeoutAt: 'nút Continue sau câu hỏi' });
    // Nothing to click, but the answer was already confirmed recorded.
    assert.equal(h.continued(), false);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
    assert.ok(h.warnings().some(w => w.includes('không thấy nút Continue')));
});

test('a stuck question panel still fails the step when the answer was never actually recorded', async () => {
    const h = await contentHarness({ questionOpen: true, continueButton: true, staleCounter: true, timeoutAt: 'đóng câu hỏi' });
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_ERROR');
    assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_DONE'), false);
    assert.equal(h.warnings().length, 0);
});

test('a missing Continue button still fails the step when the answer was never actually recorded', async () => {
    const h = await contentHarness({ questionOpen: true, continueButton: true, staleCounter: true, timeoutAt: 'nút Continue sau câu hỏi' });
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_ERROR');
    assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_DONE'), false);
    assert.equal(h.warnings().length, 0);
});

test('Stop while waiting for Continue prevents clicking it or reporting completion', async () => {
    const h = await contentHarness({ questionOpen: true, continueButton: true, waitAt: 'nút Continue sau câu hỏi' });
    assert.equal(h.reached(), 'nút Continue sau câu hỏi');
    h.stop();
    await tick();
    assert.equal(h.continued(), false);
    assert.equal(h.messages.some(message => message.type === 'COURSE_STEP_DONE'), false);
});

test('transient message-port failures are retried and the run still completes normally', async () => {
    // Exhausts both retries (300ms then 600ms) before the 3rd attempt succeeds --
    // the same "service worker briefly gone" hiccup content.js's send() is meant
    // to ride out, exercised end to end rather than just checking the wrapper exists.
    const h = await contentHarness({ transientSendFailures: 2 });
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
    assert.equal(h.selected(), true);
    // Despite 3 raw sendMessage attempts underneath, only the one that actually
    // succeeded should ever reach the run's message log.
    assert.equal(h.messages.filter(m => m.type === 'COURSE_READY').length, 1);
});

test('a non-transient sendMessage error is never retried', async () => {
    // "Extension context invalidated." is what Chrome throws when the extension
    // itself was reloaded/updated -- a real failure, not a timing hiccup -- and
    // must fail immediately instead of being treated like the transient case.
    const h = await contentHarness({ nonTransientSendFailure: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(h.messages.length, 0);
    assert.equal(h.playCount(), 0);
    assert.equal(h.selected(), false);
});

test('transient failures beyond the retry budget still give up instead of retrying forever', async () => {
    // 3 consecutive transient failures: content.js's send() only tolerates 2
    // retries (3 attempts total), so this must stop there rather than keep going.
    const h = await contentHarness({ transientSendFailures: 3 });
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(h.messages.length, 0);
    assert.equal(h.playCount(), 0);
    assert.equal(h.selected(), false);
});

test('supplied in-video question maps data answers to radio values and waits for enabled submit', () => {
    const site = adapterContext().CourseSite;
    const step = Runner.buildSteps(course, [1]).find(s => s.type === 'answerQuestion');
    const css = site.questionSelectors(step);
    assert.match(css.panel, /^#seq_content \.in-video-problem/);
    assert.ok(css.panel.includes('[value="Câu 1"]'));
    assert.equal(css.option, 'input[type="radio"][value="choice_2"]');
    assert.ok(css.submit.includes(':not(:disabled)'));
    assert.ok(css.answered.includes('data-attempts-used'));
    for (const [index, answer] of [...'ABCD'].entries()) {
        assert.ok(site.questionSelectors({ ...step, question: { id: 2, answer } }).option.includes('choice_' + index));
    }
});

test('tab discovery persists extra tabs in the run and does not drop the next selected lesson', async () => {
    let w = worker();
    await w.message({ type: 'COURSE_START', selectedLessonIds: [1, 2] });
    let { task } = await w.message({ type: 'COURSE_READY' }, w.sender());
    ({ task } = await w.message({ ...task, type: 'COURSE_STEP_DONE' }, w.sender()));
    assert.equal(task.step.type, 'discoverVideoTabs');
    const tabs = task.step.videos.map(v => v.tab).concat({ index: 3, title: '1.4', blockId: 'extra-tab' });
    await w.message({ ...task, type: 'COURSE_SYNC_TABS', tabs }, w.sender());
    const count = w.storage.courseRun.steps.length;
    // Reloading during discovery is idempotent.
    w = worker(w.storage);
    ({ task } = await w.message({ type: 'COURSE_READY' }, w.sender('new-doc')));
    await w.message({ ...task, type: 'COURSE_SYNC_TABS', tabs }, w.sender('new-doc'));
    assert.equal(w.storage.courseRun.steps.length, count);
    assert.equal(w.storage.courseRun.steps.filter(s => s.type === 'skipVideoToEnd').length, 2);
    assert.equal(w.storage.courseRun.steps.filter(s => s.type === 'openLessonVideo' && s.lesson.id === 2).length, 1);
    assert.equal(w.storage.courseRun.totalQuestions, 6);
});

test('tab discovery for the last selected lesson does not drop the final review that follows it', async () => {
    const lastLesson = course.lessons.at(-1);
    const w = worker();
    await w.message({ type: 'COURSE_START', selectedLessonIds: [lastLesson.id, -1] });
    let { task } = await w.message({ type: 'COURSE_READY' }, w.sender());
    ({ task } = await w.message({ ...task, type: 'COURSE_STEP_DONE' }, w.sender()));
    assert.equal(task.step.type, 'discoverVideoTabs');
    // A real page always reports a data-id for every tab (possibly ''); only
    // this test's own lesson happens to have no blockId configured in data.json.
    const tabs = task.step.videos.map(v => ({ ...v.tab, blockId: v.tab.blockId || 'blk-' + v.tab.index }));
    const result = await w.message({ ...task, type: 'COURSE_SYNC_TABS', tabs }, w.sender());
    assert.equal(result.ok, true);
    const steps = w.storage.courseRun.steps;
    // The wait before the review, the review's own navigation step and its
    // answerLessonTest must all still be there after splicing in the last
    // lesson's discovered tabs — they used to be wiped out because nothing
    // but another openLessonVideo was recognised as "after this lesson".
    assert.equal(steps.filter(s => s.type === 'openFinalReview').length, 1);
    assert.equal(steps.filter(s => s.type === 'answerLessonTest' && s.manualPage).length, 1);
    assert.equal(steps.at(-1).type, 'answerLessonTest');
    assert.equal(steps.at(-1).manualPage, true);
    const videoQuestions = Runner.buildSteps(course, [lastLesson.id]).filter(s => s.type === 'answerQuestion').length;
    assert.equal(w.storage.courseRun.totalQuestions, videoQuestions + course.review.questions.length);
});

test('missing answer HTML still plays/seeks to the question, pauses and does not mark it answered', async () => {
    const h = await contentHarness({ missingQuestionHtml: true });
    assert.deepEqual(h.seeks, [0, 395]);
    assert.ok(h.video.currentTime >= 401);
    assert.equal(h.video.paused, true);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_ERROR');
    assert.equal(h.messages.at(-1).code, 'CONFIG_REQUIRED');
    assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_DONE'), false);
});

test('Stop during question wait pauses video and never chooses an answer or ACKs', async () => {
    const h = await contentHarness({ waitAt: 'câu hỏi tại 06:41' });
    assert.equal(h.reached(), 'câu hỏi tại 06:41');
    h.stop();
    await tick();
    assert.equal(h.video.paused, true);
    assert.equal(h.selected(), false);
    assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_DONE'), false);
});

test('a question panel that never appears is skipped instead of stopping the whole run', async () => {
    // The user's own reported example: "Hết thời gian chờ: câu hỏi tại xx:xx".
    // Unlike a Stop or a real bug, the run loop now treats this as "give up
    // on this one question" and moves straight on to the next step.
    const h = await contentHarness({ timeoutAt: 'câu hỏi tại 06:41' });
    assert.equal(h.video.paused, true);
    assert.equal(h.selected(), false);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
    assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_ERROR'), false);
});

function waitStepHarness({ resolveImmediately }) {
    const step = { type: 'wait', ms: 3000, lesson: { id: 2, title: 'Bài 2' } };
    const task = { runId: 'run-wait', stepIndex: 0, path: course.path, step };
    let run = { id: task.runId, status: 'running' };
    const messages = [];
    const changes = event();
    const received = event();
    const delays = [];
    const context = vm.createContext({
        console: { error() {} }, DOMException, AbortController,
        CourseRunner: Runner, location: { href: course.path }, CourseActions: {},
        window: { addEventListener() {} },
        chrome: {
            runtime: {
                onMessage: received,
                sendMessage: async message => {
                    messages.push(message);
                    return { ok: true, task: message.type === 'COURSE_READY' ? task : null };
                }
            },
            storage: { local: { get: async () => ({ courseRun: clone(run) }) }, onChanged: changes }
        },
        CourseSite: {
            throwIfAborted: signal => { if (signal.aborted) throw new DOMException('Đã dừng', 'AbortError'); },
            // Stays pending until Stop aborts it, unless the caller wants the
            // real wait to elapse and resolve on its own.
            delay: (ms, signal) => {
                delays.push(ms);
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new DOMException('Đã dừng', 'AbortError')), { once: true });
                    if (resolveImmediately) resolve();
                });
            }
        }
    });
    vm.runInContext(source('content.js'), context);
    return {
        delays, messages,
        tick: async () => { for (let i = 0; i < 20; i++) await tick(); },
        stop() { run.status = 'stopped'; changes.emit({ courseRun: { newValue: run } }, 'local'); }
    };
}

test('a wait step delays via CourseSite.delay for the configured duration before acknowledging the step', async () => {
    const h = waitStepHarness({ resolveImmediately: true });
    await h.tick();
    assert.deepEqual(h.delays, [3000]);
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
});

test('Stop during the 3s wait between lessons cancels it without acknowledging the step', async () => {
    const h = waitStepHarness({ resolveImmediately: false });
    await h.tick();
    h.stop();
    await h.tick();
    assert.deepEqual(h.delays, [3000]);
    assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_DONE'), false);
});

// Isolates content.js's own routing decision (skip vs. stop) from the real
// CourseActions implementations covered elsewhere (play-video.js/
// open-video-tab.js already have their own tests for the actions themselves).
function skippableStepHarness(step, { throwError = null, hang = false } = {}) {
    const task = { runId: 'run-skip', stepIndex: 0, path: course.path, step };
    let run = { id: task.runId, status: 'running' };
    const messages = [];
    const changes = event();
    const received = event();
    const player = { paused: true, pause() { this.paused = true; }, release() {} };
    // `hang` never settles on its own -- like a real stuck DOM/player wait,
    // the only way out is the signal it's given being aborted (by Stop, or
    // by content.js's own 15s step cap), exactly what content.js's real
    // waitFor/delay helpers do. This is what actually exercises that cap's
    // timer, as opposed to throwError below, which settles synchronously
    // and never lets the cap's timer have anything left to fire against.
    const act = async (_arg, signal) => {
        if (throwError) throw throwError;
        if (!hang) return;
        await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Đã dừng', 'AbortError')), { once: true });
        });
    };
    const context = vm.createContext({
        console: { error() {}, warn() {} }, DOMException, AbortController, setTimeout, clearTimeout,
        CourseRunner: Runner, location: { href: course.path },
        CourseMedia: { connect: async () => player },
        CourseActions: { videoContainer: () => ({}), skipVideoToEnd: act, openVideoTab: act },
        window: { addEventListener() {} },
        chrome: {
            runtime: {
                onMessage: received,
                sendMessage: async message => {
                    messages.push(message);
                    return { ok: true, task: message.type === 'COURSE_READY' ? task : null };
                }
            },
            storage: { local: { get: async () => ({ courseRun: clone(run) }) }, onChanged: changes }
        },
        CourseSite: {
            throwIfAborted: signal => { if (signal.aborted) throw new DOMException('Đã dừng', 'AbortError'); },
            waitFor: async () => ({})
        }
    });
    vm.runInContext(source('content.js'), context);
    return {
        messages,
        tick: async () => { for (let i = 0; i < 20; i++) await tick(); },
        stop() { run.status = 'stopped'; changes.emit({ courseRun: { newValue: run } }, 'local'); }
    };
}

for (const stepType of ['skipVideoToEnd', 'openVideo']) {
    test(stepType + ' timing out is skipped instead of stopping the whole run', async () => {
        const h = skippableStepHarness({ type: stepType, video: { tab: { index: 1, title: '1.2' } } },
            { throwError: new Error('Hết thời gian chờ video phát hết. Video có thể đang dừng hoặc chưa tải được.') });
        await h.tick();
        assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
        assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_ERROR'), false);
    });

    test(stepType + ' failing with a real (non-timeout) error still stops the run and reports it', async () => {
        const h = skippableStepHarness({ type: stepType, video: { tab: { index: 1, title: '1.2' } } },
            { throwError: new Error('ID tab không khớp dữ liệu: 1.2') });
        await h.tick();
        assert.equal(h.messages.at(-1).type, 'COURSE_STEP_ERROR');
        assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_DONE'), false);
    });
}

// These two exercise withStepTimeout's own 15s clock for real, unlike the
// tests above (which settle synchronously and never give that clock anything
// to race against) -- the one piece of this mechanism nothing else covers.
test('a step stuck with nothing settling on its own is still capped at 35s and skipped', { timeout: 45000 }, async () => {
    const h = skippableStepHarness({ type: 'openVideo', video: { tab: { index: 1, title: '1.2' } } }, { hang: true });
    const startedAt = Date.now();
    await h.tick();
    await new Promise(resolve => setTimeout(resolve, 35500));
    await h.tick();
    assert.ok(Date.now() - startedAt >= 35000, 'should not resolve before the 35s cap');
    assert.equal(h.messages.at(-1).type, 'COURSE_STEP_DONE');
    assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_ERROR'), false);
});

test('Stop while a step is stuck still stops the run instead of being treated as the 15s cap', async () => {
    const h = skippableStepHarness({ type: 'openVideo', video: { tab: { index: 1, title: '1.2' } } }, { hang: true });
    await h.tick();
    h.stop();
    await h.tick();
    assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_DONE'), false);
    assert.equal(h.messages.some(m => m.type === 'COURSE_STEP_ERROR'), false);
});
