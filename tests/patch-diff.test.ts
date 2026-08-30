import { describe, expect, it } from 'vitest';
import { parsePatchPreview } from '../apps/desktop/src/renderer/diff-viewer';

describe('patch diff preview', () => {
  it('converts apply_patch syntax into semantic file and line rows', () => {
    const files = parsePatchPreview(`*** Begin Patch
*** Update File: src/app.ts
@@ -4,2 +4,3 @@
 const ready = true;
-const label = 'old';
+const label = 'new';
+const count = 1;
*** End Patch`);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/app.ts');
    expect(files[0]?.lines.map((line) => line.kind)).toEqual(['meta', 'context', 'remove', 'add', 'add']);
    expect(files[0]?.lines.at(-1)).toMatchObject({ newLine: 6, text: 'const count = 1;' });
  });

  it('keeps multiple files separated and hides patch protocol markers', () => {
    const files = parsePatchPreview(`*** Begin Patch
*** Update File: a.ts
@@
-old
+new
*** Add File: b.ts
@@
+export {};
*** End Patch`);
    expect(files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(files.flatMap((file) => file.lines).some((line) => line.text.includes('Begin Patch'))).toBe(false);
  });
});
