import test from 'node:test';
import assert from 'node:assert/strict';
import { arxivPDF, validateSourceRefs } from '../src/core/source.js';
import type { ExperimentSpec, SourceDocument } from '../src/shared/types.js';

test('arXiv import preserves version and rejects external or malformed sources', () => {
  assert.equal(arxivPDF('https://arxiv.org/abs/1706.03762v7').href, 'https://arxiv.org/pdf/1706.03762v7');
  assert.equal(arxivPDF('https://arxiv.org/pdf/math/0301234.pdf').href, 'https://arxiv.org/pdf/math/0301234');
  assert.throws(() => arxivPDF('https://example.com/abs/1706.03762'), /только HTTPS/);
  assert.throws(() => arxivPDF('https://arxiv.org/abs/../../etc/passwd'), /Некорректная/);
  assert.throws(() => arxivPDF('http://arxiv.org/abs/1706.03762'), /HTTPS/);
});
test('plan citations must occur on the cited source page', () => {
  const source: SourceDocument = { original: '/paper.pdf', textPath: '/paper.txt', sha256: 'test', pages: [{ page: 1, text: 'For independent bounded random variables, the tail probability is bounded.' }] };
  const spec = { sourceRefs: [{ page: 1, quote: 'independent bounded\n random variables' }] } as ExperimentSpec;
  validateSourceRefs(spec, source);
  spec.sourceRefs[0].page = 2;
  assert.throws(() => validateSourceRefs(spec, source), /Цитата не найдена/);
  spec.sourceRefs[0] = { page: 1, quote: 'Published accuracy is 99 percent' };
  assert.throws(() => validateSourceRefs(spec, source), /Цитата не найдена/);
});
