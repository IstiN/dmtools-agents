try {
    var out = cli_execute_command({ command: 'bash -c "echo OUT; echo ERR >&2; exit 7"' });
    file_write({ path: '/tmp/probe_out.txt', content: 'NO-THROW out=' + String(out) });
} catch (e) {
    file_write({ path: '/tmp/probe_out.txt', content: 'THREW ' + String(e) });
}
