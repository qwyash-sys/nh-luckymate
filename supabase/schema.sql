-- NH행운메이트 · 로또 명당 데이터용 Supabase 스키마
-- Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run 하면 됩니다.
-- (프로젝트 최초 1회만 실행하면 됩니다. 이후 데이터는 크롤러 스크립트가 채워넣습니다.)

-- 판매점별 누적 당첨 정보
create table if not exists public.winning_shops (
  lt_shp_id text primary key,       -- 동행복권 판매점 고유 ID
  shp_nm text not null,             -- 상호명
  addr text,                        -- 주소
  tel text,                         -- 전화번호
  region text,                      -- 지역(시/도)
  lat double precision,             -- 위도
  lon double precision,             -- 경도
  rank1_count integer not null default 0,  -- 1등 배출 횟수(수집된 회차 범위 내)
  rank2_count integer not null default 0,  -- 2등 배출 횟수(수집된 회차 범위 내)
  last_win_round integer,           -- 마지막으로 당첨자를 배출한 회차
  updated_at timestamptz not null default now()
);

-- 이미 수집을 완료한 회차 목록 (중복 수집 방지용)
create table if not exists public.crawled_rounds (
  round integer primary key,
  crawled_at timestamptz not null default now()
);

-- RLS 활성화: 프론트(anon key)는 읽기만 가능, 쓰기는 service_role key(크롤러)만 가능
alter table public.winning_shops enable row level security;
alter table public.crawled_rounds enable row level security;

drop policy if exists "public read winning_shops" on public.winning_shops;
create policy "public read winning_shops" on public.winning_shops
  for select using (true);

drop policy if exists "public read crawled_rounds" on public.crawled_rounds;
create policy "public read crawled_rounds" on public.crawled_rounds
  for select using (true);

-- 위치 기반 조회를 자주 하므로 지역별 인덱스, 순위 정렬용 인덱스 추가
create index if not exists idx_winning_shops_region on public.winning_shops (region);
create index if not exists idx_winning_shops_rank1 on public.winning_shops (rank1_count desc);
