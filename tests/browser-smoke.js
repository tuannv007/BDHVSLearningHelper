(async () => {
    const report = [];
    const check = (condition, label) => {
        if (!condition) throw new Error(label);
        report.push('PASS ' + label);
    };
    try {
        const [catalog, html, actionCode, popupHtml, popupCode, runnerCode, popupCss] = await Promise.all([
            fetch('../data.json').then(r => r.json()),
            fetch('fixtures/course-outline.html').then(r => r.text()),
            fetch('../actions/open-lesson-video.js').then(r => r.text()),
            fetch('../popup.html').then(r => r.text()),
            fetch('../popup.js').then(r => r.text()),
            fetch('../course-runner.js').then(r => r.text()),
            fetch('../popup.css').then(r => r.text())
        ]);
        const course = CourseRunner.getCourses(catalog)[0];
        const fakeLocation = { href: course.path, assign(url) { this.href = url; } };
        // Only navigation is mocked. Selectors, visibility and click handlers use real DOM.
        new Function('location', actionCode)(fakeLocation);
        const clicks = [];
        const host = document.getElementById('fixture');
        function mount(markup) {
            host.innerHTML = markup;
            for (const button of host.querySelectorAll('button.section-name')) {
                button.addEventListener('click', () => {
                    clicks.push(button.id);
                    const isOpen = button.getAttribute('aria-expanded') === 'true';
                    button.setAttribute('aria-expanded', String(!isOpen));
                    document.getElementById(button.getAttribute('aria-controls')).classList.toggle('is-hidden', isOpen);
                });
            }
            for (const anchor of host.querySelectorAll('a')) {
                anchor.addEventListener('click', event => {
                    event.preventDefault();
                    clicks.push(anchor.id);
                    fakeLocation.href = anchor.href;
                });
            }
        }
        mount(html);
        const signal = new AbortController().signal;
        for (const step of CourseRunner.buildSteps(course, course.lessons.map(l => l.id)).filter(s => s.type === 'openLessonVideo')) {
            fakeLocation.href = course.path;
            const prepared = [];
            await CourseActions.openLessonVideo(step, signal, { path: course.path, prepareNavigation: async (...args) => prepared.push(args) });
            check(clicks.at(-1) === step.lesson.navigation.lectureId, 'only lecture link clicked for ' + step.lesson.title);
            check(prepared[0][0] === 'lecture' && prepared[0][1] === step.lesson.navigation.lecturePath, 'checkpoint before ' + step.lesson.title);
        }
        check(clicks.length === 14, 'seven expand clicks and seven lecture clicks, no reading/exam clicks');
        const first = CourseRunner.buildSteps(course, [1])[0];
        fakeLocation.href = course.path;
        const before = clicks.length;
        await CourseActions.openLessonVideo(first, signal, { path: course.path, prepareNavigation: async () => {} });
        check(clicks.length === before + 1, 'already expanded lesson is not collapsed');
        await CourseActions.openLessonVideo(first, signal, { path: course.path, prepareNavigation: async () => {} });
        check(clicks.length === before + 1, 'resuming on lecture URL does not click again');

        fakeLocation.href = course.path;
        const bad = structuredClone(first);
        const reading = [...host.querySelectorAll('a')].find(a => a.querySelector('h4')?.textContent.trim() === 'Tài liệu đọc');
        bad.lesson.navigation.lectureId = reading.id;
        bad.lesson.navigation.lecturePath = reading.href;
        let rejected = false;
        try { await CourseActions.openLessonVideo(bad, signal, { path: course.path, prepareNavigation: async () => {} }); }
        catch (error) { rejected = error.message.includes('không phải đúng Video'); }
        check(rejected && clicks.length === before + 1, 'misconfigured reading link is rejected before click');

        const abort = new AbortController();
        await CourseActions.openLessonVideo(first, abort.signal, { path: course.path, prepareNavigation: async () => abort.abort() })
            .then(() => { throw new Error('Expected abort'); }, error => check(error.name === 'AbortError', 'Stop during navigation preparation cancels click'));
        check(clicks.length === before + 1, 'no late click after Stop');

        let redirectRejected = false;
        try {
            await CourseActions.openLessonVideo(first, signal, {
                path: course.path, navigation: { phase: 'lecture' }, prepareNavigation: async () => {}
            });
        } catch (error) { redirectRejected = error.code === 'NAVIGATION_FAILED'; }
        check(redirectRejected && clicks.length === before + 1, 'blocked lecture redirect cannot create a repeated click loop');

        host.replaceChildren();
        fakeLocation.href = course.lessons[1].navigation.lecturePath;
        fakeLocation.assign = url => { fakeLocation.href = url; mount(html); };
        const returns = [];
        await CourseActions.openLessonVideo(first, signal, {
            path: course.path, prepareNavigation: async (phase, url) => returns.push([phase, url])
        });
        check(returns[0][0] === 'outline' && returns[0][1] === course.path, 'next lesson returns to the correct course outline');
        check(returns[1][0] === 'lecture' && clicks.at(-1) === first.lesson.navigation.lectureId, 'then clicks only the next requested lecture');

        const second = JSON.parse(JSON.stringify(course).replaceAll('BacNinh', 'TestProvince'));
        second.id = 'test-province';
        second.title = 'Khóa học thử nghiệm';
        second.code = 'TEST';
        mount(html.replaceAll('BacNinh', 'TestProvince'));
        fakeLocation.href = second.path;
        const secondStep = CourseRunner.buildSteps(second, [2])[0];
        await CourseActions.openLessonVideo(secondStep, signal, { path: second.path, prepareNavigation: async () => {} });
        check(clicks.at(-1) === second.lessons[1].navigation.lectureId, 'same action works with another course using only data changes');

        // Popup runs unchanged in an iframe, with a Chrome storage/messaging test double.
        const saved = { selectedCourseId: course.id, lessonSelections: { [course.id]: [1, 5], [second.id]: [2] } };
        const sent = [];
        const listeners = [];
        const frame = document.createElement('iframe');
        document.body.append(frame);
        const doc = frame.contentDocument;
        doc.open();
        doc.write(popupHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace('<link rel="stylesheet" href="popup.css">', '<style>' + popupCss + '</style>'));
        const win = frame.contentWindow;
        win.fetch = async () => ({ ok: true, json: async () => ({ courses: [course, second] }) });
        win.chrome = {
            storage: {
                local: { get: async () => structuredClone(saved), set: async value => Object.assign(saved, structuredClone(value)) },
                onChanged: { addListener: listener => listeners.push(listener) }
            },
            runtime: {
                getURL: name => name,
                sendMessage: async message => {
                    sent.push(message);
                    saved.courseRun = message.type === 'COURSE_START' ? {
                        id: 'smoke-run', status: 'running', courseId: message.courseId,
                        selectedLessonIds: message.selectedLessonIds, moduleTestOnly: message.moduleTestOnly ?? null,
                        message: 'Đang chạy thử'
                    } : { ...saved.courseRun, status: 'stopped' };
                    listeners.forEach(listener => listener({ courseRun: { newValue: saved.courseRun } }, 'local'));
                    return { ok: true };
                }
            }
        };
        win.eval(runnerCode);
        win.eval(popupCode);
        doc.close();
        const pause = () => new Promise(resolve => setTimeout(resolve, 50));
        await pause();
        const $ = id => doc.getElementById(id);
        const itemCount = course.lessons.length + (course.review?.questions?.length ? 1 : 0);
        check($('course-select').options.length === 2 && !$('course-picker').hidden, 'popup discovers both courses');
        check(doc.querySelectorAll('.lesson input:checked').length === 2, 'saved multi-lesson selection [1, 5] is restored, not reduced to one');
        check(!$('select-all').checked && $('select-all').indeterminate, 'select-all reflects a partial selection');
        $('course-select').value = second.id;
        $('course-select').dispatchEvent(new win.Event('change'));
        await pause();
        check($('course-title').textContent === second.title && $('course-link').href === second.path, 'course title and path come from data');
        check(doc.querySelector('.lesson input:checked').value === '2', 'second course has its own lesson selection');
        check(!$('select-all-wrap').hidden, 'select all is available once more than one item can be picked');
        doc.querySelectorAll('.lesson input')[2].click(); await pause();
        check(doc.querySelectorAll('.lesson input:checked').length === 2, 'checking another lesson adds to the selection instead of replacing it');
        check([...doc.querySelectorAll('.lesson input:checked')].map(i => i.value).sort().join(',') === '2,3', 'both the saved and the newly checked lesson remain selected');
        $('select-all').click(); await pause();
        check(doc.querySelectorAll('.lesson input:checked').length === itemCount, 'select all checks every lesson plus the final review');
        $('select-all').click(); await pause();
        check(doc.querySelectorAll('.lesson input:checked').length === 0 && $('btn-start').disabled, 'unchecking select all clears every lesson and disables Start');
        $('select-all').click(); await pause();
        $('btn-start').click(); await pause();
        const startedIds = sent.at(-1).selectedLessonIds;
        check(sent.at(-1).courseId === second.id, 'Start sends the selected course');
        check(JSON.stringify(startedIds) === JSON.stringify([...second.lessons.map(l => l.id), -1]), 'Start runs every lesson in course order, then the final review');
        check($('course-select').disabled && !$('btn-stop').disabled, 'course switching locked while running');
        $('btn-stop').click(); await pause();
        check(!$('course-select').disabled && $('btn-stop').disabled, 'Stop unlocks course selection');
        $('course-select').value = course.id;
        $('course-select').dispatchEvent(new win.Event('change')); await pause();
        check(doc.querySelectorAll('.lesson input:checked').length === 2, 'switching back restores the saved multi-lesson selection');

        const testOnlyBtn = doc.querySelectorAll('.lesson-test-only')[0];
        check(!!testOnlyBtn, '"Chỉ ôn tập" button is rendered for each lesson with a module test');
        testOnlyBtn.click(); await pause();
        const testOnlyStart = sent.at(-1);
        check(testOnlyStart.type === 'COURSE_START' && testOnlyStart.moduleTestOnly === course.lessons[0].id &&
            testOnlyStart.selectedLessonIds.length === 0, '"Chỉ ôn tập" starts only that lesson\'s module test');
        check(doc.querySelectorAll('.lesson input:checked').length === 2, 'existing lesson checkboxes are untouched by a module-test-only run');
        check($('btn-start').disabled && testOnlyBtn.disabled, 'Start and every "Chỉ ôn tập" button lock while a module-test-only run is active');
        $('btn-stop').click(); await pause();
        check(!testOnlyBtn.disabled, '"Chỉ ôn tập" unlocks again once the run stops');
        check(doc.querySelectorAll('.lesson input:checked').length === 2, 'lesson selection still intact after stopping the module-test-only run');

        await runPlayerDOMTests(check);
        document.body.dataset.smoke = 'passed';
    } catch (error) {
        report.push('FAIL ' + error.stack);
        document.body.dataset.smoke = 'failed';
    }
    document.getElementById('result').textContent = report.join('\n');
})();
