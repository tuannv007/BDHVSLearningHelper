# Tích hợp HTML khóa học

- [x] Đọc nhiều khóa từ `data.json.courses[]`; popup chọn khóa và lưu lựa chọn bài riêng cho từng khóa.
- [x] `actions/open-lesson-video.js`: action `openLessonVideo` dùng dữ liệu của bài
  để bung accordion và chỉ click đúng mục **Video bài giảng N**.
- [x] Ánh xạ section ID, lecture ID, tiêu đề và URL của đủ 7 bài Bắc Ninh từ HTML đã cung cấp.
- [x] Kiểm tra bằng DOM thật trên bản HTML mẫu: bài đóng/mở, link đọc cấu hình nhầm,
  Stop trước click, về danh sách để mở bài tiếp theo, và khóa thứ hai.
- [x] Kiểm tra file/cú pháp/UTF-8 cho toàn bộ script được manifest và popup tham chiếu.
- [x] `LECTURE_PAGE_HTML`: URL courseware trong iframe HTML có đúng chapter/lecture hash;
  bộ nhận diện URL hiện tại hỗ trợ đường dẫn này.
- [x] `VIDEO_HTML`: Đọc toàn bộ `#sequence-list button[role="tab"]`, bao gồm `seq_problem`.
  Ánh xạ `video.tab.index/title/blockId`; chờ player mới trước khi chuyển sang Play/tua.
- [x] `PLAYER_HTML`: Bấm nút Play của khóa học và overlay YouTube trong iframe.
  Câu hỏi đầu tiên của video tua về `00:00` trước, rồi tua theo `time - 6 giây`,
  phát tới câu hỏi. Nếu video đã xem gần hết khiến việc tua về `00:00` bị
  treo (timeout tua trong YouTube), action không lỗi cả bước — bỏ qua lần
  tua về đầu và tiếp tục từ vị trí hiện tại. `youtube-frame.js` cũng tự dò
  lại nếu YouTube thay thế thẻ `<video>` giữa lúc đang tua (chuyển cảnh
  cuối video/xem lại) thay vì bỏ cuộc trên phần tử cũ. Stop hủy lệnh chờ và
  pause player.
- [x] `IFRAME_HTML`: Thêm `youtube-frame.js` cho YouTube embed; gửi lệnh riêng tới
  iframe của tab đang chọn qua `media-player.js`.
- [x] Tab không có câu hỏi (bao gồm 1.3): Play → tua giây cuối → chờ kết thúc.
  Các tab dư so với dữ liệu được bổ sung vào lượt chạy theo cùng quy tắc.
- [x] `QUESTION_HTML`: Nhận diện `.in-video-problem` trong `#seq_content` theo
  trường `problem_id` có giá trị `Câu N`; chỉ thao tác panel đang hiện.
- [x] `ANSWER_HTML`: Ánh xạ A/B/C/D tới radio `choice_0/1/2/3` theo data.json.
- [x] `SUBMIT_HTML`: Chọn radio, chờ nút Gửi hết disabled rồi click.
- [x] Sau Gửi, chờ Continue sẵn sàng rồi bấm; chờ panel đóng rồi cộng tiến độ.
  Không chặn Continue bằng bộ đếm `data-attempts-used`. Câu đã hiện không yêu cầu autoplay trước.
- [ ] `RESULT_HTML`: Xác minh trạng thái lưu trên website thật sau Gửi và Continue.
- [ ] Kiểm tra trọn luồng trên website thật sau khi có HTML bên trong bài giảng.

Action mở bài vẫn chọn đúng Video bài giảng. Sau tab video cuối, action
`answer-lesson-test.js` bấm `nav.sequence-bottom button.button-next`, chờ
`Ôn tập Module N` rồi chọn đủ đáp án theo `lesson.test.questions`, sau đó
bấm Gửi cho từng câu, cách nhau 200ms (`SUBMIT_GAP_MS`) để trang kịp ghi nhận
từng đáp án thay vì gửi dồn dập. Action không chờ trang báo kết quả
đúng/sai (bộ đếm `data-attempts-used` hay trạng thái correct/incorrect) cho
từng câu nữa — việc đó từng khiến cả bài bị treo rất lâu khi trang chấm chậm.
Sau khi bấm Gửi hết 20 câu, action chờ thêm đúng 5 giây một lần
(`AFTER_TEST_SETTLE_MS`) rồi hoàn tất bước ngay, để `returnToOutline` chuyển
sang bài tiếp theo.
Có thể đặt `lesson.test.pageTitle` nếu trang dùng tiêu đề khác. ID câu phải
liên tiếp từ 1, tương ứng thứ tự các khối câu hỏi trên trang; số câu phải khớp.

