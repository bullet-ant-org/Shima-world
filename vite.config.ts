import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// After build: write dist/asset-manifest.json (versioned, hashed) and stamp the SW with it.
function assetManifest(): Plugin {
  return {
    name: 'asset-manifest',
    apply: 'build',
    closeBundle() {
      const dist = 'dist';
      const files: Record<string, { hash: string; size: number }> = {};
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else {
            const rel = '/' + relative(dist, p).replace(/\\/g, '/');
            if (rel === '/sw.js' || rel === '/asset-manifest.json') continue;
            const buf = readFileSync(p);
            files[rel] = { hash: createHash('sha1').update(buf).digest('hex').slice(0, 12), size: buf.length };
          }
        }
      };
      walk(dist);
      const version = createHash('sha1').update(JSON.stringify(files)).digest('hex').slice(0, 10);
      const manifest = { version, bundles: { core: { files } } };
      writeFileSync(join(dist, 'asset-manifest.json'), JSON.stringify(manifest, null, 1));
      const swPath = join(dist, 'sw.js');
      writeFileSync(swPath, readFileSync(swPath, 'utf8').replace('__BUILD_VERSION__', version));
    },
  };
}

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  plugins: [assetManifest()],
});
