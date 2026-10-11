// Deep recall: a local cross-encoder re-scores a WIDE candidate pool by reading
// the question and each memory together, instead of comparing them only as
// separately computed vectors and keyword hits.
//
// Measured (evals/rerank/, LongMemEval-S, tuned on the even half, confirmed on
// the held-out odd half): any@1 87.2 → 93.2, all@5 85.5 → 94.9, ndcg@10
// 90.6 → 95.5, all evidence in the top 40 rounds 91.1 → 97.0 (multi-session
// 80.6 → 98.4). Cost: ~7 ms per candidate on CPU, ~1 s for a 150-row pool —
// so it is opt-in (`deep`), not on every lookup.
//
// Optional like the embedder: needs @huggingface/transformers and the model on
// disk (or allowRemote). Unavailable → callers get null and keep their ranking.
import { modelDir } from './embed.mjs';

export const RERANK_MODEL = () => process.env.BRAIN_RERANK_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2';
export const DEEP_POOL = 100;      // BM25 top N + semantic top N are added to the fused list
// 128 tokens per (query, memory) pair: on the held-out LongMemEval half it is
// as good as 256 or better (any@1 94.0 vs 91.5–93.2, all-evidence@40 97.4 vs
// 95.7–97.0) at half the cost (~7 ms/pair). TinyBERT-L2 was 4x faster still
// but lost its gains on the held-out half. Env override for reproducing runs.
export const RERANK_MAX_TOKENS = Number(process.env.BRAIN_RERANK_MAX_TOKENS) || 128;

let loading = null;
export function getReranker({ allowRemote = false } = {}) {
  if (loading) return loading;
  loading = (async () => {
    let lib;
    try { lib = await import('@huggingface/transformers'); } catch { return null; }
    try {
      lib.env.cacheDir = modelDir();
      lib.env.allowRemoteModels = !!allowRemote;
      lib.env.allowLocalModels = true;
      const id = RERANK_MODEL();
      const tok = await lib.AutoTokenizer.from_pretrained(id);
      const model = await lib.AutoModelForSequenceClassification.from_pretrained(id, { dtype: 'q8' });
      return async (query, texts) => {
        const out = [];
        for (let i = 0; i < texts.length; i += 16) {
          const chunk = texts.slice(i, i + 16);
          const inp = tok(new Array(chunk.length).fill(query), { text_pair: chunk, padding: true, truncation: true, max_length: RERANK_MAX_TOKENS });
          const { logits } = await model(inp);
          const d = logits.data, w = logits.dims.at(-1);
          for (let j = 0; j < chunk.length; j++) out.push(w === 1 ? d[j] : d[j * w + w - 1]);
        }
        return out;
      };
    } catch {
      return null;
    }
  })();
  const p = loading;
  p.then((r) => { if (!r) loading = null; }); // a failed load may be retried later
  return p;
}

const rowText = (r) => [r.title, r.narrative, r.facts].filter(Boolean).join('\n');

/**
 * Re-rank `rows` (already the union of the caller's candidates) by
 * cross-encoder score. Returns rows best first with rank-based scores, so
 * rerankByLifecycle keeps the order; null when the reranker is unavailable.
 */
export async function deepRerank(query, rows, { allowRemote = false, textOf = rowText } = {}) {
  if (!rows?.length) return rows;
  const rr = await getReranker({ allowRemote });
  if (!rr) return null;
  try {
    const scores = await rr(String(query), rows.map(textOf));
    return rows.map((r, i) => ({ r, s: scores[i], i }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map(({ r }, i) => ({ ...r, score: -1 / (i + 1) }));
  } catch {
    return null;
  }
}