Nút **Chỉ ôn tập** cạnh mỗi bài (`CourseRunner.moduleTestOnlySteps`, message
`COURSE_START` kèm `moduleTestOnly: lessonId`) chạy đúng 1 bước
`answerLessonTest` với `manualPage: true` trên tab đang mở sẵn, bỏ qua toàn bộ
`openLessonVideo`/`discoverVideoTabs`/video. Dùng chung cơ chế "mở từ tab có
sẵn" với chế độ làm riêng bài kiểm tra cuối khoá; không kiểm tra được tiêu đề
trang khớp đúng bài N (chỉ kiểm tra số câu khớp `test.questions`), nên người
dùng phải tự mở đúng trang trước khi bấm.
Khi tải lại đúng trang kiểm tra, action tiếp tục mà không bấm Trang sau lần nữa.
Stop vẫn hủy ngay cả khi đang chờ giữa hai lần Gửi hoặc đang chờ 5s cuối.
Sau đó bước riêng `returnToOutline` quay về `course.path`, kể cả bài cuối đã chọn.
Bước này được lưu sau khi xác nhận hoàn tất test; tải lại trang không gửi lại test.
Nếu còn bài được chọn, `openLessonVideo` mở bài tiếp theo từ danh sách.
Continue của video được tìm trong `.in-video-problem-wrapper` để hỗ trợ nút nằm cạnh panel.
Popup có mục Bài kiểm tra cuối khoá lấy toàn bộ `review.questions`.
Khóa Bắc Ninh có `review.navigation`: Start mở link bài cuối khoá đã cung cấp,
bấm nút bắt đầu có exam ID 289 rồi chọn tab thứ hai (data-index=1).
Sau đó kiểm tra số câu, điền đủ đáp án và gửi từng câu. Bước mở bài được lưu
riêng để tiếp tục sau chuyển trang, giống hệt cơ chế của `openLessonVideo`
(`COURSE_PREPARE_NAVIGATION` với `phase: "review"`): nếu trang bị bật lại
danh sách bài học thay vì vào đúng bài kiểm tra, action báo lỗi rõ ràng thay
vì bấm/chuyển trang lặp lại vô hạn. Khóa chưa có navigation vẫn dùng tab người dùng mở sẵn.
Chưa xác minh luồng kiểm tra trên website thật.

Luồng: Start → mở `course.path` → `openLessonVideo` → chọn video nhỏ → câu hỏi
đầu tiên tua về `00:00` trước → tua `max(0, time - 6 giây)` → chờ câu hỏi →
chọn đáp án → xác nhận lưu → tiếp tục.
Khi chuyển sang bài tiếp theo, action quay lại `course.path` nếu cần rồi mở đúng
mục Video bài giảng của bài đó. Website có thể yêu cầu hoàn tất điều kiện tiên quyết;
action không tự mở bài ôn tập để đáp ứng điều kiện.

