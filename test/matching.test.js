// 매칭 엔진 단위 테스트. 실행: node test/matching.test.js
const assert = require('assert');
const M = require('../src/lib/matching.js');

function cand(over) {
  return Object.assign({
    name: 'ベテルギウス', artists: ['優里'], artistIds: ['yuuri1'],
    durationMs: 236000, isrc: 'JPXX02100001',
    album: { name: '壱', type: 'album', releaseDate: '2022-01-19', artists: ['優里'] },
  }, over);
}

// 1) 정확 일치 + 길이 일치 → auto (85+)
{
  const entry = { titleGuess: 'ベテルギウス', artistGuess: '優里', label: '優里 - ベテルギウス', durationSec: 236 };
  const { score } = M.scoreCandidate(entry, cand({}));
  assert.ok(score >= 85, `정확 일치 점수 ${score} >= 85 이어야 함`);
  assert.strictEqual(M.classify(score), 'auto');
}

// 2) 가라오케/커버 후보는 원곡 후보보다 낮아야 함
{
  const entry = { titleGuess: 'Sparkle', artistGuess: 'RADWIMPS', label: 'RADWIMPS - Sparkle', durationSec: 535 };
  const real = M.scoreCandidate(entry, cand({ name: 'スパークル (original ver.)', artists: ['RADWIMPS'], durationMs: 537000 }));
  const karaoke = M.scoreCandidate(entry, cand({
    name: 'Sparkle (Karaoke Version)', artists: ['Karaoke Hits Band'], durationMs: 535000,
    album: { name: 'Karaoke Anime Classics', type: 'album', releaseDate: '2021-01-01' },
  }));
  assert.ok(karaoke.score < real.score, `karaoke(${karaoke.score}) < real(${real.score})`);
  assert.ok(karaoke.penalty >= 15, 'karaoke 페널티 적용');
}

// 3) 제목 같고 아티스트 다른 두 후보 → 길이로 구분
{
  const entry = { titleGuess: 'if', artistGuess: '니시노 카나', label: '니시노 카나 - if', durationSec: 283 };
  const right = M.scoreCandidate(entry, cand({ name: 'if', artists: ['Kana Nishino'], durationMs: 284000 }));
  const wrong = M.scoreCandidate(entry, cand({ name: 'if', artists: ['Kana Nishino'], durationMs: 195000 }));
  assert.ok(right.score > wrong.score + 10, `길이 일치(${right.score}) > 불일치(${wrong.score})`);
}

// 4) "제목 - 아티스트" 역순 입력도 같은 결과 (방향 모호성)
{
  const e1 = { titleGuess: 'ベテルギウス', artistGuess: '優里', label: 'x', durationSec: 236 };
  const e2 = { titleGuess: '優里', artistGuess: 'ベテルギウス', label: 'x', durationSec: 236 };
  const s1 = M.scoreCandidate(e1, cand({})).score;
  const s2 = M.scoreCandidate(e2, cand({})).score;
  assert.ok(Math.abs(s1 - s2) < 1, `역순 허용: ${s1} ≈ ${s2}`);
}

// 5) 부제 포함 제목 매칭 ("Sparkle" vs "スパークル [original ver.]" 계열)
{
  const s = M.similarity('Sparkle', 'Sparkle (Original Ver.)');
  assert.ok(s >= 75, `부제 허용 유사도 ${s} >= 75`);
}

// 6) 최초 릴리스 선택: 같은 ISRC → 컴필/베스트 제외, 최초 날짜(싱글) 승
{
  const single = cand({ album: { name: 'ベテルギウス', type: 'single', releaseDate: '2021-11-04' } });
  const album = cand({ album: { name: '壱', type: 'album', releaseDate: '2022-01-19' } });
  const comp = cand({ album: { name: 'J-POP BEST 2022', type: 'compilation', releaseDate: '2022-06-01', artists: ['Various Artists'] } });
  const remaster = cand({ album: { name: '壱 (Remastered)', type: 'album', releaseDate: '2020-01-01' } }); // 날짜가 빨라도 재발매 표시면 후순위
  const picked = M.pickOriginalRelease(album, [album, comp, single, remaster]);
  assert.strictEqual(picked.album.releaseDate, '2021-11-04', '싱글(최초 등장) 선택');
}

// 7) 다른 녹음(ISRC 다름)은 릴리스 그룹에 안 묶임
{
  const a = cand({ isrc: 'AAA' });
  const b = cand({ isrc: 'BBB', name: 'ベテルギウス (Re-recording)' });
  assert.ok(!M.sameRecording(a, b), '재녹음은 별도 녹음');
}

