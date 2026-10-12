const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Runner = require('../course-runner.js');
const course = require('../data.json').courses[0];
const step = Runner.buildSteps(course, [1]).find(s => s.type === 'answerLessonTest');

test('final review opens the configured URL, starts the exam and selects tab 2 once', async () => {
    const step = Runner.buildSteps(course, [-1])[0];
    const calls = [];
    let gated = true;
    let selected = false;
    const content = { firstElementChild: {}, querySelector: () => selected ? {} : null };
    const location = { href: course.path, assign(url) { calls.push('navigate'); this.href = url; } };
    const tab = { getAttribute: () => String(selected), click: () => { calls.push('tab2'); selected = true; content.firstElementChild = {}; } };
    const gate = { click: () => { calls.push('start'); gated = false; } };
    const context = vm.createContext({ URL, location, CourseRunner: Runner, CSS: { escape: x => x }, CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(),
        click: (el, signal) => { signal.throwIfAborted(); el.click(); },
        waitFor: async (probe, signal) => { signal.throwIfAborted(); assert.ok(probe()); },
        find: css => css.startsWith('a#') ? null : css.includes('start-timed-exam') ? (gated ? gate : null) :
            css.includes('data-index="1"') ? (gated ? null : tab) : css === '#seq_content' ? content : null
    } });
    vm.runInContext(fs.readFileSync(require.resolve('../actions/answer-lesson-test.js'), 'utf8'), context);
    // Real waitFor returns the matching element.
    context.CourseSite.waitFor = async (probe, signal) => { signal.throwIfAborted(); const value = probe(); assert.ok(value); return value; };
    const controller = new AbortController();
    const prepared = [];
    const ctx = { path: course.path, navigation: null, prepareNavigation: async (phase, url) => { prepared.push([phase, url]); } };
    await context.CourseActions.openFinalReview(step, controller.signal, ctx);
    assert.deepEqual(calls, ['navigate', 'start', 'tab2']);
    assert.deepEqual(prepared, [['review', step.navigation.path]]);
    await context.CourseActions.openFinalReview(step, controller.signal, ctx);
    assert.equal(calls.length, 3);
    assert.equal(prepared.length, 1); // already arrived on the second call: no re-navigation
    controller.abort();
    await assert.rejects(context.CourseActions.openFinalReview(step, controller.signal, ctx), { name: 'AbortError' });
});

test('final review checkpoint: a bounce back to the outline after navigating is reported, not retried in a loop', async () => {
    const step = Runner.buildSteps(course, [-1])[0];
    let selected = false;
    const content = { firstElementChild: {}, querySelector: () => selected ? {} : null };
    const location = { href: course.path, assign() { throw new Error('should not navigate again'); } };
    const context = vm.createContext({ URL, location, CourseRunner: Runner, CSS: { escape: x => x }, CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(),
        click: () => { throw new Error('should not click again'); },
        waitFor: async () => { throw new Error('should not wait again'); },
        find: css => css === '#course-outline-block-tree' ? {} : null
    } });
    vm.runInContext(fs.readFileSync(require.resolve('../actions/answer-lesson-test.js'), 'utf8'), context);
    const controller = new AbortController();
    const ctx = { path: course.path, navigation: { phase: 'review', url: step.navigation.path }, prepareNavigation: async () => {} };
    await assert.rejects(context.CourseActions.openFinalReview(step, controller.signal, ctx), error => {
        assert.equal(error.code, 'NAVIGATION_FAILED');
        return true;
    });
});

test('final review uses the entire course review and does not navigate through lessons', () => {
    const steps = Runner.buildSteps(course, [-1]);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].type, 'openFinalReview');
    assert.equal(steps[1].manualPage, true);
    assert.deepEqual(steps[1].questions, course.review.questions);
    assert.equal(steps[1].pageTitle, course.review.title);
});

test('combining the final review with a lesson selection appends it after a 3s wait, still with the full review data', () => {
    const steps = Runner.buildSteps(course, [-1, 1]);
    assert.equal(steps[0].type, 'openLessonVideo');
    assert.equal(steps[0].lesson.id, 1);
    assert.equal(steps.at(-3).type, 'wait');
    assert.equal(steps.at(-2).type, 'openFinalReview');
    assert.equal(steps.at(-1).manualPage, true);
    assert.deepEqual(steps.at(-1).questions, course.review.questions);
});

