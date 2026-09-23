#!/usr/bin/env node
/*
 * 로또 명당(당첨판매점) 데이터 수집기
 *
 * 동행복권 비공식 내부 API(dhlottery.co.kr/wnprchsplcsrch/*)를 회차 단위로 순회 호출해
 * 1등/2등 당첨판매점 정보를 로컬 JSON DB(data/winning_shops.json)에 누적한다.
 *
 * - "최근 N회차"를 목표로 하되, 이미 DB에 있는 회차는 건너뛰고 없는 회차만 새로 수집한다.
 *   (예: 1차 실행 --count 100 → 2차 실행 --count 150 이면 새로 생긴 50개 회차만 수집)
 * - 회차 하나 조회할 때마다 매번 저장하므로 중간에 중단돼도 진행 상황이 남는다.
 * - 요청 사이에 무작위 지연(기본 1.2~2.5초)을 둬서 서버에 한꺼번에 부하를 주지 않는다.
 * - 매주 같은 명령을 다시 실행하면(예: cron) 그 사이 새로 열린 회차만 자동으로 추가된다.
 *
 * 사용법:
 *   node scripts/crawl_winning_shops.mjs                # 최근 100회차 기준으로 부족한 만큼 수집
 *   node scripts/crawl_winning_shops.mjs --count 150     # 최근 150회차까지 확장 수집
 *   node scripts/crawl_winning_shops.mjs --delay-min 1500 --delay-max 3000
 *
 * 매주 자동 축적하려면(예: macOS/Linux crontab, 매주 일요일 오전 9시):
 *   0 9 * * 0 cd /Users/nsj/Desktop/nh-luckymate && node scripts/crawl_winning_shops.mjs >> data/crawl.log 2>&1
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isSupabaseConfigured, upsertRows, fetchCrawledRounds } from './supabase_client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const COUNT = parseInt(args.count || '100', 10);
const DELAY_MIN = parseInt(args['delay-min'] || '1200', 10);
const DELAY_MAX = parseInt(args['delay-max'] || '2500', 10);
const DATA_PATH = args.data
  ? path.resolve(args.data)
  : path.join(PROJECT_ROOT, 'data', 'winning_shops.json');

const EPSD_INFO_URL = 'https://www.dhlottery.co.kr/lt645/selectLtEpsdInfo.do';
const shopUrl = (round) =>
  `https://www.dhlottery.co.kr/wnprchsplcsrch/selectLtWnShp.do?srchWnShpRnk=all&srchLtEpsd=${round}&srchShpLctn=`;

// "인터넷 복권판매사이트"(온라인 채널) — 물리적 매장이 아니라서 "명당"에는 부적합, 수집 대상에서 제외
const NON_PHYSICAL_SHOP_IDS = new Set(['51100000']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomDelay() {
  return DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
}

function loadDb() {
  if (fs.existsSync(DATA_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    } catch (e) {
      console.warn(`[crawl] 기존 DB 파일 파싱 실패, 새로 시작합니다: ${e.message}`);
    }
  }
  return { crawledRounds: [], shops: {}, lastUpdated: null };
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  db.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

function upsertShop(db, item) {
  const id = item.ltShpId;
  if (NON_PHYSICAL_SHOP_IDS.has(id)) return;

  if (!db.shops[id]) {
    db.shops[id] = {
      ltShpId: id,
      shpNm: item.shpNm,
      addr: item.shpAddr,
      tel: item.shpTelno,
      region: item.region,
      lat: item.shpLat,
      lon: item.shpLot,
      rank1Count: 0,
      rank2Count: 0,
      lastWinRound: 0,
      lastWinDate: null,
    };
  }
  const shop = db.shops[id];
  // 최신 조회 결과로 판매점 기본 정보 갱신(주소·전화 등은 드물게 바뀔 수 있음)
  shop.shpNm = item.shpNm;
  shop.addr = item.shpAddr;
  shop.tel = item.shpTelno;
  shop.region = item.region;
  shop.lat = item.shpLat;
  shop.lon = item.shpLot;

  if (item.wnShpRnk === 1) shop.rank1Count++;
  else if (item.wnShpRnk === 2) shop.rank2Count++;

  if (item.draw > shop.lastWinRound) {
    shop.lastWinRound = item.draw;
  }
}

/**
 * 동행복권 서버가 응답까지 7초 이상 걸리거나 아예 connect가 타임아웃되는 일이 잦다.
 * 한 번 실패했다고 실행 전체를 포기하면 주간 자동 수집이 그 주를 통째로 건너뛰므로,
 * 간격을 늘려가며 몇 번 더 시도한다.
 */
