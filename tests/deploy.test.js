'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { removeTemp } = require('./helpers');

function writeCmd(file, text) { fs.writeFileSync(file, text.replace(/\r?\n/g, '\r\n'), 'ascii'); }
function fixture(scenario, { exists = true, lock = false, dependencies = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-deploy-test-'));
  const project = path.join(temp, 'project with spaces & bang!');
  const bin = path.join(temp, 'fake-bin');
  fs.mkdirSync(project); fs.mkdirSync(bin); fs.mkdirSync(path.join(project, 'scripts'));
  fs.copyFileSync(path.resolve(__dirname, '../deploy.cmd'), path.join(project, 'deploy.cmd'));
  // Shorten polling in the isolated COPY only; actual deployment uses three one-second samples.
  const helper = fs.readFileSync(path.resolve(__dirname, '../scripts/deploy-helper.ps1'), 'utf8').replace('[int]$PollMilliseconds = 1000', '[int]$PollMilliseconds = 25');
  fs.writeFileSync(path.join(project, 'scripts', 'deploy-helper.ps1'), helper);
  fs.writeFileSync(path.join(project, 'package.json'), '{}'); fs.writeFileSync(path.join(project, 'index.js'), '// fake');
  fs.writeFileSync(path.join(project, 'ecosystem.config.cjs'), '// fake');
  if (dependencies) fs.mkdirSync(path.join(project, 'node_modules'));
  if (lock) { fs.mkdirSync(path.join(project, '.deploy.lock')); fs.writeFileSync(path.join(project, '.deploy.lock', 'foreign.txt'), 'foreign lock'); }
  const state = path.join(temp, 'fake-state.json'), trace = path.join(temp, 'trace.txt');
  const online = [{ name: 'whatsappbot', pid: 12345, pm_id: 0, pm2_env: { status: 'online', restart_time: 0, exit_code: 0, env: { SECRET: 'PRIVATE_DEPLOY_TEST_SECRET' } } }];
  fs.writeFileSync(state, JSON.stringify(exists ? online : []));
  writeCmd(path.join(bin, 'node.cmd'), '@echo off\necho node %*>>"%WA_TEST_TRACE%"\nif "%~1"=="--version" echo v24.13.0\nexit /b 0\n');
  writeCmd(path.join(bin, 'npm.cmd'), `@echo off
echo npm %*>>"%WA_TEST_TRACE%"
if "%~1"=="--version" goto VERSION
if "%WA_TEST_CASE%"=="test-fail" exit /b 9
echo PRIVATE_DEPLOY_TEST_SECRET fake test payload
echo # tests 35
echo # pass 35
echo # fail 0
exit /b 0
:VERSION
echo 10.0.0
exit /b 0
`);
  writeCmd(path.join(bin, 'pm2.cmd'), `@echo off
echo pm2 %*>>"%WA_TEST_TRACE%"
if "%~1"=="--version" goto VERSION
if "%~1"=="jlist" goto JLIST
if "%~1"=="describe" goto DESCRIBE
if "%~1"=="stop" goto STOP
if "%~1"=="delete" goto DELETE
if "%~1"=="start" goto START
if "%~1"=="save" goto SAVE
if "%~1"=="status" goto STATUS
if "%~1"=="logs" goto LOGS
exit /b 1
:VERSION
echo 7.0.1
exit /b 0
:JLIST
if "%WA_TEST_CASE%"=="inspect-fail" exit /b 1
type "%WA_TEST_STATE%"
exit /b 0
:DESCRIBE
findstr /c:"whatsappbot" "%WA_TEST_STATE%" >nul
if errorlevel 1 exit /b 1
echo PRIVATE_DEPLOY_TEST_SECRET env=secret
exit /b 0
:STOP
if "%WA_TEST_CASE%"=="stop-fail" exit /b 1
exit /b 0
:DELETE
if "%WA_TEST_CASE%"=="delete-fail" exit /b 1
echo []>"%WA_TEST_STATE%"
exit /b 0
:START
if "%WA_TEST_CASE%"=="start-fail" exit /b 7
if "%WA_TEST_CASE%"=="exit-78" goto OWNERSHIP
if "%WA_TEST_CASE%"=="not-online" goto NOTONLINE
echo [{"name":"whatsappbot","pid":12345,"pm_id":0,"pm2_env":{"status":"online","restart_time":0,"exit_code":0}}]>"%WA_TEST_STATE%"
exit /b 0
:OWNERSHIP
echo [{"name":"whatsappbot","pid":0,"pm_id":0,"pm2_env":{"status":"stopped","restart_time":0,"exit_code":78}}]>"%WA_TEST_STATE%"
exit /b 0
:NOTONLINE
echo [{"name":"whatsappbot","pid":0,"pm_id":0,"pm2_env":{"status":"errored","restart_time":0,"exit_code":1}}]>"%WA_TEST_STATE%"
exit /b 0
:SAVE
if "%WA_TEST_CASE%"=="save-fail" exit /b 4
exit /b 0
:STATUS
echo PRIVATE_DEPLOY_TEST_SECRET hidden status text
exit /b 0
:LOGS
echo PRIVATE_DEPLOY_TEST_SECRET message body and QR data
echo prefix {"operation":"connection-open","connectionState":"READY","pid":12345,"body":"PRIVATE_DEPLOY_TEST_SECRET"}
echo prefix {"operation":"CONFLICT","connectionState":"AUTH_REQUIRED","pid":12345,"credentials":"PRIVATE_DEPLOY_TEST_SECRET"}
exit /b 0
`);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, WA_TEST_CASE: scenario, WA_TEST_STATE: state, WA_TEST_TRACE: trace };
  // Batch CALL and PowerShell Get-Command both resolve only these fake shims.
  return { temp, project, trace, env };
}
function run(f) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'deploy.cmd --no-pause'], { cwd: f.project, env: f.env, windowsHide: true });
    let output = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
}
function trace(f) { return fs.existsSync(f.trace) ? fs.readFileSync(f.trace, 'utf8').split(/\r?\n/).filter(Boolean) : []; }
function checks(f, result, expectedCode) {
  assert.equal(result.code, expectedCode, result.output);
  assert(!fs.existsSync(path.join(f.project, '.deploy.lock')), result.output);
  assert(!result.output.includes('PRIVATE_DEPLOY_TEST_SECRET'), result.output);
  const logs = fs.readdirSync(path.join(f.project, 'deploy-logs')).filter(name => name.endsWith('.log'));
  assert.equal(logs.length, 1);
  const log = fs.readFileSync(path.join(f.project, 'deploy-logs', logs[0]), 'utf8');
  assert(!log.includes('PRIVATE_DEPLOY_TEST_SECRET')); assert(log.includes('Deployment started'));
  assert(!trace(f).some(line => /pm2 kill|npm install|npm ci|git /.test(line)));
}
if (process.platform !== 'win32') {
  test('Windows deploy flow integration', { skip: 'Requires Windows cmd.exe/PowerShell' }, () => {});
} else {
  // Sequential: each fixture has independent PATH, fake state and real batch/helper copies.
  for (const [scenario, code, options] of [
    ['test-fail', 2, {}], ['fresh', 0, { exists: false }], ['online', 0, {}],
    ['start-fail', 1, {}], ['save-fail', 0, {}], ['exit-78', 1, {}],
    ['stop-fail', 1, {}], ['delete-fail', 1, {}], ['inspect-fail', 1, {}],
    ['not-online', 1, {}],
  ]) {
    test('deploy mock flow: ' + scenario, { timeout: 120000 }, async () => {
      const f = fixture(scenario, options);
      try {
        const result = await run(f); checks(f, result, code); const calls = trace(f);
        if (scenario === 'test-fail') {
          assert(result.output.includes('TESTS FAILED'));
          assert(!calls.some(line => /^pm2 (stop|delete|start|save|jlist|describe)/.test(line)));
        } else if (scenario === 'fresh') assert(!calls.some(line => /^pm2 (stop|delete)/.test(line)));
        else if (scenario === 'online') {
          for (const command of ['npm test', 'pm2 stop whatsappbot', 'pm2 delete whatsappbot', 'pm2 start ecosystem.config.cjs', 'pm2 save']) assert(calls.includes(command));
          assert(calls.indexOf('npm test') < calls.indexOf('pm2 stop whatsappbot'));
          assert(calls.indexOf('pm2 stop whatsappbot') < calls.indexOf('pm2 delete whatsappbot'));
          assert(calls.indexOf('pm2 delete whatsappbot') < calls.indexOf('pm2 start ecosystem.config.cjs'));
          assert(calls.indexOf('pm2 start ecosystem.config.cjs') < calls.indexOf('pm2 save'));
          assert(result.output.includes('Verified whatsappbot online'));
          assert(result.output.includes('AUTH_REQUIRED'));
          assert(result.output.includes('CONFLICT'));
          assert.equal(calls.filter(line => /^pm2 start /.test(line)).length, 1);
        } else if (scenario === 'save-fail') assert(result.output.includes('Bot is running, but PM2 process list could not be saved'));
        else if (scenario === 'exit-78') { assert(result.output.includes('exit 78')); assert(!calls.includes('pm2 save')); }
        else if (scenario === 'not-online') { assert(result.output.includes('not online')); assert(!calls.includes('pm2 save')); }
        else if (scenario === 'stop-fail' || scenario === 'delete-fail' || scenario === 'inspect-fail') assert(!calls.includes('pm2 start ecosystem.config.cjs'));
        if (code === 1) assert(result.output.includes('DEPLOY FAILED'));
      } finally { removeTemp(f.temp); }
    });
  }
  test('second deployment refuses existing lock and never removes foreign files', async () => {
    const f = fixture('online', { lock: true });
    try {
      const result = await run(f); assert.equal(result.code, 2); assert(result.output.includes('Another deployment appears to be running'));
      assert(fs.existsSync(path.join(f.project, '.deploy.lock', 'foreign.txt'))); assert.deepEqual(trace(f), []);
    } finally { removeTemp(f.temp); }
  });
  test('missing dependencies abort before tests or production commands', async () => {
    const f = fixture('online', { dependencies: false });
    try {
      const result = await run(f); checks(f, result, 2); assert(result.output.includes('Dependencies are missing'));
      assert.deepEqual(trace(f), []);
    } finally { removeTemp(f.temp); }
  });
}
