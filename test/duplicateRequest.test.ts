import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../src/core/parser.js';
import { planDuplicateRequest } from '../src/core/duplicateRequest.js';

const source = '### Old\r\nPOST https://example.test/a\r\nX-Test: yes\r\n\r\nbody\r\n\r\n### Old Copy\r\nGET /b\r\n';
const selected = parseHttpFile(source).requests[0];

describe('planDuplicateRequest', () => {
  it('copies only selected section with unique name and original CRLF bytes', () => {
    const plan = planDuplicateRequest(source, selected)!;
    expect(plan).toEqual({ offset: source.indexOf('### Old Copy'), text: '### Old Copy 2\r\nPOST https://example.test/a\r\nX-Test: yes\r\n\r\nbody\r\n\r\n' });
    expect(parseHttpFile(source.slice(0, plan.offset) + plan.text + source.slice(plan.offset)).requests.map((r) => r.name)).toEqual(['Old', 'Old Copy 2', 'Old Copy']);
  });
  it('rejects stale rows, malformed names, oversized and NUL files', () => {
    expect(planDuplicateRequest(source.replace('POST https://example.test/a', 'POST /changed'), selected)).toBeNull();
    expect(planDuplicateRequest(source.replace('POST https://example.test/a', 'POST https://example.test/a HTTP/2'), selected)).toBeNull();
    expect(planDuplicateRequest(source.replace('body', 'changed'), selected)).toBeNull();
    expect(planDuplicateRequest(source.replace('X-Test: yes', 'X-Test: no'), selected)).toBeNull();
    expect(planDuplicateRequest(source.replace('body\r\n\r\n### Old Copy', 'body\r\n### Old Copy'), selected)).toBeNull();
    expect(planDuplicateRequest(source.replace('### Old\r\n', '### Old\r\n# changed\r\n'), selected)).toBeNull();
    expect(planDuplicateRequest('### Old\ninvalid\n', selected)).toBeNull();
    expect(planDuplicateRequest('x'.repeat(1_048_577), selected)).toBeNull();
    expect(planDuplicateRequest(source + '\0', selected)).toBeNull();
  });
  it('duplicates a late section in a bounded many-section file without quadratic scanning', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `### R${i}\nGET /${i}\n`).join('');
    const last = parseHttpFile(many).requests.at(-1)!;
    const start = performance.now();
    const plan = planDuplicateRequest(many, last);
    expect(plan?.text).toBe('### R19999 Copy\nGET /19999\n');
    expect(performance.now() - start).toBeLessThan(2_000);
  }, 10_000);

  it('does not absorb a following malformed section or drop a terminal request without newline', () => {
    const prior = '### First\nGET /a\n### malformed\ninvalid\n';
    const plan = planDuplicateRequest(prior, parseHttpFile(prior).requests[0])!;
    expect(plan.text).toBe('### First Copy\nGET /a\n');
    expect(plan.offset).toBe(prior.indexOf('### malformed'));
    const terminal = '### Last\nGET /last';
    const endPlan = planDuplicateRequest(terminal, parseHttpFile(terminal).requests[0])!;
    expect(endPlan).toEqual({ offset: terminal.length, text: '\n### Last Copy\nGET /last\n' });
    expect(parseHttpFile(terminal + endPlan.text).requests.map((r) => r.name)).toEqual(['Last', 'Last Copy']);
  });
});
