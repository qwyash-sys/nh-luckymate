/*
 * 의존성 없는 초경량 Supabase REST(PostgREST) 클라이언트.
 * @supabase/supabase-js 패키지 설치 없이 fetch만으로 배치 upsert를 수행한다.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const env = { ...process.env };
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (env[key] === undefined) env[key] = value;
    }
  }
  return env;
}

export const env = loadEnv();
export const SUPABASE_URL = env.SUPABASE_URL;
export const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
export const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * 여러 행을 한 번에 upsert(있으면 갱신, 없으면 삽입)한다.
 * @param {string} table 테이블명
 * @param {object[]} rows 업서트할 행 배열
 * @param {string} onConflict 충돌(중복) 판단 기준 컬럼명 (예: 'lt_shp_id')
 */
export async function upsertRows(table, rows, onConflict) {
  if (!isSupabaseConfigured()) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 .env에 설정되어 있지 않습니다.');
  }
  if (rows.length === 0) return;

  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert 실패 (${table}): HTTP ${res.status} — ${text}`);
  }
}

/** rows를 chunkSize 단위로 나눠서 순서대로 upsert (한 번에 너무 큰 배치를 보내지 않기 위함) */
export async function upsertRowsInChunks(table, rows, onConflict, chunkSize = 500) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await upsertRows(table, chunk, onConflict);
  }
}

/**
 * 이미 수집된 회차 전체 목록을 가져온다 (페이지네이션 방어적으로 처리).
 * GitHub Actions처럼 로컬 파일이 매번 초기화되는 환경에서도, "이미 수집된 회차" 판단을
 * 로컬 파일이 아니라 이 함수(=Supabase, 진짜 영구 저장소) 기준으로 하기 위함.
 */
export async function fetchCrawledRounds() {
  const all = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/crawled_rounds?select=round&order=round.desc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase select 실패 (crawled_rounds): HTTP ${res.status} — ${text}`);
    }
    const rows = await res.json();
    all.push(...rows.map((r) => r.round));
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/** 테이블이 실제로 존재하고 접근 가능한지 확인 (스키마 미실행 여부 등을 미리 알려주기 위함) */
export async function checkTableExists(table) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return res.ok;
}
