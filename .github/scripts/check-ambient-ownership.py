#!/usr/bin/env python3
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

"""check-ambient-ownership.py — flag Starlark access checks that grant access on
entity ownership without a real authenticated-user guard.

Mochi runs public actions as the entity owner (entity-scoped actions) or the first
administrator (class-level actions) for anonymous callers — see core/server/web.go
owner resolution and the memory note reference-public-action-runs-as-owner.
`mochi.entity.get(id)` and an app's `owned(id)` helper both resolve ownership
against that *thread-local* effective user, so for an anonymous request to a public
action they return the OWNER. An access helper that short-circuits to a grant:

    if mochi.entity.get(id): return True        # wikis bug, 2026-06-17
    if owned(id): return True                   # forums bug, 2026-06-17

therefore treats the anonymous caller as the owner and bypasses the access rules
below it. The fix is to gate the short-circuit on a real authenticated user:

    if user and mochi.entity.get(id): return True

This detector flags exactly that shape:
  `if <cond containing owned(...) | mochi.entity.get(...) | mochi.entity.owned(...)>: return True`
  (single- or two-line) whose condition contains no `user` reference, AND whose
  enclosing function has no earlier `if not a.user` / `if not user` early-return
  (the repositories check_admin_access pattern, which is already safe).

It deliberately does NOT flag the common, safe uses (`if owned(x): is_owner = ...`,
`if not owned(x): ...`, display enrichment) — only the `return True` grant.

Three further shapes are detected below, each documented at its own rule: a
grant that consults no caller at all, an ownership call inside a `public: true`
action, and a helper whose return value IS the ownership answer.

Allowlist: `# access-ok: <reason>`. For the line-oriented rule below, on the if
line or the line above; for the function-oriented rules, anywhere in the
function or in the comment block immediately above its `def`. The window never
crosses into the preceding function - see annotated().

Usage:
  check-ambient-ownership.py [paths...]       # report violations (exit 0)
  check-ambient-ownership.py --check [paths]  # exit 1 if any violation (CI/preflight)

Default paths (run from monorepo root): apps/*/*.star + apps/*/starlark/*.star.
apps/test is exempt (internal assertions).

Tests: claude/scripts/test_check_ambient_ownership.py
"""
import re
import sys
from pathlib import Path

OWNERSHIP = re.compile(r'(\bowned\(|mochi\.entity\.(get|owned)\()')
IF_RE = re.compile(r'if\s+(.*?):\s*(.*)$')
ANON_GUARD = re.compile(r'if\s+not\s+(a\.user|user)\b')
DEF_RE = re.compile(r'^([\t ]*)def\s+(\w+)\s*\(')
ALLOW = 'access-ok:'

# Second detector: an access helper that reaches `return True` without ever
# consulting the caller. The ownership rule above keys on mochi.entity.get /
# owned(), but a grant can be spelled with no ownership call at all — the
# repositories Critical (2026-07) read it off a database column:
#
#     repo = mochi.db.row("select owner from repositories where id = ?", repo_id)
#     if repo and repo.get("owner", 1) == 0:
#         return True                    # <- anonymous callers land here
#     user_id = a.user.identity.id if ...  # the caller is consulted only AFTER
#
# Any authenticated-or-not caller passed that check, and the proxied read then
# ran with the subscriber's identity. So: for functions whose NAME marks them as
# access helpers, flag a `return True` that precedes every reference to the
# caller. Naming is the scope limiter — it keeps protocol helpers like market's
# _check_status (a stream status check, not authorization) out of the rule.
ACCESS_FN = re.compile(r'^(check_access|check_\w+_access|can_\w+|\w+_can|require_\w+)$')
# A bare `user` counts. Leaving it out made this rule flag the very shape the
# docstring above prescribes as THE fix - `if user and owned(id): return True` -
# which trains people to annotate `access-ok` around correct code.
CALLER = re.compile(
    r'\ba\.user\b|\buser\b|\buser_id\b|mochi\.access\.check\s*\(|\bcheck_\w*access\s*\('
)
RETURN_TRUE = re.compile(r'^return\s+True\s*$')
COMMENT = re.compile(r'#.*$')


