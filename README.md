# Bình dân học vụ số

Extension đọc khóa học từ `data.json`, cho chọn nhiều bài (kể cả chọn tất cả)
và mở đúng mục **Video bài giảng**. Khi chọn nhiều bài, Start chạy lần lượt
theo đúng thứ tự bài trong `data.json` (Bài 1 → Bài 7), rồi đến bài kiểm tra
cuối khoá (ôn tập) nếu có chọn; giữa mỗi bài chờ 3 giây trước khi mở bài kế
tiếp. Mỗi lần Start mở một tab khóa học mới; Stop hủy thao tác chờ (kể cả lúc
đang chờ giữa hai bài) và dừng video đang xử lý. Đóng popup vẫn tiếp tục chạy.

## Cài đặt và sử dụng (Chế độ nhà phát triển)

1. Mở trang quản lý Tiện ích mở rộng của trình duyệt:
   - Trên **Microsoft Edge**: Nhập `edge://extensions` vào thanh địa chỉ.
   - Trên **Google Chrome / Cốc Cốc**: Nhập `chrome://extensions` vào thanh địa chỉ.
2. Gạt công tắc **"Chế độ dành cho nhà phát triển" (Developer mode)** sang **BẬT (ON)**.
3. Nhấn nút **"Tải phần mở rộng đã giải nén" (Load unpacked)** ➔ Chọn thư mục `auto-action-extension` (thư mục chứa file `manifest.json`).
4. Nhấn biểu tượng mảnh ghép **🧩 (Tiện ích)** trên thanh trình duyệt ➔ Bấm nút **Ghim (Pin 📌)** icon **🎓** để tiện ích luôn hiển thị trên thanh công cụ.
5. Mở trang khóa học Bắc Ninh: `https://binhdanhocvuso.gov.vn/courses/course-v1:MOET+KNS-ND+2026-1-BacNinh/course/`
6. Nhấp vào icon **🎓** trên thanh công cụ ➔ Chọn các bài cần học ➔ Nhấn **▶ Start** để bắt đầu!
*(Ở góc dưới bên phải trang web có sẵn panel hiển thị hướng dẫn chi tiết và nút sao chép link tiện ích).*

Khi cập nhật mã nguồn tiện ích, chỉ cần bấm nút **Tải lại (Reload 🔄)** trên thẻ tiện ích trong trang quản lý tiện ích.

Khi sao chép extension sang máy khác, sao chép cả thư mục `auto-action-extension`. Nếu báo “Could not load javascript”, kiểm tra đúng thư mục đã chọn rồi bấm Reload.

## Yêu cầu Chrome và hoạt động trên máy yếu

`manifest.json` khai báo `"minimum_chrome_version": "92"` — đúng bằng mức API
mới nhất mà code thật sự dùng (`crypto.randomUUID()` và
`Array.prototype.at()`, cả hai đều từ Chrome 92). Chrome tự chặn cài/bật
extension nếu trình duyệt thấp hơn mức khai báo này, kể cả cài bằng Load
unpacked, nên khai báo cao hơn mức code thật sự cần sẽ chặn nhầm những máy
lẽ ra chạy được bình thường.

Mọi vòng lặp chờ (`waitFor` trong `site-adapter.js`, chờ trạng thái player
trong `actions/play-video.js`, chờ play/seek bên trong iframe YouTube ở
`youtube-frame.js`) đều poll theo chu kỳ cố định, không dùng sự kiện — chu kỳ
này ảnh hưởng trực tiếp tới CPU chiếm dụng trong suốt lượt chạy. Các chu kỳ
này đã được nới ra (200ms → 400ms ở hai nơi đầu, 100ms → 300ms trong iframe
YouTube, nơi vòng lặp chạy cùng lúc với việc giải mã/hiển thị video nên tốn
tài nguyên hơn cả) — không ảnh hưởng gì tới hành vi tự động hóa (không ai
theo dõi trực tiếp nên không cần phản hồi tức thì), nhưng giảm đáng kể số
lần "thức dậy" kiểm tra DOM/trạng thái trong suốt một lượt chạy dài, giúp máy
cấu hình thấp đỡ bị dồn việc.

