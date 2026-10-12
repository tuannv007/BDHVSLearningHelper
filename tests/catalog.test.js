const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Runner = require('../course-runner.js');
const catalog = require('../data.json');
const course = Runner.getCourses(catalog)[0];
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/course-outline.html'), 'utf8');

test('every packaged content/background/popup script exists, is valid UTF-8 and parses', () => {
    const manifest = require('../manifest.json');
    const scripts = new Set([
        ...manifest.content_scripts.flatMap(item => item.js), manifest.background.service_worker,
        ...[...fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
    ]);
    for (const filename of scripts) {
        const bytes = fs.readFileSync(path.join(__dirname, '..', filename));
        const code = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        assert.ok(bytes.length > 0, filename);
        new vm.Script(code, { filename });
    }
    assert.ok(scripts.has('site-adapter.js'));
    assert.ok(scripts.has('actions/open-lesson-video.js'));
});

test('all seven lesson routes are grounded in supplied HTML, never reading or exams', () => {
    for (const lesson of course.lessons) {
        const nav = lesson.navigation;
        assert.ok(fixture.includes('id="' + nav.sectionId + '"'));
        assert.ok(fixture.includes('href="' + nav.lecturePath + '"'));
        const anchor = [...fixture.matchAll(/<a\s[^>]*>[\s\S]*?<\/a>/g)].map(m => m[0])
            .find(html => html.includes('id="' + nav.lectureId + '"'));
        const title = /<h4 class="subsection-title">([\s\S]*?)<\/h4>/.exec(anchor)[1].replace(/\s+/g, ' ').trim();
        assert.ok(title.startsWith(nav.lectureTitle + ' ('), title);
        assert.match(title, /^Video bài giảng \d+ \(\d+ câu hỏi\)$/);
    }
});

test('a second course needs only its own data; IDs/routes are not copied from first course', () => {
    const second = JSON.parse(JSON.stringify(course).replaceAll('BacNinh', 'TestProvince'));
    second.id = 'test-province';
    second.title = 'Khóa thử nghiệm';
    const data = { courses: [course, second] };
    assert.equal(Runner.getCourse(data, second.id).path, second.path);
    const [step] = Runner.buildSteps(Runner.getCourse(data, second.id), [2]);
    assert.equal(step.type, 'openLessonVideo');
    assert.match(step.lesson.navigation.sectionId, /TestProvince/);
    assert.match(step.lesson.navigation.lecturePath, /TestProvince/);
    assert.throws(() => Runner.getCourse(data));
    assert.throws(() => Runner.getCourses({ courses: [course, course] }), /trùng/);
});

test('lecture destination checks accept jump_to/canonical block routes but reject other pages', () => {
    const nav = course.lessons[0].navigation;
    const blockId = nav.lectureId.split('+block@').at(-1);
    assert.equal(Runner.isLecturePage(nav.lecturePath, course.path, nav.lectureId), true);
    assert.equal(Runner.isLecturePage(course.path + blockId + '/', course.path, nav.lectureId), true);
    assert.equal(Runner.isLecturePage(course.path, course.path, nav.lectureId), false);
    assert.equal(Runner.isLecturePage(course.path + 'wrong/' + '?next=' + nav.lectureId, course.path, nav.lectureId), false);
    const other = JSON.parse(JSON.stringify(course));
    other.lessons[0].navigation.lecturePath = course.lessons[1].navigation.lecturePath;
    assert.throws(() => Runner.buildSteps(other, [1]), /không thuộc đúng/);
});