// 8) 연도만 있는 날짜 정밀도
{
  assert.ok(M.releaseDateValue('2016') < M.releaseDateValue('2016-05-01'), '연도만 → 01-01 패딩');
  assert.ok(M.releaseDateValue('2015-12-31') < M.releaseDateValue('2016'));
}

// 9) 아티스트 엔티티 일치: 표기가 달라도(優里 vs Yuuri) ID 일치 → 원곡이 커버를 이김
{
  const entry = { titleGuess: 'ベテルギウス', artistGuess: '優里', label: '優里 - ベテルギウス', durationSec: 236 };
  const opts = { resolvedArtistIds: ['yuuri1'] };
  const orig = M.scoreCandidate(entry, cand({ artists: ['Yuuri'], artistIds: ['yuuri1'], durationMs: 231000 }), opts);
  const cover = M.scoreCandidate(entry, cand({ artists: ['Bell'], artistIds: ['bell1'], durationMs: 236000 }), opts);
  assert.ok(orig.entityMatch, '엔티티 일치 플래그');
  assert.ok(orig.score >= 85, `원곡 auto 승급 (${orig.score})`);
  assert.ok(orig.score > cover.score + 10, `원곡(${orig.score}) > 커버(${cover.score})`);
}

// 10) 카드↔슬롯 DP 정렬: 실제 시나리오 (노른자 영상 기반)
{
  // 슬롯: 타임스탬프 간격(초). 아티스트 엔티티는 일부만 해석됨(한국어 표기 한계 재현)
  const slots = [
    { durationSec: 236, artistGuess: '유우리', artistIds: [] },            // 0 ← Yuuri 231s (길이로)
    { durationSec: 277, artistGuess: 'KK', artistIds: [] },               // 1
    { durationSec: 285, artistGuess: 'RADWIMPS', artistIds: ['rad'] },    // 2 ← 트림된 スパークル(534s)은 배정 불가해야 함
    { durationSec: 315, artistGuess: '월피스카터', artistIds: [] },        // 3
    { durationSec: 278, artistGuess: '월피스카터', artistIds: [] },        // 4 ← Heavenz 원곡 278s: 배정되되 consistent=false
    { durationSec: 236, artistGuess: '요네즈 켄시', artistIds: ['kenshi'] }, // 5 ← 트림된 海の幽霊 285s: 엔티티로 배정
    { durationSec: 283, artistGuess: '니시노 카나', artistIds: ['kana'] },  // 6 ← if 283s
  ];
  const cards = [
    { durationMs: 231000, artistIds: ['yuuri'], artistNames: ['Yuuri'] },
    { durationMs: 534000, artistIds: ['rad'], artistNames: ['RADWIMPS'] },   // スパークル 원본(길이 크게 불일치)
    { durationMs: 278000, artistIds: ['heavenz'], artistNames: ['Heavenz'] },
    { durationMs: 285000, artistIds: ['kenshi'], artistNames: ['Kenshi Yonezu'] },
    { durationMs: 283000, artistIds: ['kana'], artistNames: ['Kana Nishino'] },
  ];
  const pairs = M.alignMusicCards(slots, cards);
  const bySlot = Object.fromEntries(pairs.map((p) => [p.slotIndex, p]));
  assert.ok(bySlot[0] && bySlot[0].cardIndex === 0, 'Yuuri → 슬롯0 (길이 5초 차)');
  assert.ok(!pairs.some((p) => p.cardIndex === 1), '길이 크게 불일치(트림 534s vs 285s)면 미배정');
  assert.ok(bySlot[4] && bySlot[4].cardIndex === 2 && bySlot[4].consistent === false,
    'Heavenz 원곡 → 월피스카터 슬롯 배정 + 불일치 플래그(커버 충돌)');
  assert.ok(bySlot[5] && bySlot[5].cardIndex === 3 && bySlot[5].consistent === true,
    '海の幽霊: 트림돼도 엔티티로 배정');
  assert.ok(bySlot[6] && bySlot[6].cardIndex === 4, 'if → 슬롯6');
  // 교차 없음(순서 보존)
  const sortedBySlot = [...pairs].sort((a, b) => a.slotIndex - b.slotIndex);
  for (let k = 1; k < sortedBySlot.length; k++) {
    assert.ok(sortedBySlot[k].cardIndex > sortedBySlot[k - 1].cardIndex, '교차 없음');
  }
}

console.log('✅ matching: 모든 assert 통과');