def indent_of(line):
    return len(line) - len(line.lstrip('\t '))


def annotated(lines, fstart, fend):
    """Is this function annotated `# access-ok:`?

    The window is the body plus any contiguous comment block immediately above
    the def - the reasoning usually belongs with the explanation of WHY the
    caller was already established, not jammed against the return.

    It deliberately stops at the first non-comment line above the def. The
    previous spelling scanned from `fstart - 8`, which reached into the
    PRECEDING function: an annotation on one helper silenced an untouched
    neighbour, and this is a blocking deploy preflight, so it failed open in
    silence.
    """
    top = fstart
    while top > 0:
        above = lines[top - 1].strip()
        if above == '' or above.startswith('#'):
            top -= 1
            continue
        break
    return any(ALLOW in lines[j] for j in range(top, fend))


def functions(lines):
    """List of (name, start_idx, end_idx) — body is (start, end)."""
    out = []
    for i, line in enumerate(lines):
        m = DEF_RE.match(line)
        if not m:
            continue
        indent = len(m.group(1))
        end = len(lines)
        for j in range(i + 1, len(lines)):
            if lines[j].strip() == '':
                continue
            if indent_of(lines[j]) <= indent:
                end = j
                break
        out.append((m.group(2), i, end))
    return out


def enclosing(funcs, idx):
    for name, s, e in funcs:
        if s < idx < e:
            return name, s
    return None, None


def body_after(lines, i):
    """The statement controlled by a colon-terminated `if` on line i."""
    for j in range(i + 1, len(lines)):
        if lines[j].strip() == '':
            continue
        return lines[j].strip()
    return ''



# Third detector: an ownership call inside a PUBLIC action that never checks the
# caller. The two rules above key on the shape of a grant - `return True`, or a
# bare `return True` in a helper - so they never see an assignment, which is how
# feeds leaks it (feeds.star action_info_entity, 2026-07):
#
#     is_owner = owned(feed["id"])          # anonymous caller runs as the owner
#     feed["owner"] = 1 if is_owner else 0  # so a stranger is told they own it
#
# Core runs an anonymous request to a `public: true` action as the entity owner
# (web.go), so any ownership call in such an action answers about the owner
# unless the function establishes a real caller first. Reading app.json is what
# makes "public" knowable; without it this rule cannot be scoped and would flag
# every authenticated action too.
PUBLIC_ASSIGN = re.compile(r'^\w[\w\.\[\]"\']*\s*=\s*.*' )


def public_functions(star_path):
    """Function names bound to `public: true` actions in the app's manifest."""
    manifest = Path(star_path).parent / 'app.json'
    if not manifest.is_file():
        return set()
    text = manifest.read_text(encoding='utf-8', errors='replace')
    text = re.sub(r'^\s*//.*$', '', text, flags=re.M)
    names = set()
    # Each action is one object; take those carrying public: true.
    for entry in re.finditer(r'\{[^{}]*\}', text):
        block = entry.group(0)
        if '"public"' not in block or 'true' not in block:
            continue
        fn = re.search(r'"function"\s*:\s*"(\w+)"', block)
        if fn:
            names.add(fn.group(1))
    return names


def check_public_ownership(path, lines, funcs):
    """Ownership consulted in a public action with no caller guard first."""
    public = public_functions(path)
    if not public:
        return []
    out = []
    for name, fstart, fend in funcs:
        if name not in public:
            continue
        guard = None
        hit = None
        for j in range(fstart + 1, fend):
            s = lines[j].strip()
            # Only an explicit anonymous guard counts. An access check does NOT:
            # check_access permits anonymous viewers on a public entity, so it
            # establishes nothing about the caller - which is exactly how the
            # feeds case (action_info_entity) reads its owner flag after one.
            if guard is None and ANON_GUARD.match(s):
                guard = j
            if hit is None and OWNERSHIP.search(lines[j]) and not s.startswith('#'):
                hit = j
        if hit is None:
            continue
        if guard is not None and guard < hit:
            continue
        if annotated(lines, fstart, fend):
            continue
        out.append((hit + 1, name,
                    'ownership consulted in a public action before any caller '
                    'check: ' + lines[hit].strip()))
    return out


