# Bash Command Rules

1. **Never end commands with `exit`** — it kills the shell session, making `read_bash` fail with `Invalid shell ID`
2. **Capture exit code via `$?`** right after the command, before running anything else
3. **Avoid `$PIPESTATUS` with pipes** — redirect output to a file instead

**✅ Correct:**
```bash
mkdir -p outputs
pytest path/to/test.py -q -r a > outputs/pytest_output.txt 2>&1
echo $? > outputs/pytest_exit_code.txt
cat outputs/pytest_output.txt
```

**❌ Wrong:**
```bash
pytest path/to/test.py | tee outputs/pytest_output.txt; ec=$PIPESTATUS[0]; exit $ec
```
