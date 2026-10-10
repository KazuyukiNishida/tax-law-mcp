/**
 * 法令サービス
 * e-Gov法令API v2 を使った条文取得・検索のビジネスロジック
 */

import {
  fetchLawData,
  fetchLawRevisions,
  searchLaws,
  searchLawsFullText,
  rankLawSearchResults,
  getEgovUrl,
} from '../egov-client.js';
import {
  extractArticle,
  extractToc,
  listSupplProvisions,
  findSupplProvision,
  extractSupplArticle,
  type SupplProvisionInfo,
} from '../egov-parser.js';
import { stripTags } from '../html-utils.js';
import { NotFoundError } from '../errors.js';

export interface GetLawArticleResult {
  lawTitle: string;
  article: string;
  articleCaption: string;
  text: string;
  egovUrl: string;
  /** paragraph を省略して item を指定したとき、実際に一致した項番号 */
  matchedParagraph?: number;
}

export interface GetLawTocResult {
  lawTitle: string;
  toc: string;
  egovUrl: string;
}

export interface SearchLawResultItem {
  lawTitle: string;
  lawId: string;
  lawNum: string;
  lawType: string;
  egovUrl: string;
  /** 本文検索のときの該当箇所（抜粋） */
  snippet?: string;
}

export interface SearchLawResult {
  keyword: string;
  /** title=法令名・略称で一致 / fulltext=法令名で見つからず本文検索に切り替えた */
  mode: 'title' | 'fulltext';
  results: SearchLawResultItem[];
}

/**
 * 法令の特定条文を取得
 */
export async function getLawArticle(params: {
  lawName: string;
  article: string;
  paragraph?: number;
  item?: string | number;
  subitem?: string;
}): Promise<GetLawArticleResult> {
  if (params.subitem !== undefined && params.item === undefined) {
    throw new NotFoundError(
      'subitem（イ・(1)・(i)）を指定するときは item（号番号）も指定してください。'
    );
  }

  const { data, lawId, lawTitle } = await fetchLawData(params.lawName);
  const egovUrl = getEgovUrl(lawId);

  const result = extractArticle(
    data,
    params.article,
    params.paragraph,
    params.item,
    params.subitem,
  );

  if (!result) {
    const articleDesc = `第${params.article}条`;
    const paraDesc = params.paragraph !== undefined ? `第${params.paragraph}項` : '';
    const itemDesc = params.item !== undefined ? `第${params.item}号` : '';
    const subDesc = params.subitem !== undefined ? ` ${params.subitem}` : '';
    throw new NotFoundError(
      `${lawTitle} ${articleDesc}${paraDesc}${itemDesc}${subDesc} が見つかりませんでした。条文番号を確認してください。`
    );
  }

  return {
    lawTitle,
    article: params.article,
    // e-Gov の見出しは「（業務の制限）」と括弧つきで来る。表示側で括弧を付けるので外しておく
    articleCaption: (result.articleCaption ?? '').replace(/^（(.*)）$/, '$1'),
    text: result.text,
    egovUrl,
    matchedParagraph: result.matchedParagraph,
  };
}

/**
 * 法令の目次を取得
 */
export async function getLawToc(params: {
  lawName: string;
}): Promise<GetLawTocResult> {
  const { data, lawId, lawTitle } = await fetchLawData(params.lawName);
  const egovUrl = getEgovUrl(lawId);
  const toc = extractToc(data);

  return { lawTitle, toc, egovUrl };
}

export interface LawRevisionItem {
  enforcementDate: string;
  promulgateDate: string;
  amendmentLawNum: string | null;
  amendmentLawTitle: string | null;
  status: string;
  comment: string | null;
  revisionId: string;
}

export interface GetLawHistoryResult {
  lawTitle: string;
  lawId: string;
  lawNum: string;
  egovUrl: string;
  revisions: LawRevisionItem[];
}

function statusLabel(s: string): string {
  if (s === 'CurrentEnforced') return '現行';
  if (s === 'UnEnforced') return '未施行';
  if (s === 'PreviousEnforced') return '適用済';
  return s;
}

/**
 * 法令の改正履歴を取得
 */
export async function getLawHistory(params: {
  lawName: string;
  limit?: number;
}): Promise<GetLawHistoryResult> {
  const data = await fetchLawRevisions(params.lawName);
  const lawTitle = data.revisions[0]?.law_title ?? params.lawName;
  const egovUrl = getEgovUrl(data.resolvedLawId);
  const limit = params.limit ?? 30;

  const revisions: LawRevisionItem[] = data.revisions.slice(0, limit).map(r => ({
    enforcementDate: r.amendment_enforcement_date,
    promulgateDate: r.amendment_promulgate_date,
    amendmentLawNum: r.amendment_law_num,
    amendmentLawTitle: r.amendment_law_title,
    status: statusLabel(r.current_revision_status),
    comment: r.amendment_enforcement_comment,
    revisionId: r.law_revision_id,
  }));

  return {
    lawTitle,
    lawId: data.resolvedLawId,
    lawNum: data.law_info.law_num,
    egovUrl,
    revisions,
  };
}

