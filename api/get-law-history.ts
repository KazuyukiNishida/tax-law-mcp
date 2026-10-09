import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withMiddleware, queryString, queryNumber } from './_shared/middleware.js';
import { getLawHistory } from '../src/lib/services/law-service.js';

async function handler(req: VercelRequest, res: VercelResponse) {
  const lawName = queryString(req.query.law_name);
  const limit = queryNumber(req.query.limit);

  if (!lawName) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'law_name は必須です' },
    });
  }

  const result = await getLawHistory({ lawName, limit: limit ?? 30 });

  return res.status(200).json({
    lawTitle: result.lawTitle,
    lawNum: result.lawNum,
    revisions: result.revisions,
    source: 'e-Gov法令検索',
    url: result.egovUrl,
  });
}

export default withMiddleware(handler);
