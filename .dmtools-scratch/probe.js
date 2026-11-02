// scratch probe for gh-1318 TDD feasibility — deleted after the run
var out = cli_execute_command({ command: 'bash -c "mktemp -d"' });
console.log('MKTEMP:[' + String(out).trim() + ']');
var tmp = String(out).trim();
console.log('GIT-INIT:[' + cli_execute_command({ command: 'git -C ' + tmp + ' init' }) + ']');
console.log('WORKDIR-CHECK:[' + cli_execute_command({ command: 'git -C ' + tmp + ' rev-parse --is-inside-work-tree' }) + ']');
var fwErr = null;
try { file_write({ path: tmp + '/probe.txt', content: 'hello' }); } catch (e) { fwErr = e; }
console.log('FILE-WRITE-TMP:' + (fwErr ? 'BLOCKED ' + fwErr : 'OK'));
var frErr = null;
try { console.log('FILE-READ-TMP:[' + file_read({ path: tmp + '/probe.txt' }) + ']'); } catch (e) { frErr = e; }
if (frErr) console.log('FILE-READ-TMP:BLOCKED ' + frErr);
console.log('CAT:[' + cli_execute_command({ command: 'bash -c "cat ' + tmp + '/probe.txt"' }) + ']');
var mcErr = null;
try { cli_execute_command({ command: 'bash -c "echo hi > ' + tmp + '/x.txt"' }); } catch (e) { mcErr = e; }
console.log('METACHAR-GUARD:' + (mcErr ? 'BLOCKED' : 'ALLOWED'));
console.log('WORKDIR-OPT:[' + cli_execute_command({ command: 'git rev-parse --is-inside-work-tree', workingDirectory: tmp }) + ']');
console.log('CLEANUP:[' + cli_execute_command({ command: 'bash -c "rm -rf ' + tmp + '"' }) + ']');