Chrome có thể tắt background service worker bất cứ lúc nào để lấy lại bộ
nhớ — xảy ra thường xuyên hơn hẳn trên máy ít RAM — khiến một lệnh
`chrome.runtime.sendMessage` gửi đúng lúc đó không nhận được phản hồi dù
không có gì thật sự sai ("Could not establish connection..." hoặc "message
port closed before a response was received..."). Đây là đặc điểm đã biết
của kiến trúc Manifest V3, không riêng gì extension này; Chrome tự khởi động
lại service worker ngay khi có việc tiếp theo. `content.js` giờ tự thử lại
tối đa 2 lần (cách nhau 300ms rồi 600ms) khi gặp đúng hai lỗi này trước khi
mới thật sự coi là lỗi và dừng lượt chạy; lỗi khác (kể cả lỗi thật từ
background) không được thử lại, fail ngay như trước.

## Thêm khóa bằng dữ liệu

`data.json` có cấu trúc `{ "courses": [...] }`. Thêm một object vào `courses`
cho mỗi khóa trên **binhdanhocvuso.gov.vn** có cùng cấu trúc danh sách bài:

```json
{
  "id": "ma-khoa-duy-nhat",
  "title": "Tên khóa học",
  "code": "MÃ TỈNH",
  "path": "https://binhdanhocvuso.gov.vn/courses/COURSE_ID/course/",
  "navigation": {
    "action": "openLessonVideo",
    "outlineSelector": "#course-outline-block-tree"
  },
  "lessons": [
    {
      "id": 1,
      "title": "Bài 1",
      "outlineTitle": "Tiêu đề đầy đủ trên trang",
      "navigation": {
        "sectionId": "ID của button.section-name",
        "lectureId": "ID của link Video bài giảng 1",
        "lectureTitle": "Video bài giảng 1",
        "lecturePath": "URL href của chính link Video bài giảng 1"
      },
      "videos": [],
      "test": { "questions": [] }
    }
  ]
}
```

Đây là mẫu cấu trúc; thay các giá trị mô tả bằng ID/URL thật và điền `videos`
cùng câu hỏi theo mẫu khóa Bắc Ninh đã có trước khi Start. `id` khóa là chuỗi
duy nhất; `id` bài/video là số. `lectureTitle` không gồm hậu tố `(N câu hỏi)`.
Giữ ID nguyên văn, kể cả `:`, `+`, `@`; action tự xử lý ký tự đặc biệt khi tìm DOM.

Không cần sửa JavaScript để thêm khóa có cùng cấu trúc: popup tự hiển thị khóa,
đọc `path`, danh sách bài, ID và URL mới từ dữ liệu. Lựa chọn bài được lưu riêng
theo ID khóa. Giữ ID khóa ổn định nếu muốn dùng lại lựa chọn đã lưu.

## Chọn nhiều bài và bài ôn tập cuối khoá

Popup dùng checkbox cho từng bài và mục **Bài kiểm tra cuối khoá** (nếu
`review.questions` có dữ liệu); có nút **Chọn tất cả** để chọn toàn bộ. Start
xây danh sách bước theo đúng thứ tự bài trong `course.lessons`, không theo
thứ tự bấm chọn; nếu có chọn bài ôn tập, bước của nó luôn được thêm sau cùng.
Giữa hai bài liền nhau (và giữa bài học cuối với bài ôn tập) có một bước chờ
3 giây (`type: "wait"`) trước khi mở bài tiếp theo; Stop trong lúc chờ hủy
ngay bước này. Chỉ chọn bài ôn tập một mình vẫn hoạt động như trước: nếu
`review.navigation` có cấu hình thì Start tự mở khóa và bài kiểm tra; nếu
chưa có, cần tự mở sẵn đúng trang kiểm tra cuối khoá rồi mới Start. Khi kết
hợp bài ôn tập với ít nhất một bài học, `review.navigation` là bắt buộc vì
Start luôn mở một tab mới từ đầu khóa học.

Việc chuyển sang trang bài kiểm tra cuối khoá (sau khi học xong các bài đã
chọn) được lưu lại trước khi bấm link/chuyển trang, giống hệt cách mở Video
bài giảng: nếu trang thật không vào đúng bài kiểm tra mà quay lại danh sách
bài học (ví dụ do điều kiện tiên quyết), lượt chạy báo lỗi rõ ràng ngay thay
vì bấm/chuyển trang lặp lại và im lặng dừng ở trạng thái "Hoàn tất".

## Chỉ làm riêng Ôn tập Module của một bài

Mỗi bài trong danh sách có thêm nút **Chỉ ôn tập** bên cạnh checkbox, hiện khi
bài đó có `test.questions`. Cách dùng: tự mở sẵn đúng trang "Ôn tập Module N"
của bài muốn làm lại (bấm qua danh sách bài học trên trang khóa học như bình
thường), rồi bấm **Chỉ ôn tập** ở đúng bài đó trong popup — extension chỉ làm
bài ôn tập trên tab đang mở, không mở tab mới, không học lại video, không quay
về danh sách bài học sau khi xong. Vì action chỉ kiểm tra tab hiện tại có
đúng thuộc khóa học đang chọn hay không (không đọc được tiêu đề trang để biết
chắc là đúng bài N), người dùng cần tự chắc chắn đang mở đúng trang trước khi
bấm; nếu số câu trên trang không khớp `test.questions` của bài đã chọn trong
`data.json`, action sẽ báo lỗi thay vì làm nhầm. Nút này dùng chung cơ chế
"mở từ tab có sẵn" (`manualPage`) với chế độ làm riêng bài kiểm tra cuối khoá,
và không đụng đến lựa chọn checkbox nhiều bài đang có sẵn trong popup — chọn
bài xong vẫn giữ nguyên sau khi chạy xong "Chỉ ôn tập".

## Ôn tập Module / bài kiểm tra cuối khoá

`actions/answer-lesson-test.js` chọn đủ đáp án rồi bấm Gửi cho từng câu, cách
nhau 200ms một lần Gửi để trang kịp ghi nhận thay vì gửi dồn dập cả 20 câu
liên tiếp. Sau khi gửi hết, action **không** chờ từng câu báo kết quả đúng/sai
nữa (chờ trang chấm từng câu từng khiến cả bài bị treo rất lâu, có khi vài
phút, khi trang ghi kết quả chậm) — chỉ cần chắc chắn đã bấm Gửi là đủ. Action
chờ thêm đúng 5 giây một lần duy nhất cho cả bài để trang có thời gian ghi
nhận, rồi hoàn tất bước ngay để `returnToOutline` chuyển sang bài tiếp theo.
Tổng thời gian chờ thêm cho một bài 20 câu chỉ khoảng 200ms × 20 + 5s ≈ 9
giây. Bấm Stop trong lúc chờ giữa hai lần Gửi hoặc trong 5 giây chờ cuối đều
hủy ngay như bình thường.

## Action mở bài

`actions/open-lesson-video.js` đăng ký `CourseActions.openLessonVideo`:

1. Tìm outline được cấu hình, rồi tìm đúng `sectionId` trong outline.
2. Nếu `aria-expanded="false"`, click nút để bung bài; nếu đã mở thì giữ nguyên.
3. Lấy panel qua `aria-controls`, chỉ tìm `lectureId` trong panel đó.
4. Kiểm tra tiêu đề và URL khớp mục Video bài giảng trong dữ liệu.
5. Lưu bước chuyển trang rồi click link; sau redirect tiếp tục bước chưa hoàn tất.

## Tab video và điều khiển YouTube

`actions/open-video-tab.js` đọc tất cả button trong `#sequence-list`, kể cả
`seq_problem`, rồi chọn theo `data-index`. Sau click, action chờ `aria-selected`
và nội dung player mới; không tua iframe còn sót từ tab trước.

Mỗi `video` có `tab: { "index": 0, "title": "1.1", "blockId": "ID thật nếu có" }`.
`index` bắt đầu từ 0. `blockId` là tùy chọn; nếu có, phải khớp đúng `data-id`.
Bài 1 đã được ánh xạ tab 1.1 → Video 1, 1.2 → Video 2, 1.3 → Video 3.

- Tab có câu hỏi: bấm Play. Với câu hỏi đầu tiên của video, tua về `00:00`
  trước (không dùng vị trí trình duyệt tự khôi phục), rồi mới chờ thời lượng
  và tua đến `max(0, time - 6)` giây, sau đó phát đến mốc câu hỏi. Ví dụ
  `06:41` → tua `06:35`. Các câu hỏi tiếp theo trong cùng video chỉ tua tiếp
  đến mốc câu hỏi kế tiếp, không tua lại về `00:00` nữa. Nếu video đã xem
  gần hết (YouTube đang ở màn hình kết thúc/xem lại) khiến việc tua về
  `00:00` bị treo, action không báo lỗi cả bước: chỉ bỏ qua lần tua về đầu
  đó và tiếp tục từ vị trí hiện tại của video. Số giây tua sớm mặc định (6s)
  có thể ghi đè riêng cho từng câu hỏi bằng trường tùy chọn
  `"seekEarlySeconds": 10` ngay trong object câu hỏi đó trong `data.json` —
  dùng khi một video cụ thể hay tải/đệm chậm ngay gần mốc câu hỏi, cần thêm
  thời gian ổn định trước khi tới đúng chỗ. Đang áp dụng `10` cho câu hỏi
  04:26 của video 4.5/Bài 4 và câu hỏi 05:36 của video 6.4/Bài 6 — cả hai
  từng hay treo ở mức mặc định/thấp hơn ngay cả khi đã có `seekWithRetry()`
  (xem phần bên dưới).
- Tab không có câu hỏi: khai báo `"playbackOnly": true, "questions": []`.
  Extension bấm Play, tua đến `duration - 1` giây và chờ `ended` trước khi chuyển tab.
- Các tab bổ sung trên trang chưa có trong dữ liệu cũng được đưa vào lượt chạy
  theo thứ tự `data-index` và xử lý bằng cách tua đến cuối. Không tạo đáp án giả.

### Câu hỏi trong video bị kẹt do lỗi ở chính trang (không dừng cả lượt chạy)

Sau khi Gửi đáp án và bấm Continue, action chờ bảng câu hỏi tự đóng. Trên
thực tế trang thật, ở một số video, sau khi trả lời xong console hiện hàng
loạt lỗi từ chính script của trang (`invideoquiz...js: Cannot read
properties of undefined (reading 'currentTime')`, `www-widgetapi.js:
Cannot read properties of undefined (reading 'id')`) — nhiều khả năng do
YouTube tạo lại player ngay gần cuối video khiến widget câu hỏi của trang
bị mất tham chiếu và không bao giờ tự đóng bảng nữa, dù đáp án đã được Gửi
và ghi nhận thành công. Trước đây trường hợp này khiến action chờ đủ 30
giây rồi báo lỗi "Hết thời gian chờ: đóng câu hỏi" và dừng hẳn lượt chạy.

Từ giờ, việc chờ nút Continue và chờ bảng câu hỏi đóng dùng cơ chế hai
bước: thử chờ nhanh **5 giây** trước; nếu hết 5 giây mà chưa thấy (và
không phải do Stop), action kiểm tra ngay `data-attempts-used` của đúng
câu đó — nếu đáp án **đã** được ghi nhận, không chờ thêm nữa: chỉ ghi cảnh
báo ra console rồi coi như xong câu hỏi và tiếp tục lượt chạy ngay (nhanh
hơn nhiều so với chờ đủ 30 giây như trước); nếu đáp án **chưa** được ghi
nhận thật sự (ví dụ trang còn đang xử lý hoặc chưa Gửi được), action chờ
tiếp phần thời gian còn lại (tổng cộng vẫn đủ khoảng 30 giây như cũ) rồi
mới báo lỗi và dừng lại nếu vẫn không có — không nới lỏng phần đảm bảo trả
lời đúng câu, chỉ rút ngắn đúng thời gian chờ vô ích khi biết chắc câu đã
xong nhưng script (có thể bị lỗi) của trang không tự đóng bảng.

Cùng một lỗi widget/YouTube đó cũng có thể xảy ra ngay ở bước **tua tới gần
mốc câu hỏi** (hoặc tua tới cuối video khi bỏ qua tab không câu hỏi), báo
"Hết thời gian chờ tua video trong YouTube" — quan sát được ở nhiều video
khác nhau (04:26 của Bài 4, 05:36 của Bài 6), không riêng một video cụ
thể. Vì lúc này chưa có cách nào xác nhận độc lập "video đã ở đúng vị trí
chưa" (khác với việc trả lời câu hỏi có `data-attempts-used`), action
không tự bỏ qua bước tua như với Continue — thay vào đó `seekWithRetry()`
trong `actions/play-video.js` đợi 1.5 giây rồi thử tua lại đúng một lần
(lệnh hoàn toàn mới, đọc lại player từ đầu) trước khi thật sự báo lỗi và
dừng nếu lần thử lại cũng không được. Nếu một video cụ thể vẫn treo dù đã
thử lại (từng gặp ở video 6.4), cách xử lý thêm là tăng
`seekEarlySeconds` cho đúng câu hỏi đó trong `data.json` để né hẳn quãng
thời gian trang dễ lỗi, thay vì chỉ trông chờ vào việc thử lại.

Cùng đợt lỗi trên còn có thể kéo theo một lỗi khác, riêng của extension:
`postMessage` vào iframe YouTube báo "The target origin provided
(...youtube.com) does not match the recipient window's origin
(...binhdanhocvuso.gov.vn)" — do iframe tạm thời hiển thị tài liệu khác
đúng lúc gửi lệnh (nhiều khả năng trang đang tự tải lại iframe đó để phục
hồi sau lỗi widget nói trên). Lệnh dọn dẹp khi kết thúc mỗi bước
(`release()` trong `media-player.js`) chạy trong khối `finally`, nên nếu
không xử lý, lỗi này có thể ghi đè lên kết quả thật (kể cả một bước đã
thành công) và bỏ dở phần dọn dẹp còn lại. `release()` giờ bọc lệnh
thông báo này trong try/catch — bỏ qua an toàn nếu lỗi, vẫn luôn dọn dẹp
đầy đủ (gỡ listener, hủy lệnh đang chờ phản hồi) dù thành hay bại.

`media-player.js` chỉ gửi lệnh tới iframe đang chọn. `youtube-frame.js` chạy trong
YouTube embed, click `button.ytmCuedOverlayPlayButton` nếu hiển thị, rồi điều khiển
thẻ video bên trong. Manifest có quyền cho `https://www.youtube.com/embed/*`.
Sau cập nhật cần Reload extension và mở lại bài giảng để script được nạp vào iframe.
Stop hủy lệnh chờ và pause video, kể cả khi Play đang chờ phản hồi.

Phần HTML câu hỏi/đáp án vẫn còn TODO trong `site-adapter.js`. Khi chưa có selector,
extension vẫn bấm Play và tua/phát tới mốc, rồi pause và báo **Chờ cập nhật HTML**;
không đánh dấu câu hỏi đã trả lời hay tự chuyển qua câu chưa được xử lý.

### Cơ chế tự động làm mới & phục hồi khi chạy (Thay thế việc chờ 15 giây rồi bỏ qua)

Trước đây, khi một bước video hoặc câu hỏi gặp trục trặc tải chậm, extension dùng mốc chờ mù quáng 15 giây rồi tự động bỏ qua bước đó (`STEP_TIMEOUT_MS`). Cách làm này dễ dẫn đến việc bỏ sót câu hỏi hoặc cắt ngang khi video đang nạp dở trên máy yếu/mạng lag.

Hiện tại, extension đã chuyển hoàn toàn sang **hướng làm mới và phục hồi chủ động (Active Refresh & Watchdog Recovery)**:

1. **Tự động cuộn khung nhìn (`scrollIntoView`):**
   Mỗi khi chuyển tab video hoặc kết nối player, hệ thống tự động cuộn khung player và bảng câu hỏi vào chính giữa tầm mắt màn hình. Thao tác này lập tức đánh thức trình duyệt khỏi cơ chế *Off-screen Throttling* (ngủ đông iframe ngoài màn hình), buộc Chrome/Edge ưu tiên nạp video ngay tức thì.
2. **Kích hoạt kết nối sớm (`document_end`):**
   `youtube-frame.js` được nạp ngay khi khung DOM YouTube vừa dựng xong, không phải chờ `document_idle` tải hết các dữ liệu nặng (ảnh bìa, quảng cáo, analytics), giúp việc bắt tay giữa trang web và player diễn ra gần như tức thì.
3. **Cơ chế Watchdog Heartbeat thông minh:**
   Không còn cắt ngang bước sau 15 giây cố định. Thay vào đó, bộ giám sát liên tục nhận tín hiệu sống (`signal.heartbeat()`) mỗi khi video phát, tua vị trí hoặc DOM có tương tác. Chỉ khi bước bị **đơ hoàn toàn không có bất kỳ tiến triển nào** trong suốt 35 giây thì cơ chế an toàn mới can thiệp.
4. **Tự động thử lại và làm mới kết nối (Retry & Refresh):**
   Quá trình kết nối player YouTube được nâng lên tới 20 lần thử (~30 giây), cứ sau 3 lần thử lại tự động căn chỉnh lại vị trí cuộn màn hình để phục hồi kết nối thành công, đảm bảo mọi câu hỏi đều được trả lời đầy đủ thay vì bị bỏ qua.

## Kiểm tra

Không cần cài npm package:

```text
node --test tests/*.test.js
node tests/browser-smoke.cjs
```

Lệnh thứ hai dùng Edge/Chrome ở chế độ headless với profile tạm, kiểm tra trên
HTML mẫu và popup có dữ liệu mô phỏng. Có thể đặt `BROWSER_EXECUTABLE` nếu trình
duyệt ở đường dẫn khác. Kiểm tra này không đăng nhập hoặc thao tác trên khóa học thật.
