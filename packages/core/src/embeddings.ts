/**
 * Pluggable embedding provider for hybrid discovery (plan/04-architecture.md).
 *
 * ⚠️ PLACEHOLDER NOTICE — read before Phase 5 / any real demo:
 * `LocalHashEmbedding` below is a dependency-free, zero-cost stand-in so discovery works
 * end to end without an API key. It captures shared vocabulary only (a hashed bag-of-
 * words), NOT semantic meaning — "car" and "automobile" will not be recognized as
 * similar. Swap in a real model (Voyage `voyage-3`, OpenAI `text-embedding-3-small`, per
 * plan/08-requirements.md) before relying on semantic recall for anything but plumbing
 * tests. The interface is designed so that swap is a one-line change at the call site.
 */

export const EMBEDDING_DIM = 256;

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

/** Deterministic, offline, zero-cost. Bag-of-words hashed into a fixed-size vector. */
export class LocalHashEmbedding implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIM;

  async embed(text: string): Promise<number[]> {
    const vec = new Array(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    for (const token of tokens) {
      const bucket = hashString(token) % this.dimensions;
      vec[bucket] += 1;
    }

    return normalize(vec);
  }
}

function hashString(s: string): number {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function normalize(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector dimension mismatch");
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are already unit-normalized, so dot product == cosine similarity
}
