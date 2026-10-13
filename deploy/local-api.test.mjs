import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const deployDir = dirname(fileURLToPath(import.meta.url))
const repair = join(deployDir, 'repair-local-api.sh')
const shell = process.env.ANQUAN_TEST_SH || 'sh'
const shellPath = path => process.platform === 'win32'
  ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
  : path

const fixture = `server {
    listen 443 ssl;
    server_name prodsafety.ops.tw;
    ssl_certificate /etc/ssl/site.pem;
    root /var/www/site;
    location /api/ {
        proxy_pass http://sa.sa.ops.tw:10110;
        proxy_set_header Host $proxy_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
    location / {
        try_files $uri $uri/ /index.html;
    }
}
`
const fixed = fixture.replace('http://sa.sa.ops.tw:10110', 'http://127.0.0.1:10110').replace('Host $proxy_host', 'Host $http_host')

function cleanupTemp(base) {
  const target = resolve(base)
  assert.ok(target.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')))
  assert.match(target, /anquan-local-api-test-/)
  rmSync(target, { recursive: true, force: true })
}

function setup(t, original = fixture, scenario = '') {
  const base = mkdtempSync(join(tmpdir(), 'anquan-local-api-test-'))
  const bin = join(base, 'bin')
  // Model wildcard includes: only site.conf may ever appear in this directory.
  const sites = join(base, 'sites-enabled')
  mkdirSync(bin)
  mkdirSync(sites)
  const site = join(sites, 'site.conf')
  const backupDir = join(base, 'backups')
  mkdirSync(backupDir, { mode: 0o700 })
  writeFileSync(site, original)
  chmodSync(site, 0o640)
  const env = {
    ...process.env,
    ANQUAN_NGINX_BACKUP_DIR: shellPath(backupDir),
    TEST_BASE: shellPath(base),
    TEST_SITES: shellPath(sites),
    TEST_SCENARIO: scenario,
  }
  const stub = (name, body) => {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`)
    chmodSync(path, 0o755)
  }
  if (process.platform === 'win32') {
    // Normalize MSYS /c paths for the bundled native file tools. All paths still
    // refer to this test's checked OS temp directory or read-only script files.
    for (const name of ['awk', 'cat', 'chmod', 'cmp', 'cp', 'mktemp', 'mkdir', 'mv', 'readlink', 'rm', 'rmdir']) {
      const native = join(dirname(shell), `${name}.exe`).replaceAll('\\', '/')
      if (!existsSync(native)) continue
      stub(name, `
for argument do
    shift
    case "$argument" in
        /[a-zA-Z]/*) drive=\${argument#/}; drive=\${drive%%/*}; argument="$drive:/\${argument#/?/}" ;;
    esac
    set -- "$@" "$argument"
done
exec "${native}" "$@"
`)
    }
  }
  stub('id', 'if [ "$TEST_SCENARIO" = not-root ]; then echo 1; else echo 0; fi')
  // The bundled Git shell on Windows lacks install/chmod; the harness already
  // created the private backup root, so verify its sole requested operation.
  stub('install', '[ "$1" = -d ] && [ "$2" = -m ] && [ "$3" = 0700 ] && [ "$4" = -- ] && [ -d "$5" ]')
  stub('nginx', `
count=0
[ ! -f "$TEST_BASE/nginx-count" ] || count=$(cat "$TEST_BASE/nginx-count")
count=$((count + 1))
printf '%s' "$count" > "$TEST_BASE/nginx-count"
# A backup/stage placed in sites-enabled would break a real wildcard include.
set -- "$TEST_SITES"/*
[ "$#" -eq 1 ] || exit 9
if [ "$TEST_SCENARIO" = validation-fails ] && [ "$count" -eq 2 ]; then exit 1; fi
`)
  stub('systemctl', `
[ "$1" = reload ] && [ "$2" = nginx ]
count=0
[ ! -f "$TEST_BASE/reload-count" ] || count=$(cat "$TEST_BASE/reload-count")
count=$((count + 1))
printf '%s' "$count" > "$TEST_BASE/reload-count"
if [ "$TEST_SCENARIO" = reload-fails ] && [ "$count" -eq 1 ]; then exit 1; fi
`)
  // Fail immediately if a repair accidentally uses a download/build command.
  for (const name of ['curl', 'apt-get', 'pnpm', 'git']) stub(name, 'exit 99')
  t.after(() => cleanupTemp(base))
  const run = (path = site) => spawnSync(shell, [
    '-c', 'PATH="$1:$PATH"; export PATH; exec sh "$2" "$3"',
    'local-api-test', shellPath(bin), shellPath(repair), shellPath(path),
  ], { env, encoding: 'utf8' })
  const backups = () => existsSync(backupDir)
    ? readdirSync(backupDir).map(name => join(backupDir, name, 'original.conf')).filter(existsSync)
    : []
  return { base, site, sites, run, backups }
}

test('local repair preserves SSL/page/routing, owner/mode and backup outside include path', t => {
  const f = setup(t)
  const before = statSync(f.site)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(f.site, 'utf8'), fixed)
  assert.equal(statSync(f.site).mode & 0o777, before.mode & 0o777)
  assert.equal(statSync(f.site).uid, before.uid)
  assert.deepEqual(readdirSync(f.sites), ['site.conf'])
  assert.equal(f.backups().length, 1)
  assert.equal(readFileSync(f.backups()[0], 'utf8'), fixture)
  assert.equal(readFileSync(join(f.base, 'reload-count'), 'utf8'), '1')
})

test('missing Host is inserted and ^~ API prefix is supported', t => {
  const original = fixture.replace('location /api/', 'location ^~ /api/').replace('        proxy_set_header Host $proxy_host;\n', '')
  const f = setup(t, original)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(f.site, 'utf8'), /proxy_pass http:\/\/127\.0\.0\.1:10110;\n        proxy_set_header Host \$http_host;/)
})

for (const [name, original] of [
  ['multiple API blocks', fixture + fixture],
  ['nested API block', fixture.replace('        proxy_read_timeout 30s;', '        limit_except GET {\n            deny all;\n        }')],
  ['included API directives', fixture.replace('        proxy_read_timeout 30s;', '        include /etc/nginx/api-headers.conf;')],
  ['one-line API block', fixture.replace(/    location \/api\/ \{[\s\S]*?\n    \}/, '    location /api/ { proxy_pass http://outside; }')],
  ['multiple Host headers', fixture.replace('        proxy_read_timeout 30s;', '        proxy_set_header host other;')],
]) {
  test(`ambiguous ${name} leaves original file unchanged`, t => {
    const f = setup(t, original)
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /无法安全修改 API 配置/)
    assert.equal(readFileSync(f.site, 'utf8'), original)
    assert.equal(f.backups().length, 0)
    assert.equal(existsSync(join(f.base, 'reload-count')), false)
  })
}

test('validation failure restores original and reloads restored configuration', t => {
  const f = setup(t, fixture, 'validation-fails')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(f.site, 'utf8'), fixture)
  assert.equal(readFileSync(join(f.base, 'nginx-count'), 'utf8'), '3')
  assert.equal(readFileSync(join(f.base, 'reload-count'), 'utf8'), '1')
  assert.equal(readFileSync(f.backups()[0], 'utf8'), fixture)
})

test('reload failure restores original and retries reload', t => {
  const f = setup(t, fixture, 'reload-fails')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(f.site, 'utf8'), fixture)
  assert.equal(readFileSync(join(f.base, 'reload-count'), 'utf8'), '2')
})

test('already-local configuration causes no rewrite, backup or reload', t => {
  const f = setup(t, fixed)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(f.site, 'utf8'), fixed)
  assert.equal(f.backups().length, 0)
  assert.equal(existsSync(join(f.base, 'reload-count')), false)
})

test('non-root caller is refused before examining or changing Nginx', t => {
  const f = setup(t, fixture, 'not-root')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /root/)
  assert.equal(readFileSync(f.site, 'utf8'), fixture)
  assert.equal(existsSync(join(f.base, 'nginx-count')), false)
})

test('symlinked site is preserved while its actual target is repaired', t => {
  const f = setup(t)
  const link = join(f.base, 'site-link.conf')
  try {
    symlinkSync(f.site, link, 'file')
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows host does not permit creating file symlinks')
      return
    }
    throw error
  }
  const result = f.run(link)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.equal(readFileSync(f.site, 'utf8'), fixed)
})

test('--local overrides the previously saved remote upstream before any install action', t => {
  const source = readFileSync(join(deployDir, 'deploy.sh'), 'utf8')
  // Execute the actual argument/upstream selection prefix only; never install.
  const selection = source.slice(0, source.indexOf('if ! printf')) + '\nprintf "%s\\n" "$upstream"\n'
  const base = mkdtempSync(join(tmpdir(), 'anquan-local-api-test-'))
  const localDeploy = join(base, 'deploy')
  mkdirSync(localDeploy)
  mkdirSync(join(base, '.deploy'))
  writeFileSync(join(base, '.deploy', 'master-upstream'), 'outside.example:10110\n')
  const file = join(localDeploy, 'selection.sh')
  writeFileSync(file, selection.replace('[ "$(id -u)" -eq 0 ]', '[ 0 -eq 0 ]'))
  t.after(() => cleanupTemp(base))
  const run = args => spawnSync(shell, [shellPath(file), ...args], { encoding: 'utf8' })
  assert.equal(run(['--local']).stdout.trim(), '127.0.0.1:10110')
  assert.equal(run([]).stdout.trim(), 'outside.example:10110')
  assert.equal(run(['192.0.2.2:10110']).stdout.trim(), '192.0.2.2:10110')
})
