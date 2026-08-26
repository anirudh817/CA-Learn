# Biological Discovery mode — current vs. proposed (a simple comparison)

A plain-language map of what Discovery mode does **today** and what "Richer
Discovery-mode biology" would change. No code required to follow this.

---

## The one-sentence version

**Today** Discovery *changes how the answer is worded.*
**Proposed** Discovery *changes what the answer is built from* — grounding the
biological story in your run's actual data and (optionally) real external
biology, with citations.

---

## What happens today

```
Your question
     │
     ▼
[ Is Discovery "active"? ]  ← decided by KEYWORD MATCH on your question
     │   (auto: fires if it sees words like "mechanism", "hypothesis",
     │    "interpret"; on: always; off: never)
     ▼  yes
[ Two things get switched on: ]
   1. System prompt swaps to a "lead with the biological story" version
   2. ONE fixed, pre-computed "biological landscape" summary of the run
      is pasted in — the SAME summary regardless of what you asked
     │
     ▼
Model writes an interpretive-sounding answer
   (biology comes mostly from the model's own training, not your data)
```

**Three weak spots:**
| # | Weak spot | Consequence |
|---|-----------|-------------|
| 1 | Activation is keyword matching | Misses paraphrases ("what's going on in these cells?"); false-fires on literal words ("the *mechanism* of the assay") |
| 2 | One static, question-blind summary | Same biology block every time; doesn't focus on what you actually asked about |
| 3 | Binary on/off; ignores external lookups | No "how deep" control; doesn't use UniProt/Reactome/STRING/PubMed even when enabled |

---

## What we propose

```
Your question
     │
     ▼
[ Smarter activation ]  ← (C) cheap intent classifier instead of keywords
     │
     ▼
[ Pick a LEVEL ]  ← (B) off → interpret → synthesize → hypothesize
     │                 (each level pulls in more context + a stronger directive)
     ▼
[ Build QUESTION-SPECIFIC evidence ]  ← (A) the core change
   • retrieve the DE proteins / modules / enrichments relevant to YOUR question
     (reuses the existing retrieval layer)
   • if External Lookups are ON: pull pathway / interaction / literature
     evidence for exactly those entities
     │
     ▼
Model writes a CITED mechanistic narrative
   (biology is grounded in your run + real external sources, not just training)
```

## Side-by-side

| Dimension | Today | Proposed |
|---|---|---|
| **What changes** | Wording / framing | The evidence the answer is built from |
| **Grounding** | Model's training knowledge | Your run data + external biology, cited |
| **Activation** | Keyword match (brittle) | Intent classifier (C) |
| **Depth** | On / off | Graded levels (B) |
| **Context block** | One fixed run summary | Question-specific retrieval (A) |
| **External lookups** | Separate, unused by Discovery | Folded into the synthesis when enabled |
| **Where it lives** | `context_builder.py` | Same — AI subsystem, **not** the pipeline |

## Why it matters

The tracker calls Richer Discovery-mode biology *"the product differentiator."*
This is why: it turns "an AI that sounds like it understands your biology" into
"an AI that shows its work from your data and the literature." It also makes the
two composer toggles finally cooperate — **External Lookups** ("where facts come
from") feeding **Discovery** ("how the answer is framed and grounded").

## Proposed build order

1. **(B) Levels + (C) smarter activation** — smaller; ships the "levels" UX and
   builds the scaffold the next step plugs into.
2. **(A) Grounded synthesis** — the differentiator; bigger lift; leans on
   retrieval + external lookups.

*(All of this stays in the AI subsystem — no pipeline edits.)*