async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        const wait = 3000 * (i + 1);
        console.warn(`[crawl] 요청 실패(${i + 1}/${attempts}): ${e.message} — ${wait / 1000}초 후 재시도`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

async function fetchLatestRound() {
  const json = await fetchWithRetry(EPSD_INFO_URL);
  return json.data.list[0].ltEpsd;
}

async function fetchShopsForRound(round) {
  const json = await fetchWithRetry(shopUrl(round));
  if (!json.data) return null; // "조회할 수 없는 회차입니다" 등
  return json.data.list || [];
}

async function main() {
  console.log('[crawl] 최신 회차 확인 중...');
  const latest = await fetchLatestRound();
  console.log(`[crawl] 최신 회차: ${latest}회 · 목표: 최근 ${COUNT}회차`);

  const targetRounds = [];
  for (let r = latest; r > latest - COUNT && r >= 1; r--) {
    targetRounds.push(r);
  }

  const db = loadDb();
  const supabaseOn = isSupabaseConfigured();
  const already = new Set(db.crawledRounds);

  // "이미 수집됨" 판단은 로컬 파일이 아니라 Supabase(영구 저장소) 기준을 우선한다.
  // GitHub Actions처럼 매번 새로 체크아웃되는 환경에서는 로컬 파일이 비어있으므로,
  // 이 조회가 없으면 매번 전체를 다시 긁으려 들게 된다.
  if (supabaseOn) {
    try {
      const remoteRounds = await fetchCrawledRounds();
      remoteRounds.forEach((r) => already.add(r));
      console.log(`[crawl] Supabase에서 이미 수집된 회차 ${remoteRounds.length}개 확인함`);
    } catch (e) {
      console.warn(`[crawl] Supabase 회차 목록 조회 실패, 로컬 기록만으로 판단합니다: ${e.message}`);
    }
  }

  const todo = targetRounds.filter((r) => !already.has(r));

  console.log(
    `[crawl] 목표 ${targetRounds.length}회차 중 이미 수집됨 ${targetRounds.length - todo.length}회차, ` +
      `신규 수집 대상 ${todo.length}회차`
  );

  if (todo.length === 0) {
    console.log('[crawl] 추가로 수집할 회차가 없습니다. 종료합니다.');
    printSummary(db);
    return;
  }

  if (supabaseOn) {
    console.log('[crawl] Supabase 동기화 활성화됨 — 회차마다 로컬 JSON + Supabase에 동시 저장합니다.');
  } else {
    console.log('[crawl] Supabase 미설정(.env 없음) — 로컬 JSON에만 저장합니다.');
  }

  let done = 0;
  let failed = 0;
  for (const round of todo) {
    try {
      const list = await fetchShopsForRound(round);
      if (list === null) {
        console.warn(`[crawl] ${round}회: 데이터 없음(조회 불가 회차) — 건너뜀`);
      } else {
        const touchedIds = new Set();
        list.forEach((item) => {
          upsertShop(db, item);
          if (!NON_PHYSICAL_SHOP_IDS.has(item.ltShpId)) touchedIds.add(item.ltShpId);
        });
        db.crawledRounds.push(round);
        db.crawledRounds.sort((a, b) => b - a);
        done++;
        console.log(`[crawl] ${round}회 수집 완료 (${done}/${todo.length}, 판매점 ${list.length}건)`);

        if (supabaseOn) {
          try {
            const shopRows = Array.from(touchedIds).map((id) => toShopRow(db.shops[id]));
            await upsertRows('winning_shops', shopRows, 'lt_shp_id');
            await upsertRows('crawled_rounds', [{ round }], 'round');
          } catch (e) {
            console.warn(`[crawl] ${round}회 Supabase 동기화 실패: ${e.message}`);
          }
        }
      }
      saveDb(db); // 회차마다 즉시 저장 → 중단돼도 진행 상황 보존
    } catch (e) {
      failed++;
      console.error(`[crawl] ${round}회 수집 실패: ${e.message} — 건너뜀`);
    }

    if (round !== todo[todo.length - 1]) {
      await sleep(randomDelay());
    }
  }

  console.log(`[crawl] 완료. 이번 실행: 성공 ${done}건, 실패 ${failed}건`);
  printSummary(db);
}

function toShopRow(shop) {
  return {
    lt_shp_id: shop.ltShpId,
    shp_nm: shop.shpNm,
    addr: shop.addr,
    tel: shop.tel,
    region: shop.region,
    lat: shop.lat,
    lon: shop.lon,
    rank1_count: shop.rank1Count,
    rank2_count: shop.rank2Count,
    last_win_round: shop.lastWinRound,
  };
}

function printSummary(db) {
  const shopCount = Object.keys(db.shops).length;
  console.log(
    `[crawl] 누적 현황 — 회차 ${db.crawledRounds.length}개, 판매점 ${shopCount}곳, ` +
      `마지막 갱신: ${db.lastUpdated || '-'}`
  );
}

main().catch((e) => {
  console.error('[crawl] 치명적 오류:', e);
  process.exit(1);
});