test('return step navigates to the course list once and respects Stop', async () => {
    const visits = [];
    const location = { href: course.path + 'test/', assign(url) { visits.push(url); this.href = url; } };
    const context = vm.createContext({ URL, location, CourseSite: {
        throwIfAborted: signal => signal.throwIfAborted(), find: () => ({}),
        waitFor: async (probe, signal) => { signal.throwIfAborted(); assert.ok(probe()); }
    } });
    vm.runInContext(fs.readFileSync(require.resolve('../actions/open-lesson-video.js'), 'utf8'), context);
    const controller = new AbortController();
    await context.CourseActions.returnToOutline(controller.signal, course.path);
    await context.CourseActions.returnToOutline(controller.signal, course.path);
    assert.deepEqual(visits, [course.path]);
    controller.abort();
    location.href = course.path + 'test/';
    await assert.rejects(context.CourseActions.returnToOutline(controller.signal, course.path), { name: 'AbortError' });
    assert.equal(visits.length, 1);
});

function harness({ loaded = false, count = 20, last = true, stopOnSubmit = false, stopOnDelay = false, stopOnSettle = false, resetNextAnswer = false, unsavedChecked = false, lessonId = 1, optionCounts = [] } = {}) {
    const step = Runner.buildSteps(course, [lessonId]).find(s => s.type === 'answerLessonTest');
    const controller = new AbortController();
    const calls = [];
    const delays = [];
    const panels = Array.from({ length: count }, (_, index) => {
        const panel = { id: 'problem_' + index, enabled: !unsavedChecked, closest: () => null };
        panel.options = [...'ABCD'].slice(0, optionCounts[index] ?? 4).map((answer, choice) => ({ name: 'q' + index, value: 'choice_' + choice,
            dispatchEvent(event) { if (event.type === 'change' && event.bubbles) panel.enabled = true; },
            checked: unsavedChecked && answer === step.questions[index].answer,
            click: () => { panel.options.forEach(o => { o.checked = false; }); panel.options[choice].checked = true; } }));
        panel.querySelectorAll = () => panel.options;
        panel.submit = { click: () => {
            assert.ok(panels.every(p => p.options.some(o => o.checked)), 'all questions must be filled before any submission');
            calls.push([index + 1, panel.options.find(o => o.checked).value]);
            panel.enabled = false;
            if (resetNextAnswer && index === 0) panels[1].options.forEach(option => { option.checked = false; });
            if (stopOnSubmit) controller.abort();
        } };
        return panel;
    });
    const content = { querySelectorAll: () => panels };
    const next = { click: () => { calls.push('next'); loaded = true; } };
    const context = vm.createContext({ Event, CourseRunner: Runner, CSS: { escape: x => x },
        location: { href: course.lessons.find(lesson => lesson.id === lessonId).navigation.lecturePath },
        document: { querySelectorAll: () => [0, 1].map(index => ({
            getAttribute: key => key === 'data-index' ? String(index) : String(index === (last ? 1 : 0))
        })) },
        CourseSite: {
            throwIfAborted: signal => signal.throwIfAborted(),
            click: (el, signal) => { signal.throwIfAborted(); assert.ok(el); el.click(); },
            waitFor: async (probe, signal) => { signal.throwIfAborted(); const value = probe(); assert.ok(value, 'wait condition'); return value; },
            delay: (ms, signal) => {
                signal.throwIfAborted();
                delays.push(ms);
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new DOMException('Đã dừng', 'AbortError')), { once: true });
                    if (stopOnDelay || (stopOnSettle && ms === 5000)) controller.abort(); else resolve();
                });
            },
            find: (css, scope) => {
                if (css === '#seq_content') return content;
                if (css === '.unit-title') return { textContent: loaded ? step.pageTitle : 'Video' };
                if (css.startsWith('nav.')) return next;
                if (css.startsWith('#problem_')) return panels.find(p => '#' + p.id === css);
                if (css.startsWith('input')) return scope.options.find(o => css.includes(o.value));
                if (css.startsWith('.submit-attempt-container > button.submit.btn-brand')) return scope.enabled ? scope.submit : null;
                return null;
            }
        }
    });
    vm.runInContext(fs.readFileSync(require.resolve('../actions/answer-lesson-test.js'), 'utf8'), context);
    return { calls, delays, run: () => context.CourseActions.answerLessonTest(step, controller.signal, course.path) };
}

