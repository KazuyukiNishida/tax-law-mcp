/**
 * e-Gov 法令API v2 クライアント
 * https://laws.e-gov.go.jp/api/2/swagger-ui
 *
 * takurot版を参考にレート制限を実装
 */

import { lawDataCache, lawSearchCache } from './cache.js';
import type { EgovLawSearchResult, EgovLawData, EgovKeywordSearchItem } from './types.js';
import { resolveLawName } from './law-registry.js';
import { extractLawTitle } from './egov-parser.js';
import { NotFoundError } from './errors.js';

const EGOV_API_BASE = 'https://laws.e-gov.go.jp/api/2';
const MIN_REQUEST_INTERVAL_MS = 200; // 5 req/sec (takurot版参考)

let lastRequestTime = 0;

/** レート制限: 前回リクエストから最低200ms空ける */
async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

/** law_id の形式（例: 326AC1000000237, 340M50000040011）。英字を含むので数字15桁ではない */
const LAW_ID_PATTERN = /^\d{3}[0-9A-Z]{12}$/;

/** 法令名解決のために名前検索で取ってくる候補数の上限 */
const RESOLVE_CANDIDATE_LIMIT = 500;

/** 法令名の比較用正規化（全角半角の揺れ・空白を吸収） */
export function normalizeLawTitle(s: string): string {
  return s.normalize('NFKC').replace(/\s/g, '');
}

/** 検索結果の法令名（改正履歴時点・現時点の両方） */
function titlesOf(r: EgovLawSearchResult): string[] {
  return [r.revision_info?.law_title, r.current_revision_info?.law_title]
    .filter((t): t is string => !!t);
}

/** 検索結果の法令略称（e-Govではカンマ区切りで複数入る） */
function abbrevsOf(r: EgovLawSearchResult): string[] {
  return [r.revision_info?.abbrev, r.current_revision_info?.abbrev]
    .filter((a): a is string => !!a)
    .flatMap(a => a.split(/[,，、]/))
    .map(a => a.trim())
    .filter(a => a.length > 0);
}

/** 廃止・失効していない法令か */
function isInForce(r: EgovLawSearchResult): boolean {
  const status = r.revision_info?.repeal_status ?? r.current_revision_info?.repeal_status;
  return !status || status === 'None';
}

/**
 * 法令名の一致度（小さいほど良い）
 * 0=法令名完全一致, 1=略称完全一致, 2=法令名前方一致, 3=部分一致（検索APIのヒット）
 */
export function lawMatchRank(r: EgovLawSearchResult, query: string): number {
  const q = normalizeLawTitle(query);
  const titles = titlesOf(r).map(normalizeLawTitle);
  if (titles.some(t => t === q)) return 0;
  if (abbrevsOf(r).map(normalizeLawTitle).some(a => a === q)) return 1;
  if (titles.some(t => t.startsWith(q))) return 2;
  return 3;
}

/** 検索結果を「一致度 → 現行優先 → 法令名が短い順 → law_id順」に並べ替える */
export function rankLawSearchResults(results: EgovLawSearchResult[], query: string): EgovLawSearchResult[] {
  const titleLength = (r: EgovLawSearchResult) => (titlesOf(r)[0] ?? '').length;
  return [...results].sort((a, b) =>
    lawMatchRank(a, query) - lawMatchRank(b, query)
    || Number(isInForce(b)) - Number(isInForce(a))
    || titleLength(a) - titleLength(b)
    || a.law_info.law_id.localeCompare(b.law_info.law_id)
  );
}

/**
 * 法令名・略称・law_id から law_id を解決する
 *
 * 略称表 → law_id 直接指定 → e-Gov 法令名検索（法令名・略称の完全一致のみ採用）の順。
 * 完全一致がなければ別の法令に化けさせず NotFoundError（候補つき）を投げる。
 */
export async function resolveLawId(lawNameOrId: string): Promise<string> {
  const input = lawNameOrId.trim();
  const { name, lawId: registeredId } = resolveLawName(input);
  if (registeredId) return registeredId;
  if (LAW_ID_PATTERN.test(input)) return input;

  const candidates = await searchLaws(name, RESOLVE_CANDIDATE_LIMIT);
  const exact = rankLawSearchResults(candidates, name).filter(r => lawMatchRank(r, name) <= 1);
  if (exact.length > 0) {
    return exact[0].law_info.law_id;
  }

  if (candidates.length === 0) {
    throw new NotFoundError(`法令が見つかりません: "${name}"`);
  }
  const suggestions = rankLawSearchResults(candidates, name)
    .slice(0, 5)
    .map(r => `${titlesOf(r)[0] ?? r.law_info.law_id}（${r.law_info.law_id}）`);
  throw new NotFoundError(
    `法令が見つかりません: "${name}"（法令名・略称の完全一致なし）。候補: ${suggestions.join('、')}。正式名称か law_id で指定してください。`
  );
}