# Fourth detector: a helper whose RETURN VALUE is the ownership answer, and
# which takes a caller identity it never tests (feeds is_feed_owner, 2026-08-07):
#
#     def is_feed_owner(user_id, feed_data):
#         if feed_data == None:
#             return False
#         return owned(feed_data.get("id"))   # <- answers about the OWNER
#
# The three rules above all key on the shape of a GRANT - an `if ...: return
# True`, a bare `return True`, an ownership call inside a public action - so a
# helper whose whole body IS the ownership test slips past every one of them.
# In feeds this reached 26 call sites.
#
# The caller test is that the identity parameter is actually EXERCISED, not
# merely declared. is_feed_owner accepted `user_id` and ignored it; a rule that
# accepted the signature as evidence would stay blind on the very case that
# motivated it. The fix was to add `or not user_id` to the guard.
#
# Taking a caller identity is also what scopes the rule: it separates an access
# predicate from the app's own `owned()` / `owned_set()` primitives, which take
# no identity and are the tool these helpers call rather than the defect.
CALLER_PARAM = re.compile(r'^(user|user_id|uid|identity|caller|viewer|member)$')
CALLER_TESTED = (
    r'(?:^|\s)(?:if|elif|while)\s+.*\b{name}\b'      # if not user_id / if user_id and ...
    r'|\b{name}\b\s*(?:==|!=)|(?:==|!=)\s*\b{name}\b'
)
ASSIGN_RE = re.compile(r'^(\w+)\s*=\s*(.+)$')
RETURN_RE = re.compile(r'^return\s+(.+)$')


def def_params(line):
    m = re.match(r'^[\t ]*def\s+\w+\s*\(([^)]*)\)', line)
    if not m:
        return []
    return [p.split('=')[0].strip() for p in m.group(1).split(',') if p.strip()]


def ownership_derived(lines, funcs):
    """Names of functions whose return value derives from an ambient ownership
    call - directly, through a local, or through another such function."""
    derived = set()
    for _ in range(6):
        grew = False
        for name, fstart, fend in funcs:
            if name in derived:
                continue
            body = [(j, lines[j].strip()) for j in range(fstart + 1, fend)]
            body = [(j, s) for j, s in body if not s.startswith('#')]
            # Locals carrying an ownership answer: `is_owner = owned(x)`.
            taint = set()
            for _ in range(4):
                spread = False
                for _, s in body:
                    m = ASSIGN_RE.match(s)
                    if not m or m.group(1) in taint:
                        continue
                    expr = m.group(2)
                    if (OWNERSHIP.search(expr)
                            or any(re.search(r'\b%s\b' % re.escape(t), expr) for t in taint)
                            or any(re.search(r'\b%s\s*\(' % re.escape(d), expr) for d in derived)):
                        taint.add(m.group(1))
                        spread = True
                if not spread:
                    break
            for _, s in body:
                m = RETURN_RE.match(s)
                if not m:
                    continue
                expr = m.group(1).strip()
                if expr in ('True', 'False', 'None'):
                    continue
                if (OWNERSHIP.search(expr)
                        or any(re.search(r'\b%s\b' % re.escape(t), expr) for t in taint)
                        or any(re.search(r'\b%s\s*\(' % re.escape(d), expr) for d in derived)):
                    derived.add(name)
                    grew = True
                    break
        if not grew:
            break
    return derived


def check_owner_predicates(lines, funcs):
    """Ownership-answering helpers that ignore the caller identity they take."""
    derived = ownership_derived(lines, funcs)
    out = []
    for name, fstart, fend in funcs:
        if name not in derived:
            continue
        params = [p for p in def_params(lines[fstart]) if CALLER_PARAM.match(p)]
        if not params:
            continue
        body = [lines[j] for j in range(fstart + 1, fend)
                if not lines[j].strip().startswith('#')]
        if any(re.search(CALLER_TESTED.format(name=re.escape(p)), b)
               for p in params for b in body):
            continue
        if annotated(lines, fstart, fend):
            continue
        out.append((fstart + 1, name,
                    'returns an ambient ownership answer but never tests its '
                    'caller identity (%s): %s' % (', '.join(params),
                                                  lines[fstart].strip())))
    return out


