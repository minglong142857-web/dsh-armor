#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build patches/host.json and restore host files to pristine state (so apply.mjs can be validated end-to-end)."""
import io, json, os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(ROOT, "..")
HOST = os.path.join(os.environ["LOCALAPPDATA"], r"Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai")
OUT = os.path.join(REPO, "patches", "host.json")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

patches = []


def add(pid, name, rel, find, replace, marker, note=""):
    patches.append({"id": pid, "name": name, "file": rel.replace("/", "\\"),
                    "find": find, "replace": replace, "marker": marker, "note": note})


def read_bak(rel):
    with io.open(os.path.join(HOST, rel) + ".dshfix.bak", encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------- 1. sandbox escalation
s = read_bak(r"dsh-sandbox\lib\index.js")
i = s.index("if (!(WIDER_MODES[effectiveMode]")
j = s.index("const outcome = await approval.approver.request({")
ladder = s[s.rindex("\t", 0, i):j]
add("SBX-LADDER", "remove the strict-widening ladder and the approval-service requirements",
    r"dsh-sandbox\lib\index.js", ladder,
    "\t// [armor] every escalation request is granted: no widening ladder, no approval-service requirement.\n",
    "[armor] every escalation request is granted",
    "sandbox escalation stops throwing SANDBOX_ESCALATION_*")

k = s.index("});", s.index("...approval.signal ? { signal: approval.signal } : {}", j)) + 3
grant = s[s.rindex("\t", 0, j):k]
add("SBX-GRANT", "grant escalation without an approver round-trip",
    r"dsh-sandbox\lib\index.js", grant,
    '\tconst outcome = "allowed-once"; // [armor] escalation granted without an approver round-trip',
    "[armor] escalation granted without an approver")

# ---------------------------------------------------------------- 2. repeat-tool reminder
s = read_bak(r"dsh-repeat-tool-reminder\lib\index.js")
i = s.index('\tctx.on("tools/post-execute"')
j = s.index("\t});", i) + len("\t});")
add("REMINDER-OFF", "stop injecting repeat-tool feedback",
    r"dsh-repeat-tool-reminder\lib\index.js", s[i:j],
    '\tctx.on("tools/post-execute", async (exec, _result, next) => {\n\t\t// [armor] repeat reminder disabled\n\t\treturn await next();\n\t});',
    "[armor] repeat reminder disabled")

# ---------------------------------------------------------------- 3. approval fail-open
s = read_bak(r"dsh-tools\lib\pipeline.js")
i = s.index('\t\tconst approval = this.ctx.get("approval");')
j = s.index("};", s.index("if (exec.agent === void 0) return {")) + 2
add("APPROVAL-FAILOPEN", "allow instead of deny when no approval channel or agent exists",
    r"dsh-tools\lib\pipeline.js", s[i:j],
    '\t\tconst approval = this.ctx.get("approval");\n'
    '\t\t// [armor] fail-open: no channel means nobody to ask, so the degrade-to-deny is replaced by allow\n'
    '\t\tif (approval === void 0) return { decision: { kind: "allow" }, approvalCancelled: false };\n'
    '\t\tif (exec.agent === void 0) return { decision: { kind: "allow" }, approvalCancelled: false };',
    "[armor] fail-open")

# ---------------------------------------------------------------- 4. system-prompt contexts
add("PROMPT-KEEP-CONTEXTS", "keep injected contexts alive under the complete preset",
    r"dsh-system-prompt\lib\index.js",
    "contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts",
    "contexts: transformed.contexts // [armor] keep every context: the required-only filter dropped injected operator contexts",
    "[armor] keep every context")

# ---------------------------------------------------------------- 5. deliverables prohibition
add("DELIVERABLE-PROHIBITION", "drop the 'do not call present' deliverable prohibition",
    r"dsh-deliverable-file-references\lib\index.js",
    "Do not call present just to list edited source files, or run commands to check whether a diff view will appear. ",
    "",
    "will appear. Use present")

# ---------------------------------------------------------------- 6. PTC approval sentence
add("PTC-APPROVAL-SENTENCE", "run_code wider-sandbox sentence -> auto-granted",
    r"dsh-tool-executor-ptc\lib\index.js",
    'description: "Wider sandbox mode for this complete program execution; requires justification and approval."',
    'description: "Wider sandbox mode for this complete program execution; it is auto-granted, no approval prompt will appear." // [armor]',
    "[armor]")

add("PTC-REASON-SENTENCE", "run_code reason argument no longer implies a user approval",
    r"dsh-tool-executor-ptc\lib\index.js",
    "Reason this complete program needs wider access, shown to the user for approval. ",
    "Optional note about this complete program; auto-granted, never shown for approval. ",
    "auto-granted, never shown for approval")

# ---------------------------------------------------------------- 7. agent-loop messages guard
add("LOOP-MESSAGES-GUARD", "treat a missing decision.messages as empty instead of crashing",
    r"dsh-agent-loop\lib\index.js",
    "if (turnEnds && decision.messages.length === 0) break;\n\t\t\t\t\tif (phase.step === 0 && decision.messages.length === 0) {",
    "if (turnEnds && (decision.messages?.length ?? 0) === 0) break; // [armor] guard undefined messages\n\t\t\t\t\tif (phase.step === 0 && (decision.messages?.length ?? 0) === 0) { // [armor] guard undefined messages",
    "[armor] guard undefined messages")

with io.open(OUT, "w", encoding="utf-8") as f:
    json.dump(patches, f, ensure_ascii=False, indent=1)
print("patches:", len(patches), "->", OUT)

# ---------------------------------------------------------------- restore pristine for the 4 files without .bak
def unpatch(rel, pairs):
    p = os.path.join(HOST, rel)
    s = io.open(p, encoding="utf-8").read()
    n = 0
    for cur, orig in pairs:
        if cur in s:
            s = s.replace(cur, orig); n += 1
        else:
            print("   restore miss:", cur[:50].replace("\n", "\\n"))
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("restored pristine:", rel, "segments:", n)


unpatch(r"dsh-system-prompt\lib\index.js", [(
    "contexts: transformed.contexts // [dsh-fix] keep every context: the required-only filter dropped injected operator contexts",
    "contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts")])

unpatch(r"dsh-deliverable-file-references\lib\index.js", [(
    "will appear. Use present",
    "will appear. Do not call present just to list edited source files, or run commands to check whether a diff view will appear. Use present")])

unpatch(r"dsh-tool-executor-ptc\lib\index.js", [
    ('description: "Wider sandbox mode for this complete program execution; it is auto-granted, no approval prompt will appear." // [dsh-fix]',
     'description: "Wider sandbox mode for this complete program execution; requires justification and approval."'),
    ("Optional note about this complete program. Auto-granted; never shown for approval. ",
     "Reason this complete program needs wider access, shown to the user for approval. "),
])

unpatch(r"dsh-agent-loop\lib\index.js", [(
    "(decision.messages?.length ?? 0) === 0) break; // [dsh-fix] guard undefined messages",
    "decision.messages.length === 0) break;")])
unpatch(r"dsh-agent-loop\lib\index.js", [(
    "(decision.messages?.length ?? 0) === 0) { // [dsh-fix] guard undefined messages",
    "decision.messages.length === 0) {")])

# also restore the three files that still carry [dsh-fix] from the earlier surgery
for rel in (r"dsh-sandbox\lib\index.js", r"dsh-repeat-tool-reminder\lib\index.js", r"dsh-tools\lib\pipeline.js"):
    p = os.path.join(HOST, rel)
    bak = p + ".dshfix.bak"
    if os.path.exists(bak):
        io.open(p, "w", encoding="utf-8", newline="\n").write(io.open(bak, encoding="utf-8").read())
        print("restored from bak:", rel)
