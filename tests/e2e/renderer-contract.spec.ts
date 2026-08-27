import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('Renderer contract contains the three-pane SeeCoder surface', async () => {
  const html = await readFile('apps/desktop/src/renderer/index.html', 'utf8');
  const source = await readFile('apps/desktop/src/renderer/main.tsx', 'utf8');
  expect(html).toContain('SeeCoder');
  expect(source).toContain('Changes');
  expect(source).toContain('Terminal');
  expect(source).toContain('Trace');
  expect(source).toContain('approval.requested');
});

