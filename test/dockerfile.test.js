const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('Docker image installs production npm dependencies', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY\s+(?:--chown=\S+\s+)?package\.json package-lock\.json \.\//);
  assert.match(dockerfile, /npm ci --omit=dev/);
});

test('Docker image copies server helper modules used at runtime and runs as non-root node user', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /COPY\s+(?:--chown=\S+\s+)?server\.js \.\//);
  assert.match(dockerfile, /COPY\s+(?:--chown=\S+\s+)?src \.\/src/);
  assert.match(dockerfile, /COPY\s+(?:--from=\S+\s+)?(?:--chown=\S+\s+)?(?:\/app\/)?public \.\/public/);
  assert.match(dockerfile, /^\s*USER\s+node\s*$/m);
});

test('.dockerignore excludes VCS, dev tests, docs, and node_modules', () => {
  const dockerignore = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8');
  assert.match(dockerignore, /^\.git$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^test$/m);
  assert.match(dockerignore, /^docs$/m);
  assert.doesNotMatch(dockerignore, /^scripts\/?$/m);
});
