import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLawHistory } from '../lib/services/law-service.js';

export function registerGetLawHistoryTool(server: McpServer) {
  server.tool(
    'get_law_history',
    '日本の法令の改正履歴（沿革）を取得する。施行日・改正法番号・現行/未施行/適用済の区別を一覧表示。e-Gov法令API v2を使用。',
    {
      law_name: z.string().describe(
        '法令名または略称。例: "所得税法", "法人税法", "租税特別措置法", "所法", "措法"'
      ),
      limit: z.number().optional().describe(
        '取得件数（省略時は30件、最大100件）。新しい改正から順に返す。'
      ),
    },
    async (args) => {
      try {
        const result = await getLawHistory({
          lawName: args.law_name,
          limit: args.limit ? Math.min(args.limit, 100) : 30,
        });

        const rows = result.revisions.map(r => {
          const line = `${r.enforcementDate} | ${r.status} | ${r.amendmentLawNum ?? '（公布後即施行）'} | ${r.amendmentLawTitle ?? '（制定）'}`;
          return r.comment ? `${line}\n  ※ ${r.comment}` : line;
        }).join('\n');

        return {
          content: [{
            type: 'text' as const,
            text: [
              `# ${result.lawTitle} — 改正履歴`,
              `（${result.lawNum}）`,
              '',
              '施行日 | 状態 | 改正法番号 | 改正法名',
              '--- | --- | --- | ---',
              rows,
              '',
              `全${result.revisions.length}件を表示（API総件数は /api/2/law_revisions/${result.lawId} で確認可）`,
              `---`,
              `出典：e-Gov法令検索（デジタル庁）`,
              `URL: ${result.egovUrl}`,
            ].join('\n'),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `エラー: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
