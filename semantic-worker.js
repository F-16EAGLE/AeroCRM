/**
 * semantic-worker.js
 * Runs entirely off the main thread. Lazily loads Transformers.js and the
 * all-MiniLM-L6-v2 sentence embedding model (~25MB, cached by the browser
 * after first load) to provide semantic similarity search over contact
 * notes. Falls back gracefully — app.js only calls this when the user
 * enables "AI search", so keyword search (Fuse.js) always works offline.
 */

let extractorPromise = null;
let corpus = []; // [{ id, text, embedding }]

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import(
        'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1'
      );
      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    })();
  }
  return extractorPromise;
}

async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

self.onmessage = async (e) => {
  const { type, payload, requestId } = e.data;
  try {
    if (type === 'index') {
      // payload: [{ id, text }]
      const results = [];
      for (const item of payload) {
        const embedding = await embed(item.text || '');
        results.push({ id: item.id, embedding });
      }
      corpus = results;
      self.postMessage({ type: 'index-complete', requestId, count: results.length });
    } else if (type === 'query') {
      // payload: { text, topK }
      const queryEmbedding = await embed(payload.text);
      const scored = corpus
        .map((c) => ({ id: c.id, score: cosineSimilarity(queryEmbedding, c.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, payload.topK || 20);
      self.postMessage({ type: 'query-result', requestId, results: scored });
    }
  } catch (err) {
    self.postMessage({ type: 'error', requestId, message: err.message || String(err) });
  }
};