test('last video tab navigates once and submits all 20 test answers from data', async () => {
    const h = harness();
    await h.run();
    assert.equal(h.calls[0], 'next');
    assert.deepEqual(h.calls.slice(1), step.questions.map(q => [q.id, 'choice_' + (q.answer.charCodeAt(0) - 65)]));
    await h.run();
    assert.equal(h.calls.filter(call => call === 'next').length, 1, 'must not navigate again from the test page');
    assert.equal(h.calls.length, 41, 'each question is submitted again when this action is rerun');
});
test('test question count mismatch stops before selecting or submitting', async () => {
    const h = harness({ loaded: true, count: 19 });
    await assert.rejects(h.run(), /wait condition/);
    assert.deepEqual(h.calls, []);
});
test('navigation is rejected before the final video tab', async () => {
    const h = harness({ last: false });
    await assert.rejects(h.run(), /tab video cuối/);
    assert.deepEqual(h.calls, []);
});
test('Stop during test submission prevents subsequent questions', async () => {
    const h = harness({ loaded: true, stopOnSubmit: true });
    await assert.rejects(h.run(), { name: 'AbortError' });
    assert.equal(h.calls.length, 1);
});
test('Submit clicks are paced 200ms apart, then a flat 5s settle wait follows the last submission — no per-question result wait', async () => {
    const h = harness({ loaded: true });
    await h.run();
    assert.equal(h.calls.length, 20, 'every question was submitted');
    assert.equal(h.delays.length, 21);
    assert.deepEqual(h.delays.slice(0, 20), Array(20).fill(200), 'every submission waits the same 200ms gap');
    assert.equal(h.delays.at(-1), 5000, 'a single flat 5s settle wait follows once every answer is submitted');
});
test('Stop during the pacing delay after a submit still cancels the run', async () => {
    const h = harness({ loaded: true, stopOnDelay: true });
    await assert.rejects(h.run(), { name: 'AbortError' });
    assert.equal(h.calls.length, 1);
});
test('Stop during the post-test settle wait still cancels the run after every question was submitted', async () => {
    const h = harness({ loaded: true, stopOnSettle: true });
    await assert.rejects(h.run(), { name: 'AbortError' });
    assert.equal(h.calls.length, 20);
    assert.equal(h.delays.at(-1), 5000);
});
test('a selection reset by page rendering is restored before submission', async () => {
    const h = harness({ loaded: true, resetNextAnswer: true });
    await h.run();
    assert.deepEqual(h.calls, step.questions.map(q => [q.id, 'choice_' + (q.answer.charCodeAt(0) - 65)]));
});
test('checked but unsaved answers with previous attempts still enable and click every Submit', async () => {
    const h = harness({ loaded: true, unsavedChecked: true });
    await h.run();
    assert.equal(h.calls.length, 20);
});
test('every lesson test uses its entire test.questions array, not video questions', () => {
    for (const lesson of course.lessons) {
        const exam = Runner.buildSteps(course, [lesson.id]).find(s => s.type === 'answerLessonTest');
        assert.equal(exam.questions.length, 20);
        assert.deepEqual(exam.questions, lesson.test.questions);
    }
});
test('lesson 2 navigates to its test and submits its own 20 answers', async () => {
    // Counts extracted from the user's actual Module 2 HTML: question 1 has A–C.
    const optionCounts = require('./fixtures/module-2-option-counts.json');
    assert.equal(optionCounts[0], 3);
    const h = harness({ lessonId: 2, optionCounts });
    await h.run();
    assert.equal(h.calls[0], 'next');
    assert.deepEqual(h.calls.slice(1), course.lessons[1].test.questions.map(q =>
        [q.id, 'choice_' + (q.answer.charCodeAt(0) - 65)]));
});
test('an answer absent from the displayed choices stops before any submission', async () => {
    const h = harness({ loaded: true, lessonId: 2, optionCounts: [3, 2] });
    // Module 2 question 2 uses C, which is absent when only A/B exist.
    await assert.rejects(h.run(), /Lựa chọn câu 2/);
    assert.equal(h.calls.length, 0);
});
test('after the test, only the next selected lesson is opened through the outline action, following a 3s wait', () => {
    const steps = Runner.buildSteps(course, [1, 3]);
    const index = steps.findIndex(s => s.type === 'answerLessonTest');
    assert.equal(steps[index + 1].type, 'returnToOutline');
    assert.equal(steps[index + 2].type, 'wait');
    assert.equal(steps[index + 3].type, 'openLessonVideo');
    assert.equal(steps[index + 3].lesson.id, 3);
    assert.ok(steps.every(s => s.lesson.id !== 2));
});
test('discovery preserves the lesson test after all discovered video tabs', () => {
    const discovery = Runner.buildSteps(course, [1]).find(s => s.type === 'discoverVideoTabs');
    const steps = Runner.stepsFromTabs(discovery, discovery.videos.map(v => v.tab));
    assert.equal(steps.at(-1).type, 'returnToOutline');
    assert.equal(steps.at(-2).type, 'answerLessonTest');
    assert.deepEqual(steps.at(-2).questions, course.lessons[0].test.questions);
});
