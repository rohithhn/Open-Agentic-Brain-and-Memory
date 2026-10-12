import '../test-env.mjs';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const lib = await import('@huggingface/transformers').catch(() => null);
if (!lib) { console.error('the optional @huggingface/transformers library is not installed: npm install @huggingface/transformers'); process.exit(2); }
lib.env.cacheDir = join(HERE, '..', 'longmemeval', 'data', 'models'); lib.env.allowRemoteModels = true;
for (const id of (process.argv[2] || 'Xenova/ms-marco-MiniLM-L-6-v2').split(',')) {
  const t0 = performance.now();
  const tok = await lib.AutoTokenizer.from_pretrained(id);
  const model = await lib.AutoModelForSequenceClassification.from_pretrained(id, { dtype: 'q8' });
  const load = performance.now() - t0;
  const q = 'How many bikes did I service in March?';
  const docs = ['user: I took my road bike in for a tune-up on March 10 at Pedal Power.', 'user: what is a good pasta recipe?', 'user: my mountain bike got new brakes in March too'];
  const t1 = performance.now();
  const inp = tok(new Array(docs.length).fill(q), { text_pair: docs, padding: true, truncation: true, max_length: 256 });
  const { logits } = await model(inp);
  console.log(id, 'load', load.toFixed(0), 'ms; 3 pairs', (performance.now() - t1).toFixed(0), 'ms; scores', Array.from(logits.data).map((x) => x.toFixed(2)).join(' '));
}