/**
 * 法令名またはlaw_idから法令全文を取得
 */
export async function fetchLawData(lawNameOrId: string): Promise<{
  data: EgovLawData;
  lawId: string;
  lawTitle: string;
}> {
  const lawId = await resolveLawId(lawNameOrId);

  // キャッシュチェック
  const cached = lawDataCache.get(lawId);
  if (cached) {
    const data = JSON.parse(cached) as EgovLawData;
    return { data, lawId, lawTitle: extractLawTitle(data) };
  }

  // e-Gov API v2 から取得
  await rateLimit();
  const url = `${EGOV_API_BASE}/law_data/${lawId}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new NotFoundError(`法令が見つかりません (law_id: ${lawId})`);
    }
    throw new Error(`e-Gov API エラー: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const data = json as EgovLawData;

  // キャッシュに保存
  lawDataCache.set(lawId, JSON.stringify(data));

  return { data, lawId, lawTitle: extractLawTitle(data) };
}

/**
 * 法令を法令名・略称（部分一致）で検索
 *
 * e-Gov v2 の /laws は `law_title` で絞り込む。`keyword` は /laws では無視され、
 * 全法令が law_id 順（明治の太政官布告から）で返ってくるので使わないこと。
 */
export async function searchLaws(
  title: string,
  limit: number = 10,
  lawType?: string
): Promise<EgovLawSearchResult[]> {
  const cacheKey = `title|${title}|${limit}|${lawType ?? ''}`;
  const cached = lawSearchCache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const params = new URLSearchParams({
    law_title: title,
    limit: String(limit),
    response_format: 'json',
  });
  if (lawType) {
    params.set('law_type', lawType);
  }

  await rateLimit();
  const url = `${EGOV_API_BASE}/laws?${params}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`e-Gov API 検索エラー: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const results = (json.laws ?? []) as EgovLawSearchResult[];

  lawSearchCache.set(cacheKey, JSON.stringify(results));

  return results;
}

/**
 * /keyword の limit は「返す法令数」ではなく「該当箇所の総数」（上限1000）。
 * sentences_limit で1法令1件に絞っても、絞る前の該当箇所数で枠を消費するため、
 * 頻出語だと少ない limit では1〜2法令しか返らない。上限で取ってから法令数で切る。
 */
const KEYWORD_HIT_LIMIT = 1000;

/**
 * 法令本文の全文検索（法令名で見つからないときの補助）
 * e-Gov v2 の /keyword を使う。1法令につき該当箇所1件だけ返す。
 */
export async function searchLawsFullText(
  keyword: string,
  limit: number = 10,
  lawType?: string
): Promise<EgovKeywordSearchItem[]> {
  const cacheKey = `fulltext|${keyword}|${limit}|${lawType ?? ''}`;
  const cached = lawSearchCache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const params = new URLSearchParams({
    keyword,
    limit: String(KEYWORD_HIT_LIMIT),
    sentences_limit: '1',
    sentence_text_size: '80',
    response_format: 'json',
  });
  if (lawType) {
    params.set('law_type', lawType);
  }

  await rateLimit();
  const url = `${EGOV_API_BASE}/keyword?${params}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`e-Gov API 本文検索エラー: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const items = ((json.items ?? []) as EgovKeywordSearchItem[]).slice(0, limit);

  lawSearchCache.set(cacheKey, JSON.stringify(items));

  return items;
}

/**
 * e-Gov の法令ページURLを生成
 */
export function getEgovUrl(lawId: string): string {
  return `https://laws.e-gov.go.jp/law/${lawId}`;
}

export interface EgovRevision {
  law_revision_id: string;
  law_title: string;
  amendment_promulgate_date: string;
  amendment_enforcement_date: string;
  amendment_enforcement_comment: string | null;
  amendment_law_id: string | null;
  amendment_law_title: string | null;
  amendment_law_num: string | null;
  current_revision_status: 'CurrentEnforced' | 'UnEnforced' | 'PreviousEnforced' | string;
}

export interface EgovLawRevisionsResponse {
  law_info: {
    law_id: string;
    law_num: string;
    promulgation_date: string;
  };
  revisions: EgovRevision[];
}

/**
 * 法令の改正履歴一覧を取得
 */
export async function fetchLawRevisions(lawNameOrId: string): Promise<EgovLawRevisionsResponse & { resolvedLawId: string }> {
  const lawId = await resolveLawId(lawNameOrId);

  await rateLimit();
  const url = `${EGOV_API_BASE}/law_revisions/${lawId}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });

  if (!res.ok) {
    if (res.status === 404) throw new NotFoundError(`法令が見つかりません (law_id: ${lawId})`);
    throw new Error(`e-Gov API エラー: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as EgovLawRevisionsResponse;
  return { ...data, resolvedLawId: lawId };
}
