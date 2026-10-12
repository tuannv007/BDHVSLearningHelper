/* Shared by the service worker, popup, content script and Node tests. */
(function (root) {
    'use strict';
    const ORIGIN = 'https://binhdanhocvuso.gov.vn';

    function questionSeconds(question) {
        // Prefer the human-editable mm:ss field; support seconds-only records too.
        if (question.time != null) {
            const match = /^(\d+):([0-5]\d)$/.exec(question.time);
            if (!match) throw new Error('Thời gian không hợp lệ: ' + question.time);
            return Number(match[1]) * 60 + Number(match[2]);
        }
        if (!Number.isFinite(question.timeSeconds) || question.timeSeconds < 0) {
            throw new Error('Câu hỏi thiếu thời gian hợp lệ.');
        }
        return question.timeSeconds;
    }

    function validateCourse(course) {
        const url = new URL(course.path);
        if (url.origin !== ORIGIN || !/^\/courses\/[^/]+\/course\/$/.test(url.pathname)) {
            throw new Error('Trường path phải là URL khóa học trên binhdanhocvuso.gov.vn.');
        }
        if (!Array.isArray(course.lessons) || !course.lessons.length) {
            throw new Error('data.json chưa có danh sách bài học.');
        }
        if (course.navigation?.action && course.navigation.action !== 'openLessonVideo') {
            throw new Error('Action mở bài không hỗ trợ: ' + course.navigation.action);
        }
        if (new Set(course.lessons.map(lesson => lesson.id)).size !== course.lessons.length) {
            throw new Error('ID bài học bị trùng trong khóa ' + course.title);
        }
        return course;
    }

    function getCourses(data) {
        const courses = data.courses || [data]; // Read legacy single-course data too.
        if (!Array.isArray(courses) || !courses.length) throw new Error('data.json chưa có khóa học.');
        const normalized = courses.map(course => ({ ...validateCourse(course), id: course.id || course.path }));
        if (new Set(normalized.map(course => course.id)).size !== normalized.length) {
            throw new Error('ID khóa học bị trùng trong data.json.');
        }
        return normalized;
    }

    function getCourse(data, id) {
        const courses = getCourses(data);
        const course = id == null && courses.length === 1 ? courses[0] : courses.find(item => item.id === id);
        if (!course) throw new Error('Hãy chọn một khóa học có trong data.json.');
        return course;
    }

    function isLecturePage(url, path, lectureId) {
        if (!isCoursePage(url, path) || !lectureId) return false;
        // jump_to URLs use the full block ID; courseware routes may use its block hash.
        const blockId = lectureId.split('+block@').at(-1);
        return new URL(url).pathname.split('/').some(part => {
            const decoded = decodeURIComponent(part);
            return decoded === lectureId || decoded === blockId;
        });
    }

    function lessonNavigation(course, lesson) {
        const navigation = lesson.navigation;
        if (!navigation?.sectionId || !navigation.lectureId || !navigation.lecturePath ||
            !/^Video bài giảng\s+\d+$/i.test(navigation.lectureTitle || '')) {
            throw new Error('Thiếu cấu hình mở Video bài giảng tại ' + lesson.title + ' trong data.json.');
        }
        if (!isLecturePage(navigation.lecturePath, course.path, navigation.lectureId)) {
            throw new Error('Link Video bài giảng không thuộc đúng khóa/bài: ' + lesson.title);
        }
        return navigation;
    }

    function isCoursePage(url, path) {
        try {
            const page = new URL(url);
            const course = new URL(path);
            const prefix = course.pathname.slice(0, -'course/'.length);
            return page.origin === course.origin && page.pathname.startsWith(prefix);
        } catch {
            return false;
        }
    }

    // How many seconds before a question's timestamp playback should reach
    // before waiting for the panel — gives YouTube a moment to actually be
    // playing (not still loading/buffering) once the exact mark arrives. Some
    // videos load noticeably slower right around a specific question (seen on
    // real runs); question.seekEarlySeconds in data.json overrides this for
    // just that one question when 6s isn't enough runway.
    const DEFAULT_SEEK_EARLY_SECONDS = 6;

    function videoSteps(lesson, videos) {
        const steps = [];
        for (const [index, video] of videos.entries()) {
            const videoRef = {
                id: video.id, title: video.title,
                tab: video.tab || { index, title: lesson.id + '.' + (index + 1) }
            };
            steps.push({ type: 'openVideo', lesson, video: videoRef });
            if (video.playbackOnly === true && !video.questions?.length) {
                steps.push({ type: 'skipVideoToEnd', lesson, video: videoRef });
                continue;
            }
            if (!Array.isArray(video.questions) || !video.questions.length) {
                throw new Error(lesson.title + ' / ' + video.title + ' chưa có câu hỏi hoặc playbackOnly.');
            }
            const questions = video.questions.map(question => ({
                ...question, timeSeconds: questionSeconds(question)
            })).sort((a, b) => a.timeSeconds - b.timeSeconds);
            for (const [questionIndex, question] of questions.entries()) {
                if (!/^[A-D]$/.test(question.answer)) {
                    throw new Error('Đáp án không hợp lệ tại ' + lesson.title + ' / ' + video.title);
                }
                const seekEarly = Number.isFinite(question.seekEarlySeconds) && question.seekEarlySeconds >= 0
                    ? question.seekEarlySeconds : DEFAULT_SEEK_EARLY_SECONDS;
                steps.push({ type: 'answerQuestion', lesson, video: videoRef, question,
                    seekSeconds: Math.max(0, question.timeSeconds - seekEarly),
                    // Only the first question of a fresh video resets it to 00:00
                    // first; later questions in the same video keep playing on.
                    resetToStart: questionIndex === 0 });
            }
        }
        return steps;
    }

    function stepsFromTabs(step, tabs) {
        if (!Array.isArray(tabs) || !tabs.length || tabs.length > 100 ||
            tabs.some(tab => !Number.isInteger(tab.index) || tab.index < 0 ||
                typeof tab.title !== 'string' || typeof tab.blockId !== 'string') ||
            new Set(tabs.map(tab => tab.index)).size !== tabs.length) {
            throw new Error('Danh sách tab của bài giảng không hợp lệ.');
        }
        const configured = new Map(step.videos.map((video, index) => [video.tab?.index ?? index, video]));
        if (configured.size !== step.videos.length) throw new Error('Trùng tab.index trong data.json.');
        for (const [index, video] of configured) {
            const tab = tabs.find(item => item.index === index);
            if (!tab || (video.tab?.title && video.tab.title !== tab.title) ||
                (video.tab?.blockId && video.tab.blockId !== tab.blockId)) {
                throw new Error('Tab không khớp dữ liệu tại ' + step.lesson.title + ' / ' + video.title);
            }
        }
        const videos = [...tabs].sort((a, b) => a.index - b.index).map(tab => {
            const known = configured.get(tab.index);
            return known ? { ...known, tab } : {
                id: tab.index + 1, title: 'Video ' + tab.title, tab, playbackOnly: true, questions: []
            };
        });
        return [...videoSteps(step.lesson, videos), ...testSteps(step.lesson, step.test)];
    }

    function testSteps(lesson, data) {
        if (!data?.questions?.length) return [];
        const questions = [...data.questions].sort((a, b) => a.id - b.id);
        if (questions.some((q, index) => q.id !== index + 1 || !/^[A-D]$/.test(q.answer))) {
            throw new Error('Dữ liệu test phải có ID liên tiếp từ 1 và đáp án A–D: ' + lesson.title);
        }
        return [{ type: 'answerLessonTest', lesson, questions,
            pageTitle: data.pageTitle || 'Ôn tập Module ' + lesson.id },
            { type: 'returnToOutline', lesson }];
    }

    // Gap enforced between two selected lessons, and between the last selected
    // lesson and the final review, when several are queued up in one run.
    const LESSON_GAP_MS = 3000;
    const REVIEW_LESSON = { id: -1, title: 'Bài kiểm tra cuối khoá' };

    function waitStep(lesson) {
        return { type: 'wait', ms: LESSON_GAP_MS, lesson };
    }

    function finalReviewSteps(course, { requireNavigation }) {
        const steps = testSteps(REVIEW_LESSON, course.review);
        if (!steps.length) throw new Error('Chưa có review.questions trong data.json.');
        const answer = { ...steps[0], pageTitle: course.review.title || 'Bài kiểm tra cuối khoá', manualPage: true };
        const nav = course.review.navigation;
        if (!nav) {
            if (requireNavigation) {
                throw new Error('Cần khai báo review.navigation trong data.json để tự mở bài kiểm tra cuối khoá sau các bài học.');
            }
            return [answer];
        }
        if (!isLecturePage(nav.path, course.path, nav.sequenceId) || !nav.examId ||
            !Number.isInteger(nav.tabIndex) || nav.tabIndex < 0) throw new Error('Cấu hình mở bài cuối khoá không hợp lệ.');
        return [{ type: 'openFinalReview', lesson: answer.lesson, navigation: nav }, answer];
    }

    function moduleTestOnlySteps(course, lessonId) {
        const lesson = course.lessons.find(item => item.id === lessonId);
        if (!lesson) throw new Error('Bài học không tồn tại.');
        // Only the module test itself, run from a tab the user already opened
        // to the right "Ôn tập Module" page — no video, no navigation.
        const steps = testSteps({ id: lesson.id, title: lesson.title }, lesson.test);
        if (!steps.length) throw new Error(lesson.title + ' chưa có câu hỏi ôn tập.');
        return [{ ...steps[0], manualPage: true }];
    }

    function buildSteps(course, selectedIds) {
        validateCourse(course);
        if (!Array.isArray(selectedIds) || !selectedIds.length) {
            throw new Error('Hãy chọn ít nhất một bài học.');
        }
        const wantsReview = selectedIds.includes(-1);
        const lessonIds = selectedIds.filter(id => id !== -1);
        if (wantsReview && !lessonIds.length) {
            // Review only: allow running it from a tab the user already opened,
            // when the course has no automatic navigation configured for it.
            return finalReviewSteps(course, { requireNavigation: false });
        }
        const ids = new Set(lessonIds);
        if ([...ids].some(id => !course.lessons.some(lesson => lesson.id === id))) {
            throw new Error('Danh sách chọn có bài học không tồn tại.');
        }
        if (wantsReview && !course.review?.questions?.length) {
            throw new Error('Chưa có review.questions trong data.json.');
        }
        const steps = [];
        const selectedLessons = course.lessons.filter(item => ids.has(item.id));
        for (const [index, lesson] of selectedLessons.entries()) {
            if (index > 0) steps.push(waitStep({ id: lesson.id, title: lesson.title }));
            if (!Array.isArray(lesson.videos) || !lesson.videos.length) {
                throw new Error(lesson.title + ' chưa có video.');
            }
            const lessonRef = { id: lesson.id, title: lesson.title, navigation: lessonNavigation(course, lesson) };
            steps.push({
                type: 'openLessonVideo', lesson: lessonRef,
                outlineSelector: course.navigation?.outlineSelector || '#course-outline-block-tree'
            });
            steps.push({ type: 'discoverVideoTabs', lesson: lessonRef, videos: lesson.videos, test: lesson.test });
            steps.push(...videoSteps(lessonRef, lesson.videos));
            steps.push(...testSteps(lessonRef, lesson.test));
        }
        if (wantsReview) {
            // Runs after every selected lesson, in course order, never before.
            if (steps.length) steps.push(waitStep(REVIEW_LESSON));
            steps.push(...finalReviewSteps(course, { requireNavigation: true }));
        }
        return steps;
    }

    function describeStep(step) {
        if (!step) return 'Đã xử lý xong video và câu hỏi kiểm tra các bài đã chọn.';
        if (step.type === 'wait') return 'Đang chờ ' + Math.round(step.ms / 1000) + 's trước ' + step.lesson.title;
        if (step.type === 'answerLessonTest') return step.lesson.title + ' · Đang làm ' + step.pageTitle;
        if (step.type === 'returnToOutline') return step.lesson.title + ' · Đang quay về danh sách bài học';
        if (step.type === 'openFinalReview') return 'Đang mở bài kiểm tra cuối khoá';
        if (step.type === 'openLessonVideo') return step.lesson.title + ' · Đang mở ' + step.lesson.navigation.lectureTitle;
        if (step.type === 'discoverVideoTabs') return step.lesson.title + ' · Đang đọc danh sách tab video';
        if (step.type === 'openVideo') return step.lesson.title + ' · Đang mở ' + step.video.title;
        if (step.type === 'skipVideoToEnd') return step.lesson.title + ' · Tab ' + step.video.tab.title + ' · Tua đến cuối video';
        return step.lesson.title + ' · ' + step.video.title + ' · Câu hỏi ' +
            (step.question.time || step.question.timeSeconds + 's') + ' · Đáp án ' + step.question.answer;
    }

    root.CourseRunner = { validateCourse, getCourses, getCourse, isCoursePage, isLecturePage, questionSeconds, buildSteps, moduleTestOnlySteps, stepsFromTabs, describeStep };
    if (typeof module !== 'undefined') module.exports = root.CourseRunner;
})(globalThis);
