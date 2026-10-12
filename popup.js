document.addEventListener('DOMContentLoaded', async () => {
    const $ = id => document.getElementById(id);
    let course;
    let courses = [];
    let lessonSelections = {};
    let run;
    let busy = false;
    let selectionWrites = Promise.resolve();
    let selected = new Set();
    let currentItems = [];
    const labels = { running: 'Đang chạy', stopped: 'Đã dừng', completed: 'Hoàn tất', error: 'Có lỗi', needsConfig: 'Chờ cập nhật HTML' };

    function describeSelection() {
        if (!selected.size) return 'Chưa chọn bài nào.';
        const lessonCount = [...selected].filter(id => id !== -1).length;
        const wantsReview = selected.has(-1);
        if (wantsReview && !lessonCount) {
            return course.review.navigation ? 'Start sẽ mở và bắt đầu bài kiểm tra tính giờ.' : 'Mở sẵn trang kiểm tra cuối khoá rồi nhấn Start.';
        }
        const base = 'Đã chọn ' + lessonCount + '/' + (course?.lessons.length || 0) + ' bài học';
        return wantsReview ? base + ', sau đó tự làm bài ôn tập (chờ 3s giữa mỗi bài).' : base + ' (chờ 3s giữa mỗi bài).';
    }

    function render() {
        const running = run?.status === 'running';
        const viewRun = run?.courseId === course?.id || run?.path === course?.path ? run : null;
        const inputs = [...document.querySelectorAll('.lesson input')];
        for (const input of inputs) {
            input.checked = selected.has(Number(input.value));
            input.disabled = busy || running;
        }
        const selectAll = $('select-all');
        $('select-all-wrap').hidden = currentItems.length < 2;
        selectAll.checked = currentItems.length > 0 && selected.size === currentItems.length;
        selectAll.indeterminate = selected.size > 0 && selected.size < currentItems.length;
        selectAll.disabled = busy || running;
        $('btn-start').disabled = busy || running || !course || !selected.size;
        $('btn-stop').disabled = busy || !running;
        $('course-select').disabled = busy || running;
        $('selection-summary').textContent = describeSelection();
        $('status-text').textContent = labels[viewRun?.status] || 'Sẵn sàng';
        $('status-dot').className = 'dot ' + (viewRun?.status || '');
        $('status-detail').textContent = viewRun?.message || 'Chọn các bài muốn chạy, rồi nhấn Start.';
        $('run-progress').max = viewRun?.totalQuestions || 1;
        $('run-progress').value = viewRun?.completedQuestions || 0;
        const mixedRun = viewRun?.selectedLessonIds?.includes(-1) && viewRun.selectedLessonIds.length > 1;
        const testOnlyRun = viewRun?.selectedLessonIds?.includes(-1) || viewRun?.moduleTestOnly != null;
        const unit = testOnlyRun ? (mixedRun ? ' câu đã xử lý' : ' câu kiểm tra đã gửi') : ' câu hỏi video đã xử lý';
        $('progress-text').textContent = (viewRun?.completedQuestions || 0) + '/' + (viewRun?.totalQuestions || 0) + unit;
        for (const button of document.querySelectorAll('.lesson-test-only')) button.disabled = busy || running;

        const logsList = $('logs-list');
        const logsCount = $('logs-count');
        const logs = Array.isArray(viewRun?.logs) ? viewRun.logs : [];
        if (logsCount) logsCount.textContent = logs.length + ' bước';
        if (logsList) {
            if (!logs.length) {
                logsList.innerHTML = '<p class="muted empty-logs">Chưa có nhật ký nào. Nhấn Start để bắt đầu.</p>';
            } else {
                let html = '';
                let lastLesson = null;
                for (const item of logs) {
                    if (item.lessonTitle && item.lessonTitle !== lastLesson) {
                        lastLesson = item.lessonTitle;
                        html += `<div class="log-group-title">📘 ${lastLesson}</div>`;
                    }
                    const icon = item.status === 'success' ? '✔' :
                        item.status === 'error' ? '✖' :
                        item.status === 'skipped' ? '⚠️' : '⏳';
                    const cls = item.status || 'running';
                    html += `<div class="log-entry ${cls}">`;
                    html += `<span class="log-entry-icon">${icon}</span>`;
                    html += `<div style="flex:1;">`;
                    html += `<div class="log-entry-desc">${item.desc || ('Bước ' + (item.stepIndex + 1))}</div>`;
                    if (item.status === 'error' && item.detail) {
                        html += `<div class="log-entry-detail">${item.detail}</div>`;
                    } else if (item.status === 'skipped' && item.detail) {
                        html += `<div class="log-entry-detail" style="color:#fde68a;">${item.detail}</div>`;
                    }
                    html += `</div></div>`;
                }
                logsList.innerHTML = html;
                logsList.scrollTop = logsList.scrollHeight;
            }
        }
    }

    function showError(error) {
        $('error-message').textContent = error.message;
        $('error-message').hidden = false;
    }
    function saveSelection() {
        lessonSelections[course.id] = [...selected];
        // Plain JSON round-trip instead of structuredClone(): lessonSelections
        // is always just course IDs mapped to arrays of numbers, and this
        // keeps the extension installable on Chrome versions that predate
        // structuredClone (added in Chrome 98) without losing anything.
        const value = { selectedCourseId: course.id, lessonSelections: JSON.parse(JSON.stringify(lessonSelections)) };
        selectionWrites = selectionWrites.then(() => chrome.storage.local.set(value)).catch(showError);
        render();
    }

    function chooseCourse(id, selectedIds) {
        course = courses.find(item => item.id === id) || courses[0];
        const ids = selectedIds || lessonSelections[course.id] || [];
        const items = [...course.lessons];
        if (course.review?.questions?.length) items.push({ id: -1, title: 'Bài kiểm tra cuối khoá', review: true });
        currentItems = items;
        selected = new Set(ids.filter(id => items.some(lesson => lesson.id === id)));
        $('course-select').value = course.id;
        $('course-title').textContent = course.title;
        $('course-code').textContent = course.code || '';
        $('course-code').hidden = !course.code;
        $('course-link').href = course.path;
        $('lesson-list').replaceChildren();
        for (const lesson of items) {
            const label = document.createElement('label');
            label.className = 'lesson';
            label.title = lesson.outlineTitle || lesson.title;
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = lesson.id;
            input.addEventListener('change', () => {
                if (input.checked) selected.add(lesson.id);
                else selected.delete(lesson.id);
                saveSelection();
            });
            const title = document.createElement('span');
            title.className = 'lesson-title';
            title.textContent = lesson.title;
            const meta = document.createElement('span');
            meta.className = 'lesson-meta';
            meta.textContent = lesson.review ? course.review.questions.length + ' câu · ' + (course.review.navigation ? 'Tự mở bài kiểm tra tính giờ' : 'Mở sẵn trang kiểm tra rồi Start') : lesson.videos.length + ' video · ' + lesson.videos.reduce((n, video) => n + video.questions.length, 0) + ' câu hỏi';
            label.append(input, title, meta);
            const row = document.createElement('div');
            row.className = 'lesson-row';
            row.append(label);
            if (!lesson.review && lesson.test?.questions?.length) {
                const testOnlyBtn = document.createElement('button');
                testOnlyBtn.type = 'button';
                testOnlyBtn.className = 'lesson-test-only';
                testOnlyBtn.textContent = 'Chỉ ôn tập';
                testOnlyBtn.title = 'Mở sẵn đúng trang "' + (lesson.test.pageTitle || 'Ôn tập Module ' + lesson.id) +
                    '" rồi bấm để chỉ làm riêng bài ôn tập này, không học lại video.';
                testOnlyBtn.addEventListener('click', () => startModuleTestOnly(lesson));
                row.append(testOnlyBtn);
            }
            $('lesson-list').append(row);
        }
        render();
    }

    async function startModuleTestOnly(lesson) {
        busy = true;
        $('error-message').hidden = true;
        render();
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'COURSE_START', courseId: course?.id, selectedLessonIds: [], moduleTestOnly: lesson.id
            });
            if (!response?.ok) throw new Error(response?.error || 'Không kết nối được extension.');
            run = (await chrome.storage.local.get('courseRun')).courseRun;
        } catch (error) {
            showError(error);
        } finally {
            busy = false;
            render();
        }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.courseRun) {
            run = changes.courseRun.newValue;
            // A "Chỉ ôn tập" run carries no lesson selection of its own — leave
            // the checkboxes exactly as the user left them.
            if (run?.status === 'running' && run.moduleTestOnly == null && courses.some(item => item.id === run.courseId)) {
                chooseCourse(run.courseId, run.selectedLessonIds);
            }
            render();
        }
    });
    $('course-select').addEventListener('change', event => {
        chooseCourse(event.target.value);
        $('error-message').hidden = true;
        saveSelection();
    });
    $('select-all').addEventListener('change', () => {
        selected = $('select-all').checked ? new Set(currentItems.map(item => item.id)) : new Set();
        saveSelection();
    });

    async function command(type) {
        busy = true;
        $('error-message').hidden = true;
        render();
        try {
            await selectionWrites;
            const response = await chrome.runtime.sendMessage({ type, courseId: course?.id, selectedLessonIds: [...selected] });
            if (!response?.ok) throw new Error(response?.error || 'Không kết nối được extension.');
            run = (await chrome.storage.local.get('courseRun')).courseRun;
        } catch (error) {
            showError(error);
        } finally {
            busy = false;
            render();
        }
    }
    $('btn-start').addEventListener('click', () => command('COURSE_START'));
    $('btn-stop').addEventListener('click', () => command('COURSE_STOP'));

    try {
        const response = await fetch(chrome.runtime.getURL('data.json'));
        if (!response.ok) throw new Error('Không đọc được data.json.');
        courses = CourseRunner.getCourses(await response.json());
        const saved = await chrome.storage.local.get(['selectedCourseId', 'lessonSelections', 'selectedLessonIds', 'courseRun']);
        run = saved.courseRun;
        lessonSelections = saved.lessonSelections || { [courses[0].id]: saved.selectedLessonIds || [] };
        for (const item of courses) {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = item.title;
            $('course-select').append(option);
        }
        $('course-picker').hidden = courses.length < 2;
        const restoringRun = run?.status === 'running' && run.moduleTestOnly == null;
        chooseCourse(restoringRun ? run.courseId : saved.selectedCourseId,
            restoringRun ? run.selectedLessonIds : undefined);
    } catch (error) {
        course = null;
        showError(error);
    }
    render();
});
