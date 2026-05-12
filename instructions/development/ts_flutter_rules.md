# TrackState Flutter Project Rules

These rules are **binding** for all development and rework agents working in this project.
They supplement `implementation_instructions.md` and `bug_implementation_instructions.md`.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Dart (Flutter) |
| Target platforms | iOS, Android, Web (Flutter Web) |
| State management | Follow existing pattern in `lib/` (check `pubspec.yaml`) |
| CLI tool | `bin/trackstate.dart` — a Dart CLI (not a Flutter app) |
| Testing framework | `flutter test` for unit/widget tests; `testing/` folder for automation tests |
| Config | `.dmtools/config.js` for agent/pipeline config; `pubspec.yaml` for dependencies |

---

## Flutter-Specific Implementation Rules

### 1 — Read the project structure before implementing

```bash
find lib/ -name "*.dart" | head -40    # existing source
cat pubspec.yaml                        # approved dependencies
cat lib/main.dart                       # app entry point
find lib/ -name "*_bloc.dart" -o -name "*_cubit.dart" | head -10  # state management
```

Understand the existing architecture before writing a single line of code.

### 2 — Only add packages already in pubspec.yaml or run flutter pub add

Never manually edit `pubspec.yaml` to add a package. Use:
```bash
flutter pub add <package>
```
Only add packages that are genuinely required for the feature. Do not introduce new state management libraries, navigation packages, or DI frameworks unless specified in the ticket.

### 3 — Widget key discipline

Every widget that is tested in automation or is user-facing must have a `ValueKey` or `Key` set. Keys must be stable, semantic, and kebab-case:
```dart
// ✅ CORRECT
ElevatedButton(
  key: const ValueKey('submit-button'),
  onPressed: onPressed,
  child: const Text('Submit'),
)
```

### 4 — Accessibility — semantic labels on all interactive widgets

Every `IconButton`, `GestureDetector`, and custom interactive widget needs:
```dart
Semantics(
  label: 'Close dialog',
  button: true,
  child: IconButton(icon: const Icon(Icons.close), onPressed: onPressed),
)
```

This is required for both accessibility and automation.

### 5 — No hardcoded colors or sizes

Use theme values:
```dart
// ❌ WRONG
color: Color(0xFF2D3748)

// ✅ CORRECT
color: Theme.of(context).colorScheme.primary
```

### 6 — TrackState CLI (bin/trackstate.dart) specific rules

- The CLI uses the `--path` flag to specify the target repository path
- Always validate `--path` before executing any operation
- CLI commands must return structured JSON to stdout; errors to stderr
- Never use `dart run /absolute/path/to/bin/trackstate.dart` — use `dart run trackstate`
- The CLI must be runnable from the repository root

### 7 — Do not touch the `testing/` folder

The `testing/` folder is owned exclusively by test automation agents. Development and rework agents must never modify files under `testing/` unless:
- A ticket explicitly requires a change to the test harness
- A core model change breaks an existing test (fix the test to match the new contract, not vice versa)

If you need to add a `testing/` change, add an explicit justification in `outputs/response.md`.

### 8 — Run flutter analyze and flutter test before finishing

```bash
flutter analyze lib/
flutter test
```

Fix all analyzer errors and test failures before outputting `outputs/response.md`.

### 9 — Null safety

All new Dart code must be null-safe. Prefer:
- `final String? value = ...` over `dynamic`
- `value ?? defaultValue` over `if (value != null)`
- `value!` only when you have a provable non-null guarantee
- Never silence the analyzer with `// ignore:` without an explanation

### 10 — Localization — no hardcoded UI strings

All user-visible strings must go through the localization system. Check how existing strings are defined:
```bash
find lib/ -name "*.arb" | head -5
find lib/ -name "app_localizations*.dart" | head -5
```
Add new strings to the `.arb` file; use the generated accessor in widgets. Never use raw string literals in `Text()` widgets.

---

## Bug Fix Additional Rules (TrackState-specific)

### Dart CLI bugs — verify platform and package resolution

For CLI bugs, always verify:
1. Run `dart run trackstate <command>` from the repo root (not a subpath)
2. Check that `pubspec.yaml` has the correct `executables:` entry
3. Test the fix on both the happy path AND the error path described in the ticket

### Regression check — use `git log --oneline lib/ | head -20`

Before writing the fix, check recent changes to the affected files. If another agent recently modified the same file, read that diff first to avoid conflicting changes.

---

## Output (`outputs/response.md`) must include

1. **Issues/Notes** — any missing/incomplete or out-of-scope concerns
2. **Approach** — architecture decisions and why the chosen approach is correct
3. **Files Modified** — every file created or changed with a one-line description
4. **Test Coverage** — what tests were added or modified and what they verify
5. **Flutter Analyze** — `flutter analyze` result (0 issues or issues list with justification)