/** 法令名検索で並べ替え用に取ってくる候補数 */
const SEARCH_CANDIDATE_LIMIT = 100;

/**
 * 法令をキーワード検索
 * まず法令名・略称で探し（完全一致→前方一致→部分一致の順）、なければ本文検索に切り替える。
 */
export async function searchLaw(params: {
  keyword: string;
  lawType?: string;
  limit?: number;
}): Promise<SearchLawResult> {
  const limit = Math.min(params.limit ?? 10, 20);
  const keyword = params.keyword.trim();

  const byTitle = await searchLaws(keyword, SEARCH_CANDIDATE_LIMIT, params.lawType);
  if (byTitle.length > 0) {
    return {
      keyword,
      mode: 'title',
      results: rankLawSearchResults(byTitle, keyword).slice(0, limit).map(r => ({
        lawTitle: r.revision_info?.law_title ?? r.current_revision_info?.law_title ?? '',
        lawId: r.law_info.law_id,
        lawNum: r.law_info.law_num,
        lawType: r.law_info.law_type,
        egovUrl: getEgovUrl(r.law_info.law_id),
      })),
    };
  }

  const byText = await searchLawsFullText(keyword, limit, params.lawType);
  return {
    keyword,
    mode: 'fulltext',
    results: byText.map(r => ({
      lawTitle: r.revision_info?.law_title ?? '',
      lawId: r.law_info.law_id,
      lawNum: r.law_info.law_num,
      lawType: r.law_info.law_type,
      egovUrl: getEgovUrl(r.law_info.law_id),
      snippet: r.sentences?.[0] ? stripTags(r.sentences[0].text) : undefined,
    })),
  };
}

export interface GetSupplResult {
  lawTitle: string;
  /** 制定時附則なら undefined */
  amendLawNum?: string;
  extract: boolean;
  text: string;
  egovUrl: string;
}

/** 附則の一覧を取得する */
export async function listSuppl(params: { lawName: string }): Promise<{
  lawTitle: string;
  egovUrl: string;
  items: SupplProvisionInfo[];
}> {
  const { data, lawId, lawTitle } = await fetchLawData(params.lawName);
  return { lawTitle, egovUrl: getEgovUrl(lawId), items: listSupplProvisions(data) };
}

/** 附則の条文（または附則ブロック全体）を取得する */
export async function getSupplProvision(params: {
  lawName: string;
  supplementary?: string | boolean;
  article?: string;
  paragraph?: number;
  item?: string | number;
  subitem?: string;
}): Promise<GetSupplResult> {
  const { data, lawId, lawTitle } = await fetchLawData(params.lawName);
  const egovUrl = getEgovUrl(lawId);

  const found = findSupplProvision(data, params.supplementary);
  if (!found) {
    const all = listSupplProvisions(data);
    const hint = all.length
      ? `この法令には附則が${all.length}件あります。format="suppl" で一覧を確認してください。`
      : 'この法令に附則は収録されていません。';
    throw new NotFoundError(
      `${lawTitle} の附則「${String(params.supplementary ?? '制定')}」が見つかりませんでした。${hint}`
    );
  }
  if ('ambiguous' in found) {
    const list = found.ambiguous
      .map((i) => `  - ${i.amendLawNum ?? '（制定時附則）'}${i.extract ? '（抄）' : ''}`)
      .join('\n');
    throw new NotFoundError(
      `${lawTitle} の附則「${String(params.supplementary ?? '')}」が一意に定まりませんでした。候補:\n${list}`
    );
  }

  const result = extractSupplArticle(
    found.node,
    params.article,
    params.paragraph,
    params.item,
    params.subitem,
  );
  if (!result) {
    const label = found.info.amendLawNum ?? '制定時附則';
    const nums = found.info.articleNums.length
      ? `この附則が持つ条: ${found.info.articleNums.join(', ')}`
      : 'この附則は条を持たず、項のみで構成されています（article を省いて取得してください）。';
    throw new NotFoundError(
      `${lawTitle} 附則（${label}）${params.article ? ` 第${params.article}条` : ''} が見つかりませんでした。${nums}`
    );
  }

  return {
    lawTitle,
    amendLawNum: found.info.amendLawNum,
    extract: found.info.extract,
    text: result.text,
    egovUrl,
  };
}