def check_file(path):
    violations = []
    lines = Path(path).read_text(encoding='utf-8', errors='replace').splitlines()
    funcs = functions(lines)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith('if '):
            continue
        m = IF_RE.match(stripped)
        if not m:
            continue
        cond, rest = m.group(1), m.group(2)
        if not OWNERSHIP.search(cond):
            continue
        body = rest if rest else body_after(lines, i)
        if body != 'return True':
            continue
        # Gated by a real authenticated user in the condition itself.
        if 'user' in cond:
            continue
        # Intentional exception annotated at the site.
        if ALLOW in line or (i > 0 and ALLOW in lines[i - 1]):
            continue
        # Function returns early on an anonymous caller before this short-circuit
        # (e.g. repositories check_admin_access: `if not a.user: return False`).
        name, fstart = enclosing(funcs, i)
        if fstart is not None and any(
            ANON_GUARD.match(lines[j].strip()) for j in range(fstart, i)
        ):
            continue
        violations.append((i + 1, name or '<module>', stripped))

    # Access helpers that grant before consulting the caller at all.
    for name, fstart, fend in funcs:
        if not ACCESS_FN.match(name):
            continue
        first_true = None
        first_caller = None
        for j in range(fstart + 1, fend):
            s = lines[j].strip()
            if first_true is None and RETURN_TRUE.match(s):
                first_true = j
            # Code only: a comment that merely mentions the user is not the
            # function consulting it, and comments are common enough here that
            # matching them would silence the rule outright.
            if first_caller is None and CALLER.search(COMMENT.sub('', lines[j])):
                first_caller = j
        if first_true is None:
            continue
        if first_caller is not None and first_caller < first_true:
            continue
        if annotated(lines, fstart, fend):
            continue
        violations.append((first_true + 1, name,
                           'grants before consulting the caller: '
                           + lines[first_true].strip()))

    violations += check_public_ownership(path, lines, funcs)
    violations += check_owner_predicates(lines, funcs)
    return violations


def expand(args):
    paths = []
    for a in args:
        p = Path(a)
        if p.is_dir():
            paths += sorted(p.rglob('*.star'))
        elif any(ch in a for ch in '*?['):
            paths += sorted(Path('.').glob(a))
        else:
            paths.append(p)
    # apps/test is internal assertions, not user-facing access control - exempt
    # per CLAUDE.md, the same way the i18n and attachment gates treat it.
    return [p for p in paths
            if p.suffix == '.star' and p.is_file() and 'apps/test/' not in p.as_posix()]


def main():
    argv = sys.argv[1:]
    check = '--check' in argv
    argv = [a for a in argv if a != '--check']
    if argv:
        files = expand(argv)
    else:
        # Recursive, matching what a directory-scoped run already does (the
        # /deploy preflight passes apps/<app>, CI passes `.`). The two-level
        # globs this replaces missed 15 files - every apps/settings/{system,
        # user}/*.star and the vendored lib/attachments.star copies - so a
        # repo-root run reported clean on files it had never opened.
        files = expand(['apps'])

    total = 0
    for f in sorted(set(files)):
        for lineno, func, text in check_file(f):
            total += 1
            print(f'{f}:{lineno}: ownership grant without a.user guard '
                  f'in {func}(): {text}')

    if total:
        print(f'\n{total} ownership-grant short-circuit(s) without an a.user guard. '
              f'Gate with `if user and ...`, or annotate intentional cases with '
              f'`# access-ok: <reason>`.', file=sys.stderr)
        sys.exit(1 if check else 0)
    else:
        print('check-ambient-ownership: no ungated ownership grants found.')
        sys.exit(0)


if __name__ == '__main__':
    main()
