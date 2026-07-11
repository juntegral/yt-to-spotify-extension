// 실제 예시 영상(노른자, HdrGNGrOTD0)의 설명란 트랙리스트로 파서 검증.
// 실행: node test/parse-tracklist.test.js
const assert = require('assert');
const { parseDescriptionTracklist } = require('../src/lib/parse-tracklist.js');

// 사례 1: 실제 설명란처럼 줄단위 트랙리스트
const lineFormat = `
저 멀리 보이는 별에 닿을때까지
배경출처: https://coolhdwall.com/pc-wallpaper/4k-anime-boy

Soundtrack
00:00 유우리 - 베텔게우스
03:56 KK - 달이 아름다워
08:33 RADWIMPS - Sparkle
13:18 월피스카터 - 이별만이 인생이다
18:33 월피스카터 - 그것이 당신의 행복이라 할지라도
23:11 요네즈 켄시 - 바다의 유령
27:07 니시노 카나 - if
31:50 RADWIMPS - 사랑이 할 수 있는 일이 아직 있을까
38:38 Aimer - 육등성의 밤
44:17 Akie - 천성의 약함
48:48 세레우스 - 너의 밤이 밝아올 때까지
53:26 Aimer - 별무리비너스
57:34 카노 - 지구 최후의 고백을
1:02:08 Akie - 내일의 밤하늘 초계반
1:06:05 Akie - 아무것도 아니야
1:11:53 마후마후 - RAIN
`;

// 사례 2: 브라우저에서 복사된 인라인/마크다운 형태 (타임스탬프가 링크)
const inlineFormat =
  'Soundtrack [00:00](https://www.youtube.com/watch?v=HdrGNGrOTD0) 유우리 - 베텔게우스 ' +
  '[03:56](https://www.youtube.com/watch?v=HdrGNGrOTD0&t=236s) KK - 달이 아름다워 ' +
  '[08:33](https://youtu.be/x&t=513s) RADWIMPS - Sparkle ' +
  '[13:18](https://youtu.be/x&t=798s) 월피스카터 - 이별만이 인생이다';

function report(name, tracks) {
  console.log(`\n[${name}] 추출 ${tracks.length}곡`);
  tracks.forEach((t) => console.log(`  ${t.index}. ${t.time}  ${t.artistGuess} / ${t.titleGuess}`));
}

const a = parseDescriptionTracklist(lineFormat);
report('줄단위', a);
assert.strictEqual(a.length, 16, '줄단위: 16곡이어야 함');
assert.strictEqual(a[0].artistGuess, '유우리');
assert.strictEqual(a[0].titleGuess, '베텔게우스');
assert.strictEqual(a[13].time, '1:02:08');
assert.strictEqual(a[13].seconds, 3728);
assert.strictEqual(a[0].durationSec, 236, '첫 곡 길이 = 3:56 = 236초');
assert.strictEqual(a[15].durationSec, null, '마지막 곡 길이 불명');

const b = parseDescriptionTracklist(inlineFormat);
report('인라인', b);
assert.strictEqual(b.length, 4, '인라인: 4곡이어야 함');
assert.strictEqual(b[1].titleGuess, '달이 아름다워');
assert.ok(!/https?:/.test(b.map((t) => t.label).join(' ')), 'URL 잔여물 없어야 함');

console.log('\n✅ 모든 assert 통과');
