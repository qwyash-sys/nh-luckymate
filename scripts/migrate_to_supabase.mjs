#!/usr/bin/env node
/*
 * 로컬 JSON DB(data/winning_shops.json)에 이미 쌓아둔 데이터를 Supabase로 1회 이관한다.
 * (supabase/schema.sql을 Supabase SQL Editor에서 먼저 실행해 테이블을 만들어둔 뒤 사용할 것)
 *
 * 사용법: node scripts/migrate_to_supabase.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkTableExists, upsertRowsInChunks, isSupabaseConfigured } from './supabase_client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(PROJECT_ROOT, 'data', 'winning_shops.json');

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

async function main() {
  if (!isSupabaseConfigured()) {
    console.error('[migrate] .env에 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다.');
    process.exit(1);
  }
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`[migrate] ${DATA_PATH} 파일이 없습니다. 먼저 크롤러를 실행하세요.`);
    process.exit(1);
  }

  console.log('[migrate] Supabase 테이블 존재 확인 중...');
  const shopsOk = await checkTableExists('winning_shops');
  const roundsOk = await checkTableExists('crawled_rounds');
  if (!shopsOk || !roundsOk) {
    console.error(
      '[migrate] 테이블이 아직 없습니다. Supabase 대시보드 → SQL Editor에서 supabase/schema.sql을 먼저 실행해주세요.'
    );
    process.exit(1);
  }

  const db = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const shopRows = Object.values(db.shops).map(toShopRow);
  const roundRows = db.crawledRounds.map((r) => ({ round: r }));

  console.log(`[migrate] 판매점 ${shopRows.length}건, 회차 ${roundRows.length}건 업로드 중...`);
  await upsertRowsInChunks('winning_shops', shopRows, 'lt_shp_id', 500);
  console.log('[migrate] 판매점 업로드 완료');
  await upsertRowsInChunks('crawled_rounds', roundRows, 'round', 500);
  console.log('[migrate] 회차 목록 업로드 완료');

  console.log('[migrate] 이관 완료.');
}

main().catch((e) => {
  console.error('[migrate] 오류:', e);
  process.exit(1);
});
