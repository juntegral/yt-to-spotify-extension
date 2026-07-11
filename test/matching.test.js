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

console.log('✅ matching: 모든 assert 통과');