Hiện có thể mở bài, chọn tab, Play và tua trong YouTube iframe, chọn đáp án
theo dữ liệu rồi Gửi và Continue. Việc chờ nút Continue và chờ đóng panel sau
Continue chờ nhanh 5 giây trước; nếu quá 5 giây mà đáp án **chưa** được xác
nhận ghi nhận (`data-attempts-used`), chờ tiếp phần còn lại (tổng khoảng 30
giây) rồi mới báo lỗi và không cộng tiến độ nếu vẫn không có; nếu đáp án đã
được xác nhận ghi nhận thì không chờ thêm, cộng tiến độ và tiếp tục ngay,
chỉ ghi cảnh báo ra console (xem mục "Câu hỏi trong video bị kẹt do lỗi ở
chính trang" trong README.md). Lựa chọn và tiến độ lưu trong
`chrome.storage.local`; Stop hủy chờ và pause video. Start chạy lại từ đầu.
Cách thêm khóa và kiểm tra xem `README.md`.

## Đã sửa: câu hỏi trong video trả lời xong không chuyển tiếp do lỗi widget của trang

Một số video (quan sát được tại Bài 2/Video 3, qua console thật do người
dùng cung cấp) sau khi trả lời xong tự phát sinh lỗi từ chính script của
trang (`invideoquiz...js` đọc `currentTime` của `undefined`,
`www-widgetapi.js` đọc `id` của `undefined`, lặp hàng chục lần) ngay trước
dòng lỗi của extension "Hết thời gian chờ: đóng câu hỏi". Tức là đáp án đã
Gửi và Continue đã được bấm thành công, chỉ riêng bảng câu hỏi không tự
đóng vì widget câu hỏi của trang bị lỗi (nghi do YouTube dựng lại player
gần cuối video) — không phải lỗi ở phần chọn/gửi đáp án của extension. Đã
sửa: `content.js`'s `continueQuestion()` giờ chờ theo hai bước qua
`waitTolerant()` — thử chờ nhanh 5 giây trước; nếu chưa xong (không phải do
Stop) mà `data-attempts-used` đã xác nhận câu đó được ghi nhận, coi là
**không nghiêm trọng**: ghi cảnh báo console rồi tiếp tục ngay, không chờ
thêm; nếu chưa ghi nhận thật thì chờ tiếp phần còn lại (tổng khoảng 30 giây
như cũ) rồi mới báo lỗi và dừng nếu vẫn không có. Thêm 4 test kiểm chứng cả
hai nhánh (hết giờ chờ nút Continue / hết giờ chờ đóng bảng, mỗi trường hợp
có và không có xác nhận đã ghi nhận đáp án) — 74 test Node đều pass.

## Đã sửa: học xong bài cuối cùng đã chọn không tự mở bài kiểm tra cuối khoá

Khi chọn 1 bài học (ví dụ Bài 7) cùng với "Bài kiểm tra cuối khoá", popup
báo "Hoàn tất" ngay sau khi xong bài học đó, không tự mở bài kiểm tra cuối
khoá như đã thiết kế. Nguyên nhân nằm ở `background.js`, bước
`COURSE_SYNC_TABS` (chạy sau khi đọc được danh sách tab thật trên trang):
để chỉ thay đúng các bước của riêng bài học vừa đọc tab (không đụng tới các
bài khác), code tìm bước `openLessonVideo` **tiếp theo** trong `run.steps`
làm mốc dừng; nếu không thấy bước nào như vậy (không có bài học nào sau
đó), code coi như "đây là bài cuối cùng của cả lượt chạy" và ghi đè toàn bộ
phần còn lại của `run.steps` bằng dữ liệu chỉ của bài học này — kể cả khi
thực ra vẫn còn bước chờ + mở bài kiểm tra cuối khoá + làm bài kiểm tra
cuối khoá phía sau, vì các bước đó không phải kiểu `openLessonVideo` nên
không được nhận diện là mốc dừng hợp lệ. Kết quả: các bước của bài kiểm
tra cuối khoá bị xoá mất ngay khi bài học **cuối cùng được chọn** (không
phải Bài 7 cụ thể — bất kỳ bài nào được chọn sau cùng, kèm bài kiểm tra
cuối khoá, đều gặp lỗi này) đọc xong danh sách tab, khiến lượt chạy kết
thúc sớm mà không báo lỗi gì. Đã sửa: mốc dừng giờ nhận diện thêm cả bước
`wait` và `openFinalReview` (không chỉ `openLessonVideo`) — đúng với thực
tế là luôn có một bước `wait` ngay trước khi sang bài học tiếp theo HOẶC
trước khi mở bài kiểm tra cuối khoá. Đồng thời sửa luôn cách tính lại
`totalQuestions` ở bước này cho khớp với cách tính lúc Start (có cộng thêm
số câu của bài kiểm tra cuối khoá), tránh hiển thị sai tiến độ. Thêm 1 test
tái hiện đúng kịch bản (chọn bài học cuối cùng + bài kiểm tra cuối khoá,
giả lập đọc tab thật) xác nhận trước khi sửa test này fail đúng như lỗi mô
tả, sau khi sửa thì pass — 75 test Node đều pass.

## Đã sửa: câu hỏi video 4.5 (Bài 4) hay bị treo do tua quá sát mốc câu hỏi

Người dùng phản ánh video 4.5 (câu hỏi tại 04:26) hay bị lỗi tải/quay khi
tua tới gần mốc câu hỏi (mặc định tua sớm 6 giây, tức tới 04:20), dẫn đến
quá thời gian chờ. Chưa có console log thật để xác định chính xác nguyên
nhân phía YouTube/mạng, nhưng theo đề xuất của người dùng, đã thêm khả năng
tùy chỉnh **riêng từng câu hỏi**: trường `question.seekEarlySeconds` (tùy
chọn) trong `data.json` ghi đè số giây tua sớm mặc định (6s) cho đúng câu
hỏi đó — không ảnh hưởng các câu hỏi khác. Đã đặt `seekEarlySeconds: 15`
cho câu hỏi 04:26 của video 4.5/Bài 4, cho video nhiều thời gian ổn định
hơn trước khi tới đúng mốc câu hỏi. Nếu video khác cũng gặp tình trạng
tương tự, chỉ cần thêm cùng trường này vào đúng câu hỏi trong data.json,
không cần sửa code. Thêm test xác nhận override hoạt động đúng (và bỏ qua
giá trị âm/không hợp lệ, dùng lại mặc định 6s) — 76 test Node đều pass.

## Đã sửa: tua tới gần câu hỏi hay bị "Hết thời gian chờ tua video trong YouTube"

Người dùng cung cấp console log thật cho cả video 4.5 (Bài 4) và video 6.4
(Bài 6, câu hỏi tại 05:36, tua tới 05:30) — cùng đúng chuỗi lỗi đã thấy ở
lỗi video 2.3 trước đây (`invideoquiz...js` đọc `currentTime` của
`undefined`, `www-widgetapi.js` đọc `id` của `undefined`, lặp hàng trăm
lần), nhưng lần này xảy ra ngay ở bước **tua tới gần mốc câu hỏi**, trước
khi câu hỏi kịp xuất hiện — khác thời điểm với lỗi 2.3 (lúc đó xảy ra sau
khi trả lời xong). Cùng một triệu chứng gốc (widget câu hỏi/YouTube của
trang bị lỗi tham chiếu) nhưng có thể chặn đứng bất kỳ thao tác nào với
player tại thời điểm đó, không chỉ riêng lúc đóng bảng câu hỏi. Vì đây là
lỗi có thể lặp lại ở nhiều video khác nhau (không riêng 4.5), thay vì tiếp
tục vá riêng từng video bằng `seekEarlySeconds`, đã thêm cơ chế chung:
`actions/play-video.js` giờ có `seekWithRetry()` — nếu một lệnh tua (tới
mốc câu hỏi, hoặc tới cuối video khi bỏ qua tab không câu hỏi) bị lỗi
(không phải do Stop), đợi 1.5 giây rồi thử tua lại đúng một lần trên
player hiện có trước khi thật sự báo lỗi và dừng bước; nếu lần thử lại vẫn
lỗi thì vẫn dừng như cũ, không liều tiếp tục với vị trí video chưa được
xác nhận đúng. `seekEarlySeconds: 15` đã đặt riêng cho video 4.5 vẫn được
giữ lại (giảm khả năng gặp lỗi ngay từ đầu), cơ chế thử lại giúp cả những
video khác như 6.4 mà không cần thêm cấu hình riêng trong data.json. Thêm
3 test kiểm chứng: tua lỗi 1 lần rồi thành công ở lần thử lại (vẫn hoàn
tất bước), tua lỗi cả 2 lần (vẫn báo lỗi và dừng như cũ, không âm thầm bỏ
qua), và Stop trong lúc tua không bị thử lại mà dừng ngay — 79 test Node
đều pass.

## Đã sửa: video 6.4 vẫn treo dù đã có seekWithRetry — tăng seekEarlySeconds lên 10s cho cả 4.5 và 6.4

Người dùng xác nhận: dù `seekWithRetry` đã thử lại đúng 1 lần, video 6.4
(tua tới 05:30, câu hỏi tại 05:36) vẫn báo "Hết thời gian chờ tua video
trong YouTube" y như trước — nghĩa là ngay tại đúng mốc 05:30 của video
này, lỗi widget của trang kéo dài đủ lâu để cả 2 lần tua (lần đầu và lần
thử lại sau 1.5 giây) đều rơi đúng vào khoảng thời gian lỗi đó. Thử lại
thêm lần nữa không giải quyết được một khoảng lỗi kéo dài như vậy — hướng
đúng, theo đúng đề nghị của người dùng, là tua sớm hơn nữa để cả thao tác
tua né hẳn khoảng thời gian trang dễ lỗi đó. Đã đặt `seekEarlySeconds: 10`
cho cả hai: câu hỏi video 4.5 (04:26 → tua tới 04:16, đổi từ mức 15s/04:11
trước đó xuống đúng 10s theo yêu cầu mới nhất) và câu hỏi video 6.4
(05:36 → tua tới 05:26, trước đó dùng mặc định 6s/05:30). `seekWithRetry`
vẫn giữ nguyên làm lớp phòng vệ thứ hai, phòng khi ngay cả mốc tua sớm hơn
này thỉnh thoảng vẫn gặp đúng lúc trang bị lỗi — 80 test Node đều pass.

## Đã sửa: postMessage tới iframe YouTube báo sai origin có thể làm mất kết quả một bước đã xong

Console log người dùng cung cấp cho video 6.4 lần này còn lộ thêm một lỗi
mới, khác chuỗi lỗi widget quen thuộc: `media-player.js:39` báo "Failed to
execute 'postMessage' on 'DOMWindow': The target origin provided
('https://www.youtube.com') does not match the recipient window's origin
('https://binhdanhocvuso.gov.vn'...)". Đây là lỗi từ chính code của
extension (không phải lỗi widget của trang), xảy ra khi gọi `postMessage`
vào iframe YouTube đúng lúc iframe đó tạm thời hiển thị một tài liệu khác
— nhiều khả năng do trang tự tải lại chính iframe đó để "tự phục hồi" ngay
sau khi widget câu hỏi của nó bị lỗi tham chiếu (cùng một sự cố gốc phía
trang, chỉ biểu hiện khác). Đáng lo nhất là khi lỗi này rơi đúng lúc
`release()` dọn dẹp player — hàm này luôn chạy trong khối `finally` sau
mỗi bước — vì nó có thể ném lỗi thay cho kết quả thật của bước đó: một
bước ĐÃ THÀNH CÔNG vẫn có thể hiện ra như lỗi, và các việc dọn dẹp còn lại
(gỡ listener, hủy các lệnh đang chờ phản hồi) bị bỏ dở theo, gây rò rỉ.
Đã bọc lệnh `postMessage` thông báo release trong try/catch — lệnh này chỉ
mang tính thông báo, không có gì chờ phản hồi, nên bỏ qua an toàn khi lỗi
và luôn chạy tiếp phần dọn dẹp còn lại dù thành hay bại. Thêm 1 test xác
nhận `release()` không ném lỗi và vẫn dọn dẹp đầy đủ khi gặp đúng lỗi này
— 80 test Node đều pass.

## Đã cải thiện: giảm nhẹ cấu hình để phù hợp với máy yếu, giảm nguy cơ dừng giữa chừng

Người dùng phản ánh bản v3.0.3, khi áp dụng rộng cho nhiều máy khác nhau, vẫn
có lượt chạy dừng giữa chừng, và một số máy cấu hình thấp không chạy được
extension. Đã tìm hiểu và làm 3 việc:

1. **Tự thử lại khi mất kết nối tạm thời với background**: Chrome có thể tắt
   hẳn service worker nền bất cứ lúc nào để lấy lại bộ nhớ, xảy ra nhiều hơn
   hẳn trên máy ít RAM đúng như phản ánh; một lệnh `sendMessage` gửi đúng
   lúc đó không nhận được phản hồi dù không có gì thật sự sai ("Could not
   establish connection..." / "message port closed before a response was
   received..."), khiến cả lượt chạy dừng oan dù bản thân trang/video không
   có vấn đề gì. `content.js` giờ tự thử lại tối đa 2 lần (300ms rồi 600ms)
   riêng cho đúng hai lỗi này trước khi mới coi là lỗi thật; lỗi khác không
   đổi cách xử lý (fail ngay như cũ). Thêm 3 test: thử lại thành công sau 2
   lần lỗi tạm thời (lượt chạy vẫn hoàn tất bình thường), lỗi không thuộc
   loại tạm thời thì không hề thử lại, và lỗi tạm thời lặp lại quá số lần
   cho phép (3 lần liên tiếp) vẫn dừng lại đúng như thiết kế chứ không thử
   lại vô hạn — 83 test Node đều pass.
2. **Giảm tần suất poll trong mọi vòng lặp chờ**: `site-adapter.js` (200ms →
   400ms), chờ trạng thái player trong `actions/play-video.js` (200ms →
   400ms, mỗi lần là một lượt gửi/nhận với iframe YouTube nên nặng hơn poll
   DOM thường), và vòng lặp bên trong `youtube-frame.js` (100ms → 300ms,
   chạy cùng lúc với việc giải mã/hiển thị video nên tốn tài nguyên nhất
   trong ba nơi). Không ảnh hưởng gì tới hành vi tự động hóa (không cần
   phản hồi tức thì vì không ai theo dõi trực tiếp), nhưng giảm đáng kể số
   lần thức dậy kiểm tra trạng thái trong suốt một lượt chạy dài — có thể
   tạo khác biệt thật trên máy đã sát ngưỡng xử lý kịp.
3. **Hạ `minimum_chrome_version` từ 106 xuống 92**: Chrome chặn hẳn việc
   cài/bật extension nếu trình duyệt thấp hơn mức khai báo trong
   `manifest.json`, kể cả cài bằng Load unpacked — mức "106" trước đó cao
   hơn hẳn mức API mới nhất mà code thật sự dùng, tự loại những máy còn
   dùng Chrome cũ hơn dù lẽ ra chạy được bình thường. Đã bỏ
   `structuredClone()` (chỉ dùng ở `popup.js` để lưu lựa chọn bài, thay
   bằng cách clone qua JSON — dữ liệu vốn chỉ là ID/số nên không mất gì) —
   API mới nhất còn lại thật sự cần (`crypto.randomUUID()`,
   `Array.prototype.at()`) đều có từ Chrome 92, nên hạ đúng xuống mức đó.

Đã tìm hiểu thêm một hướng nữa nhưng **không áp dụng**: ép YouTube phát ở
chất lượng thấp nhất (video luôn tắt tiếng, không ai thật sự xem) để giảm
tải giải mã hình ảnh. Kiểm thử trực tiếp bằng trình duyệt thật với YouTube
IFrame API xác nhận `setPlaybackQuality('tiny')` không có tác dụng trên
embed hiện tại của YouTube — player tự động quay lại chất lượng "large"
ngay sau đó dù đã gọi lệnh ép rõ ràng. Vì không có cách nào xác nhận chắc
chắn tác dụng thật (và không thể kiểm thử lại đúng trong kiến trúc thật của
extension), quyết định không đưa hướng này vào bản cập nhật để tránh thêm
code không rõ có ích hay không.

**Lưu ý**: lượt chạy dừng giữa chừng có thể do hai nguyên nhân khác nhau —
lỗi tạm thời khi mất kết nối với background nền (đã xử lý ở trên), và lỗi
widget/YouTube phía trang binhdanhocvuso.gov.vn (xem mục "Câu hỏi trong
video bị kẹt do lỗi ở chính trang" phía trên và "Lỗi đang chờ xử lý" ngay
bên dưới) — nguyên nhân thứ hai nằm ngoài khả năng kiểm soát của extension,
bản cập nhật này không giải quyết được triệt để nguyên nhân đó, chỉ giảm
khả năng gặp nguyên nhân thứ nhất.

## Đã thêm: bỏ qua câu hỏi/video bị treo thay vì dừng cả lượt chạy

Người dùng phản ánh cụ thể: một số video vẫn báo lỗi "Hết thời gian chờ: câu
hỏi tại xx:xx" và dừng hẳn lượt chạy; yêu cầu sau khi hết thời gian chờ thì
tự động chuyển sang câu hỏi/video tiếp theo, không dừng lại, và bỏ qua luôn
việc báo lỗi/tiến độ để bớt việc cho extension.

Vòng lặp chính trong `content.js`'s `start()` giờ bọc riêng từng bước:
gặp đúng lỗi "Hết thời gian chờ..." (không phải Stop, không phải lỗi khác)
ở một trong ba loại bước — `answerQuestion` (một câu hỏi trong video),
`skipVideoToEnd` (một video không có câu hỏi), `openVideo` (chuyển sang tab
video khác) — thì chỉ ghi cảnh báo ra console rồi coi như xong bước đó,
tiếp tục ngay sang bước tiếp theo qua đúng luồng `COURSE_STEP_DONE` bình
thường, **không** gửi `COURSE_STEP_ERROR` nữa. Popup vì vậy tiếp tục hiện
"Đang chạy" và tiến độ vẫn tăng bình thường, đúng như yêu cầu "bỏ qua việc
thông báo lỗi". Cố tình **không** áp dụng cho các bước mở bài/điều
hướng/bài kiểm tra (`openLessonVideo`, `discoverVideoTabs`,
`answerLessonTest`, `openFinalReview`, `returnToOutline`) — timeout ở những
bước đó thường nghĩa là trang chưa vào đúng chỗ run đang cần, bỏ qua liều
lĩnh có thể khiến cả một bài học/bài kiểm tra bị trôi qua trong im lặng chứ
không chỉ một video/câu hỏi lẻ.

Có một ngoại lệ giữ nguyên như cũ, không bị nới theo thay đổi này:
`answerQuestion` đã có sẵn cơ chế chờ khoan dung riêng cho nút Continue/đóng
bảng câu hỏi (xem mục "Câu hỏi trong video bị kẹt..." phía trên) — nếu hết
cả thời gian chờ đầy đủ (~30s) mà `data-attempts-used` vẫn xác nhận đáp án
**chưa hề được ghi nhận** (khác với trường hợp đã ghi nhận nhưng bảng không
tự đóng), lỗi đó vẫn dừng cả lượt chạy và báo lỗi như trước — không để lọt
qua cơ chế bỏ qua mới. Đây là ranh giới duy nhất còn giữ: một câu hỏi thật
sự chưa từng được trả lời trên hệ thống thật không nên bị coi như đã xong.
Ngoài trường hợp này, mọi timeout khác ở ba loại bước trên (kể cả đúng ví dụ
"câu hỏi tại xx:xx" người dùng nêu — chờ bảng câu hỏi xuất hiện, trước khi
kịp chọn đáp án) đều được bỏ qua theo cơ chế mới.

Thêm 5 test: một test tái hiện đúng ví dụ "câu hỏi tại 06:41" không xuất
hiện (bỏ qua, lượt chạy hoàn tất bình thường, không có COURSE_STEP_ERROR);
hai test cho `skipVideoToEnd`/`openVideo` timeout tương tự; hai test đối
chứng xác nhận một lỗi **không phải** timeout ở cùng hai loại bước đó vẫn
dừng lượt chạy và báo lỗi như cũ (không bị bỏ qua nhầm). Đã xác nhận cả 5
test đều fail đúng như mô tả khi tạm tắt cơ chế mới (kiểm chứng red/green),
rồi pass sau khi bật lại. Hai test cũ xác nhận câu hỏi thật sự chưa được
ghi nhận vẫn dừng lượt chạy (ranh giới `neverSkip` ở trên) vẫn pass không
đổi — 88 test Node và toàn bộ test trình duyệt đều pass.

**Đã thử nhưng chưa đi tiếp được**: tìm hiểu xem chính trang binhdanhocvuso.gov.vn
(khóa `KNS-ND`, nền tảng Open edX — nhận ra qua cấu trúc URL `course-v1:`/
`block-v1:`/`jump_to` sẵn có trong `data.json`) có tính năng nào sẵn có giúp
tự động hoá ổn định hơn (API tiến độ, cơ chế điều hướng ít phụ thuộc DOM
hơn...). Mở trực tiếp trang khóa học thật để kiểm tra thì gặp tường đăng
nhập ("Bạn phải tham gia khóa học để xem được nội dung") — không có sẵn
tài khoản đăng nhập trong phiên trình duyệt, và việc nhập thông tin đăng
nhập thay người dùng nằm ngoài phạm vi cho phép. Không đủ căn cứ để kết
luận có hay không có tính năng như vậy. Cách chắc chắn nhất để tiếp tục
hướng này vẫn là cách đã dùng xuyên suốt dự án: console log/HTML thật chụp
trực tiếp từ trang lúc đã đăng nhập (đặc biệt là lúc widget câu hỏi bị lỗi)
— nếu cung cấp thêm, có thể tìm được cách xử lý tận gốc thay vì chỉ né/bỏ
qua như hiện tại.

## Đã chỉnh: cơ chế bỏ qua ở trên giờ chờ tối đa 15 giây thay vì theo ngân sách gốc

Theo yêu cầu người dùng: thay vì để mỗi bước bị treo chạy hết ngân sách chờ
gốc của nó (vốn không được thiết kế cho việc "bỏ qua" — có chỗ tới 90 giây,
xem mục thống kê thời gian chờ đã gửi trước đó trong hội thoại) rồi mới bị
cơ chế ở mục trên bắt được, `content.js` giờ tự đặt một mốc chờ riêng 15
giây (`STEP_TIMEOUT_MS`) cho đúng ba loại bước có thể bỏ qua
(`answerQuestion`, `skipVideoToEnd`, `openVideo`). Thêm hàm `withStepTimeout()`
tạo một `AbortController` riêng cho từng bước, tự huỷ khi tới mốc 15 giây
HOẶC khi Stop thật sự được bấm (bất kể cái nào tới trước) — nhờ dùng đúng cơ
chế signal/AbortController đã có sẵn trong toàn bộ code, phần đang dở dang
lúc bị huỷ (chờ DOM, lệnh gửi vào iframe YouTube qua postMessage...) dừng
lại thật ngay lúc đó, không chạy ngầm tiếp sau khi đã chuyển sang bước kế —
giống hệt cách Stop vẫn hoạt động, không phải kiểu "bỏ mặc cho chạy tiếp
trong nền". Việc phân biệt "tới mốc 15 giây" với "Stop thật" dựa vào một cờ
`timedOut` riêng, vì cả hai đều tạo ra cùng loại lỗi (AbortError).

Vì đặt mốc chờ ở một chỗ duy nhất (thay vì hạ từng ngân sách chờ lồng bên
trong nhiều file khác nhau: site-adapter.js, play-video.js, youtube-frame.js,
media-player.js), khi cơ chế 15 giây bắt được thì thông tin cụ thể "đang chờ
gì" từ đúng chỗ bị treo không còn nữa (khác với trước, khi lỗi tới từ chính
chỗ bị treo nên tự mang theo mô tả) — dòng cảnh báo console giờ nêu tên câu
hỏi/video từ chính dữ liệu bước thay vì mô tả wait cụ thể, ví dụ "answerQuestion,
câu hỏi 06:41" hoặc "openVideo, video 1.2" kèm "quá 15 giây", vẫn đủ để biết
đúng câu/video nào bị bỏ qua dù kém chi tiết hơn.

**Hệ quả cần lưu ý**: ranh giới `neverSkip` trong `answerQuestion` (một câu
hỏi thật sự chưa được ghi nhận đáp án vẫn dừng cả lượt chạy, xem mục trên)
cần đủ ~30 giây mới xác định được — với mốc 15 giây mới luôn cắt ngang
trước đó, ranh giới này trong thực tế không còn cơ hội áp dụng nữa (dù code
vẫn còn nguyên, chỉ là không chạm tới được). Đã cập nhật `README.md` nêu rõ
hệ quả này.

Thêm 2 test dùng thời gian chờ thật (không giả lập tức thời như các test
khác trong file): một test dựng một bước "treo hẳn, không tự xong" và xác
nhận vẫn phải chờ đủ ~15 giây thật rồi mới được bỏ qua (xác nhận qua cả thời
gian trôi qua lẫn kết quả COURSE_STEP_DONE); một test xác nhận Stop trong
lúc đang treo vẫn dừng hẳn lượt chạy, không bị nhầm thành "tới mốc 15 giây".
Đã xác nhận test đầu tiên fail đúng như mong đợi khi tạm tắt lệnh huỷ bên
trong `withStepTimeout` (kiểm chứng red/green), pass sau khi bật lại — 90
test Node và toàn bộ test trình duyệt đều pass.

## Lỗi đang chờ xử lý (chưa có đủ bằng chứng để chẩn đoán)

- Chưa rõ nguyên nhân gốc thật sự của lỗi widget/YouTube phía trang (mạng,
  YouTube, hay chính binhdanhocvuso.gov.vn) — hiện chỉ có cách né bớt
  (tua sớm hơn), phát hiện và thử lại khi nó xảy ra, cùng đảm bảo dọn dẹp
  không bị lỗi ăn theo, chứ chưa ngăn được lỗi xảy ra từ gốc. Nếu sau bản
  này vẫn còn gặp treo tương tự ở video/mốc thời gian khác, console log
  thật chụp đúng lúc đó (kèm đúng mốc thời gian video và câu hỏi) vẫn là
  cách chẩn đoán chắc chắn nhất, để biết có cần tăng seekEarlySeconds cho
  đúng câu hỏi đó hay đổi cách khác.
